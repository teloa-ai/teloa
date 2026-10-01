import type {IndustryPluginInstance,IndustryPluginState} from './industry-plugin-api.ts'
import type {BusinessLedger} from '@teloa/contract'
import type {IndustryLoadRecord} from './industry-load-api.ts'
import type {IndustryManifest,IndustryResource} from './industry-manifest.ts'
import type {PreviewRole} from './role-preview.ts'
import type {MessageKey} from './i18n/messages.ts'
import type {TeloaTranslate} from './i18n/index.ts'

type Kind=IndustryResource['kind']

/**
 * 一个业务 = 七类东西（产品文档 design specification）。
 * 市场包、业务卡摘要、业务范围内页三处都读这一份：顺序、标签、单位逐字相同，不各写一份。
 * 契约的 12 种资源每种恰好落在一行，行内合并的都有共同本质（一条配好的外部连接 / 台账里看到的内容 / 工作按什么方式被发起）。
 */
export type CompositionRowId='staff'|'skill'|'knowledge'|'source'|'board'|'method'|'extension'
export type CompositionRow={id:CompositionRowId;kinds:readonly Kind[];label:MessageKey;question:MessageKey;unit:MessageKey}

/** 顺序就是搭一个业务的过程：先有人 → 靠什么本事和依据 → 接上外部世界 → 东西被管起来看起来 → 对它开工 → 额外装的能力。 */
export const COMPOSITION_ROWS:readonly CompositionRow[]=[
 {id:'staff',kinds:['role'],label:'composition.row.staff',question:'composition.question.staff',unit:'composition.unit.staff'},
 {id:'skill',kinds:['skill'],label:'composition.row.skill',question:'composition.question.skill',unit:'composition.unit.skill'},
 {id:'knowledge',kinds:['knowledge'],label:'composition.row.knowledge',question:'composition.question.knowledge',unit:'composition.unit.knowledge'},
 {id:'source',kinds:['mcp','data-source','execution-tool'],label:'composition.row.source',question:'composition.question.source',unit:'composition.unit.source'},
 {id:'board',kinds:['object-type','business-view','business-configuration'],label:'composition.row.board',question:'composition.question.board',unit:'composition.unit.board'},
 {id:'method',kinds:['work-template','plan','business-action'],label:'composition.row.method',question:'composition.question.method',unit:'composition.unit.method'},
 {id:'extension',kinds:['plugin'],label:'composition.row.extension',question:'composition.question.extension',unit:'composition.unit.extension'},
]

/** 任务模板行的附注词条（两边都有 / 只有自动化 / 只有动作）与扩展行的副标。 */
export const COMPOSITION_METHOD_NOTE_KEY:MessageKey='composition.note.method'
export const COMPOSITION_AUTOMATION_NOTE_KEY:MessageKey='composition.note.automations'
export const COMPOSITION_ACTION_NOTE_KEY:MessageKey='composition.note.actions'
export const COMPOSITION_EXTENSION_NOTE_KEY:MessageKey='composition.extension.note'
/** 两条空态句：接入源与业务看板各一条，别处不复用。 */
export const COMPOSITION_EMPTY_KEYS:Readonly<Partial<Record<CompositionRowId,MessageKey>>>={source:'composition.empty.source',board:'composition.empty.board'}

/**
 * `count` 是该行说给用户听的主数字：看板说「几类东西」，任务模板说「几个任务模板」，
 * 其余行就是该行资源条数。明细只在这两行出现，供单位词条的第二个数与附注使用。
 */
export type CompositionCount={id:CompositionRowId;count:number;detail?:{configurations?:number;objectTypes?:number;views?:number;automations?:number;actions?:number}}

const rowById=(id:CompositionRowId):CompositionRow=>COMPOSITION_ROWS.find(row=>row.id===id)!

