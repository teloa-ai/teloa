import {createHash} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import {defineTool,type PreToolDecision,type ParameterSchemaSpec} from '@deepseek-ai/dsh-tools'
import {WorkError,isRecord,taskInput,readPageCreateAtomicSkillDraft,readMarketPluginRegistrySource,readMarketPluginInstallPreview,pageCreateCanonicalBody,pageCreateLimits,type PageCreateDraft,type PageCreateDraftPreview} from '@teloa/contract'
import type {PageCreateDraftService,PageCreatePreviewService} from '@teloa/backend'
import {authorizeConversationInstructionMutation,conversationInstructionMutationRequestId,assertConversationInstructionMutationAuthorization,type ConversationInstructionMutationAuthorization,type ConversationMutationInput} from './conversation-mutation.ts'
import {readCustomMcpDefinition,customMcpDefinitionHash} from './custom-mcp-definition.ts'

export const capabilityDraftToolNames=['teloa_create_preview','teloa_create_apply'] as const
export type SkillInitialAvailability='enabled'|'disabled'
export type CapabilityDraftApplyInput={draftId:string;expectedBodyHash:string;initialAvailability?:SkillInitialAvailability}
/** 技能回执的 availability 读自真实启停记录，模型据此回报是否已启用。 */
export type CapabilityDraftResult={schema:'teloa.capability-draft-result/v1';draft:PageCreateDraft;appliedRef:string;readiness:string;next:string;availability?:SkillInitialAvailability}
export type CapabilityDraftToolsPorts=Pick<ConversationMutationInput,'owner'|'conversation'|'readTaskPolicy'>&{
 preview:(input:{draftId:string},signal?:AbortSignal)=>Promise<PageCreateDraftPreview>
 apply:(input:CapabilityDraftApplyInput,signal?:AbortSignal)=>Promise<CapabilityDraftResult>
}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const invalid=(message:string)=>new WorkError('teloa/invalid-input',message)
const bad=()=>new WorkError('teloa/invalid-host-response','能力应用服务返回了不一致的身份或状态。')
function input(value:unknown,apply:boolean):{draftId:string;expectedBodyHash?:string;initialAvailability?:SkillInitialAvailability}{
 const row=taskInput(value,apply?['draftId','expectedBodyHash','initialAvailability']:['draftId'])
 if(!uuid(row.draftId)||apply&&!hash(row.expectedBodyHash))throw invalid('新建草案身份或摘要格式不正确。')
 if(row.initialAvailability!==undefined&&row.initialAvailability!=='enabled'&&row.initialAvailability!=='disabled')throw invalid('技能初始启停只能是 enabled 或 disabled。')
 return {draftId:row.draftId.toLowerCase(),...(apply?{expectedBodyHash:row.expectedBodyHash as string}:{}),...(row.initialAvailability===undefined?{}:{initialAvailability:row.initialAvailability})}
}

