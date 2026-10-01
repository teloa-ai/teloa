import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {
 WorkError,businessCustomizationLimits,businessDefinitionCanonicalBody,businessDefinitionPaths,readBusinessDefinitionBody,taskInput,
 type BusinessActionDefinition,type BusinessDefinitionDiffRow,type BusinessDefinitionKind,
 type BusinessDefinitionPreview,type BusinessDefinitionSource,
 type BusinessObjectTypeDefinition,type BusinessViewDefinition,
 type BusinessSourceMappingDefinition,type BusinessWidgetDefinition,type BusinessDashboardDefinition,
} from '@teloa/contract'
import {businessLocalDefinitionHash,type BusinessLocalActor,type BusinessLocalDefinitionService} from './business-definition-local.ts'
import {issueBusinessDefinitionPreviewReceipt} from './business-definition-preview-receipt.ts'
import type {BusinessDefinitionBundle,BusinessDefinitionSourceReader} from './business-definition-source.ts'
import {viewFields,type BusinessLedgerService} from './business-view-compute.ts'
import {readBusinessObjectSnapshot} from './business-data.ts'
import {mapSourceItem} from './business-sync.ts'
import type {BusinessSyncSourceResolver} from './business-sync-sources.ts'
import type {BusinessWidgetService} from './business-widgets.ts'

const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value===value.trim()&&value.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
const forbidden=(message:string)=>new WorkError('teloa/forbidden',message)
const conflict=(message:string)=>new WorkError('teloa/conflict',message)
const corrupt=(message:string)=>new WorkError('teloa/storage-corrupt',message)
const invalid=(message:string)=>new WorkError('teloa/invalid-input',message)
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const sha256=(value:string)=>createHash('sha256').update(value).digest('hex')
/**
 * 套上草案覆盖那一趟合并里的跨引用失败（`details.crossReference`）是草案造成的：改报 `teloa/invalid-input` 带原核对文案，
 * 并只转发 `crossReference` 这一项——客户端据此单说「草案与已有定义对不上」，其余 invalid-input 另说通用原因。
 * 调用方在此之前已经不带覆盖跑过一次 `forScope` 成功，因此这里的失败不可能是库里已生效声明本身的问题（那一种照旧 `source-unavailable`）。
 */
const draftCrossReference=(error:unknown)=>error instanceof WorkError&&error.code==='teloa/source-unavailable'&&error.details?.crossReference===true?new WorkError('teloa/invalid-input',error.message,{crossReference:true}):error

type LedgerDefinition=BusinessObjectTypeDefinition|BusinessViewDefinition|BusinessActionDefinition
type AnyDefinition=LedgerDefinition|BusinessSourceMappingDefinition|BusinessWidgetDefinition|BusinessDashboardDefinition
type AnyRecord={source:BusinessDefinitionSource;definition:AnyDefinition}
/** 预览 widget 草案时真跑一次 SQL 只回这么多行（同一执行边界，见 `BusinessWidgetService.compute`）。 */
const widgetTrialRows=50
/** source-mapping 试拉只展示映射后的前这么多条对象。 */
const mappingTrialObjects=5

function kindOf(definition:LedgerDefinition):BusinessDefinitionKind{
 return definition.format==='teloa.business-object-type/v1'?'object-type':definition.format==='teloa.business-view/v1'?'view':'action'
}

/** 一个种类在本范围内当前生效的全部声明（模板与本地已经由 `forScope` 合并过，来源由 `source.origin` 逐字带出）。 */
function ofKind(bundles:readonly BusinessDefinitionBundle[],kind:BusinessDefinitionKind):AnyRecord[]{
 const rows:AnyRecord[]=[]
 const pick={'object-type':'objectTypes','view':'views','action':'actions','source-mapping':'mappings','widget':'widgets','dashboard':'dashboards'} as const
 for(const bundle of bundles)rows.push(...bundle[pick[kind]])
 return rows
}

/**
 * 这份声明引用到的字段名。三个种类各有各的引用面，但一律只列**标识**：
 * 预览会连同摘要一起进模型上下文，取值样例一个都不给（规格 §7 第 3 条、§8 第 1 条）。
 */
