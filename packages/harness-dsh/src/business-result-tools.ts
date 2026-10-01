import type {Context} from '@deepseek-ai/cordis'
import {defineTool,type PreToolDecision,type ToolExecution} from '@deepseek-ai/dsh-tools'
import {WorkError,businessDashboardLimits,businessScopeKeyRule,isBusinessScopeKey,readBusinessDashboardPage,readBusinessWidgetDefinition,taskInput} from '@teloa/contract'
import type {BusinessDashboardService,BusinessDefinitionSourceReader,BusinessSyncService,BusinessWidgetService} from '@teloa/backend'
import type {TaskToolPolicyReader} from './task-tool-guard.ts'

export const businessResultToolNames=['teloa_business_result_record','teloa_business_dashboard_read','teloa_business_sql_trial'] as const
type ToolName=typeof businessResultToolNames[number]
type SqlPool={connect:()=>Promise<{query:(sql:string)=>Promise<unknown>;release:()=>void}>}
export type BusinessResultToolsPorts={
 owner:string
 conversation:(sessionId:string)=>Promise<{ownerId:string;sessionId:string;status:'pending'|'ready'}>
 readTaskPolicy:TaskToolPolicyReader
 /** 任务会话绑定的业务范围（任务来源对象所在范围）；未绑定业务为 null。主会话不调。 */
 readBusinessScope:(sessionId:string,signal:AbortSignal)=>Promise<string|null>
 /** `pool` 只用于在只读可重复读事务里读本范围生效声明（试算的逻辑表），不执行任何用户 SQL。 */
 services:()=>Promise<{sync:BusinessSyncService;dashboards:BusinessDashboardService;widgets:BusinessWidgetService;definitions:Pick<BusinessDefinitionSourceReader,'forScope'>;pool:SqlPool}>
 scopeIds:()=>Promise<readonly string[]>
}

/** 一次成果记录的条数上限（同步服务自身上限 100，工具侧收紧到 50）。 */
const recordItemsLimit=50
/** 试算回给模型的行数上限：查询仍按完整执行边界跑，只截返回。 */
const trialRows=50
const keys:Record<ToolName,readonly string[]>={teloa_business_result_record:['scope','mappingId','items'],teloa_business_dashboard_read:['scope','dashboardId'],teloa_business_sql_trial:['scope','sql']}
const names=new Set<string>(businessResultToolNames)
const forbidden=(message:string)=>new WorkError('teloa/forbidden',message)
const invalid=(message:string)=>new WorkError('teloa/invalid-input',message)
const localId=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/.test(value)

type Input={scope:string;mappingId?:string;items?:unknown[];dashboardId?:string;sql?:string}
function argumentsOf(name:ToolName,args:unknown):Input{
 const row=taskInput(args,keys[name])
 if(!isBusinessScopeKey(row.scope)||row.scope==='general')throw invalid('需要明确的业务范围：'+businessScopeKeyRule+'，不能是通用工作（general）。')
 const scope=row.scope
 if(name==='teloa_business_result_record'){
  if(!localId(row.mappingId))throw invalid('数据源映射标识不合法。')
  if(!Array.isArray(row.items)||!row.items.length||row.items.length>recordItemsLimit)throw invalid('成果条目必须是 1 到 '+recordItemsLimit+' 条。')
  return {scope,mappingId:row.mappingId,items:row.items}
 }
 if(name==='teloa_business_dashboard_read'){
  if(!localId(row.dashboardId))throw invalid('看板标识不合法。')
  return {scope,dashboardId:row.dashboardId}
 }
 if(typeof row.sql!=='string'||!row.sql.trim())throw invalid('需要一条只读 SQL。')
 if(new TextEncoder().encode(row.sql).byteLength>businessDashboardLimits.sqlBytes)throw invalid('SQL 超过 '+businessDashboardLimits.sqlBytes+' 字节。')
 return {scope,sql:row.sql}
}