/** 仅接受草案身份与摘要，不允许模型选择 RPC、文件目录、安装命令或本人身份。 */
export function registerCapabilityDraftTools(ctx:Context,ports:CapabilityDraftToolsPorts){
 const checked=new WeakMap<object,ConversationInstructionMutationAuthorization>()
 const authorize=(exec:Parameters<typeof ctx.tools.execute>[0])=>authorizeConversationInstructionMutation({...ports,...(exec.agent?{agent:exec.agent}:{}),signal:exec.signal})
 const definitions=[
  {name:'teloa_create_preview' as const,description:'在当前对话预览本人已保存的技能、连接器、计划或官方扩展草案，返回要创建的内容、影响和下一步；无需打开管理页面。计划只读预览后由本人打开原稿确认，本工具的 apply 不处理计划。新建草案由 teloa_create_draft 或 teloa_method_reuse 返回身份；查本人以前保存的原稿先调用 teloa_create_drafts 按名称找到固定身份，再核对预览。预览不会安装、运行、授权或启用任何能力。员工创建和修改使用 teloa_employees_* 工具，业务配置使用原会话业务搭建工具，本入口不处理这两类草案。',parameters:{draftId:{type:'string',required:true}}},
  {name:'teloa_create_apply' as const,description:'按用户指令在当前对话应用已经预览的技能、连接器或官方扩展草案。必须带本次预览的 bodyHash；实际创建和安装复用现有处理服务与原生权限审核。不会执行技能附件、自动填写密钥、完成 OAuth、启用扩展或启动外部 MCP 进程。连接草案保存后可能仍需本人安全连接流程，以回执 readiness 和 next 为准。相同已应用草案可安全重试。技能草案可传 initialAvailability：本人要求只安装、暂不启用时传 disabled，技能从安装起就不可被模型或本人加载；缺省为 enabled。已应用或复用已有安装时不改动原启停，回执 availability 是真实启停值，必须按它回报是否已启用。员工使用 teloa_employees_*，业务使用原会话业务搭建工具。',parameters:{draftId:{type:'string',required:true},expectedBodyHash:{type:'string',required:true},initialAvailability:{type:'string',enum:['enabled','disabled']}}},
 ] as const
 for(const definition of definitions)ctx.tools.register(defineTool({...definition,output:{schema:{type:'string'} as const,render:(_args:unknown,value:string)=>[{type:'text' as const,text:value}]},execute:async(args,exec)=>{
  assertConversationInstructionMutationAuthorization(checked.get(exec),await authorize(exec))
  const row=input(args,definition.name==='teloa_create_apply')
  return JSON.stringify(definition.name==='teloa_create_preview'?await ports.preview({draftId:row.draftId},exec.signal):await ports.apply(row as CapabilityDraftApplyInput,exec.signal))
 }}))
 return ctx.on('tools/pre-execute',async(exec,next):Promise<PreToolDecision>=>{
  if(!(capabilityDraftToolNames as readonly string[]).includes(exec.name))return next()
  try{const authorization=await authorize(exec);input(exec.arguments,exec.name==='teloa_create_apply');checked.set(exec,authorization)}catch(error){return {kind:'deny',reason:error instanceof Error?error.message:'无法核对能力草案身份。'}}
  // 允许、询问和自动审核均由原生权限模式决定，不附加一层无差别确认。
  return next()
 },{prepend:true})
}

type Handler=(endpoint:string,payload:unknown,signal?:AbortSignal)=>Promise<unknown>
export type CapabilityDraftApplicationPorts={
 owner:string;scopeIds:()=>Promise<readonly string[]>
 services:()=>Promise<{drafts:Pick<PageCreateDraftService,'read'|'apply'>;preview:Pick<PageCreatePreviewService,'preview'>}>
 verifySource?:(draft:PageCreateDraft,signal?:AbortSignal)=>Promise<void>
 marketContentHandler:Handler;skillInstallationsHandler:Handler;skillAvailabilityHandler:Handler;businessSpaceHandler:Handler;industryLoadsHandler:Handler
 industryMcpConnectionHandler:Handler;industryDataSourceHandler:Handler;marketPluginInstallationHandler:Handler
}
/** 同一草案每个阶段身份固定；落定前断线重试也复用原安装/加载回执。 */
export function capabilityDraftRequestId(draft:Pick<PageCreateDraft,'id'|'bodyHash'>,phase:string):string{
 const digest=createHash('sha256').update(['teloa-capability-draft/v1',draft.id,draft.bodyHash,phase].join('\0')).digest('hex')
 return `${digest.slice(0,8)}-${digest.slice(8,12)}-5${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`
}
const record=(value:unknown):Record<string,unknown>=>{if(!isRecord(value))throw bad();return value}
function contentReceipt(value:unknown,owner:string){
 const row=record(value),content=record(row.content)
 if(!uuid(content.id)||content.ownerId!==owner||!hash(content.hash))throw bad()
 return {id:content.id,hash:content.hash}
}
const encoded=(path:string,value:unknown)=>({path,base64:Buffer.from(pageCreateCanonicalBody(value)).toString('base64')})