/** 七行计数的唯一算法：整行一个资源都没有就不返回，界面据此不渲染空行、也不显示「0 位同事」。 */
function countRows(countOf:(kind:Kind)=>number):CompositionCount[]{
 const rows:CompositionCount[]=[]
 for(const row of COMPOSITION_ROWS){
  const total=row.kinds.reduce((sum,kind)=>sum+countOf(kind),0)
  if(!total)continue
  if(row.id==='board')rows.push({id:row.id,count:countOf('object-type'),detail:{objectTypes:countOf('object-type'),views:countOf('business-view'),...(countOf('business-configuration')?{configurations:countOf('business-configuration')}:{})}})
  else if(row.id==='method')rows.push({id:row.id,count:countOf('work-template'),detail:{automations:countOf('plan'),actions:countOf('business-action')}})
  else rows.push({id:row.id,count:total})
 }
 return rows
}

/**
 * 市场包按七行说清「添加后你会得到」。清单里的 `role` 都是要新建的同事，本人的默认分身不在包里，
 * 因此包计数天然不含分身；分身只在已加载的业务面板里如实列出（见 `composeFromWorkspace`）。
 */
export function composeFromManifest(manifest:IndustryManifest):CompositionCount[]{
 return countRows(kind=>manifest.resources.filter(resource=>resource.kind===kind).length)
}

/** 只有各类资源数量时（官方目录列表回包的 `contents`）走同一套七行算法，方案卡的「包含」摘要与产品页计数一致。 */
export function composeFromCounts(counts:Readonly<Partial<Record<Kind,number>>>):CompositionCount[]{
 return countRows(kind=>counts[kind]??0)
}

export type ConnectorMode='read'|'write'

/**
 * 每条接入源带一句副标：业内一致的两档——读（只拿数据）/ 写（会改外部世界，含执行动作，不再区分「写」与「执行」）——
 * 加一个只叠在写上的「需你审批」标记。
 * data-source 恒为读；execution-tool 恒为写且恒带审批标记（它走安全审批链）；
 * mcp 现阶段拿不到 MCP 官方 `readOnlyHint`/`destructiveHint` 标注——DSH 的 `dsh-mcp-client` 把工具注册进来时
 * 不保留 MCP `annotations`，Teloa 不改 `@deepseek-ai/*`——按 MCP 规范默认值保守判写，且不带审批标记
 * （拿不到 `destructiveHint` 就不替用户断言它需要审批）。日后拿到这两个标注再逐工具下调。
 */
export function connectorMode(item:{kind:Kind}):{mode:ConnectorMode;approval:boolean}|undefined{
 if(item.kind==='data-source')return {mode:'read',approval:false}
 if(item.kind==='execution-tool')return {mode:'write',approval:true}
 if(item.kind==='mcp')return {mode:'write',approval:false}
 return undefined
}

/**
 * 方案产品页接入源一条的读写（官方页与本机页同一口径）：按 `mcpConnectionReadOnly` 判定为只读的连接写「读」，
 * 其余仍按资源类型的保守口径（见 `connectorMode`）。
 */
export function sourceConnectorMode(resource:{id:string;kind:Kind},readOnly:readonly string[]):{mode:ConnectorMode;approval:boolean}|{mode:'read'}|undefined{
 return readOnly.includes(resource.id)?{mode:'read'}:connectorMode({kind:resource.kind})
}

export type CompositionItemState='active'|'paused'|'retired'|'default-twin'|'installed'|'pending-authorization'|'pinned'|'pinned-version'|'pending-pin'|'connected'|'discovered'|'disconnected'|'has-data'|'no-data'|'available'|'missing-field'|'missing-connection'|'needs-restart'|'pending-install'|'unverified'|'installing'|'pending-enable'|'install-failed'

/**
 * 状态词与连接器副标都只从词表读，组件不自己拼中文。
 * `pinned` 是动作「挂在对象上」的意思（任务模板行），`pinned-version` 是资料「固定版本」的意思（依据资料行）——
 * 两个中文说法不同，不能共用同一个状态值，否则改一边的词条会连带改坏另一边。
 */
