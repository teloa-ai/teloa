import {createHash} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import type {Session} from '@deepseek-ai/dsh-session'
import {defineTool,type PreToolDecision} from '@deepseek-ai/dsh-tools'
import {WorkError,roleInput,roleDefinition,roleWriteDefinition,readRoleProfile,type DigitalRole,type RoleProfile,type RoleRuntimeConfig} from '@teloa/contract'
import {roleAvatarDescription} from './role-avatar-description.ts'
import type {TaskToolPolicyReader} from './task-tool-guard.ts'
import {authorizeOrdinaryConversationMutation} from './conversation-mutation.ts'
import {readConversationInstructionIdentity,type ConversationInstructionIdentity} from './conversation-instruction-identity.ts'

export const employeeToolNames=['teloa_employees_directory','teloa_employees_get','teloa_employees_create','teloa_employees_profile','teloa_employees_update','teloa_employees_lifecycle'] as const
export type EmployeeToolName=typeof employeeToolNames[number]
export type EmployeeRoleEndpoint='roles/list'|'roles/create'|'roles/edit'|'roles/profile'
export type EmployeeToolsPorts={
 owner:string
 conversation:(sessionId:string)=>Promise<{ownerId:string;sessionId:string;status:'pending'|'ready'}>
 readTaskPolicy:TaskToolPolicyReader
 /** 必须接入已固定宿主本人身份的 createRoleHandler，保留知识预检和实际权益检查。 */
 roleHandler:(endpoint:EmployeeRoleEndpoint,payload:unknown)=>Promise<unknown>
 /** 同工作台 roles/lifecycle，不能绕过岗位状态、交接和权益服务。 */
 lifecycle:(payload:unknown)=>Promise<unknown>
}
export type EmployeeToolResult={schema:'teloa.employee-result/v1';sessionId:string;operation:'get'|'create'|'profile'|'update'|'lifecycle';role:DigitalRole;requestId?:string;appliedVersion?:number;handoffTaskIds?:string[]}
export type EmployeeDirectoryResult={schema:'teloa.employee-result/v1';sessionId:string;operation:'directory';roles:DigitalRole[]}
type Execution={agent?:{session:Session};signal:AbortSignal;callId?:unknown}
const names=new Set<string>(employeeToolNames)
const readOnly=new Set<string>(['teloa_employees_directory','teloa_employees_get'])
const definitionKeys=['name','avatarKey','scopes','duty','dataScope','executionScope','skills','knowledge','responsibility','runtimeConfig'] as const
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0
const timestamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value
const hostFailure=()=>new WorkError('teloa/host-unavailable','员工服务暂不可用，请重试并先核对员工目录。')
async function safe<T>(operation:()=>Promise<T>):Promise<T>{try{return await operation()}catch(error){if(error instanceof WorkError)throw error;throw hostFailure()}}

