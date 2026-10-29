import {createHash} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import {defineTool,type ParameterSchemaSpec,type PreToolDecision} from '@deepseek-ai/dsh-tools'
import {WorkError,taskInput,readTaskToolArgumentRules,groupAgentGrantChangeInput,groupAgentGrantGetInput,isBundledExtensionId,bundledExtensionStates,type TaskToolArgumentRule} from '@teloa/contract'
import {authorizeOrdinaryConversationMutation,authorizeConversationInstructionMutation,assertConversationInstructionMutationAuthorization,conversationInstructionMutationRequestId,type ConversationInstructionMutationAuthorization,type ConversationInstructionMutationInput} from './conversation-mutation.ts'

type Handler=(endpoint:string,payload:unknown,signal?:AbortSignal)=>Promise<unknown>
export type CapabilityResource={kind:'skill'|'extension'|'connector'|'role-tools'|'group-agent-grant';id:string;ownerId:string;title:string;version:number|string;state:string;installationId?:string;contentId?:string;nativeName?:string;connectorKind?:'data-source'|'mcp'|'execution-tool';roleId?:string;groupId?:string}
export type CapabilityManagementPorts=Pick<ConversationInstructionMutationInput,'owner'|'conversation'|'readTaskPolicy'>&{
 skillAvailability:Handler;skillSelection:Handler;extensions:(endpoint:string,payload:unknown,signal?:AbortSignal,beforeCommit?:()=>Promise<void>)=>Promise<unknown>;roleGrants:Handler;groupGrants:Handler;dataSources:Handler;executionTools:Handler;probe:Handler
 admitText:(text:string)=>void
 describe:(name:Name,input:Record<string,unknown>,value:unknown)=>Promise<CapabilityResource|null>
}
const requiredString={type:'string',required:true} as const,requiredVersion={type:'integer',required:true} as const
const installation={installationId:requiredString},role={roleId:requiredString},groupRole={groupId:requiredString,...role}
const connectorKind={type:'string',enum:['data-source','execution-tool'],required:true} as const,connector={kind:connectorKind,instanceId:requiredString}
const definitions=[
 {name:'teloa_skill_availability_preview',read:true,description:'读取一项本人已安装技能的真实可用状态和启停影响。启停使用这里返回的 availability.version、bundleHash 与 impactDigest；这是配置预览，不执行技能。',parameters:installation},
 {name:'teloa_skill_availability_change',read:false,description:'按本人当前指令启用或停用同一项安装，固定预览版本、安装包与影响摘要。沿原服务更新实际选定技能的原生可用性；已有历史不删除。冲突先重新预览，不猜版本。',parameters:{...installation,expectedVersion:requiredVersion,expectedBundleHash:requiredString,expectedImpactDigest:requiredString,action:{type:'string',enum:['enable','disable'],required:true},reason:{type:'string'}}},
 {name:'teloa_skill_selection_get',read:true,description:'读取本人技能名称目前选定的真实安装及选择版本。此名称是内部原生技能名，展示名称可为中文。',parameters:{nativeName:requiredString}},
 {name:'teloa_skill_selection_preview',read:true,description:'预览同一原生技能的两个已安装版本切换影响。不修改正文、不安装或授权；从回包取得选择版本、两个 bundleHash 和 impactDigest。',parameters:{currentInstallationId:requiredString,targetInstallationId:requiredString}},
 {name:'teloa_skill_selection_change',read:false,description:'按本人指令将同一个技能选定到已安装目标版本，必须使用切换预览的固定版本及摘要。industryUsages 只列本人明确要求迁移的行业使用关系，可为空；不会重建同名技能。',parameters:{nativeName:requiredString,currentInstallationId:requiredString,targetInstallationId:requiredString,expectedSelectionVersion:requiredVersion,expectedCurrentBundleHash:requiredString,expectedTargetBundleHash:requiredString,expectedImpactDigest:requiredString,industryUsages:{type:'array',required:true,items:{type:'object',additionalProperties:false,properties:{loadId:requiredString,itemInstanceId:requiredString}}}}},
 {name:'teloa_extensions_list',read:true,description:'读取应用随附官方扩展的真实版本和加载状态。IM 通道为内置能力，不能整体停用；本地检索可选启停。不会读取第三方包、凭据或配置文件。',parameters:{}},
 {name:'teloa_extensions_set',read:false,description:'按本人指令启停一项随附官方扩展。必须使用目录当前版本和状态，宿主在 profile 锁内重新核验并沿现有热加载服务操作。以返回的 active/available 或 pending 状态判断是否已生效。不会安装任意 npm 包或执行命令。',parameters:{extensionId:{type:'string',enum:['im-gateway','local-embedding'],required:true},enabled:{type:'boolean',required:true},expectedVersion:requiredString,expectedState:{type:'string',enum:bundledExtensionStates,required:true}}},
 {name:'teloa_role_tools_get',read:true,description:'读取本人员工当前版本及已保存的工具授权。只有本回包的真实状态和精确规则可作为当前授权证据；候选目录、MCP已连接或只读分类均不能替代。工具授权与员工技能、知识关联分开；改授权前必须核对本人意图。',parameters:role},
 {name:'teloa_role_tools_candidates',read:true,description:'读取本人员工可授权的真实工具目录，返回固定 key、精确参数选项和目录摘要。这是可选目录，不是当前已授权清单；核对现有权限必须另读 teloa_role_tools_get，不能把全部候选写成已授权或补进本人限定的工具清单。保存只能按 key 选择；参数索引从 0 开始。不会任意扩展工具或数据范围。',parameters:role},
 {name:'teloa_role_tools_change',read:false,description:'按本人明确指令保存或撤销同一个员工的工具授权。保存前需暂停员工，并带当前员工版本、候选目录 digest；selections 每项 key 来自候选，argumentIndices 只选本人要授予的精确参数下标。anyArguments 或 workspaceFiles 候选填空数组，沿候选原边界授予。撤销 selections 为空，不自动恢复在岗。',parameters:{...role,expectedRoleVersion:requiredVersion,action:{type:'string',enum:['save','revoke'],required:true},expectedCandidatesDigest:requiredString,selections:{type:'array',required:true,items:{type:'object',additionalProperties:false,properties:{key:requiredString,argumentIndices:{type:'array',required:true,items:{type:'integer'}}}}}}},
 {name:'teloa_group_agent_grant_get',read:true,description:'读取本人群中指定员工的真实资料、回应及自动运行授权，包含当前群/员工版本与失效状态；成员关系不会替代资料授权。',parameters:groupRole},
 {name:'teloa_group_agent_grant_change',read:false,description:'按本人明确指令保存或撤销指定群员工的资料、回应与自动运行授权。必须固定真实群和员工版本；resources 仅列明确允许的原资料、附件或成果及原版本。服务在事务内核对归属、范围、成员和原版本。不给其他资料或工具扩权，不自动发送本人消息。',parameters:{...groupRole,expectedGroupVersion:requiredVersion,expectedRoleVersion:requiredVersion,action:{type:'string',enum:['save','revoke'],required:true},resources:{type:'array',required:true,items:{type:'object',additionalProperties:false,properties:{kind:{type:'string',enum:['group-resource','artifact','attachment','work-resource'],required:true},id:requiredString,version:requiredVersion}}},canPost:{type:'boolean',required:true},canAutoRun:{type:'boolean',required:true}}},
 {name:'teloa_connector_instances_list',read:true,description:'读取本人已加载行业方案的数据源或执行工具连接实例，返回原实例、固定来源、revision 和实际状态，不读取密钥。MCP 目录使用 teloa_mcp_list。',parameters:{kind:connectorKind}},
 {name:'teloa_connector_instances_get',read:true,description:'读取本人一个已登记的行业连接实例及当前 revision。配置本身不表示可执行，漂移或 needs_authorization 须核对真实授权。',parameters:connector},
 {name:'teloa_connector_instances_authorize',read:false,description:'按本人明确指令授权原行业连接实例中已登记的固定数据源或执行工具配方。必须使用当前 expectedRevision；来源、实际范围和已登记适配器由服务核验。只配置不执行外部动作，不接受 URL、密钥、命令或新工具名称。缺本人认证或配置时返回原服务要求，不能冒充已接通。',parameters:{...connector,expectedRevision:requiredVersion}},
 {name:'teloa_connector_probe',read:false,description:'按本人指令对已经登记的数据源、MCP 或执行工具连接做一次真实连接测试。可能访问已授权目标，结果以 ok/reason 为准；不新增连接，不提交业务动作，不接受任意地址或凭据。',parameters:{kind:{type:'string',enum:['data-source','mcp','execution-tool'],required:true},instanceId:requiredString}},
] as const
export const capabilityManagementToolNames=definitions.map(row=>row.name)
type Name=typeof definitions[number]['name']
const names=new Set<string>(capabilityManagementToolNames),readOnly=new Set<string>(definitions.filter(row=>row.read).map(row=>row.name))
const invalid=()=>new WorkError('teloa/invalid-input','能力配置参数格式不正确或包含未授权字段。')
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const positive=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>0&&Number(value)<2147483647
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
function validate(name:Name,args:unknown):Record<string,unknown>{
 const definition=definitions.find(row=>row.name===name)!,row={...taskInput(args,Object.keys(definition.parameters))}
 if(Object.values(row).some(value=>value===undefined)||Object.entries(definition.parameters).some(([key,spec])=>'required'in spec&&spec.required&&!Object.hasOwn(row,key)))throw invalid()
 for(const [key,value] of Object.entries(row)){
  if(['installationId','currentInstallationId','targetInstallationId','roleId','groupId','instanceId'].includes(key)&&!uuid(value)||key.startsWith('expected')&&key!=='expectedVersion'&&key!=='expectedState'&&(key.endsWith('Version')||key==='expectedRevision'?!positive(value):!hash(value)))throw invalid()
 }
 if(name==='teloa_skill_availability_change'){
  if(!positive(row.expectedVersion)||!['enable','disable'].includes(String(row.action))||row.reason!==undefined&&(typeof row.reason!=='string'||row.reason.length>4000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(row.reason)))throw invalid()
 }
 if(name==='teloa_skill_selection_get'||name==='teloa_skill_selection_change')if(typeof row.nativeName!=='string'||row.nativeName.length>120||!/^([a-z0-9]+-)*[a-z0-9]+$/.test(row.nativeName))throw invalid()
 if(name==='teloa_skill_selection_change'){
  if(!Array.isArray(row.industryUsages)||row.industryUsages.length>1000)throw invalid()
  row.industryUsages=row.industryUsages.map(value=>{const usage=taskInput(value,['loadId','itemInstanceId']);if(!uuid(usage.loadId)||!uuid(usage.itemInstanceId))throw invalid();return usage})
 }
 if(name==='teloa_extensions_set'){
  if(!isBundledExtensionId(row.extensionId)||typeof row.enabled!=='boolean'||row.extensionId==='im-gateway'&&!row.enabled||typeof row.expectedVersion!=='string'||row.expectedVersion.length>80||!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(row.expectedVersion)||!(bundledExtensionStates as readonly unknown[]).includes(row.expectedState))throw invalid()
 }
 if(name==='teloa_role_tools_change'){
  if(!['save','revoke'].includes(String(row.action))||!Array.isArray(row.selections)||row.selections.length>128||row.action==='save'&&!row.selections.length||row.action==='revoke'&&row.selections.length)throw invalid()
  const keys=new Set<string>();row.selections=row.selections.map(value=>{const selected=taskInput(value,['key','argumentIndices']);if(!hash(selected.key)||keys.has(selected.key)||!Array.isArray(selected.argumentIndices)||selected.argumentIndices.length>128||new Set(selected.argumentIndices).size!==selected.argumentIndices.length||selected.argumentIndices.some(index=>!Number.isSafeInteger(index)||index<0||index>=128))throw invalid();keys.add(selected.key);return selected})
 }
 if(name==='teloa_group_agent_grant_get')return groupAgentGrantGetInput(row)
 if(name==='teloa_group_agent_grant_change'){const {requestId:_,...parsed}=groupAgentGrantChangeInput({...row,requestId:'00000000-0000-4000-8000-000000000000'});return parsed}
 if(name.startsWith('teloa_connector_')){
  if(!['data-source','execution-tool',...(name==='teloa_connector_probe'?['mcp']:[])].includes(String(row.kind))||name==='teloa_connector_instances_authorize'&&!positive(row.expectedRevision))throw invalid()
 }
 return row
}
function candidates(value:unknown){
 const row=taskInput(value,['roleVersion','rules','skillHttp','delegation']);if(!positive(row.roleVersion))throw new WorkError('teloa/invalid-host-response','员工工具候选版本不正确。')
 let rules:TaskToolArgumentRule[];try{rules=readTaskToolArgumentRules(row.rules)}catch{throw new WorkError('teloa/invalid-host-response','员工工具候选规则不正确。')}
 return {roleVersion:row.roleVersion,digest:digest([row.roleVersion,rules]),candidates:rules.map(rule=>({key:digest(rule),rule})),...(row.skillHttp===undefined?{}:{skillHttp:row.skillHttp}),...(row.delegation===undefined?{}:{delegation:row.delegation})}
}
export function registerCapabilityManagementTools(ctx:Context,ports:CapabilityManagementPorts){
 const checked=new WeakMap<object,ConversationInstructionMutationAuthorization>()
 const authorize=(exec:Parameters<typeof ctx.tools.execute>[0],name:Name)=>readOnly.has(name)?authorizeOrdinaryConversationMutation({...ports,...(exec.agent?{agent:exec.agent}:{}),signal:exec.signal},'能力配置'):authorizeConversationInstructionMutation({...ports,...(exec.agent?{agent:exec.agent}:{}),signal:exec.signal})
 const output={schema:{type:'string'} as const,render:(_args:unknown,value:string)=>[{type:'text' as const,text:value}]}
 for(const definition of definitions)ctx.tools.register(defineTool({...definition,parameters:definition.parameters as ParameterSchemaSpec,output,execute:async(args,exec)=>{
  try{
   const authorization=await authorize(exec,definition.name),row=validate(definition.name,args);ports.admitText(JSON.stringify(row))
   if(!definition.read)assertConversationInstructionMutationAuthorization(checked.get(exec),authorization as ConversationInstructionMutationAuthorization)
   const requestId=!definition.read?conversationInstructionMutationRequestId(authorization as ConversationInstructionMutationAuthorization,definition.name,exec.callId):undefined
   let value:unknown
   if(definition.name==='teloa_skill_availability_preview'||definition.name==='teloa_skill_availability_change')value=await ports.skillAvailability(definition.read?'skill-availability/preview':'skill-availability/change',definition.read?row:{...row,requestId},exec.signal)
   else if(definition.name.startsWith('teloa_skill_selection_'))value=await ports.skillSelection('skill-selections/'+definition.name.slice('teloa_skill_selection_'.length),definition.read?row:{...row,requestId},exec.signal)
   else if(definition.name==='teloa_extensions_list')value=await ports.extensions('bundled-extensions/list',{},exec.signal)
   else if(definition.name==='teloa_extensions_set')value=await ports.extensions('bundled-extensions/set',{extensionId:row.extensionId,enabled:row.enabled,expected:{version:row.expectedVersion,state:row.expectedState}},exec.signal,async()=>{exec.signal.throwIfAborted();assertConversationInstructionMutationAuthorization(checked.get(exec),await authorizeConversationInstructionMutation({...ports,...(exec.agent?{agent:exec.agent}:{}),signal:exec.signal}));exec.signal.throwIfAborted()})
   else if(definition.name==='teloa_role_tools_get')value=await ports.roleGrants('role-tools/get',row,exec.signal)
   else if(definition.name==='teloa_role_tools_candidates')value=candidates(await ports.roleGrants('role-tools/candidates',row,exec.signal))
   else if(definition.name==='teloa_role_tools_change'){
    let rules:TaskToolArgumentRule[]=[]
    if(row.action==='save'){
     const available=candidates(await ports.roleGrants('role-tools/candidates',{roleId:row.roleId},exec.signal))
     if(available.roleVersion!==row.expectedRoleVersion||available.digest!==row.expectedCandidatesDigest)throw new WorkError('teloa/version-conflict','员工工具候选已变化，请重新核对授权。')
     rules=(row.selections as {key:string;argumentIndices:number[]}[]).map(selection=>{
      const candidate=available.candidates.find(item=>item.key===selection.key)?.rule
      if(!candidate||candidate.anyArguments||candidate.workspaceFiles){if(!candidate||selection.argumentIndices.length)throw invalid();return candidate}
      if(!selection.argumentIndices.length||selection.argumentIndices.some(index=>index>=candidate.allowed.length))throw invalid()
      return {name:candidate.name,allowed:selection.argumentIndices.map(index=>candidate.allowed[index]!)}
     })
    }
    // 候选读取可能等待 I/O；最终写入口之前再次核验同一真实指令。
    assertConversationInstructionMutationAuthorization(checked.get(exec),await authorizeConversationInstructionMutation({...ports,...(exec.agent?{agent:exec.agent}:{}),signal:exec.signal}))
    value=await ports.roleGrants('role-tools/change',{roleId:row.roleId,expectedRoleVersion:row.expectedRoleVersion,action:row.action,rules},exec.signal)
   }else if(definition.name.startsWith('teloa_group_agent_grant_'))value=await ports.groupGrants(definition.read?'groups/agent-grants/get':'groups/agent-grants/change',definition.read?row:{...row,requestId},exec.signal)
   else if(definition.name==='teloa_connector_probe')value=await ports.probe('connectors/probe',row,exec.signal)
   else{
    const {kind,...input}=row,handler=kind==='data-source'?ports.dataSources:ports.executionTools,method=definition.name.slice('teloa_connector_instances_'.length)
    value=await handler((kind==='data-source'?'industry-data-sources/':'industry-execution-tools/')+method,definition.read?input:{...input,requestId},exec.signal)
   }
   const resource=await ports.describe(definition.name,row,value)
   if(resource&&(resource.ownerId!==ports.owner||typeof resource.id!=='string'||!resource.id||typeof resource.title!=='string'||!resource.title.trim()||resource.title.length>500||!['skill','extension','connector','role-tools','group-agent-grant'].includes(resource.kind)||typeof resource.state!=='string'||!resource.state||(typeof resource.version==='string'?!resource.version.trim()||resource.version.length>80:!positive(resource.version))))throw new WorkError('teloa/invalid-host-response','能力配置回执对象身份不一致。')
   const result=JSON.stringify({schema:'teloa.capability-result/v1',sessionId:authorization.sessionId,operation:definition.name,value,...(resource?{resource}:{})});ports.admitText(result);return result
  }catch(error){if(error instanceof WorkError){ports.admitText(error.message);throw new WorkError(error.code,error.message)}throw new WorkError('teloa/host-unavailable','能力配置服务暂不可用，请重试并先核对真实目录。')}
 }}))
 return ctx.on('tools/pre-execute',async(exec,next):Promise<PreToolDecision>=>{
  if(!names.has(exec.name))return next()
  try{const name=exec.name as Name,authorization=await authorize(exec,name);ports.admitText(JSON.stringify(validate(name,exec.arguments)));if(!readOnly.has(name))checked.set(exec,authorization as ConversationInstructionMutationAuthorization)}catch(error){return {kind:'deny',reason:error instanceof WorkError?error.message:'无法核对能力配置边界。'}}
  return next()
 },{prepend:true})
}