function referencedFields(definition:LedgerDefinition):string[]{
 if(definition.format==='teloa.business-object-type/v1')return definition.fields.map(field=>field.name)
 if(definition.format==='teloa.business-view/v1')return [...viewFields(definition)]
 const names=definition.inputs.filter(input=>input.from==='field').map(input=>input.field)
 // 执行工具目标的 targetFrom 也可能取字段：它与 inputs 一样是这份动作真正引用到的那一列。
 if(definition.target.kind==='execution-tool'&&definition.target.targetFrom.from==='field')names.push(definition.target.targetFrom.field)
 return names
}

/**
 * 草案预览：差异、影响范围与试算三块。
 *
 * 三块算在**同一次只读事务**里（`repeatable read read only`）：差异的基准、影响范围枚举到的声明与试算的底稿
 * 必须来自同一份 MVCC 快照，否则用户看到的"改动前"与"改动后"不是同一件事；`read only` 让"预览一个字节也不写"
 * 由数据库自己担保，而不是靠读代码确认。试算复用台账那一条计算路径（D4）——按草案算出来的就是确认之后的那一个块。
 */
export class BusinessDefinitionPreviewService{
 private readonly pool:Pool
 private readonly identity:{now:()=>string}
 private readonly drafts:Pick<BusinessLocalDefinitionService,'draftInTransaction'|'currentVersionInTransaction'>
 private readonly definitions:Pick<BusinessDefinitionSourceReader,'forScope'>
 private readonly ledger:Pick<BusinessLedgerService,'computeInTransaction'>
 /** 看板三种声明（source-mapping / widget / dashboard）的试算依赖；缺省即这三种一律不给预览（旧装配形态照常可用）。 */
 private readonly boards:{widgets:Pick<BusinessWidgetService,'compute'|'rewrite'>;resolveSource?:BusinessSyncSourceResolver}|undefined
 constructor(
  pool:Pool,identity:{now:()=>string},
  drafts:Pick<BusinessLocalDefinitionService,'draftInTransaction'|'currentVersionInTransaction'>,
  definitions:Pick<BusinessDefinitionSourceReader,'forScope'>,
  ledger:Pick<BusinessLedgerService,'computeInTransaction'>,
  boards?:{widgets:Pick<BusinessWidgetService,'compute'|'rewrite'>;resolveSource?:BusinessSyncSourceResolver},
 ){this.pool=pool;this.identity=identity;this.drafts=drafts;this.definitions=definitions;this.ledger=ledger;this.boards=boards}

