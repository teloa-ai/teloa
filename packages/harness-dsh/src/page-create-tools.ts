import type {Context} from '@deepseek-ai/cordis'
import {defineTool,type PreToolDecision} from '@deepseek-ai/dsh-tools'
import {WorkError,taskInput,readPageCreateAtomicSkillDraft,type PageCreateEntity,type WritableRoleDefinition} from '@teloa/contract'
import type {TaskToolPolicyReader} from './task-tool-guard.ts'
import {authorizeConversationMutation,conversationMutationRequestId} from './conversation-mutation.ts'
import {assertSkillCreatorLoaded,type BuiltinSkillCreator} from './builtin-skill-creator.ts'

export const pageCreateToolNames=['teloa_create_directory','teloa_create_draft'] as const
export type PageCreateToolsPorts={
 owner:string
 conversation:(sessionId:string)=>Promise<{ownerId:string;sessionId:string;status:'pending'|'ready'}>
 readTaskPolicy:TaskToolPolicyReader
 /** 只回宿主已经核对过的目录摘要；不提供草案正文、对象取值或任何凭据。 */
 directory:(input:{entity:PageCreateEntity;scope?:string})=>Promise<unknown>
 draft:(input:{entity:PageCreateEntity;scope?:string;body:unknown;requestId:string})=>Promise<unknown>
 /** 内置技能创建器；null 表示宿主启动时未能准备好，技能草案一律拒绝，其余实体不受影响。 */
 skillCreator:BuiltinSkillCreator|null
}
const entities=['business-definition','business-domain','role','skill','connector','extension'] as const
// 工具说明必须自足：真实会话没有仓库源码可查，不能让模型猜岗位字段。
const roleDraftExample:WritableRoleDefinition={name:'研究助理',kind:'employee',scopes:['general'],duty:'根据本人提供的资料整理周报草案',dataScope:'仅本次提供且已获准使用的资料',executionScope:'只分析与代拟，发送或修改外部系统前交由本人确认',skills:[],knowledge:[],responsibility:{triggers:['本人交办周报'],autonomousActions:['归纳资料并代拟周报'],confirmationPoints:['对外发送前请本人确认'],escalationRules:['缺少资料时向本人说明'],deliveryChecks:['核对事实与来源']}}
const roleDraftHelp='员工（entity=role）的 body 是员工定义 JSON 字符串，不是市场包、不是 {fields:...} 请求包装；不接受 format/id/title/description/version 等额外字段。必填 name、kind（employee 或 twin）、scopes（非空业务键数组，通用工作可用 general）、duty、dataScope、executionScope、skills、knowledge、responsibility。skills 为已有原生技能名数组，knowledge 为已有资料 ID 数组；无已核对资源时用 []，不得编造。responsibility 包含 triggers/autonomousActions/confirmationPoints/escalationRules/deliveryChecks 五个字符串数组。运行配置未核对时省略 runtimeConfig。最小员工示例：\n'+JSON.stringify(roleDraftExample)+'\n请按需求改写职责；范围和资源以目录为准。'
const skillDraftExample={id:'content-review',title:'内容核对',version:'1.0.0',categories:[],files:[{path:'SKILL.md',base64:Buffer.from('---\nname: content-review\ndescription: Review an internal content draft against supplied sources.\n---\nCheck facts against the supplied sources and list unresolved questions.\n').toString('base64')}]}
const skillDraftHelp='\n技能（entity=skill）的 body 是包含 id、title、version、categories、files 的 JSON 对象序列化字符串，不是 Markdown 字符串。version 用固定三段版本号；categories 无分类时用 []；files 每项只含相对路径 path 和文件 UTF-8 字节的 base64，必须恰好有一份 SKILL.md。不传本机路径或 scope。最小技能示例：\n'+JSON.stringify(skillDraftExample)+'\n按用户需求生成正文，再编码；不需要读取 Teloa 源码。'
const entity=(value:unknown):value is PageCreateEntity=>(entities as readonly string[]).includes(value as string)
/** 只有业务与连接器需要业务范围；员工、技能、扩展缺省，见客户端 CreateEntryProps.scope 注释。 */
const scopedEntities=new Set<PageCreateEntity>(['business-definition','business-domain','connector'])
const scope=(value:unknown):string|undefined=>{
 if(value===undefined)return undefined
 if(typeof value!=='string'||!value.trim()||value!==value.trim()||value.length>120||/[\x00-\x1f\x7f]/.test(value)||value==='general')throw new WorkError('teloa/invalid-input','业务范围不正确：业务与连接必须给一个已登记的业务范围，不能是通用工作（general）。')
 return value
}
function directoryInput(value:unknown){
 const row=taskInput(value,['entity','scope'])
 if(!entity(row.entity))throw new WorkError('teloa/invalid-input','页内新建目录格式不正确。')
 if(!scopedEntities.has(row.entity))return {entity:row.entity}
 const businessScope=scope(row.scope)
 return {entity:row.entity,...(businessScope===undefined?{}:{scope:businessScope})}
}
function draftInput(value:unknown){
 const row=taskInput(value,['entity','scope','body'])
 if(!entity(row.entity)||typeof row.body!=='string'||!row.body.trim()||row.body.length>131072)throw new WorkError('teloa/invalid-input','页内新建草案格式不正确。')
 let body:unknown
 try{body=JSON.parse(row.body)}catch{throw new WorkError('teloa/invalid-input','草案正文必须是 JSON。')}
 if(row.entity==='skill')body=readPageCreateAtomicSkillDraft(body)
 if(!scopedEntities.has(row.entity))return {entity:row.entity,body}
 const businessScope=scope(row.scope)
 if(businessScope===undefined)throw new WorkError('teloa/invalid-input','此类新建对象需要业务范围。')
 return {entity:row.entity,body,scope:businessScope}
}