/** 新工具仅接受完整本人普通会话；执行正文再次核对，以覆盖审批期间的会话变化。 */
async function authorize(ports:EmployeeToolsPorts,exec:Execution,name:EmployeeToolName):Promise<{sessionId:string;instruction?:ConversationInstructionIdentity}>{
 const {sessionId}=await authorizeOrdinaryConversationMutation({...ports,...(exec.agent?{agent:exec.agent}:{}),signal:exec.signal},'员工管理')
 return readOnly.has(name)?{sessionId}:{sessionId,instruction:readConversationInstructionIdentity(exec.agent!)}
}
function requestIdentity(owner:string,instruction:ConversationInstructionIdentity,name:EmployeeToolName,callId:unknown):string{
 if(typeof callId!=='string'||!callId.trim())throw new WorkError('teloa/invalid-input','员工保存缺少真实工具调用身份。')
 const hash=createHash('sha256').update(['teloa-employee-tool/v1',owner,instruction.sessionId,instruction.messageId,String(instruction.seq),name,callId].join('\0')).digest('hex')
 return `${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`
}
function identity(row:Record<string,unknown>):void{
 if(!uuid(row.roleId)||!positive(row.expectedVersion))throw new WorkError('teloa/invalid-input','员工身份或版本不合法，请先读取员工详情。')
}
function readRole(value:unknown,owner:string):DigitalRole{
 try{
  const row=roleInput(value,['id','ownerId','version','state','createdAt','updatedAt',...definitionKeys,'kind'])
  const {id,ownerId,version,state,createdAt,updatedAt,...fields}=row
  if(!uuid(id)||ownerId!==owner||!positive(version)||!['active','paused','retired'].includes(String(state))||!timestamp(createdAt)||!timestamp(updatedAt))throw Error()
  return {...roleDefinition(fields),id,ownerId:owner,version,state:state as DigitalRole['state'],createdAt,updatedAt}
 }catch{throw new WorkError('teloa/invalid-host-response','员工服务返回了无效或跨本人的记录，请核对原员工。')}
}
async function directory(ports:EmployeeToolsPorts):Promise<DigitalRole[]>{
 const value=await ports.roleHandler('roles/list',{})
 if(!Array.isArray(value))throw new WorkError('teloa/invalid-host-response','员工目录返回格式不正确。')
 const roles=value.map(item=>readRole(item,ports.owner))
 if(new Set(roles.map(role=>role.id)).size!==roles.length)throw new WorkError('teloa/invalid-host-response','员工目录包含重复身份，请核对原记录。')
 return roles.filter(role=>role.kind==='employee')
}
async function getEmployee(ports:EmployeeToolsPorts,roleId:unknown):Promise<DigitalRole>{
 if(!uuid(roleId))throw new WorkError('teloa/invalid-input','请选择真实员工身份。')
 const role=(await directory(ports)).find(item=>item.id===roleId)
 if(!role)throw new WorkError('teloa/forbidden','员工不存在或不属于当前本人；个人分身请使用其原配置入口。')
 return role
}
function profile(role:DigitalRole):RoleProfile{return readRoleProfile({name:role.name,...(role.avatarKey?{avatarKey:role.avatarKey}:{})})}

/** auto/default 是未固定主模型；不写 provider、地址或凭据，不修改宿主模型设置。 */
function fields(row:Record<string,unknown>){
 const runtime=row.runtimeConfig===undefined?undefined:roleInput(row.runtimeConfig,['agentPresetId','model','fallbackModel'])
 let runtimeConfig:RoleRuntimeConfig|undefined
 if(runtime){
  const {model,...rest}=runtime
  const normalized={...rest,...(model===undefined||model==='auto'||model==='default'?{}:{model})}
  if(Object.keys(normalized).length)runtimeConfig=normalized as RoleRuntimeConfig
 }
 const {runtimeConfig:_runtime,...definition}=row
 return roleWriteDefinition({...definition,kind:'employee',...(runtimeConfig?{runtimeConfig}:{})})
}

const stringList={type:'array',items:{type:'string'},required:true} as const
const avatar={type:'string',description:roleAvatarDescription} as const
const model={type:'object',additionalProperties:false,properties:{provider:{type:'string',required:true},model:{type:'string',required:true},reasoningEffort:{type:'string'}}} as const
const runtime={type:'object',additionalProperties:false,properties:{agentPresetId:{type:'string'},model:{oneOf:[model,{type:'string',enum:['auto','default']}]},fallbackModel:model}} as const
const profileSpec={type:'object',additionalProperties:false,properties:{name:{type:'string',required:true},avatarKey:avatar}} as const
const fullDefinition={
 name:{type:'string',required:true},avatarKey:avatar,scopes:{...stringList,description:'使用本人已有业务scope；通用工作为general，不猜测私有业务ID。'},duty:{type:'string',required:true},dataScope:{type:'string',required:true},executionScope:{type:'string',required:true},skills:{...stringList,description:'真实技能ID声明；不授予安装或执行权限。'},knowledge:{...stringList,description:'本人已有资料资源ID；没有实际资料时用空数组。'},
 responsibility:{type:'object',additionalProperties:false,required:true,properties:{triggers:stringList,autonomousActions:stringList,confirmationPoints:stringList,escalationRules:stringList,deliveryChecks:stringList}},
 runtimeConfig:{...runtime,description:'可省略以沿用宿主模型路由。model:auto/default表示未固定；固定模型必须填写真实provider/model，不能填写密钥。'},
} as const
const versionParameters={roleId:{type:'string',required:true},expectedVersion:{type:'integer',required:true}} as const
const output={schema:{type:'string'} as const,render:(_args:unknown,value:string)=>[{type:'text' as const,text:value}]}