 async preview(actor:BusinessLocalActor,input:unknown,signal?:AbortSignal):Promise<BusinessDefinitionPreview>{
  if(!text(actor?.ownerId,128)||!Array.isArray(actor.scopeIds)||!actor.scopeIds.length||new Set(actor.scopeIds).size!==actor.scopeIds.length||actor.scopeIds.some(scope=>!text(scope,120)||scope==='general'))throw forbidden('需要有效的本人身份与业务范围。')
  const row=taskInput(input,['draftId','body','scope','pull'])
  const hasBody=Object.hasOwn(row,'body'),hasScope=Object.hasOwn(row,'scope')
  if(hasBody!==hasScope)throw invalid('业务声明预览的草案正文与业务范围必须同时提供。')
  // pull 只表达"用户显式点了试拉"：只收 true，缺省即不试拉受管 MCP 工具来源。
  if(Object.hasOwn(row,'pull')&&row.pull!==true)throw invalid('试拉标记只能为 true。')
  const pull=row.pull===true
  if(!uuid(row.draftId))throw forbidden('业务声明草案不存在或不属于当前本人。')
  signal?.throwIfAborted()
  const db=await this.pool.connect()
  try{
   await db.query('begin isolation level repeatable read read only')
   // 正常入口读第二期草案表；页内新建则带来已校验的页面草案正文，临时投影成同一份声明草案。
   // 两条路径随后共用完整的差异、影响范围与试算，不在页内新建处复制一套业务判据。
   let draft
   if(!hasBody){
    // 不存在与不属本人回同一句（`draftInTransaction`）：否则回包本身就能用来枚举别人的草案标识。
    draft=await this.drafts.draftInTransaction(db,actor.ownerId,String(row.draftId))
   }else{
    if(!text(row.body,businessCustomizationLimits.bodyBytes)||!text(row.scope,120)||row.scope==='general'||/[\r\n]/.test(row.scope))throw invalid('页内新建的业务声明草案不正确。')
    let parsed:unknown
    try{parsed=JSON.parse(row.body)}catch{throw corrupt('页内新建的业务声明草案正文不是有效 JSON，已停止预览。')}
    let definition:LedgerDefinition
    try{
     const raw=parsed as {format?:unknown}
     const kind=raw?.format==='teloa.business-object-type/v1'?'object-type':raw?.format==='teloa.business-view/v1'?'view':raw?.format==='teloa.business-action/v1'?'action':undefined
     if(!kind)throw invalid('页内新建的业务声明格式不正确。')
     definition=readBusinessDefinitionBody(kind,parsed) as LedgerDefinition
    }catch(error){if(error instanceof WorkError)throw error;throw corrupt('页内新建的业务声明草案正文不再符合声明格式，已停止预览。')}
    if(definition.domain!==row.scope)throw corrupt('页内新建的业务声明草案正文与业务范围不一致，已停止预览。')
    const body=businessDefinitionCanonicalBody(definition)
    if(body!==row.body)throw corrupt('页内新建的业务声明草案正文不是规范化正文，已停止预览。')
    const now=this.identity.now(),kind=kindOf(definition)
    draft={id:row.draftId,ownerId:actor.ownerId,requestId:row.draftId,scope:row.scope,kind,localId:definition.id,semver:definition.version,definitionHash:businessLocalDefinitionHash(row.scope,kind,definition.id,definition.version,sha256(body)),body,status:'draft' as const,createdAt:now,updatedAt:now}
   }
   if(!actor.scopeIds.includes(draft.scope))throw forbidden('当前主体未获准定制此业务范围。')
   // 已生效的草案不再预览：预览的语义是"确认之后会变成什么样"，对一份已经生效的正文没有这回事。
   if(draft.status!=='draft')throw conflict('业务声明草案已经生效，不再预览。')
   /**
    * 库里存的也不信：草案正文再过一遍 `read*`。入库时已经过过一遍，此时不符说明存储被改动过，
    * 因此是 `teloa/storage-corrupt` 而不是"调用方给错了参数"（与 `apply` 那一遍同规矩）。
    */
   let parsed:unknown
   try{parsed=JSON.parse(draft.body)}catch{throw corrupt('业务声明草案正文不是有效 JSON，已停止预览。')}
   let read
   try{read=readBusinessDefinitionBody(draft.kind,parsed)}catch{throw corrupt('业务声明草案正文不再符合声明格式，已停止预览。')}
   // 数据源映射、组件、看板三种的试算要执行器与同步源：装配方没给就不预览。
   const ledgerKind=read.format==='teloa.business-object-type/v1'||read.format==='teloa.business-view/v1'||read.format==='teloa.business-action/v1'
   if(!ledgerKind&&!this.boards)throw invalid('该种类业务声明暂不支持预览。')
   const definition:AnyDefinition=read
   if(definition.id!==draft.localId||definition.domain!==draft.scope)throw corrupt('业务声明草案正文与草案身份不一致，已停止预览。')
   signal?.throwIfAborted()
   const currentVersion=await this.drafts.currentVersionInTransaction(db,actor.ownerId,draft.scope,draft.kind,draft.localId)

   /**
    * 比对基准是"当前生效的那一份"，由 `forScope` 说：本地指针有值即本地当前版本，否则模板侧同 localId 声明，
    * 两者都没有即新增声明（`base.origin==='none'`）。来源逐字取 `source.origin`，不从版本号或 loadId 反推（D3）。
    */
   const bundles=await this.definitions.forScope(db,actor.ownerId,draft.scope)
   const current=ofKind(bundles,draft.kind).find(record=>record.definition.id===draft.localId)
   const base=current
    ?{origin:current.source.origin,semver:current.source.version,definitionHash:current.source.definitionHash}
    :{origin:'none' as const}
   const diff=diffRows(current?.definition,definition)
   const diffTruncated=diff.length>businessCustomizationLimits.diffRows
   signal?.throwIfAborted()

   const head={
    schema:'teloa.business-definition-preview/v1' as const,
    draft,receipt:issueBusinessDefinitionPreviewReceipt({ownerId:actor.ownerId,scope:draft.scope,draftId:draft.id,definitionHash:draft.definitionHash,currentVersion}),base,
    diff:diffTruncated?diff.slice(0,businessCustomizationLimits.diffRows):diff,
    diffTruncated,
   }
   if(definition.format==='teloa.business-widget/v1'||definition.format==='teloa.business-dashboard/v1'||definition.format==='teloa.business-source-mapping/v1'){
    const trial=await this.boardTrial(db,actor.ownerId,draft,definition,bundles,pull,signal)
    await db.query('commit')
    return {...head,...trial,computedAt:this.identity.now()}
   }
   /**
    * 试算：对象类型草案算它自己那个块，视图 / 动作草案算它挂靠的那个对象类型的块。
    * 覆盖只活在这一次只读事务里（`BusinessLedgerOverride`），与库里的本地声明走同一段合并与跨引用代码。
    * 合并之后跨引用不成立时整条抛错而不是把 trial 压成缺省：`trialUnavailable` 那几个取值只说"没有可算的数据"，
    * 说不了"这份草案生效之后台账读不出来"（规格 §8 第 7 条）。草案造成的跨引用失败报 `teloa/invalid-input` 带原因（`draftCrossReference`），
    * 基线本身就读不出来的（上面不带覆盖那一趟已经抛过）照旧 `source-unavailable`。
    */
   const objectType=definition.format==='teloa.business-object-type/v1'?definition.id:definition.objectType
   let computed
   try{computed=await this.ledger.computeInTransaction(db,actor,{scope:draft.scope,objectType},signal,{kind:draft.kind,localId:draft.localId,body:draft.body})}
   catch(error){throw draftCrossReference(error)}
   const block=computed.blocks[0]
   if(!block)throw corrupt('按草案试算的台账没有回出对应的块，已停止预览。')
   // 未接上来源与零对象都不画空块：界面据此说"接上来源后再看"，而不是显示一堆 0（规格 §5.4）。
   const unavailable=!block.source.connected?'source-disconnected' as const:block.objects?undefined:'no-objects' as const

   await db.query('commit')
   return {
    ...head,
    impact:impactOf(bundles,draft.scope,objectType,definition),
    ...(unavailable?{trialUnavailable:unavailable}:{trial:block}),
    computedAt:this.identity.now(),
   }
  }catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
 }

