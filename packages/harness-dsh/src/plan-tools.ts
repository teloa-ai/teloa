import {createHash} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import {defineTool,type PreToolDecision} from '@deepseek-ai/dsh-tools'
import {WorkError,isRecord,roleDefinition} from '@teloa/contract'
import type {TaskToolPolicyReader} from './task-tool-guard.ts'
import {authorizeOrdinaryConversationMutation} from './conversation-mutation.ts'

export const planToolNames=['teloa_plans_directory','teloa_plans_list','teloa_plans_get','teloa_plans_history','teloa_plans_create','teloa_plans_change','teloa_plans_update'] as const
type PlanToolName=typeof planToolNames[number]
type PlanEndpoint='plans/list'|'plans/get'|'plans/create'|'plans/change'
type PlanTimezone='Asia/Singapore'|'Asia/Shanghai'|'UTC'
type ConversationBinding={ownerId:string;sessionId:string;status:'pending'|'ready'}

export type PlanToolsPorts={
 owner:string
 conversation:(sessionId:string)=>Promise<ConversationBinding>
 readTaskPolicy:TaskToolPolicyReader
 planHandler:(endpoint:PlanEndpoint,payload:unknown)=>Promise<unknown>
 scheduleHandler:(endpoint:'plans/executions',payload:unknown)=>Promise<unknown>
 roles:{list:(owner:string,input:unknown)=>Promise<unknown>}
 now:()=>string
 timezone:()=>PlanTimezone
}

const names=new Set<string>(planToolNames)
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{
 if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new WorkError('teloa/invalid-input','持续计划工具参数包含未知字段或格式不正确。')
 return value
}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0
const timestamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value
const hostFailure=(label='持续计划')=>new WorkError('teloa/host-unavailable',label+'服务暂不可用，请重试并先核对目录。')

function requestIdentity(owner:string,sessionId:string,name:string,callId:string):string{
 const hash=createHash('sha256').update(['teloa-plan-tool/v1',owner,sessionId,name,callId].join('\0')).digest('hex')
 return `${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`
}

async function authorize(ports:Pick<PlanToolsPorts,'owner'|'conversation'|'readTaskPolicy'>,exec:{agent?:{session:{id:string;header:{origin?:string}}};signal:AbortSignal},label='持续计划'):Promise<string>{
 return (await authorizeOrdinaryConversationMutation({...ports,...(exec.agent?{agent:exec.agent}:{}),signal:exec.signal},label+'管理')).sessionId
}

async function safe<T>(operation:()=>Promise<T>,label='持续计划'):Promise<T>{
 try{return await operation()}catch(error){if(error instanceof WorkError)throw error;throw hostFailure(label)}
}

function roleDirectory(value:unknown,owner:string):{id:string;version:number;name:string;scopes:string[]}[]{
 if(!Array.isArray(value))throw new WorkError('teloa/invalid-host-response','员工目录返回格式不正确。')
 const result=[] as {id:string;version:number;name:string;scopes:string[]}[]
 for(const item of value){
  try{
   const row=exact(item,['id','ownerId','version','state','createdAt','updatedAt','name','kind','scopes','duty','dataScope','executionScope','skills','knowledge','responsibility','runtimeConfig'])
   const definition=roleDefinition({name:row.name,kind:row.kind,scopes:row.scopes,duty:row.duty,dataScope:row.dataScope,executionScope:row.executionScope,skills:row.skills,knowledge:row.knowledge,...(row.responsibility===undefined?{}:{responsibility:row.responsibility}),...(row.runtimeConfig===undefined?{}:{runtimeConfig:row.runtimeConfig})})
   if(!uuid(row.id)||row.ownerId!==owner||!positive(row.version)||!timestamp(row.createdAt)||!timestamp(row.updatedAt))throw Error()
   if(typeof row.state!=='string'||!['active','paused','retired'].includes(row.state))throw Error()
   if(row.state==='active'&&definition.kind==='employee')result.push({id:row.id,version:row.version,name:definition.name,scopes:definition.scopes})
  }catch(error){if(error instanceof WorkError&&error.code==='teloa/invalid-host-response')throw error;throw new WorkError('teloa/invalid-host-response','员工目录返回了无效或跨本人的记录。')}
 }
 return result
}