/** 草案身份和摘要仍取固定正文；仅把明确的文本文件投影成可逐字核对的预览字段。 */
function readableSkillPreview(preview:PageCreateDraftPreview):PageCreateDraftPreview{
 const body=readPageCreateAtomicSkillDraft(JSON.parse(preview.draft.body))
 pageCreateCanonicalBody(body)
 const readable=new Map<string,{path:string;value:string}>()
 body.files.forEach((file,index)=>{
  if(!/\.(?:md|txt|json|ya?ml|csv|tsv)$/i.test(file.path))return
  let content:string
  try{content=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.from(file.base64,'base64'))}catch{return}
  if(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content))return
  const value=JSON.stringify(content)
  if(Buffer.byteLength(value,'utf8')>pageCreateLimits.bodyBytes)return
  readable.set(`files[${index}].base64`,{path:`files[${index}].content`,value})
 })
 return {...preview,fields:preview.fields.map(field=>readable.get(field.path)??field)}
}

/** 固定实体聚合器：每一支只有对应的既有写处理器，没有模型可控制的通用 RPC 路径。 */
export function createCapabilityDraftApplication(ports:CapabilityDraftApplicationPorts){
 const actor=async()=>({ownerId:ports.owner,scopeIds:[...await ports.scopeIds()].filter(scope=>scope!=='general')})
 const supported=(draft:PageCreateDraft)=>{
  if(draft.entity!=='skill'&&draft.entity!=='connector'&&draft.entity!=='extension')throw invalid('此应用入口只处理技能、连接器和官方扩展草案。')
 }
 const receipt=async(draft:PageCreateDraft,signal?:AbortSignal,requested?:SkillInitialAvailability):Promise<CapabilityDraftResult>=>{
  supported(draft)
  if(draft.status!=='applied'||!draft.appliedRef)throw bad()
  let readiness:string,next:string,availability:SkillInitialAvailability|undefined
  if(draft.entity==='skill'){
   // 兼容页面已有的 contentId 回执；会话安装回执显式标明 installation 身份。
   if(!draft.appliedRef.startsWith('skill:')){readiness='saved';next='可在本会话继续使用技能安装工具核对并安装。'}
   else{
    const installationId=draft.appliedRef.slice(6),installed=record(await ports.skillInstallationsHandler('skill-installations/get',{installationId},signal))
    if(installed.ownerId!==ports.owner||installed.id!==installationId)throw bad()
    const observed=record(await ports.skillInstallationsHandler('skill-installations/observe',{installationId},signal))
    if(observed.installationId!==installationId||typeof observed.state!=='string')throw bad()
    const state=record(await ports.skillAvailabilityHandler('skill-availability/get',{installationId},signal))
    if(state.installationId!==installationId||state.availability!=='enabled'&&state.availability!=='disabled')throw bad()
    availability=state.availability
    if(availability==='disabled'){readiness='installed-disabled';next='技能已安装但未启用：模型与本人都不能加载；需要时由本人通过技能启停明确启用。'}
    else{readiness=observed.state==='available'?'installed':observed.state;next=observed.state==='available'?'技能已安装并启用，已进入默认工作区；可在本会话按需加载。':'技能文件已安装并启用；请按观测状态检查同名来源或文件。'}
    if(requested&&requested!==availability)next+=` 本次请求的初始启停为 ${requested}，实际为 ${availability}：草案已按原请求应用或复用了已有安装，未改动其启停。`
   }
  }else if(draft.entity==='connector'){
   const [loadId,itemInstanceId]=draft.appliedRef.split(':')
   if(!uuid(loadId)||!uuid(itemInstanceId))throw bad()
   const load=record(await ports.industryLoadsHandler('industry-loads/get',{loadId},signal))
   if(load.ownerId!==ports.owner||load.id!==loadId||!Array.isArray(load.items))throw bad()
   const item=load.items.map(record).find(item=>item.instanceId===itemInstanceId)
   if(!item||item.kind!=='mcp'&&item.kind!=='data-source')throw bad()
   // 实例化仅登记待连接定义；不伪造健康探测，也不读取凭据。
   readiness=item.status==='active'?'configured':'needs_connection'
   next='连接定义已保存；连接与本人认证须通过现有安全连接入口完成，尚未验证连接健康。'
  }else{
   const installed=record(await ports.marketPluginInstallationHandler('market-plugins/get',{installationId:draft.appliedRef},signal))
   if(installed.ownerId!==ports.owner||installed.id!==draft.appliedRef||typeof installed.state!=='string')throw bad()
   readiness=installed.state
   next=installed.state==='installed-active'?'扩展已可用。':installed.state==='installed-restart-required'?'扩展已安装，等待本人正常重启应用。':'扩展已安装；启用仍需本人单独授权。'
  }
  return {schema:'teloa.capability-draft-result/v1',draft,appliedRef:draft.appliedRef,readiness,next,...(availability?{availability}:{})}
 }
 const write=async(draft:PageCreateDraft,signal?:AbortSignal,initialAvailability?:SkillInitialAvailability):Promise<string>=>{
  supported(draft);signal?.throwIfAborted()
  await ports.verifySource?.(draft,signal);signal?.throwIfAborted()
  if(draft.entity==='skill'){
   const {files,...metadata}=readPageCreateAtomicSkillDraft(JSON.parse(draft.body))
   const content=contentReceipt(await ports.marketContentHandler('market-content/import',{kind:'atomic-skill',requestId:capabilityDraftRequestId(draft,'import'),source:{kind:'upload',name:'会话创建技能'},metadata,files},signal),ports.owner)
   const source={kind:'atomic',contentId:content.id}
   const preview=record(await ports.skillInstallationsHandler('skill-installations/preview',{source},signal))
   if(!hash(preview.bundleHash)||preview.trustHash!==undefined&&!hash(preview.trustHash))throw bad()
   // 安装预览可能等待文件或原生服务；写入前再次核对方法来源，不能沿用等待前的认可。
   await ports.verifySource?.(draft,signal);signal?.throwIfAborted()
   const result=record(await ports.skillInstallationsHandler('skill-installations/install',{requestId:capabilityDraftRequestId(draft,'install'),source,expectedBundleHash:preview.bundleHash,...(preview.trustHash===undefined?{}:{expectedTrustHash:preview.trustHash}),...(initialAvailability===undefined?{}:{initialAvailability})},signal)),installation=record(result.installation)
   if(!uuid(installation.id)||installation.ownerId!==ports.owner||installation.state!=='installed'||installation.bundleHash!==preview.bundleHash)throw bad()
   return 'skill:'+installation.id
  }
  if(draft.entity==='extension'){
   const source=readMarketPluginRegistrySource(JSON.parse(draft.body))
   const preview=readMarketPluginInstallPreview(await ports.marketPluginInstallationHandler('market-plugins/preview',{source},signal))
   await ports.verifySource?.(draft,signal);signal?.throwIfAborted()
   const installed=record(await ports.marketPluginInstallationHandler('market-plugins/install',{schema:'teloa.market-plugin-install-spec/v1',requestId:capabilityDraftRequestId(draft,'install'),preview},signal))
   if(!uuid(installed.id)||installed.ownerId!==ports.owner||!['installed-pending-enable','installed-active','installed-restart-required'].includes(String(installed.state)))throw new WorkError('teloa/dependency-unavailable','扩展安装尚未成功，草案保留以供核对和重试。')
   return installed.id
  }
  const body=record(JSON.parse(draft.body)),manifest=record(body.manifest),resource=record(body.resource)
  const kind=resource.format==='teloa.mcp-connection/v1'?'mcp':resource.format==='teloa.data-source/v1'?'data-source':undefined
  const localId=kind==='mcp'?resource.serverName:resource.sourceId
  if(!kind||manifest.scope!==draft.scope||!Array.isArray(manifest.resources)||manifest.resources.length!==1)throw invalid('连接草案只能声明当前业务范围的一项包内连接。')
  const declared=record(manifest.resources[0]),source=record(declared.source)
  if(declared.id!==localId||declared.kind!==kind||source.kind!=='local'||typeof source.path!=='string'||source.path==='teloa.json')throw invalid('连接草案的资源声明与固定定义不一致。')
  if(kind==='data-source'&&(!Array.isArray(resource.scopes)||resource.scopes.length!==1||resource.scopes[0]!==draft.scope))throw invalid('连接数据源范围必须与当前业务空间一致。')
  const content=contentReceipt(await ports.marketContentHandler('market-content/import',{kind:'industry-template',requestId:capabilityDraftRequestId(draft,'import'),source:{kind:'upload',name:'会话创建连接'},manifestPath:'teloa.json',files:[encoded('teloa.json',manifest),encoded(source.path,resource)],references:[]},signal),ports.owner)
  const space=record(await ports.businessSpaceHandler('business-spaces/current',{},signal))
  if(!uuid(space.id)||!Number.isSafeInteger(space.version)||Number(space.version)<1)throw bad()
  // 加载会增加空间版本；断线重试先复用同一固定内容的活跃加载，不把变化后的空间版本塞回原请求。
  const directory=record(await ports.industryLoadsHandler('industry-loads/list',{},signal))
  if(!Array.isArray(directory.items))throw bad()
  const existing=directory.items.map(record).find(load=>load.ownerId===ports.owner&&load.contentId===content.id&&load.contentHash===content.hash&&load.status==='active'&&record(load.space).id===space.id)
  const load=existing??record(await ports.industryLoadsHandler('industry-loads/create',{requestId:capabilityDraftRequestId(draft,'load'),contentId:content.id,contentHash:content.hash,target:{kind:'existing',spaceId:space.id,expectedVersion:space.version}},signal))
  if(load.ownerId!==ports.owner||!uuid(load.id)||!Array.isArray(load.items))throw bad()
  const item=load.items.map(record).find(item=>item.localId===localId&&item.kind===kind)
  if(!item||!uuid(item.instanceId))throw bad()
  const handler=kind==='mcp'?ports.industryMcpConnectionHandler:ports.industryDataSourceHandler
  const endpoint=kind==='mcp'?'industry-mcp-connections/instantiate':'industry-data-sources/instantiate'
  const instance=record(await handler(endpoint,{requestId:capabilityDraftRequestId(draft,'instantiate'),loadId:load.id,itemInstanceId:item.instanceId},signal))
  if(instance.ownerId!==ports.owner||instance.loadId!==load.id||instance.itemInstanceId!==item.instanceId)throw bad()
  return load.id+':'+item.instanceId
 }
 return {
  preview:async(value:{draftId:string},signal?:AbortSignal):Promise<PageCreateDraftPreview>=>{
   const currentActor=await actor(),service=await ports.services(),draft=await service.drafts.read(currentActor,value,signal)
   if(draft.entity!=='share'&&draft.entity!=='plan')supported(draft)
   const preview=await service.preview.preview(currentActor,value,signal)
   if(draft.entity==='share'||draft.entity==='plan')return preview
   // 页面旧流程只保存市场条目；对话应用的真实落点与后果在这里明确，不把安装说成目录保存。
   if(draft.entity==='skill')return {...readableSkillPreview(preview),consequences:[{kind:'impact',id:'skill-managed-file-install',required:true}],next:{endpoint:'skill-installations/install',consentKeys:[]}}
   if(draft.entity==='extension')return {...preview,next:{endpoint:'market-plugins/install',consentKeys:preview.next.consentKeys}}
   const resource=record(record(JSON.parse(draft.body)).resource)
   return {...preview,consequences:[{kind:'impact',id:'connector-definition-registration',required:true},{kind:'credential',id:'authentication-if-required',required:false},{kind:'egress',id:'after-explicit-connect',required:false}],next:{endpoint:resource.format==='teloa.mcp-connection/v1'?'industry-mcp-connections/instantiate':'industry-data-sources/instantiate',consentKeys:[]}}
  },
  apply:async(value:CapabilityDraftApplyInput,signal?:AbortSignal):Promise<CapabilityDraftResult>=>{
   const currentActor=await actor(),service=await ports.services(),{initialAvailability,...fixed}=value
   if(initialAvailability!==undefined&&(await service.drafts.read(currentActor,{draftId:fixed.draftId},signal)).entity!=='skill')throw invalid('只有技能草案可以指定初始启停；扩展启用仍需本人单独授权。')
   const draft=await service.drafts.apply(currentActor,fixed,draft=>write(draft,signal,initialAvailability),signal)
   return receipt(draft,signal,initialAvailability)
  },
 }
}