 /**
  * 看板三种声明的影响范围与试算。三者都先按草案覆盖跑一遍 `forScope`：合并与跨引用与生效之后同一段代码，
  * 草案造成的跨引用失败在这里就以 `teloa/invalid-input` 带原因拒绝（`draftCrossReference`）。
  *  - widget：按草案真跑一次（同一执行边界，回 ≤ 50 行）；SQL 不合规、形状不符都在 `widgetTrial.status='failed'` 里给人看，预览本身不抛。
  *    试算按 `all`；带 `timeFilter` 的另按 `7d` 只改写不执行，SQL 没读接入的表即 `failed`（二期规格 §3.3）。
  *  - dashboard：引用的组件必须全是本范围当前生效的组件，否则 `teloa/invalid-input`；试算给出布局。
  *  - source-mapping：对源试拉 1 页、按映射转换，不落库。试拉失败分四种情况（规格 §5.2）：来源没接上（没有来源解析器，或解析 / 拉取抛
  *    `details.sourceState:'disconnected'`）→ `trialUnavailable:'source-disconnected'`；数据源配置文件存在却读不了（`sourceState:'config-unreadable'`）→
  *    `trialUnavailable:'config-unreadable'`；草案点名了不能用于同步的工具（同步源只读门的 `teloa/forbidden`，带 `details.toolGate`）→ `teloa/invalid-input` 带原文（不带 crossReference）；
  *    其余 `WorkError`（超时、回包不符、其他来源的 forbidden 等）→ `trialUnavailable:'pull-failed'`，原文不下发。
  *    受管 MCP 工具来源只在 `pull` 为真时试拉，否则 `trialUnavailable:'pull-required'`。
  * `impact.objectType`：映射取目标对象类型；组件与看板不挂靠单一对象类型（SQL 组件的逻辑表横跨整个范围），取空串。
  */
 private async boardTrial(
  db:PoolClient,ownerId:string,draft:{scope:string;kind:BusinessDefinitionKind;localId:string;body:string},
  definition:BusinessSourceMappingDefinition|BusinessWidgetDefinition|BusinessDashboardDefinition,bundles:readonly BusinessDefinitionBundle[],pull:boolean,signal?:AbortSignal,
 ):Promise<Pick<BusinessDefinitionPreview,'impact'|'widgetTrial'|'dashboardTrial'|'mappingTrial'|'trialUnavailable'>>{
  const scope=draft.scope,boards=this.boards!
  const empty={scope,objectType:'',views:[] as string[],actions:[] as string[],fields:[] as string[],widgets:[] as string[],dashboards:[] as string[]}
  if(definition.format==='teloa.business-dashboard/v1'){
   const known=new Set(bundles.flatMap(bundle=>bundle.widgets.map(row=>row.definition.id)))
   const missing=definition.widgets.filter(id=>!known.has(id))
   if(missing.length)throw invalid('看板引用的组件不存在：'+missing.join('、')+'。请先确认这些组件生效。')
  }
  let trial
  try{trial=await this.definitions.forScope(db,ownerId,scope,{kind:draft.kind,localId:draft.localId,body:draft.body})}
  catch(error){throw draftCrossReference(error)}
  signal?.throwIfAborted()
  if(definition.format==='teloa.business-dashboard/v1')
   return {impact:{...empty,widgets:[...definition.widgets].sort(),dashboards:[definition.id]},dashboardTrial:{layout:definition.layout}}
  if(definition.format==='teloa.business-widget/v1'){
   const ctx={ownerId,scope,now:this.identity.now(),objectTypes:trial.flatMap(bundle=>bundle.objectTypes).map(row=>row.definition),views:trial.flatMap(bundle=>bundle.views)}
   let {throttled:_throttled,...widgetTrial}=await boards.widgets.compute(ctx,definition,widgetTrialRows,signal)
   // 试算按 all 执行；接入了时间范围的再按 7d 只改写不执行，核对 SQL 确实读了接入的表——改写失败即试算失败，界面据此不能确认（二期规格 §3.3）。
   if(widgetTrial.status==='ok'&&definition.timeFilter){
    try{await boards.widgets.rewrite(ctx,definition,'7d')}
    catch(error){
     if(!(error instanceof WorkError))throw error
     widgetTrial={...widgetTrial,status:'failed',columns:[],rows:[],rowCount:0,bytes:0,error:{code:error.code,reason:error.message}}
    }
   }
   const dashboards=bundles.flatMap(bundle=>bundle.dashboards).filter(row=>row.definition.widgets.includes(definition.id)).map(row=>row.definition.id)
   return {impact:{...empty,widgets:[definition.id],dashboards:[...new Set(dashboards)].sort()},widgetTrial}
  }
  const objectType=trial.flatMap(bundle=>bundle.objectTypes).find(row=>row.definition.id===definition.objectType)?.definition
  if(!objectType)throw corrupt('按草案合并后找不到映射的目标对象类型，已停止预览。')
  const declared=new Set(objectType.fields.map(field=>field.name))
  const impact={...empty,objectType:objectType.id,fields:[...new Set(definition.mapping.map(item=>item.field).filter(field=>declared.has(field)))].sort()}
  if(definition.source.kind==='role-result')return {impact,trialUnavailable:'no-objects'}
  // 受管 MCP 工具是外部调用：打开预览不自动执行，等用户看过 server / tool / 参数后显式试拉（安全审查 M1）。
  if(definition.source.kind==='mcp-tool'&&!pull)return {impact,trialUnavailable:'pull-required'}
  if(!boards.resolveSource)return {impact,trialUnavailable:'source-disconnected'}
  let page
  try{page=await (await boards.resolveSource(definition)).fetch({scope,pageSize:definition.pageSize??50,...(signal?{signal}:{})})}
  catch(error){
   if(signal?.aborted||!(error instanceof WorkError))throw error
   if(error.details?.sourceState==='disconnected')return {impact,trialUnavailable:'source-disconnected'}
   if(error.details?.sourceState==='config-unreadable')return {impact,trialUnavailable:'config-unreadable'}
   if(error.code==='teloa/forbidden'&&error.details?.toolGate===true)throw invalid(error.message)
   return {impact,trialUnavailable:'pull-failed'}
  }
  const nameOf=new Map(objectType.fields.map(field=>[field.from,field.name]))
  const objects:NonNullable<BusinessDefinitionPreview['mappingTrial']>['objects']=[]
  for(const item of page.items){
   if(objects.length>=mappingTrialObjects)break
   let snapshot:{id:string;fields:Array<{label:string;value:string}>}|undefined
   if(definition.mapping.length===0){try{snapshot=readBusinessObjectSnapshot(item,scope)}catch{snapshot=undefined}}
   else{const mapped=mapSourceItem(definition,objectType,item,page.capturedAt);snapshot='snapshot' in mapped?mapped.snapshot:undefined}
   if(!snapshot)continue
   objects.push({objectId:snapshot.id,fields:snapshot.fields.flatMap(field=>{const name=nameOf.get(field.label);return name===undefined?[]:[{field:name,value:field.value}]})})
  }
  return {impact,mappingTrial:{fetched:page.items.length,objects}}
 }
}