export const COMPOSITION_STATE_KEYS:Readonly<Record<CompositionItemState,MessageKey>>={
 active:'composition.state.active',paused:'composition.state.paused',retired:'composition.state.retired','default-twin':'composition.state.defaultTwin',
 installed:'composition.state.installed','pending-authorization':'composition.state.pendingAuthorization',pinned:'composition.state.pinned',
 'pinned-version':'composition.state.pinnedVersion','pending-pin':'composition.state.pendingPin',
 discovered:'composition.state.discovered',connected:'composition.state.connected',disconnected:'composition.state.disconnected','has-data':'composition.state.hasData','no-data':'composition.state.noData',
 available:'composition.state.available','missing-field':'composition.state.missingField','missing-connection':'composition.state.missingConnection',
 'needs-restart':'composition.state.needsRestart','pending-install':'composition.state.pendingInstall',
 unverified:'extension.unverified',installing:'extension.installing','pending-enable':'extension.pendingEnable','install-failed':'extension.installFailed',
}
export const COMPOSITION_MODE_KEYS:Readonly<Record<ConnectorMode,MessageKey>>={read:'composition.mode.read',write:'composition.mode.write'}
/** 只叠在写上的审批标记，与模式词分开管理：读永远不带它，写不一定带。 */
export const COMPOSITION_APPROVAL_KEY:MessageKey='composition.mode.approval'

/** 「去配置」的落点：共享资源（技能、连接器）只有一处配置页，业务自有的东西回到该业务里。 */
export type CompositionTarget={kind:'team';scope:string}|{kind:'capabilities'}|{kind:'knowledge'}|{kind:'connectors'}|{kind:'business';scope:string;section?:string}|{kind:'plans';scope:string}|{kind:'market';category:'plugin'}|{kind:'extension';instanceId:string}
export type CompositionItem={id:string;title:string;state:CompositionItemState;mode?:ConnectorMode;approval?:boolean;go:CompositionTarget}

/** 能力页只摆跨业务复用的四行；顺序仍由 `COMPOSITION_ROWS` 决定，这里只给过滤名单。 */
export const CAPABILITY_ROW_IDS:readonly CompositionRowId[]=['skill','source','method','extension']

/**
 * 去重判据：落点不带 `scope`（技能 `{kind:'capabilities'}`、接入源 `{kind:'connectors'}`、扩展 `{kind:'market'}`）
 * 说明它是一份共享的东西、只有一处可配，跨业务合并成一条；带 `scope`（`team`/`business`/`plans`）
 * 说明每个业务各自配，逐业务各一条。
 */
export function compositionTargetScope(target:CompositionTarget):string|undefined{
 switch(target.kind){
  case 'team':case 'business':case 'plans':return target.scope
  case 'capabilities':case 'knowledge':case 'connectors':case 'market':case 'extension':return undefined
 }
}

/** 两处渲染共用的接入源副标拼法：无 mode 不说话，写且需审批才加「 · 需你审批」，不各自拼一遍。 */
export function connectorModeLabel(item:{mode?:ConnectorMode;approval?:boolean},t:(key:MessageKey)=>string):string|undefined{
 if(!item.mode)return undefined
 const label=t(COMPOSITION_MODE_KEYS[item.mode])
 return item.approval?label+' · '+t(COMPOSITION_APPROVAL_KEY):label
}
export type CompositionSection={id:CompositionRowId;count:CompositionCount;items:CompositionItem[]}

type LoadItem=IndustryLoadRecord['items'][number]

/** 加载项只有 `active` 才算真在手上；其余状态都还差一步，按各行的说法讲清楚差哪一步。 */
const settled=(item:LoadItem)=>item.status==='active'

export type CompositionWorkspaceInput={
 scope:string
 loads:readonly IndustryLoadRecord[]
 roles:readonly PreviewRole[]
 plugins?:readonly Pick<IndustryPluginInstance,'loadId'|'itemInstanceId'|'state'>[]|undefined
 ledger?:BusinessLedger|undefined
 plans?:readonly {scope:string;state:string;title:string}[]
}

/**
 * 业务范围内页「这个业务有什么」的唯一数据源：同一份七行，按已加载的真实记录逐项列出来。
 * 加载记录按空间范围收窄，与 `projectIndustryWorkspace` 同一判据；卸载与被取代的加载不算数。
 * 默认分身如实列出并标「默认分身」，但不计入人数——它一直都在，不是这个业务带来的。
 */