/** 只写草案的会话工具。没有任何模型工具能让草案直接生效或跳过页面预览。 */
export function registerPageCreateTools(ctx:Context,ports:PageCreateToolsPorts){
 const authorize=(exec:Parameters<typeof ctx.tools.execute>[0])=>authorizeConversationMutation({owner:ports.owner,conversation:ports.conversation,readTaskPolicy:ports.readTaskPolicy,...(exec.agent?{agent:exec.agent}:{}),signal:exec.signal})
 // 技能草案必须由创建器生成：创建器正文要在当前模型可见上下文中且与固定版本一致，模型自报不算。
 const creatorLoaded=(exec:Parameters<typeof ctx.tools.execute>[0],entity:PageCreateEntity)=>{
  if(entity!=='skill')return
  if(!ports.skillCreator)throw new WorkError('teloa/dependency-unavailable','技能创建器不可用，暂不能生成技能草案。')
  if(!exec.agent)throw new WorkError('teloa/forbidden','技能草案需要真实本人普通会话。')
  assertSkillCreatorLoaded(exec.agent.session,ports.skillCreator)
 }
 const definitions=[
  {name:'teloa_create_directory' as const,description:'读取本人已有的业务范围、员工、技能、连接和官方扩展目录摘要，用于生成新建草案前核对名称、范围与来源。不返回对象取值、草案正文或凭据。员工、技能、扩展不需要 scope（传了会被忽略）；业务定义、连接必须传本人已登记的业务范围；新增一类业务（business-domain）用的是尚未登记的新范围键，不必先登记。scope 只能是 1–64 位字母、数字、下划线或连字符（如 recruiting），不能是中文或 general。',parameters:{entity:{type:'string',enum:[...entities],required:true},scope:{type:'string'}}},
  {name:'teloa_create_draft' as const,description:'把一份已校验的新建定义保存成待确认草案。只能用于本人普通工作会话；草案不会创建、安装、授权或启用任何东西，必须在对应页面预览并确认。员工、技能、扩展不需要 scope（传了会被忽略）；业务定义、连接必须传本人已登记的业务范围；新增一类业务（business-domain）用的是尚未登记的新范围键，不必先登记。scope 只能是 1–64 位字母、数字、下划线或连字符（如 recruiting），不能是中文或 general。技能草案的 SKILL.md 必须带 frontmatter，name 与草案 id 相同且只含小写字母、数字、连字符，description 必填；中文名字放 title。业务定义正文是三种声明之一，校验失败会指出缺少或不认识的字段路径：teloa.business-object-type/v1（顶层必填 format/id/version/domain/title/unit/lead/sourceId/fields，可选 localized/progress/defaultAction）；teloa.business-view/v1（顶层必填 format/id/version/domain/title/kind/chart/objectType/measures/filters/limit，distribution/trend 需另加 dimension，非 board-card 需另加 sort，可选 localized/window）；teloa.business-action/v1（顶层必填 format/id/version/domain/title/objectType/target/inputs，可选 localized）。',parameters:{entity:{type:'string',enum:[...entities],required:true},scope:{type:'string'},body:{type:'string',required:true}}},
 ] as const
 for(const definition of definitions)ctx.tools.register(defineTool({...definition,
  description:definition.description+(definition.name==='teloa_create_draft'?roleDraftHelp+skillDraftHelp:''),
  output:{schema:{type:'string'} as const,render:(_args:unknown,value:string)=>[{type:'text' as const,text:value}]},
  execute:async(args,exec)=>{
   const authorization=await authorize(exec)
   if(definition.name==='teloa_create_directory')return JSON.stringify(await ports.directory(directoryInput(args)))
   const draft=draftInput(args);creatorLoaded(exec,draft.entity)
   const requestId=conversationMutationRequestId(authorization,'teloa_create_draft')
   return JSON.stringify(await ports.draft({...draft,requestId}))
  },
 }))
 return ctx.on('tools/pre-execute',async(exec,next):Promise<PreToolDecision>=>{
  if(!(pageCreateToolNames as readonly string[]).includes(exec.name))return next()
  try{await authorize(exec);if(exec.name==='teloa_create_directory')directoryInput(exec.arguments);else creatorLoaded(exec,draftInput(exec.arguments).entity)}catch(error){return {kind:'deny',reason:error instanceof Error?error.message:'无法核对页内新建草案身份。'}}
  const decision=await next()
  if(decision.kind==='deny'||exec.name==='teloa_create_directory')return decision
  const prior=decision.kind==='ask'?`原生规则同时要求确认：${decision.reason} `:''
  return {kind:'ask',reason:prior+'确认把这份新建定义保存成草案？草案不会直接创建任何内容，需要你在对应页面预览并确认。'}
 })
}