/**
 * AI 员工成果与看板读取工具（规格 §7 一期权限）：
 *  - `teloa_business_result_record`：只允许任务会话（有任务策略且本工具在授权清单内）且会话绑定了业务；映射必须是 `role-result`；
 *    写入本人登记范围，来源标识固定为 `role-result:` + 会话前 8 位。
 *  - `teloa_business_dashboard_read`：主会话与任务会话都可；只读结果快照，不触发刷新。
 *  - `teloa_business_sql_trial`：主会话与任务会话都可；白名单 → 改写 → 执行边界内试算，≤ 50 行（超出时 `truncated:true` 并给 `totalRows`），不落库；SQL 不合规在返回值里给出原因。
 * 主会话可读本人任一登记范围；任务会话（AI 员工）只能用于**会话绑定的业务范围**（任务来源对象所在范围），未绑定业务一律拒绝——
 * 不继承本人的全量视野（与 `resources.ts` 资料授权同一原则）。
 * 三者身份不符在前置守卫一律 deny，正文执行时再核一次（确认期间身份可能变化）。任务会话没有刷新、同步与声明草案的写口。
 */
export function registerBusinessResultTools(ctx:Context,ports:BusinessResultToolsPorts):()=>void{
 /** taskScope：主会话为 undefined（不收窄）；任务会话为其绑定的业务范围。 */
 async function identity(name:ToolName,exec:Pick<ToolExecution,'agent'|'signal'>):Promise<{sessionId:string;taskScope:string|undefined}>{
  if(!exec.agent)throw forbidden('业务看板工具需要真实会话。')
  const session=exec.agent.session,sessionId=session.id
  if(session.header.origin==='subagent')throw forbidden('子 Agent 会话不能使用业务看板工具。')
  let binding:Awaited<ReturnType<BusinessResultToolsPorts['conversation']>>,policy:Awaited<ReturnType<TaskToolPolicyReader>>
  try{[binding,policy]=await Promise.all([ports.conversation(sessionId),ports.readTaskPolicy(sessionId,exec.signal)])}
  catch(error){if(error instanceof WorkError)throw error;throw new WorkError('teloa/dependency-unavailable','暂时无法核对会话身份。')}
  if(binding.ownerId!==ports.owner||binding.sessionId!==sessionId||binding.status!=='ready')throw forbidden('当前会话未绑定为本人可用工作会话。')
  if(policy?.stopRequested===true)throw forbidden('本次执行已请求停止。')
  if(name==='teloa_business_result_record'&&(policy===null||!policy.allowedTools.includes(name)))throw forbidden('成果记录只允许任务会话。')
  if(name!=='teloa_business_result_record'&&policy!==null&&!policy.allowedTools.includes(name))throw forbidden('当前任务未授权使用此工具。')
  let taskScope:string|undefined
  if(policy!==null){
   let bound:string|null
   try{bound=await ports.readBusinessScope(sessionId,exec.signal)}catch{bound=null}
   if(bound===null)throw forbidden(name==='teloa_business_result_record'?'成果记录只允许绑定了业务的任务会话。':'任务会话只能读取其绑定业务范围的看板，当前任务未绑定业务。')
   taskScope=bound
  }
  exec.signal.throwIfAborted()
  return {sessionId,taskScope}
 }
 async function actorFor(scope:string,taskScope:string|undefined){
  if(taskScope!==undefined&&scope!==taskScope)throw forbidden('任务会话只能使用其绑定的业务范围。')
  const scopes=[...await ports.scopeIds()]
  if(!scopes.includes(scope))throw forbidden('当前主体未获准读取此业务范围。')
  return {ownerId:ports.owner,scopeIds:taskScope===undefined?scopes:[scope]}
 }
 async function roleResultMapping(scope:string,mappingId:string,taskScope:string|undefined){
  const actor=await actorFor(scope,taskScope),{sync}=await ports.services()
  const mapping=(await sync.mappings(actor,scope)).find(item=>item.id===mappingId)
  if(!mapping)throw invalid('数据源映射不存在于本业务范围。')
  if(mapping.source.kind!=='role-result')throw forbidden('成果记录只接受 AI 员工成果映射（role-result）。')
  return {actor,sync}
 }
 async function sqlTrial(scope:string,sql:string,taskScope:string|undefined,signal:AbortSignal):Promise<unknown>{
  await actorFor(scope,taskScope)
  let widget
  try{widget=readBusinessWidgetDefinition({format:'teloa.business-widget/v1',id:'sql-trial',version:'1.0.0',domain:scope,title:'SQL 试算',kind:'table',query:sql})}
  catch(error){if(error instanceof WorkError)return {error:{code:error.code,reason:error.message}};throw error}
  const {pool,definitions,widgets}=await ports.services(),db=await pool.connect()
  let bundles
  try{
   await db.query('begin isolation level repeatable read read only')
   bundles=await definitions.forScope(db as never,ports.owner,scope)
   await db.query('commit')
  }catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
  const result=await widgets.compute({ownerId:ports.owner,scope,now:new Date().toISOString(),objectTypes:bundles.flatMap(bundle=>bundle.objectTypes).map(record=>record.definition),views:bundles.flatMap(bundle=>bundle.views)},widget,undefined,signal)
  if(result.status==='failed')return {error:result.error}
  // 查询按完整执行边界跑完，这里只截返回给模型的行；截了就告诉模型（truncated + 截断前行数），免得它把前 50 行当成全部。
  const rows=result.rows.slice(0,trialRows)
  return {columns:result.columns,rows,rowCount:rows.length,truncated:result.rows.length>rows.length,totalRows:result.rows.length}
 }

 const definitions=[
  {name:businessResultToolNames[0],description:'把本次任务得出的业务成果按 AI 员工成果映射记为业务对象（本人范围，1–50 条）。只在绑定了业务的任务会话可用；条目字段按映射声明的路径取值。',parameters:{scope:{type:'string',required:true},mappingId:{type:'string',required:true},items:{type:'array',items:{type:'object',additionalProperties:true},required:true}}},
  {name:businessResultToolNames[1],description:'读取本人一张业务看板的最近结果快照（不触发刷新）：看板声明、组件声明与各组件结果、更新时刻。',parameters:{scope:{type:'string',required:true},dashboardId:{type:'string',required:true}}},
  {name:businessResultToolNames[2],description:'在看板执行边界内试算一条只读 SQL（逻辑表为本范围对象类型），最多返回 50 行，不保存。SQL 不合规时返回 error.reason，据此修改后再试。',parameters:{scope:{type:'string',required:true},sql:{type:'string',required:true}}},
 ] as const
 // 三个工具参数各不相同：类型上只保留公共的 scope（参数由 argumentsOf 严格核对），运行时 schema 原样注册。
 for(const definition of definitions)ctx.tools.register(defineTool({...definition,parameters:definition.parameters as {readonly scope:{readonly type:'string';readonly required:true}},output:{schema:{type:'string'} as const,render:(_args:unknown,value:string)=>[{type:'text' as const,text:value}]},execute:async(args,exec)=>{
  const {sessionId,taskScope}=await identity(definition.name,exec),input=argumentsOf(definition.name,args)
  let value:unknown
  if(definition.name==='teloa_business_result_record'){
   const {actor,sync}=await roleResultMapping(input.scope,input.mappingId!,taskScope)
   value=await sync.ingest(actor,{scope:input.scope,mappingId:input.mappingId!,items:input.items!,sourceId:'role-result:'+sessionId.slice(0,8)},exec.signal)
  }else if(definition.name==='teloa_business_dashboard_read'){
   const actor=await actorFor(input.scope,taskScope),{dashboards}=await ports.services()
   const page=await dashboards.read(actor,{scope:input.scope,dashboardId:input.dashboardId!})
   value=readBusinessDashboardPage(page,input.scope)
  }else value=await sqlTrial(input.scope,input.sql!,taskScope,exec.signal)
  exec.signal.throwIfAborted()
  return JSON.stringify(value)
 }}))
 return ctx.on('tools/pre-execute',async(exec,next):Promise<PreToolDecision>=>{
  if(!names.has(exec.name))return next()
  try{
   const name=exec.name as ToolName
   const {taskScope}=await identity(name,exec)
   const input=argumentsOf(name,exec.arguments)
   if(name==='teloa_business_result_record')await roleResultMapping(input.scope,input.mappingId!,taskScope)
   else await actorFor(input.scope,taskScope)
  }catch(error){return {kind:'deny',reason:error instanceof WorkError?error.message:'暂时无法核对业务看板工具身份。'}}
  return next()
 })
}