export function composeFromWorkspace(input:CompositionWorkspaceInput):CompositionSection[]{
 const scope=input.scope
 const loaded=input.loads.filter(load=>load.status==='active'&&load.space.scope===scope).flatMap(load=>load.items.filter(item=>item.status!=='skipped'))
 const byKind=(...kinds:readonly Kind[])=>loaded.filter(item=>kinds.includes(item.kind))

 const staff=input.roles.filter(role=>role.scopes.some(value=>value===scope)).map((role):CompositionItem=>({
  id:role.id,title:role.name,state:role.kind==='twin'?'default-twin':role.state,go:{kind:'team',scope},
 }))
 // 技能三档：装好了说已安装；已实例化只是还没授权，说待授权；只登记过（待适配、已脱钩）还没装，说待安装——
 // 不能不装也说「待授权」，那是给已经装上、只差点头的技能用的词。
 const skills=byKind('skill').map((item):CompositionItem=>({
  id:item.instanceId,title:item.title,state:settled(item)?'installed':item.status==='instantiated'?'pending-authorization':'pending-install',go:{kind:'capabilities'},
 }))
 // 依据资料一装上就是固定版本（产品文档「固定版本，添加不扩大读取权限」），不是「可用」；
 // 还没装时说待固定，不能借用扩展的「待安装」——资料不是插件，不用「安装」这个词。
 const materials=byKind('knowledge').map((item):CompositionItem=>({
  id:item.instanceId,title:item.title,state:settled(item)?'pinned-version':'pending-pin',go:{kind:'knowledge'},
 }))
 const connections=byKind('mcp','data-source','execution-tool').map((item):CompositionItem=>{
  const result=connectorMode({kind:item.kind})
  return {id:item.instanceId,title:item.title,state:settled(item)?'connected':'disconnected',...(result?{mode:result.mode}:{}),...(result?.approval?{approval:true}:{}),go:{kind:'connectors'}}
 })
 // 加载记录会折叠安装阶段；只有扩展实例能判断是否需重启，缺失时明确待核对。
 const extensionStates:Record<IndustryPluginState,CompositionItemState>={needs_install:'pending-install',installing:'installing','pending-enable':'pending-enable',active:'installed','restart-required':'needs-restart',failed:'install-failed',detached:'pending-install'}
 const extensions=byKind('plugin').map((item):CompositionItem=>{
  const load=input.loads.find(load=>load.status==='active'&&load.space.scope===scope&&load.items.some(row=>row.instanceId===item.instanceId))
  const instance=input.plugins?.find(row=>row.loadId===load?.id&&row.itemInstanceId===item.instanceId)
  return {id:item.instanceId,title:item.title,state:instance?extensionStates[instance.state]:item.status==='pending-adapter'||item.status==='detached'?'pending-install':'unverified',go:{kind:'extension',instanceId:item.instanceId}}
 })

 // 看板行优先读真实台账：块里有对象条数、缺字段和来源连接的事实，声明只在还没算出台账时兜底。
 const blocks=input.ledger?.scope===scope?input.ledger.blocks:undefined
 const boardItems=blocks
  ?blocks.map((block):CompositionItem=>({
   id:block.objectType.definition.id,
   title:block.objectType.definition.title,
   state:!block.source.connected?'missing-connection':block.missingFields.length?'missing-field':block.objects>0?'has-data':'no-data',
   go:{kind:'business',scope,section:block.objectType.definition.id},
  }))
  :byKind('object-type').map((item):CompositionItem=>({
   id:item.instanceId,title:item.title,state:settled(item)?'no-data':'pending-install',go:{kind:'business',scope,section:item.localId},
  }))
 const views=blocks?blocks.reduce((sum,block)=>sum+block.views.length,0):byKind('business-view').length

 const templates=byKind('work-template').map((item):CompositionItem=>({
  id:item.instanceId,title:item.title,state:settled(item)?'available':'pending-install',go:{kind:'business',scope},
 }))
 // 自动化优先读真实的持续计划；没有传时回落到加载声明，免得面板上连声明过的自动化都看不见。
 const planRows=input.plans?.filter(plan=>plan.scope===scope)
 const automations=planRows
  ?planRows.map((plan,index):CompositionItem=>({
   id:'plan:'+index,title:plan.title,state:plan.state==='active'||plan.state==='paused'||plan.state==='retired'?plan.state:'available',go:{kind:'plans',scope},
  }))
  :byKind('plan').map((item):CompositionItem=>({
   id:item.instanceId,title:item.title,state:settled(item)?'available':'pending-install',go:{kind:'plans',scope},
  }))
 const actions=byKind('business-action').map((item):CompositionItem=>({
  id:item.instanceId,title:item.title,state:'pinned',go:{kind:'business',scope},
 }))

 const sections:CompositionSection[]=[
  {id:'staff',count:{id:'staff',count:staff.filter(item=>item.state!=='default-twin').length},items:staff},
  {id:'skill',count:{id:'skill',count:skills.length},items:skills},
  {id:'knowledge',count:{id:'knowledge',count:materials.length},items:materials},
  {id:'source',count:{id:'source',count:connections.length},items:connections},
  {id:'board',count:{id:'board',count:boardItems.length,detail:{objectTypes:boardItems.length,views}},items:boardItems},
  {id:'method',count:{id:'method',count:templates.length,detail:{automations:automations.length,actions:actions.length}},items:[...templates,...automations,...actions]},
  {id:'extension',count:{id:'extension',count:extensions.length},items:extensions},
 ]
 // 看板行只有视图、没有对象类型时也得留着：视图不是逐条列出来的条目，按条目数滤会把「有几张视图」整行抹掉。
 return sections.filter(section=>section.items.length>0||(section.id==='board'&&views>0))
}