const emptyParameters={} as const
const planIdParameters={planId:{type:'string',required:true}} as const
const cursorSpec={type:'object',additionalProperties:false,properties:{claimedAt:{type:'string',required:true},claimId:{type:'string',required:true}}} as const
const historyParameters={planId:{type:'string',required:true},limit:{type:'integer',required:true},cursor:cursorSpec} as const
const createParameters={title:{type:'string',required:true},goal:{type:'string',required:true},scope:{type:'string',required:true},dataScope:{type:'string',required:true},delivery:{type:'string',required:true},notificationPolicy:{type:'string',enum:['always','attention','failure','silent'],required:true},roleId:{type:'string',required:true},expectedRoleVersion:{type:'integer',required:true},cadence:{type:'string',enum:['daily','weekly'],required:true},weekday:{type:'integer',enum:[1,2,3,4,5,6,7],required:true},time:{type:'string',required:true},timezone:{type:'string',enum:['Asia/Singapore','Asia/Shanghai','UTC'],required:true}} as const
const changeParameters={planId:{type:'string',required:true},expectedVersion:{type:'integer',required:true},action:{type:'string',enum:['enable','pause','archive'],required:true},note:{type:'string'}} as const
const updateParameters={planId:{type:'string',required:true},expectedVersion:{type:'integer',required:true},expectedConfigVersion:{type:'integer',required:true},title:{type:'string',required:true},goal:{type:'string',required:true},dataScope:{type:'string',required:true},delivery:{type:'string',required:true},notificationPolicy:{type:'string',enum:['always','attention','failure','silent'],required:true},cadence:{type:'string',enum:['daily','weekly'],required:true},weekday:{type:'integer',enum:[1,2,3,4,5,6,7],required:true},time:{type:'string',required:true},timezone:{type:'string',enum:['Asia/Singapore','Asia/Shanghai','UTC'],required:true}} as const
const output={schema:{type:'string'} as const,render:(_args:unknown,value:string)=>[{type:'text' as const,text:value}]}

