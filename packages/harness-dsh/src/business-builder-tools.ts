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
function mutationInput(value:unknown){
 const row=taskInput(value,['draftId','expectedRevision','patch','patchJson'])
 if(typeof row.draftId!=='string'||!uuid.test(row.draftId)||!Number.isSafeInteger(row.expectedRevision)||Number(row.expectedRevision)<1)throw invalid()
 if(Object.hasOwn(row,'patch')===Object.hasOwn(row,'patchJson'))throw new WorkError('teloa/invalid-input','patchJson 与旧 patch 必须恰好提供一项，请按 read 中的 patchProtocol 生成。')
 let patch:unknown=row.patch
 if(Object.hasOwn(row,'patchJson')){
  if(typeof row.patchJson!=='string')throw invalid()
  if(Buffer.byteLength(row.patchJson,'utf8')>businessConfigurationLimits.canonicalBytes)throw new WorkError('teloa/invalid-input','patchJson 超过 UTF-8 大小上限，请减少本次整组修改。')
  try{patch=JSON.parse(row.patchJson)}catch{throw new WorkError('teloa/invalid-input','patchJson 必须是完整有效的 JSON 对象字符串；不能使用 Markdown 围栏、注释或截断内容。')}
 }
 if(!patch||typeof patch!=='object'||Array.isArray(patch))throw invalid()
 for(const key of ['upsertDefinitions','removeDefinitions','upsertPages','removePageIds','pageOrder']){
  if(Object.hasOwn(patch,key)&&!Array.isArray(Reflect.get(patch,key)))throw new WorkError('teloa/invalid-input',key+' 必须是 JSON 数组，不能使用 item 包装；请按 read 中的 patchProtocol 重新生成。')
 }
 return {draftId:row.draftId,expectedRevision:row.expectedRevision as number,patch}
}
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
const capabilities={objectResultProtocol:{tool:'teloa_business_object_result_record',sourceKind:'role-result',identityPath:'$.object.id',resultPathPrefix:'$.result.',rules:'成果使用独立对象类型，以宿主提供的 object.id 为唯一主键；员工只能在已关联业务对象的当前任务轮次、已授权工具及映射中回写，一轮每映射一份最终成果；看板统计成果对象，自动更新须本人启用。'},format:businessConfigurationFormat,definitionKinds:businessConfigurationDefinitionKinds,fieldTypes:businessFieldTypes,fieldCapabilities:businessFieldCapabilities,viewKinds:businessViewKinds,aggregations:businessAggregations,timeBuckets:businessTimeBuckets,chartTypes:businessChartTypes,filterOperators:businessFilterOperators,viewWindows:businessViewWindows,viewCharts:businessViewCharts,limits:{...businessConfigurationLimits,...businessLedgerLimits,definitionBytes:131072,responseBytes:262144,directoryPage:32},rules:'保留目录分配的 scope 与 sources；definition.domain 必须等于 scope，object-type.sourceId 必须引用原 local-records 来源。'+referenceRules+'整组 patch 复用 teloa.business-configuration/v1，支持 object-type/view/source-mapping/widget/dashboard；source-mapping 沿用 teloa.business-source-mapping/v1，启用持续运行须本人另行操作；页面为 records/dashboard。字段用 name 标识，enum 声明 values，reference 声明 referenceType；当前版本不支持金额和多选，需要时先经 teloa_business_builder_upgrade 升级这份草案，再用 teloa_business_builder_read 读取新版能力后修订。附件尚不支持。'}
/** 形状示例必须由当前版本的同一契约读取器校验；仅说明格式，不生成业务数据或扩大能力。 */
function patchProtocol(draft:BusinessConfigurationDraft){
 const sourceId=draft.candidate.sources[0]?.sourceId
 if(!sourceId)throw new WorkError('teloa/invalid-host-response','业务草案缺少真实记录来源，请恢复原草案。')
 const used=new Set([...draft.candidate.definitions.map(item=>item.definition.id),...draft.candidate.pages.map(item=>item.id)])
 const fresh=(base:string)=>{let id=base,index=1;while(used.has(id))id=base+'-'+ ++index;used.add(id);return id}
 const head={version:'1.0.0',domain:draft.scope},objectType=fresh('example-record'),viewId=fresh('example-status'),widgetId=fresh('example-widget'),dashboardId=fresh('example-dashboard'),homePageId=fresh('example-home'),recordsPageId=fresh('example-records')
 const capacity={definitionsRemaining:businessConfigurationLimits.definitions-draft.candidate.definitions.length,pagesRemaining:businessConfigurationLimits.pages-draft.candidate.pages.length}
 const canAdd=capacity.definitionsRemaining>=4&&capacity.pagesRemaining>=2
 const existingPage=draft.candidate.pages[0]
 const patch=readBusinessConfigurationPatchVersioned(canAdd?{
  upsertDefinitions:[
   {kind:'object-type',definition:{...head,format:draft.candidate.format===businessConfigurationFormat?'teloa.business-object-type/v1':'teloa.business-object-type/v2',id:objectType,title:'记录',unit:'条',lead:'记录业务对象，并按状态展示数量。',sourceId,fields:[
    {name:'name',label:'名称',from:'名称',type:'text',required:true},
    {name:'date',label:'日期',from:'日期',type:'datetime',required:false},
    {name:'owner',label:'负责人',from:'负责人',type:'text',required:false},
    {name:'status',label:'状态',from:'状态',type:'enum',required:true,values:['待处理','进行中','完成']},
   ]}},
   {kind:'view',definition:{...head,format:'teloa.business-view/v1',id:viewId,title:'各状态数量',kind:'distribution',chart:'pie',objectType,dimension:{field:'status',limit:3},measures:[{id:'count',label:'数量',aggregation:'count'}],filters:[],sort:{by:'dimension',direction:'asc'},limit:3}},
   {kind:'widget',definition:{...head,format:'teloa.business-widget/v1',id:widgetId,title:'各状态数量',kind:'view-ref',viewRef:viewId}},
   {kind:'dashboard',definition:{...head,format:'teloa.business-dashboard/v1',id:dashboardId,title:'首页',widgets:[widgetId],layout:[{widget:widgetId,x:0,y:0,w:12,h:2}],refresh:{kind:'every',seconds:3600},acknowledgeShortInterval:false}},
  ],
  upsertPages:[{id:homePageId,title:'首页',kind:'dashboard',dashboardId},{id:recordsPageId,title:'记录',kind:'records',objectType,fields:['name','date','owner','status'],allowCreate:true,allowEdit:true,allowArchive:true}],homePageId,pageOrder:[...draft.candidate.pages.map(item=>item.id),homePageId,recordsPageId],
 }:existingPage?{upsertPages:[existingPage]}:{title:draft.candidate.title},draft.candidate.format)
 return {input:'patchJson',legacyInput:'patch',exactlyOne:true,maxUtf8Bytes:businessConfigurationLimits.canonicalBytes,exampleOnly:true,exampleMode:canAdd?'add-complete':'modify-existing',capacity,exampleJson:JSON.stringify(patch),rules:(canAdd?'当前容量允许完整新增形状示例；按目标调整内容，使用新标识以免覆盖原定义。':'当前剩余容量不足完整新增示例，只展示现有页面或标题的合法修改形状；没有新增或移除定义、页面，不改原页面顺序。')+'示例未保存或执行，须保留已有页面及配置。patchJson 是 JSON.stringify(patch) 得到的一个字符串，不是嵌套对象或 Markdown。数组使用 []，布尔为 true/false；字段标签为 label，from 必填；lead 是说明字符串，sourceId 与它同级；定义 version 使用三段字符串如 1.0.0；对象、页面与定义 id 使用字母数字和连字符，字段 name 可用下划线。baseVersion=0 是新业务草案，可以新增定义和页面；数量上限包括现有配置，不通过升级绕过容量或输入格式错误。'}
}
function draftCapabilities(draft:BusinessConfigurationDraft){
 if(draft.candidate.format===businessConfigurationFormat)return capabilities
 return {...capabilities,format:businessConfigurationFormatV2,fieldTypes:[...businessFieldTypes,'money','multi-enum','multi-reference'],richFieldFormat:businessRichFieldFormat,viewFormats:['teloa.business-view/v1',businessViewFormatV2],richViewFieldCapabilities:businessRichViewFieldCapabilities,rules:'保留目录分配的 scope 与 sources；definition.domain 必须等于 scope，object-type.sourceId 必须引用原 local-records 来源。object-type 使用 teloa.business-object-type/v2；富字段使用 teloa.business-rich-field/v2，基础字段沿现有协议。money 声明 currencies（允许的三字母大写币种），multi-enum 声明 values（选项及固定顺序）；每个字段仍含 name/label/from/type/required。金额记录值为规范 JSON 字符串 {"currency":"CNY","decimal":"123.45"}，不转浮点数；多选为按 values 顺序的非空 JSON 数组字符串。金额、多选统计使用 teloa.business-view/v2，引用真实对象字段并按 richViewFieldCapabilities 生成；金额 sum/avg/min/max 的每项 measure 必须显式 currency，不合并或换算不同币种，avg 使用四位小数 half-even。multi-enum 可作为 distribution 维度，单条记录可能包含多个标签，各标签成员数不能相加作为互斥总量；筛选 contains 为一个声明成员、overlaps 为多个声明成员。看板复用 teloa.business-widget/v1 的 view-ref 和 teloa.business-dashboard/v1，v2 看板目前只支持 view-ref，旧 SQL 不支持 rich；保留现有页面和定义，无法支持的旧 SQL 页面应解释限制，不得为绕过校验删除。'+relationRulesV2+'附件尚未支持。草案格式固定，不能用 patch 改为另一格式。'}
}
function read(draft:BusinessConfigurationDraft,input:ReturnType<typeof query>){
 const base={draftId:draft.id,revision:draft.revision,baseVersion:draft.baseVersion,hash:draft.hash,status:draft.status,title:draft.candidate.title,scope:draft.scope,sources:draft.candidate.sources}
 if(input.definition){const ref=input.definition,found=draft.candidate.definitions.find(item=>item.kind===ref.kind&&item.definition.id===ref.localId);if(!found)throw new WorkError('teloa/not-found','草案中不存在该定义。');encoded(found.definition,131072);return encoded({...base,definition:found})}
 if('pageId' in input){const page=draft.candidate.pages.find(item=>item.id===input.pageId);if(!page)throw new WorkError('teloa/not-found','草案中不存在该页面。');return encoded({...base,page})}
 const end=input.cursor+32
 return encoded({...base,capabilities:{...draftCapabilities(draft),patchProtocol:patchProtocol(draft)},pages:draft.candidate.pages.map(({id,title,kind})=>({id,title,kind})),homePageId:draft.candidate.homePageId,definitions:draft.candidate.definitions.slice(input.cursor,end).map(({kind,definition})=>({kind,localId:definition.id,title:definition.title,version:definition.version})),...(end<draft.candidate.definitions.length?{nextCursor:end}:{})})
}
/** 原生引擎冻结同一个 exec.arguments；WeakMap 只固定审批前身份，不复制执行或审批引擎。 */
export function registerBusinessBuilderTools(ctx:Context,ports:BusinessBuilderToolsPorts){
 const authorized=new WeakMap<ToolExecution,{fingerprint:string;instruction:ConversationInstructionIdentity;upgradeState?:string;reviseRetry?:{format:string;hash:string}}>()
 // pre-step在本人消息落盘前读取真实绑定；只读上下文不能要求尚未提交的指令身份。
 const authorizeContext=async(exec:Pick<ToolExecution,'agent'|'signal'>)=>{
  const auth=await authorizeOrdinaryConversationMutation({...ports,...(exec.agent?{agent:exec.agent}:{}),signal:exec.signal},'业务搭建')
  if(await ports.isRoleConversation(auth.sessionId)||await ports.isTaskConversation(auth.sessionId))throw new WorkError('teloa/forbidden','员工或任务会话不能修改本人业务草案。')
  const binding=await ports.binding(auth.sessionId)
  if(!binding)throw new WorkError('teloa/forbidden','当前是普通会话，没有业务搭建草案。请在“业务”页点击“新建业务”，进入搭建会话后继续描述目标；已有草案请打开原搭建会话。不要猜业务范围或草案格式，也不要改用 teloa_create_draft 创建同名业务。')
  if(binding.kind!=='builder'||binding.sessionId!==auth.sessionId||!binding.draftId)throw new WorkError('teloa/forbidden','当前会话尚未完整绑定业务草案，请先恢复原搭建会话。')
  const draft=await ports.draft(binding.draftId)
  if(draft.ownerId!==ports.owner||draft.id!==binding.draftId||draft.scope!==draft.candidate.scope||binding.scope!==undefined&&binding.scope!==draft.scope)throw new WorkError('teloa/forbidden','草案与当前本人搭建绑定不一致。')
  exec.signal.throwIfAborted()
  return {draft,fingerprint:JSON.stringify([ports.owner,auth.sessionId,binding.requestId,binding.draftId,binding.scope??null,binding.workspaceId??null,binding.title,binding.createdAt,draft.scope,draft.candidate.sources,draft.candidate.format])}
 }
 const authorize=async(exec:Pick<ToolExecution,'agent'|'signal'>)=>({...await authorizeContext(exec),instruction:readConversationInstructionIdentity(exec.agent!)})
 const definitions:ReadonlyArray<{name:typeof businessBuilderToolNames[number];description:string;parameters:ParameterSchemaSpec}>=[
  {name:businessBuilderToolNames[0],description:'仅在已绑定的本人业务搭建会话读取当前草案与能力规则。普通会话没有搭建草案时，请引导本人在“业务”页点击“新建业务”，进入搭建会话继续描述；已有草案则打开原搭建会话，不猜范围或草案格式，不以 teloa_create_draft 替代。{} 或 cursor 按32条读取定义目录；definition:{kind,localId} 读一条定义；pageId 读一页配置，三类互斥。不返回业务记录或凭据。修订或结果未知时先读取当前 revision/hash。',parameters:{cursor:{type:'integer'},definition:{type:'object',additionalProperties:false,properties:{kind:{type:'string',enum:[...businessConfigurationDefinitionKinds],required:true},localId:{type:'string',required:true}}},pageId:{type:'string'}}},
  {name:businessBuilderToolNames[1],description:'经本人一次原生确认，整组修订当前业务草案；不采用、启用或交办。先 read 核对原 scope/sources/revision 与 capabilities.patchProtocol 合法完整示例。优先 patchJson：JSON.stringify(patch) 生成的字符串；与旧对象 patch 恰一，不用 item 包装、不猜字段、不转换布尔字符串。整组支持 title/homePageId/upsertDefinitions/removeDefinitions/upsertPages/removePageIds/pageOrder，不能更换范围或来源。返回 revision/hash 才是保存成功；未知先 read，沿原指令回执核对。',parameters:{draftId:{type:'string',required:true},expectedRevision:{type:'integer',required:true},patchJson:{type:'string',description:'完整 JSON 对象的字符串，UTF-8 不超过 2097152 字节；按 read 的 patchProtocol.exampleJson 构造实际 patch，保留原范围/来源和已有配置。与 patch 恰一。'},patch:{type:'object',additionalProperties:true,description:'兼容旧调用的对象 patch；不能与 patchJson 同时提供，数组/布尔必须是原生 JSON 类型。'}}},
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
  let current:Awaited<ReturnType<typeof authorizeContext>>
  try{current=await authorizeContext({agent,signal})}catch(error){if(error instanceof WorkError&&['teloa/not-bound','teloa/not-found','teloa/forbidden'].includes(error.code))return decision;throw error}
  const notice=createUserMessage({source:{kind:source,form:'notice',summary:'当前业务搭建草案'},content:[{type:'text',text:'当前是本人已绑定的业务搭建会话，正在搭建业务“'+current.draft.candidate.title+'”。宿主已生成草案及业务标识，用户只需中文描述目标和字段；不要要求用户填写或选择范围键、UUID、版本或来源ID，也不要另建业务。capabilities中的general与draft-only仅描述会话许可和保存状态，不改变当前搭建身份。先用 teloa_business_builder_read 取得当前草案的scope、sources、revision、能力及patchProtocol合法示例，沿用它们，再用 teloa_business_builder_revise 的patchJson字符串整组保存可预览草案；此处不使用业务definitions独立草案或teloa_create_draft替代原草案。旧版需要金额、多选关联或唯一约束时先用 teloa_business_builder_upgrade 升级，升级后再次用 teloa_business_builder_read 读取新版能力，再 revise。v2的multi-reference保存真实目标ID数组，uniqueFields逐字段独立唯一；目标标题与状态从记录list/get读取，预查不能保证事务唯一。v2 类型化统计须依能力表生成，旧 SQL 不支持富字段；现有看板必须完整保留，不删页绕限制。保存草案不采用、启用或交办；自然语言回答不等于已保存，采用仍由本人在预览页执行。最终只展示业务名称、可理解状态和下一步，技术身份仅供工具内部。当前草案：'+JSON.stringify({draftId:current.draft.id,revision:current.draft.revision})}]})
  return {...decision,messages:[...decision.messages,notice]}
 })
 return ()=>{removeGuard();removeContext()}
}