/**
 * 任务模板行的附注：只说真有的那一半，两边都有才连起来说，两边都没有就没有附注。
 * 内置示例里「只有动作、没有自动化」和「只有自动化、没有动作」两种都真实存在，
 * 所以不能拿一条带两个数的句子硬套，否则会当着用户面写出「0 个动作挂在对象上」。
 */
export function compositionMethodNote(detail:CompositionCount['detail'],t:TeloaTranslate,number:(n:number)=>string):string{
 const automations=detail?.automations??0,actions=detail?.actions??0
 if(automations&&actions)return t(COMPOSITION_METHOD_NOTE_KEY,{automations:number(automations),actions:number(actions)})
 if(automations)return t(COMPOSITION_AUTOMATION_NOTE_KEY,{automations:number(automations)})
 if(actions)return t(COMPOSITION_ACTION_NOTE_KEY,{actions:number(actions)})
 return ''
}

/** 摘要分段：同事/技能/资料是「谁带着什么本事」，接入、看板、任务模板、扩展各成一段。 */
const SUMMARY_SEGMENTS:readonly (readonly CompositionRowId[])[]=[['staff','skill','knowledge'],['source'],['board'],['method'],['extension']]

/**
 * 业务卡与市场卡的一行摘要：只有名词加计数，段间「｜」，段内「 · 」。
 * 主数字为 0 且一个明细数都没有的行不进摘要（只有默认分身的同事行就是这种），全空返回空串让界面整行不渲染。
 * 两种「半空」的行不能跟着主数字一起掉队：任务模板行的自动化与动作、看板行的视图都是真有的东西，
 * 主数字为 0 时说那半句，而不是把整行咽回去——没有任务模板也不写「0 个任务模板」。
 */
export function compositionSummary(rows:readonly CompositionCount[],t:TeloaTranslate,number:(n:number)=>string):string{
 const speak=(row:CompositionCount)=>row.id==='method'&&row.count===0
  ?compositionMethodNote(row.detail,t,number)
  :row.detail?.configurations?t('market.dashboard.count',{count:number(row.detail.configurations)}):t(rowById(row.id).unit,{count:number(row.count),views:number(row.detail?.views??0)})
 const shown=(row:CompositionCount)=>row.id==='method'
  ?row.count>0||(row.detail?.automations??0)>0||(row.detail?.actions??0)>0
  :row.count>0||(row.detail?.views??0)>0||(row.detail?.configurations??0)>0
 return SUMMARY_SEGMENTS
  .map(ids=>ids
   .flatMap(id=>{
    const row=rows.find(item=>item.id===id)
    return row&&shown(row)?[speak(row)]:[]
   })
   .join(' · '))
  .filter(segment=>segment.length>0)
  .join(' ｜ ')
}