export function registerPlanTools(ctx:Context,ports:PlanToolsPorts){
 const definitions=[
  {name:'teloa_plans_directory' as const,description:'列出本人可负责持续计划的在岗员工及业务范围，并返回宿主当前时间和默认日程时区。创建前先调用；不要猜员工身份或版本。',parameters:emptyParameters},
  {name:'teloa_plans_list' as const,description:'列出本人真实持续计划。按返回的计划身份和版本操作；未知写入结果先调用本工具核对。',parameters:emptyParameters},
  {name:'teloa_plans_get' as const,description:'读取本人一项真实持续计划的固定定义、状态和版本。计划身份必须来自目录。',parameters:planIdParameters},
  {name:'teloa_plans_history' as const,description:'分页读取本人一项持续计划的真实领取和执行历史。',parameters:historyParameters},
  {name:'teloa_plans_create' as const,description:'创建本人持续计划，来源固定为手工创建，结果固定为暂停；必须由本人核对通知策略，策略只决定主动提醒方式，不影响领取、执行和历史记录。不支持 Cron、事件触发或模板来源。先查员工目录并使用返回的员工身份和版本。',parameters:createParameters},
  {name:'teloa_plans_change' as const,description:'启用、暂停或归档本人持续计划。启用和归档需要本人原生确认；未知结果先查目录，不能盲目重建。',parameters:changeParameters},
  {name:'teloa_plans_update' as const,description:'更新本人持续计划的目标、资料范围、交付方式、通知策略和日程。员工、业务范围和来源保持固定。更新会改变下一次调度配置，必须本人原生确认；先读取计划取得两个当前版本。',parameters:updateParameters},
 ] as const
 for(const definition of definitions){
  ctx.tools.register(defineTool({...definition,output,execute:async(args,exec)=>{
   const sessionId=await authorize(ports,exec)
   return safe(async()=>{
    let value:unknown
    if(definition.name==='teloa_plans_directory'){
     exact(args,[]);const observedAt=ports.now(),defaultTimezone=ports.timezone()
     if(!timestamp(observedAt)||!['Asia/Singapore','Asia/Shanghai','UTC'].includes(defaultTimezone))throw hostFailure()
     value={observedAt,defaultTimezone,roles:roleDirectory(await ports.roles.list(ports.owner,{}),ports.owner)}
    }else if(definition.name==='teloa_plans_list'){
     exact(args,[]);value=await ports.planHandler('plans/list',{})
    }else if(definition.name==='teloa_plans_get'){
     const row=exact(args,['planId']);value=await ports.planHandler('plans/get',{planId:row.planId})
    }else if(definition.name==='teloa_plans_history'){
     const row=exact(args,['planId','limit','cursor']);if('cursor' in row)exact(row.cursor,['claimedAt','claimId'])
     value=await ports.scheduleHandler('plans/executions',row)
    }else if(definition.name==='teloa_plans_create'){
     const row=exact(args,['title','goal','scope','dataScope','delivery','notificationPolicy','roleId','expectedRoleVersion','cadence','weekday','time','timezone'])
     const requestId=requestIdentity(ports.owner,sessionId,definition.name,String(exec.callId))
     const {cadence,weekday,time,timezone,...fields}=row
     const plan=await ports.planHandler('plans/create',{requestId,fields:{...fields,trigger:{kind:'schedule',cadence,weekday,time,timezone}},source:{kind:'manual'}})
     value={requestId,plan}
    }else if(definition.name==='teloa_plans_change'){
     const row=exact(args,['planId','expectedVersion','action','note'])
     const requestId=requestIdentity(ports.owner,sessionId,definition.name,String(exec.callId))
     value={requestId,plan:await ports.planHandler('plans/change',{...row,requestId})}
    }else{
     const row=exact(args,['planId','expectedVersion','expectedConfigVersion','title','goal','dataScope','delivery','notificationPolicy','cadence','weekday','time','timezone'])
     const requestId=requestIdentity(ports.owner,sessionId,definition.name,String(exec.callId))
     const {planId,expectedVersion,expectedConfigVersion,title,goal,dataScope,delivery,notificationPolicy,cadence,weekday,time,timezone}=row
     value={requestId,plan:await ports.planHandler('plans/change',{planId,expectedVersion,expectedConfigVersion,requestId,action:'update',fields:{title,goal,dataScope,delivery,notificationPolicy,trigger:{kind:'schedule',cadence,weekday,time,timezone}}})}
    }
    return JSON.stringify(value)
   })
  }}))
 }
 return ctx.on('tools/pre-execute',async(exec,next):Promise<PreToolDecision>=>{
  if(!names.has(exec.name))return next()
  try{await authorize(ports,exec)}catch(error){return {kind:'deny',reason:error instanceof WorkError?error.message:'无法核对持续计划管理身份。'}}
  const decision=await next()
  if(decision.kind!=='allow'||!['teloa_plans_change','teloa_plans_update'].includes(exec.name))return decision
  const row=exec.name==='teloa_plans_change'?exact(exec.arguments,['planId','expectedVersion','action','note']):exact(exec.arguments,['planId','expectedVersion','expectedConfigVersion','title','goal','dataScope','delivery','notificationPolicy','cadence','weekday','time','timezone'])
  if(exec.name==='teloa_plans_change'&&row.action!=='enable'&&row.action!=='archive')return decision
  try{
   const plan=await safe(()=>ports.planHandler('plans/get',{planId:row.planId}))
   const record=isRecord(plan)?plan:{},title=typeof record.title==='string'?record.title:'该持续计划',trigger=isRecord(record.trigger)?record.trigger:{},timezone=typeof trigger.timezone==='string'?trigger.timezone:'未知时区',time=typeof trigger.time==='string'?trigger.time:'未知时间'
   const cadence=trigger.cadence==='daily'?`每天 ${time}`:trigger.cadence==='weekly'?`每周${String(trigger.weekday)} ${time}`:`未知日程 ${time}`
   return {kind:'ask',reason:exec.name==='teloa_plans_update'?`确认更新持续计划“${title}”的下次日程和交付配置？`:`确认${row.action==='enable'?'启用':'归档'}持续计划“${title}”（${cadence}，${timezone}）？`}
  }catch(error){return {kind:'deny',reason:error instanceof WorkError?error.message:'无法读取持续计划，已拒绝操作。'}}
 })
}

export {authorize as authorizePlanManagement,requestIdentity as planRequestIdentity,safe as safePlanOperation}