export function registerEmployeeTools(ctx:Context,ports:EmployeeToolsPorts){
 // 原生运行器以同一执行对象走过前置审核与工具体；授权不跨调用缓存。
 const instructions=new WeakMap<object,ConversationInstructionIdentity>()
 const revalidate=async(exec:Execution,name:EmployeeToolName)=>{
  const authorization=await authorize(ports,exec,name)
  if(!readOnly.has(name)){
   const expected=instructions.get(exec),actual=authorization.instruction
   if(!expected||!actual||expected.sessionId!==actual.sessionId||expected.messageId!==actual.messageId||expected.seq!==actual.seq)throw new WorkError('teloa/version-conflict','审核期间本人指令已变化，请按当前指令重新执行员工操作。')
  }
  return authorization
 }
 const definitions=[
  {name:'teloa_employees_directory',description:'列出本人真实数字员工的身份、头像、职责、范围、状态和版本（排除个人分身）。创建或调整前读取；未知写入结果先核对此目录，不重复创建。能力和资料是声明，实际使用仍需原服务授权。',parameters:{}},
  {name:'teloa_employees_get',description:'按本人目录中的roleId读取完整员工详情和当前版本。修改时使用此处姓名头像作为expectedProfile，不猜身份或版本；员工原单聊由客户端已有入口打开。',parameters:{roleId:{type:'string',required:true}}},
  {name:'teloa_employees_create',description:'依本人当轮明确指令创建一位真实数字员工。完整填写职责、资料范围、执行边界及结构化职责；未选择的技能和资料用空数组，模型可省略或auto。只创建employee，不能创建分身，不安装技能、不写凭据、不授予外发权限。原生审核决定风险审批；成功回执返回真实员工id/version/name及来源会话。',parameters:fullDefinition},
  {name:'teloa_employees_profile',description:'依本人当轮指令修改员工姓名和内置头像。先读取员工详情，传当前expectedVersion及完整expectedProfile；新profile也需完整填写。此操作不改变岗位执行版本、职责或权限，并发资料变化会拒绝覆盖。',parameters:{...versionParameters,expectedProfile:{...profileSpec,required:true},profile:{...profileSpec,required:true}}},
  {name:'teloa_employees_update',description:'依本人当轮明确指令保存员工完整职责及运行定义。先读取身份、版本和姓名头像基线；保留未要求修改的字段。扩大范围、变更能力/资料/模型前按原服务要求先暂停并等待关联工作收口，不能自动停任务。风险与权限提升由原生审核判断；成功后返回原员工与新版本，不另建员工。',parameters:{...versionParameters,expectedProfile:{...profileSpec,required:true},...fullDefinition}},
  {name:'teloa_employees_lifecycle',description:'依本人当轮明确指令暂停、恢复或退役原数字员工。先读取当前版本，说明真实原因；恢复按原权益重新核验，退役可产生待交接任务。不得代替用户主动停止关联运行，不处理个人分身。保留原生风险审核与原服务版本回执。',parameters:{...versionParameters,action:{type:'string',enum:['pause','resume','retire'],required:true},reason:{type:'string',required:true}}},
 ] as const
 for(const definition of definitions){
  ctx.tools.register(defineTool({...definition,output,execute:async(args,exec)=>{
   const authorization=await revalidate(exec,definition.name)
   return safe(async()=>{
    const envelope={schema:'teloa.employee-result/v1' as const,sessionId:authorization.sessionId}
    if(definition.name==='teloa_employees_directory'){
     roleInput(args,[]);return JSON.stringify({...envelope,operation:'directory',roles:await directory(ports)} satisfies EmployeeDirectoryResult)
    }
    if(definition.name==='teloa_employees_get'){
     const row=roleInput(args,['roleId']);return JSON.stringify({...envelope,operation:'get',role:await getEmployee(ports,row.roleId)} satisfies EmployeeToolResult)
    }
    const requestId=requestIdentity(ports.owner,authorization.instruction!,definition.name,exec.callId)
    let result:EmployeeToolResult
    if(definition.name==='teloa_employees_create'){
     const row=roleInput(args,definitionKeys),saved=await ports.roleHandler('roles/create',{requestId,fields:fields(row)}),role=readRole(saved,ports.owner)
     if(role.kind!=='employee')throw new WorkError('teloa/invalid-host-response','创建结果不是数字员工，请先核对目录。')
     result={...envelope,operation:'create',requestId,role}
    }else if(definition.name==='teloa_employees_profile'){
     const row=roleInput(args,['roleId','expectedVersion','expectedProfile','profile']);identity(row)
     const expectedProfile=readRoleProfile(row.expectedProfile),nextProfile=readRoleProfile(row.profile)
     await getEmployee(ports,row.roleId)
     await revalidate(exec,definition.name)
     result={...envelope,operation:'profile',requestId,role:readRole(await ports.roleHandler('roles/profile',{roleId:row.roleId,expectedVersion:row.expectedVersion,expectedProfile,profile:nextProfile}),ports.owner)}
    }else if(definition.name==='teloa_employees_update'){
     const row=roleInput(args,['roleId','expectedVersion','expectedProfile',...definitionKeys]);identity(row)
     const {roleId,expectedVersion,expectedProfile,...definitionFields}=row,current=await getEmployee(ports,roleId)
     const baseline=readRoleProfile(expectedProfile)
     // 真实服务负责版本重试；这里不提前把有效的旧版本幂等回执改判为冲突。
     if(current.version===expectedVersion&&JSON.stringify(profile(current))!==JSON.stringify(baseline))throw new WorkError('teloa/version-conflict','员工姓名头像已变化，请读取当前资料后复核。')
     await revalidate(exec,definition.name)
     result={...envelope,operation:'update',requestId,role:readRole(await ports.roleHandler('roles/edit',{roleId,expectedVersion,expectedProfile:baseline,fields:fields(definitionFields)}),ports.owner)}
    }else{
     const row=roleInput(args,['roleId','expectedVersion','action','reason']);identity(row)
     if(typeof row.action!=='string'||!['pause','resume','retire'].includes(row.action)||typeof row.reason!=='string'||!row.reason.trim()||row.reason.length>4000)throw new WorkError('teloa/invalid-input','员工状态操作或原因不合法。')
     await getEmployee(ports,row.roleId)
     await revalidate(exec,definition.name)
     const saved=roleInput(await ports.lifecycle({...row,reason:row.reason.trim()}),['role','appliedVersion','handoffTaskIds']),role=readRole(saved.role,ports.owner)
     if(!positive(saved.appliedVersion)||saved.appliedVersion!==Number(row.expectedVersion)+1||saved.appliedVersion>role.version||!Array.isArray(saved.handoffTaskIds)||!saved.handoffTaskIds.every(uuid)||new Set(saved.handoffTaskIds).size!==saved.handoffTaskIds.length)throw new WorkError('teloa/invalid-host-response','员工生命周期回执无效，请先核对原员工。')
     result={...envelope,operation:'lifecycle',requestId,role,appliedVersion:saved.appliedVersion,handoffTaskIds:saved.handoffTaskIds}
    }
    if(result.role.id!==('roleId' in args?args.roleId:result.role.id)||result.role.kind!=='employee')throw new WorkError('teloa/invalid-host-response','保存结果未对应原员工，请先核对目录。')
    return JSON.stringify(result)
   })
  }}))
 }
 return ctx.on('tools/pre-execute',async(exec,next):Promise<PreToolDecision>=>{
  if(!names.has(exec.name))return next()
  try{
   const authorization=await authorize(ports,exec,exec.name as EmployeeToolName)
   if(authorization.instruction)instructions.set(exec,authorization.instruction)
  }catch(error){return {kind:'deny',reason:error instanceof WorkError?error.message:'无法核对本人员工管理身份。'}}
  // 原生 auto-review 与权限策略决定 allow/ask/deny，常规配置不被工具统一升级为 ask。
  return next()
 },{prepend:true})
}
