import type {Context} from '@deepseek-ai/cordis'
import {defineTool,type PreToolDecision} from '@deepseek-ai/dsh-tools'
import {WorkError,taskInput} from '@teloa/contract'
import {authorizePlanManagement,planRequestIdentity,safePlanOperation,type PlanToolsPorts} from './plan-tools.ts'
export const industryPlanToolNames=['teloa_industry_plans_directory','teloa_industry_plans_preview','teloa_industry_plans_create','teloa_industry_plans_source'] as const
export type IndustryPlanToolsPorts=Pick<PlanToolsPorts,'owner'|'conversation'|'readTaskPolicy'>&{
 directory:()=>Promise<unknown>
 handler:(method:string,payload:unknown)=>Promise<unknown>
}
const item={loadId:{type:'string',required:true},itemInstanceId:{type:'string',required:true}} as const
const parameters={...item,goal:{type:'string',required:true},delivery:{type:'string',required:true},notificationPolicy:{type:'string',enum:['always','attention','failure','silent'],required:true},roleId:{type:'string',required:true},expectedRoleVersion:{type:'integer',required:true},cadence:{type:'string',enum:['daily','weekly'],required:true},weekday:{type:'integer',enum:[1,2,3,4,5,6,7],required:true},time:{type:'string',required:true},timezone:{type:'string',enum:['Asia/Singapore','Asia/Shanghai','UTC'],required:true}} as const
const names=new Set<string>(industryPlanToolNames)
/** 行业入口复用普通计划管理身份与原生工具闸；创建始终暂停，启用仍走 plans/change。 */
export function registerIndustryPlanTools(ctx:Context,ports:IndustryPlanToolsPorts){
 const definitions=[
  {name:'teloa_industry_plans_directory' as const,description:'列出本人已加载行业的计划模板与真实关联员工。先查询身份，不猜load/item/role。模板和员工提示不表示已授权。',parameters:{}},
  {name:'teloa_industry_plans_preview' as const,description:'读取一个已加载行业计划的固定方法、资料说明、交付和默认日程。创建前核对预览，不能改用manual丢失行业来源。',parameters:item},
  {name:'teloa_industry_plans_create' as const,description:'从固定行业计划模板创建真实暂停计划。用目录和预览返回的身份与当前在岗员工版本；填写目标、交付、日程并由本人明确选择通知策略。通知只控制主动提醒，执行事实始终保存；启用另走原生确认。',parameters},
  {name:'teloa_industry_plans_source' as const,description:'读取本人真实计划的固定行业创建依据，普通计划返回空来源。',parameters:{planId:{type:'string',required:true}}},
 ] as const
 for(const definition of definitions)ctx.tools.register(defineTool({...definition,output:{schema:{type:'string'} as const,render:(_args:unknown,value:string)=>[{type:'text' as const,text:value}]},execute:async(args,exec)=>{
  const sessionId=await authorizePlanManagement(ports,exec)
  return safePlanOperation(async()=>{
   if(definition.name==='teloa_industry_plans_directory'){taskInput(args,[]);return JSON.stringify(await ports.directory())}
   if(definition.name==='teloa_industry_plans_preview'){const row=taskInput(args,['loadId','itemInstanceId']);return JSON.stringify(await ports.handler('industry-plans/preview',row))}
   if(definition.name==='teloa_industry_plans_source'){const row=taskInput(args,['planId']);return JSON.stringify(await ports.handler('industry-plans/source',row))}
   const row=taskInput(args,['loadId','itemInstanceId','goal','delivery','notificationPolicy','roleId','expectedRoleVersion','cadence','weekday','time','timezone']),{cadence,weekday,time,timezone,...input}=row,requestId=planRequestIdentity(ports.owner,sessionId,definition.name,String(exec.callId))
   return JSON.stringify({requestId,...await ports.handler('industry-plans/create',{...input,requestId,trigger:{kind:'schedule',cadence,weekday,time,timezone}}) as object})
  })
 }}))
 return ctx.on('tools/pre-execute',async(exec,next):Promise<PreToolDecision>=>{
  if(!names.has(exec.name))return next()
  try{await authorizePlanManagement(ports,exec)}catch(error){return {kind:'deny',reason:error instanceof WorkError?error.message:'无法核对行业计划管理身份。'}}
  return next()
 })
}