/**
 * 差异：两侧都走 `businessDefinitionPaths`，按路径并集排序逐条比对——同一份声明必得同一批路径，
 * 因此"改了一个标题"只出一行，而不是整份正文重排。缺省的一侧是 `null`（新增声明时整张表都是 `before:null`）。
 */
function diffRows(before:AnyDefinition|undefined,after:AnyDefinition):BusinessDefinitionDiffRow[]{
 const left=before===undefined?new Map<string,string>():businessDefinitionPaths(before),right=businessDefinitionPaths(after)
 const rows:BusinessDefinitionDiffRow[]=[]
 for(const path of [...new Set([...left.keys(),...right.keys()])].sort()){
  const a=left.get(path)??null,b=right.get(path)??null
  if(a!==b)rows.push({path,before:a,after:b})
 }
 return rows
}

/**
 * 影响范围：全是标识，不含任何对象取值。对象类型一改，挂在它上面的视图与动作全部跟着重算，
 * 因此按当前生效的声明枚举它们；视图 / 动作草案只影响它自己那一条。
 */
function impactOf(bundles:readonly BusinessDefinitionBundle[],scope:string,objectType:string,definition:LedgerDefinition):BusinessDefinitionPreview['impact']{
 const views=new Set<string>(),actions=new Set<string>()
 if(definition.format==='teloa.business-object-type/v1'){
  for(const bundle of bundles){
   for(const record of bundle.views)if(record.definition.objectType===objectType)views.add(record.definition.id)
   for(const record of bundle.actions)if(record.definition.objectType===objectType)actions.add(record.definition.id)
  }
 }else if(definition.format==='teloa.business-view/v1')views.add(definition.id)
 else actions.add(definition.id)
 return {scope,objectType,views:[...views].sort(),actions:[...actions].sort(),fields:[...new Set(referencedFields(definition))].sort(),widgets:[],dashboards:[]}
}