export const customMcpToolNames=['teloa_mcp_preview','teloa_mcp_save','teloa_mcp_connection_connect','teloa_mcp_list','teloa_mcp_get','teloa_mcp_disconnect','teloa_mcp_update'] as const
export type CustomMcpToolsPorts=Pick<ConversationMutationInput,'owner'|'conversation'|'readTaskPolicy'>&{handler:Handler}
/** 自定义 HTTP MCP 与目录连接共用受管连接服务；模型不能提交凭据、启动命令或配置路径。 */
export function registerCustomMcpTools(ctx:Context,ports:CustomMcpToolsPorts){
 const checked=new WeakMap<object,ConversationInstructionMutationAuthorization>()
 const definitionSchema={type:'object',additionalProperties:false,required:true,properties:{schema:{type:'string',enum:['teloa.mcp-server/v1'],required:true},serverName:{type:'string',required:true},title:{type:'string',required:true},transport:{type:'string',enum:['streamable-http'],required:true},url:{type:'string',required:true}}} as const
 const definitions=[
  {name:'teloa_mcp_preview' as const,description:'预览本人指定的自定义 HTTP MCP 服务定义。definition 包含 schema=teloa.mcp-server/v1、serverName、title、transport=streamable-http、url。远程地址使用 HTTPS，本机回环可用 HTTP。地址不能携带凭据、查询参数或片段；不接受 headers、密钥、OAuth 或 stdio 命令。预览不访问该服务。',parameters:{definition:definitionSchema}},
  {name:'teloa_mcp_save' as const,description:'按本人指令保存刚预览的无凭据自定义 HTTP MCP 定义，必须带预览的 definitionHash。本操作仅保存，尚未连接；服务若要求认证，须本人通过安全认证流程完成，不能在会话填写密钥。相同定义重复保存复用原连接。',parameters:{definition:definitionSchema,expectedDefinitionHash:{type:'string',required:true}}},
  {name:'teloa_mcp_connection_connect' as const,description:'按本人授权连接一项已保存的受管 MCP，以返回的 connection.status 和实际工具发现结果判断是否接通。只热加载这一项连接，不重启应用。不得把保存成功说成健康或已授权；连接报错后可核对该记录并重试。',parameters:{id:{type:'string',required:true}}},
  {name:'teloa_mcp_list' as const,description:'读取本人已保存的受管 MCP 连接目录与真实连接状态；不包含凭据。目录出现不代表已连接。',parameters:{}},
  {name:'teloa_mcp_get' as const,description:'读取一项本人受管 MCP 的当前状态。自定义连接同时返回无凭据定义与当前 definitionHash，修改前须用本次摘要。目录连接不暴露其凭据或认证参数。',parameters:{id:{type:'string',required:true}}},
  {name:'teloa_mcp_disconnect' as const,description:'按本人指令断开这一项受管 MCP，并注销它的工具；保留配置以便之后重连，不重启应用。目录 OAuth 连接沿既有服务吊销认证。',parameters:{id:{type:'string',required:true}}},
  {name:'teloa_mcp_update' as const,description:'按本人指令修改同一项自定义 HTTP MCP 的标题或无凭据 URL。须保留 serverName，并带 teloa_mcp_get 返回的当前 definitionHash。本操作断开旧连接并保存新定义，连接是随后单独动作。过期摘要拒绝覆盖；不接受密钥、命令或配置路径。',parameters:{id:{type:'string',required:true},definition:definitionSchema,expectedDefinitionHash:{type:'string',required:true}}},
 ] as const
 const validate=(name:string,args:unknown)=>{
  if(name==='teloa_mcp_list'){taskInput(args,[]);return {}}
  if(name==='teloa_mcp_connection_connect'||name==='teloa_mcp_get'||name==='teloa_mcp_disconnect'){const row=taskInput(args,['id']);if(!uuid(row.id))throw invalid('受管 MCP 连接身份不正确。');return {id:row.id.toLowerCase()}}
  if(name==='teloa_mcp_update'){
   const row=taskInput(args,['id','definition','expectedDefinitionHash'])
   if(!uuid(row.id)||!hash(row.expectedDefinitionHash))throw invalid('MCP 修改身份或原定义摘要不正确。')
   return {id:row.id.toLowerCase(),definition:readCustomMcpDefinition(row.definition),expectedDefinitionHash:row.expectedDefinitionHash}
  }
  const row=taskInput(args,name==='teloa_mcp_save'?['definition','expectedDefinitionHash']:['definition']),definition=readCustomMcpDefinition(row.definition)
  if(name==='teloa_mcp_save'&&row.expectedDefinitionHash!==customMcpDefinitionHash(definition))throw new WorkError('teloa/version-conflict','MCP 定义与预览摘要不同，请重新预览。')
  return {definition,...(name==='teloa_mcp_save'?{expectedDefinitionHash:row.expectedDefinitionHash}:{})}
 }
 const authorize=(exec:Parameters<typeof ctx.tools.execute>[0])=>authorizeConversationInstructionMutation({...ports,...(exec.agent?{agent:exec.agent}:{}),signal:exec.signal})
 for(const definition of definitions)ctx.tools.register(defineTool({...definition,parameters:definition.parameters as ParameterSchemaSpec,output:{schema:{type:'string'} as const,render:(_args:unknown,value:string)=>[{type:'text' as const,text:value}]},execute:async(args,exec)=>{
  const authorization=await authorize(exec),row=validate(definition.name,args)
  assertConversationInstructionMutationAuthorization(checked.get(exec),authorization)
  if(definition.name==='teloa_mcp_list')return JSON.stringify(await ports.handler('mcp-connections/list',row,exec.signal))
  if(definition.name==='teloa_mcp_get')return JSON.stringify(await ports.handler('mcp-connections/get-custom',row,exec.signal))
  if(definition.name==='teloa_mcp_preview')return JSON.stringify(await ports.handler('mcp-connections/preview-custom',row,exec.signal))
  const payload=definition.name==='teloa_mcp_save'||definition.name==='teloa_mcp_update'?{...row,requestId:conversationInstructionMutationRequestId(authorization,definition.name,exec.callId)}:row
  const endpoint=definition.name==='teloa_mcp_save'?'mcp-connections/save-custom':definition.name==='teloa_mcp_update'?'mcp-connections/update-custom':definition.name==='teloa_mcp_disconnect'?'mcp-connections/disconnect':'mcp-connections/connect'
  const connection=await ports.handler(endpoint,payload,exec.signal)
  return JSON.stringify({schema:'teloa.mcp-result/v1',connection})
 }}))
 return ctx.on('tools/pre-execute',async(exec,next):Promise<PreToolDecision>=>{
  if(!(customMcpToolNames as readonly string[]).includes(exec.name))return next()
  try{const authorization=await authorize(exec);validate(exec.name,exec.arguments);checked.set(exec,authorization)}catch(error){return {kind:'deny',reason:error instanceof Error?error.message:'无法核对自定义 MCP 定义。'}}
  return next()
 },{prepend:true})
}
