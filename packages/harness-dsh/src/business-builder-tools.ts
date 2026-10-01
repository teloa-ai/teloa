import {createHash} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import {createUserMessage,type ContextFormed} from '@deepseek-ai/dsh-llm'
import {defineTool,type ToolExecution,type ParameterSchemaSpec} from '@deepseek-ai/dsh-tools'
import {WorkError,taskInput,readBusinessConfigurationPatchVersioned,readBusinessConfigurationDraftResponseVersioned,businessConfigurationFormat,businessConfigurationFormatV2,businessRichFieldFormat,businessViewFormatV2,businessRichViewFieldCapabilities,businessConfigurationLimits,businessConfigurationDefinitionKinds,businessFieldTypes,businessViewKinds,businessAggregations,businessTimeBuckets,businessChartTypes,businessFilterOperators,businessViewWindows,businessViewCharts,businessFieldCapabilities,businessLedgerLimits,type BusinessConversationBinding,type BusinessConfigurationPatch,type BusinessConfigurationPatchV2} from '@teloa/contract'
import {businessConfigurationHash,type BusinessConfigurationDraft} from '@teloa/backend'
import {authorizeOrdinaryConversationMutation} from './conversation-mutation.ts'
import {readConversationInstructionIdentity,type ConversationInstructionIdentity} from './conversation-instruction-identity.ts'
import type {TaskToolPolicyReader} from './task-tool-guard.ts'

export const businessBuilderToolNames=['teloa_business_builder_read','teloa_business_builder_revise','teloa_business_builder_upgrade'] as const
export type BusinessBuilderToolsPorts={
 owner:string
 conversation:(sessionId:string)=>Promise<{ownerId:string;sessionId:string;status:'pending'|'ready'}>
 readTaskPolicy:TaskToolPolicyReader
 isRoleConversation:(sessionId:string)=>Promise<boolean>
 isTaskConversation:(sessionId:string)=>Promise<boolean>
 /** 宿主必须使用真实绑定服务及即时本人授权，不能用模型提供的 session/draft 代替。 */
 binding:(sessionId:string)=>Promise<BusinessConversationBinding|undefined>
 draft:(draftId:string)=>Promise<BusinessConfigurationDraft>
 revise:(input:{draftId:string;expectedRevision:number;requestId:string;patch:BusinessConfigurationPatch|BusinessConfigurationPatchV2})=>Promise<BusinessConfigurationDraft>
 reviseReceipt:(input:{draftId:string;expectedRevision:number;requestId:string;patch:unknown})=>Promise<BusinessConfigurationDraft|undefined>
 upgradeFormat:(input:{draftId:string;expectedRevision:number;requestId:string})=>Promise<BusinessConfigurationDraft>
}
const source='plugin:teloa.business-builder' as const
declare module '@deepseek-ai/dsh-llm' {interface MessageSourceMap {'plugin:teloa.business-builder':{kind:typeof source}&ContextFormed}}
const names=new Set<string>(businessBuilderToolNames),uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i,localId=/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/
const invalid=()=>new WorkError('teloa/invalid-input','草案工具参数格式不正确，请按目录中的当前协议生成。')
function encoded(value:unknown,max=262144):string{const text=JSON.stringify(value);if(Buffer.byteLength(text,'utf8')>max)throw new WorkError('teloa/invalid-input','草案读取结果超过大小上限，请分条读取。');return text}
function query(value:unknown){
 const row=taskInput(value,['cursor','definition','pageId'])
 if('definition' in row){if('cursor' in row||'pageId' in row)throw invalid();const ref=taskInput(row.definition,['kind','localId']);if(!(businessConfigurationDefinitionKinds as readonly unknown[]).includes(ref.kind)||typeof ref.localId!=='string'||!localId.test(ref.localId))throw invalid();return {definition:{kind:ref.kind,localId:ref.localId}}}
 if('pageId' in row){if('cursor' in row||typeof row.pageId!=='string'||!localId.test(row.pageId))throw invalid();return {pageId:row.pageId}}
 if(row.cursor!==undefined&&(!Number.isSafeInteger(row.cursor)||Number(row.cursor)<0))throw invalid()
 return {cursor:row.cursor===undefined?0:row.cursor as number}
}
function mutationInput(value:unknown){const row=taskInput(value,['draftId','expectedRevision','patch']);if(typeof row.draftId!=='string'||!uuid.test(row.draftId)||!Number.isSafeInteger(row.expectedRevision)||Number(row.expectedRevision)<1||!row.patch||typeof row.patch!=='object'||Array.isArray(row.patch))throw invalid();return {draftId:row.draftId,expectedRevision:row.expectedRevision as number,patch:row.patch}}
function mutation(value:unknown,format:string){const row=mutationInput(value);return {...row,patch:readBusinessConfigurationPatchVersioned(row.patch,format)}}
function requestId(owner:string,identity:ConversationInstructionIdentity,draftId:string,revision:number){const h=createHash('sha256').update(JSON.stringify(['teloa-business-builder/v1',owner,identity.sessionId,identity.messageId,identity.seq,businessBuilderToolNames[1],draftId.toLowerCase(),revision])).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`}
function upgradeRequestId(owner:string,identity:ConversationInstructionIdentity,draftId:string,revision:number){const h=createHash('sha256').update(JSON.stringify(['teloa-business-builder/v1',owner,identity.sessionId,identity.messageId,identity.seq,businessBuilderToolNames[2],draftId.toLowerCase(),revision])).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`}
function upgradeInput(value:unknown,draft:BusinessConfigurationDraft){
 const row=taskInput(value,['draftId','expectedRevision'])
 if(typeof row.draftId!=='string'||!uuid.test(row.draftId)||!Number.isSafeInteger(row.expectedRevision)||Number(row.expectedRevision)<1)throw invalid()
 if(row.draftId!==draft.id)throw new WorkError('teloa/forbidden','当前搭建会话不能升级另一份草案。')
 if(draft.status!=='draft')throw new WorkError('teloa/forbidden','已保存的业务不能从草案工具升级，请先恢复可修改的草案。')
 if(draft.candidate.format===businessConfigurationFormatV2){
  // 旧版本仅交给后端核对同请求回执；没有原回执时不得新建转换。
  if(Number(row.expectedRevision)>=draft.revision)throw new WorkError('teloa/conflict','这份草案已支持金额和多选，无需升级，请重新读取后继续修订。')
 }else if(draft.candidate.format!==businessConfigurationFormat||row.expectedRevision!==draft.revision)throw new WorkError('teloa/version-conflict','业务配置草案已变化，请重新读取后升级。')
 return {draftId:row.draftId,expectedRevision:row.expectedRevision as number}
}
function upgradeState(draft:BusinessConfigurationDraft){return JSON.stringify([draft.revision,draft.baseVersion,draft.hash,draft.status])}
function invalidReceipt(operation:'升级'|'保存'){return new WorkError('teloa/invalid-host-response','草案'+operation+'回执与原请求不一致，请先读取当前草案核对。')}
function mutationReceipt(value:unknown,draft:BusinessConfigurationDraft,revision:number,operation:'升级'|'保存'):BusinessConfigurationDraft{
 let result:BusinessConfigurationDraft
 try{result=readBusinessConfigurationDraftResponseVersioned(value)}catch{throw invalidReceipt(operation)}
 if(result.ownerId!==draft.ownerId||result.id!==draft.id||result.scope!==draft.scope||result.baseVersion!==draft.baseVersion||JSON.stringify(result.candidate.sources)!==JSON.stringify(draft.candidate.sources)||result.revision!==revision+1||result.status!=='draft'||result.hash!==businessConfigurationHash(result.candidate))throw invalidReceipt(operation)
 return result
}
function upgradeReceipt(value:unknown,draft:BusinessConfigurationDraft,revision:number):BusinessConfigurationDraft{const result=mutationReceipt(value,draft,revision,'升级');if(result.candidate.format!==businessConfigurationFormatV2)throw invalidReceipt('升级');return result}
const referenceRules='reference 支持同业务本地记录单选关联，referenceType 必须指向完整候选中的真实本地对象类型，来源须为原 local-records；合法关联的 records 页面可开启 allowCreate/allowEdit。字段值保存目标原始 ID，名称与状态须读真实目标，必填遵循 required。关系多选、唯一约束和跨业务关联尚未支持。'
const relationRulesV2='reference 为单选关联，值保存目标原始 ID；multi-reference 为多选关联，使用 teloa.business-rich-field/v2 并声明 referenceType，值为按 ID 字典序排列、无重复的 1–32 个真实目标 ID 的规范 JSON 数组字符串，编码总长不超过2000字符，不保存标题、不截断。referenceType 必须指向完整候选中同业务的真实本地对象类型，来源须为原 local-records；合法关联的 records 页面可开启 allowCreate/allowEdit。实际记录须先用记录 list/get 读取每个真实目标标题与状态，所有非空目标都须属于当前本人、当前业务已采用的本地类型，且有效未归档，编辑时失效旧值须清空或改绑；可选空值为空字符串，required 不得省略或清空。object-type/v2 可声明 constraints:{uniqueFields:[字段name]}，1–50个不重复的真实字段，每个字段独立唯一，不是组合唯一；multi-enum 不支持唯一声明。文本、枚举、单关联精确匹配，数字按数值，布尔、时长按既有解析，money 按币种及精确金额；可选空值不占用。单关联唯一为一对一；多关联唯一时每个成员不能被另一活跃源记录占用，形成一对多；不声明唯一的多关联为多对多。归档源释放占用，后端事务按全部操作后态重新核验并允许合法交换；list 预查不能保证唯一，新增唯一约束须在预览和采用时重新检查现存活跃记录，冲突先处理数据。multi-reference 仅支持 v2 contains/overlaps 筛选与 count 条件，不作原 ID 分布维度或数值/文本聚合。跨业务关联、组合唯一与外部来源写入尚未支持。'
const capabilities={format:businessConfigurationFormat,definitionKinds:businessConfigurationDefinitionKinds,fieldTypes:businessFieldTypes,fieldCapabilities:businessFieldCapabilities,viewKinds:businessViewKinds,aggregations:businessAggregations,timeBuckets:businessTimeBuckets,chartTypes:businessChartTypes,filterOperators:businessFilterOperators,viewWindows:businessViewWindows,viewCharts:businessViewCharts,limits:{...businessConfigurationLimits,...businessLedgerLimits,definitionBytes:131072,responseBytes:262144,directoryPage:32},rules:'保留目录分配的 scope 与 sources；definition.domain 必须等于 scope，object-type.sourceId 必须引用原 local-records 来源。'+referenceRules+'整组 patch 复用 teloa.business-configuration/v1，支持 object-type/view/source-mapping/widget/dashboard；source-mapping 沿用 teloa.business-source-mapping/v1，启用持续运行须本人另行操作；页面为 records/dashboard。字段用 name 标识，enum 声明 values，reference 声明 referenceType；当前版本不支持金额和多选，需要时先经 teloa_business_builder_upgrade 升级这份草案，再用 teloa_business_builder_read 读取新版能力后修订。附件尚不支持。'}
function draftCapabilities(draft:BusinessConfigurationDraft){
 if(draft.candidate.format===businessConfigurationFormat)return capabilities
 return {...capabilities,format:businessConfigurationFormatV2,fieldTypes:[...businessFieldTypes,'money','multi-enum','multi-reference'],richFieldFormat:businessRichFieldFormat,viewFormats:['teloa.business-view/v1',businessViewFormatV2],richViewFieldCapabilities:businessRichViewFieldCapabilities,rules:'保留目录分配的 scope 与 sources；definition.domain 必须等于 scope，object-type.sourceId 必须引用原 local-records 来源。object-type 使用 teloa.business-object-type/v2；富字段使用 teloa.business-rich-field/v2，基础字段沿现有协议。money 声明 currencies（允许的三字母大写币种），multi-enum 声明 values（选项及固定顺序）；每个字段仍含 name/label/from/type/required。金额记录值为规范 JSON 字符串 {"currency":"CNY","decimal":"123.45"}，不转浮点数；多选为按 values 顺序的非空 JSON 数组字符串。金额、多选统计使用 teloa.business-view/v2，引用真实对象字段并按 richViewFieldCapabilities 生成；金额 sum/avg/min/max 的每项 measure 必须显式 currency，不合并或换算不同币种，avg 使用四位小数 half-even。multi-enum 可作为 distribution 维度，单条记录可能包含多个标签，各标签成员数不能相加作为互斥总量；筛选 contains 为一个声明成员、overlaps 为多个声明成员。看板复用 teloa.business-widget/v1 的 view-ref 和 teloa.business-dashboard/v1，v2 看板目前只支持 view-ref，旧 SQL 不支持 rich；保留现有页面和定义，无法支持的旧 SQL 页面应解释限制，不得为绕过校验删除。'+relationRulesV2+'附件尚未支持。草案格式固定，不能用 patch 改为另一格式。'}
}
function read(draft:BusinessConfigurationDraft,input:ReturnType<typeof query>){
 const base={draftId:draft.id,revision:draft.revision,baseVersion:draft.baseVersion,hash:draft.hash,status:draft.status,title:draft.candidate.title,scope:draft.scope,sources:draft.candidate.sources}
 if(input.definition){const ref=input.definition,found=draft.candidate.definitions.find(item=>item.kind===ref.kind&&item.definition.id===ref.localId);if(!found)throw new WorkError('teloa/not-found','草案中不存在该定义。');encoded(found.definition,131072);return encoded({...base,definition:found})}
 if('pageId' in input){const page=draft.candidate.pages.find(item=>item.id===input.pageId);if(!page)throw new WorkError('teloa/not-found','草案中不存在该页面。');return encoded({...base,page})}
 const end=input.cursor+32
 return encoded({...base,capabilities:draftCapabilities(draft),pages:draft.candidate.pages.map(({id,title,kind})=>({id,title,kind})),homePageId:draft.candidate.homePageId,definitions:draft.candidate.definitions.slice(input.cursor,end).map(({kind,definition})=>({kind,localId:definition.id,title:definition.title,version:definition.version})),...(end<draft.candidate.definitions.length?{nextCursor:end}:{})})
}
/** 原生引擎冻结同一个 exec.arguments；WeakMap 只固定审批前身份，不复制执行或审批引擎。 */
export function registerBusinessBuilderTools(ctx:Context,ports:BusinessBuilderToolsPorts){
 const authorized=new WeakMap<ToolExecution,{fingerprint:string;instruction:ConversationInstructionIdentity;upgradeState?:string;reviseRetry?:{format:string;hash:string}}>()
 const authorize=async(exec:Pick<ToolExecution,'agent'|'signal'>)=>{
  const auth=await authorizeOrdinaryConversationMutation({...ports,...(exec.agent?{agent:exec.agent}:{}),signal:exec.signal},'业务搭建')
  if(await ports.isRoleConversation(auth.sessionId)||await ports.isTaskConversation(auth.sessionId))throw new WorkError('teloa/forbidden','员工或任务会话不能修改本人业务草案。')
  const binding=await ports.binding(auth.sessionId)
  if(!binding||binding.kind!=='builder'||binding.sessionId!==auth.sessionId||!binding.draftId)throw new WorkError('teloa/forbidden','当前会话尚未完整绑定业务草案，请先恢复原搭建会话。')
  const draft=await ports.draft(binding.draftId)
  if(draft.ownerId!==ports.owner||draft.id!==binding.draftId||draft.scope!==draft.candidate.scope||binding.scope!==undefined&&binding.scope!==draft.scope)throw new WorkError('teloa/forbidden','草案与当前本人搭建绑定不一致。')
  exec.signal.throwIfAborted()
  return {draft,instruction:readConversationInstructionIdentity(exec.agent!),fingerprint:JSON.stringify([ports.owner,auth.sessionId,binding.requestId,binding.draftId,binding.scope??null,binding.workspaceId??null,binding.title,binding.createdAt,draft.scope,draft.candidate.sources,draft.candidate.format])}
 }
 const definitions:ReadonlyArray<{name:typeof businessBuilderToolNames[number];description:string;parameters:ParameterSchemaSpec}>=[
  {name:businessBuilderToolNames[0],description:'读取当前本人搭建草案与能力规则。{} 或 cursor 按32条读取定义目录；definition:{kind,localId} 读一条定义；pageId 读一页配置，三类互斥。不返回业务记录或凭据。修订或结果未知时先读取当前 revision/hash。',parameters:{cursor:{type:'integer'},definition:{type:'object',additionalProperties:false,properties:{kind:{type:'string',enum:[...businessConfigurationDefinitionKinds],required:true},localId:{type:'string',required:true}}},pageId:{type:'string'}}},
  {name:businessBuilderToolNames[1],description:'经本人一次原生确认，把当前搭建业务整组 patch 保存为草案；不会采用、启用业务或交办。先 read 核对原 scope/sources 与 revision。patch 支持 title/homePageId/upsertDefinitions[{kind,definition}]/removeDefinitions[{kind,localId}]/upsertPages/removePageIds/pageOrder，定义正文沿现有业务定义协议，不能更换业务范围或来源。返回 revision/hash 才表示保存成功；回包未知先 read，不更换指令重复生成。',parameters:{draftId:{type:'string',required:true},expectedRevision:{type:'integer',required:true},patch:{type:'object',required:true,additionalProperties:true}}},
  {name:businessBuilderToolNames[2],description:'经本人一次原生确认，为当前旧版搭建草案增加金额、多选支持。先 read 核对 draftId/revision，再升级，成功后再次 read 读取新版能力再 revise。只升级同一份草案，不改现有记录，不保存或运行业务。不能选择其他范围、会话、身份或目标格式；已经支持时无需升级。回包未知先 read，同原指令与旧 revision 只能核对原请求回执。',parameters:{draftId:{type:'string',required:true},expectedRevision:{type:'integer',required:true}}},
 ] as const
 for(const definition of definitions)ctx.tools.register(defineTool({...definition,output:{schema:{type:'string'} as const,render:(_args:unknown,value:string)=>[{type:'text' as const,text:value}]},execute:async(args,exec)=>{
  try{
   const fixed=authorized.get(exec),current=await authorize(exec)
   if(!fixed||fixed.fingerprint!==current.fingerprint||JSON.stringify(fixed.instruction)!==JSON.stringify(current.instruction))throw new WorkError('teloa/conflict','审批期间本人指令或草案绑定已变化，请重新读取后发起。')
   if(definition.name===businessBuilderToolNames[0])return read(current.draft,query(args))
   if(definition.name===businessBuilderToolNames[2]){
    if(fixed.upgradeState!==upgradeState(current.draft))throw new WorkError('teloa/version-conflict','审批期间业务草案版本已变化，请重新读取后升级。')
    const input=upgradeInput(args,current.draft),result=upgradeReceipt(await ports.upgradeFormat({...input,requestId:upgradeRequestId(ports.owner,fixed.instruction,input.draftId,input.expectedRevision)}),current.draft,input.expectedRevision)
    return encoded({draftId:result.id,revision:result.revision,baseVersion:result.baseVersion,hash:result.hash,title:result.candidate.title,pageCount:result.candidate.pages.length,status:result.status,format:result.candidate.format})
   }
   const format=fixed.reviseRetry?.format??current.draft.candidate.format,input=mutation(args,format)
   if(input.draftId!==current.draft.id)throw new WorkError('teloa/forbidden','不能从当前搭建会话修改另一份草案。')
   const saved=await ports.revise({...input,requestId:requestId(ports.owner,fixed.instruction,input.draftId,input.expectedRevision)}),result=fixed.reviseRetry?mutationReceipt(saved,current.draft,input.expectedRevision,'保存'):saved
   if(result.ownerId!==ports.owner||result.id!==input.draftId||result.scope!==current.draft.scope||result.candidate.format!==format||result.revision!==input.expectedRevision+1||fixed.reviseRetry&&result.hash!==fixed.reviseRetry.hash)throw new WorkError('teloa/invalid-host-response','草案保存回执与原请求不一致。')
   return encoded({draftId:result.id,revision:result.revision,baseVersion:result.baseVersion,hash:result.hash,title:result.candidate.title,pageCount:result.candidate.pages.length,status:result.status})
  }catch(error){if(error instanceof WorkError||exec.signal.aborted)throw error;throw new WorkError('teloa/host-unavailable','草案服务回执暂不可用，请先读取当前草案核对，不要另建或重复发送。')}
 }}))
 const removeGuard=ctx.on('tools/pre-execute',async(exec,next)=>{
  if(!names.has(exec.name))return next()
  let current:Awaited<ReturnType<typeof authorize>>,input:ReturnType<typeof mutation>|undefined,upgrade:ReturnType<typeof upgradeInput>|undefined,reviseRetry:{format:string;hash:string}|undefined
  try{
   current=await authorize(exec)
   if(exec.name===businessBuilderToolNames[0])query(exec.arguments)
   else if(exec.name===businessBuilderToolNames[2])upgrade=upgradeInput(exec.arguments,current.draft)
   else{
    const raw=mutationInput(exec.arguments)
    if(raw.draftId!==current.draft.id)throw new WorkError('teloa/forbidden','当前搭建会话不能修改另一份草案。')
    if(raw.expectedRevision<current.draft.revision){
     const prior=await ports.reviseReceipt({...raw,requestId:requestId(ports.owner,current.instruction,raw.draftId,raw.expectedRevision)})
     exec.signal.throwIfAborted()
     if(prior){const receipt=mutationReceipt(prior,current.draft,raw.expectedRevision,'保存');reviseRetry={format:receipt.candidate.format,hash:receipt.hash}}
    }
    input=mutation(raw,reviseRetry?.format??current.draft.candidate.format)
   }
   authorized.set(exec,{fingerprint:current.fingerprint,instruction:current.instruction,...(upgrade?{upgradeState:upgradeState(current.draft)}:{}),...(reviseRetry?{reviseRetry}:{})})
  }catch(error){return {kind:'deny' as const,reason:error instanceof WorkError?error.message:'无法核对本人业务草案。'}}
  const decision=await next()
  if(decision.kind==='deny'||decision.kind==='cancel')return decision
  if(upgrade)return {kind:'ask' as const,reason:(decision.kind==='ask'&&decision.reason?decision.reason+'\n':'')+'为这份草案增加金额、多选支持；现有记录不会改变，保存业务前仍需预览。确认继续？'}
  if(!input)return decision
  const p=input.patch,summary={title:p.title,homePageId:p.homePageId,upsertDefinitions:p.upsertDefinitions?.map(d=>({kind:d.kind,id:d.definition.id,title:d.definition.title})),removeDefinitions:p.removeDefinitions,upsertPages:p.upsertPages?.map(d=>({id:d.id,title:d.title})),removePageIds:p.removePageIds,pageOrder:p.pageOrder}
  return {kind:'ask' as const,reason:(decision.kind==='ask'&&decision.reason?decision.reason+'\n':'')+'确认修订业务“'+current.draft.candidate.title+'”的整组草案（原版本 '+input.expectedRevision+'）？变更：'+JSON.stringify(summary)+'。只保存草案，需在预览页另行保存业务，不会启动运行。'}
 })
 const removeContext=ctx.on('agent/pre-step',async({agent,signal},next)=>{
  const decision=await next();if(decision.kind==='reject'||!decision.messages.some(message=>message.source.kind==='user'))return decision
  let current:Awaited<ReturnType<typeof authorize>>
  try{current=await authorize({agent,signal})}catch(error){if(error instanceof WorkError&&['teloa/not-bound','teloa/not-found','teloa/forbidden'].includes(error.code))return decision;throw error}
  const notice=createUserMessage({source:{kind:source,form:'notice',summary:'当前业务搭建草案'},content:[{type:'text',text:'当前在搭建业务“'+current.draft.candidate.title+'”。先用 teloa_business_builder_read 核对当前配置与能力；旧版草案需要金额、多选关联或唯一约束时，先经 teloa_business_builder_upgrade 升级，升级后再次用 teloa_business_builder_read 读取新版能力，再经 teloa_business_builder_revise 整组保存草案。v2 的 multi-reference 保存真实目标 ID 的规范数组，constraints.uniqueFields 是逐字段独立唯一；目标标题与状态用记录 list/get 读取，预查不能保证事务唯一。v2 类型化统计须依能力表生成，旧 SQL 不支持富字段；现有看板必须完整保留，不能为绕过限制删页或替换成记录页。不要交办正式工作；自然语言回答不表示保存成功，采用只能由本人在预览页执行。当前草案：'+JSON.stringify({draftId:current.draft.id,revision:current.draft.revision})}]})
  return {...decision,messages:[...decision.messages,notice]}
 })
 return ()=>{removeGuard();removeContext()}
}
