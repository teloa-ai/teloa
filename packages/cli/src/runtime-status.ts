type ActivityHost={agents:{list:()=>Array<{status:string;whenIdle:()=>Promise<void>}>};jobs:{list:()=>Array<{status:string}>};sessions:{list:()=>Array<{id:string}>};terminalController:{list:(id:string)=>Array<{state:string}>}}
export async function readRuntimeActivity(host:ActivityHost){
 const agents=host.agents.list(),jobs=host.jobs.list(),terminals=host.sessions.list().flatMap(session=>host.terminalController.list(session.id))
 if(agents.some(row=>!['idle','running','disposed'].includes(row.status))||jobs.some(row=>!['running','stopping','completed','killed','failed'].includes(row.status))||terminals.some(row=>!['running','exited','failed'].includes(row.state)))throw Error('无法确认完整运行状态。')
 const busy=await Promise.all(agents.map(async agent=>{
  if(agent.status==='running')return true
  let timer:ReturnType<typeof setTimeout>|undefined
  try{return await Promise.race([agent.whenIdle().then(()=>false),new Promise<boolean>(done=>{timer=setTimeout(()=>done(true),20)})])}finally{clearTimeout(timer)}
 }))
 const result={agents:busy.filter(Boolean).length,jobs:jobs.filter(row=>row.status==='running'||row.status==='stopping').length,terminals:terminals.filter(row=>row.state==='running').length}
 return {...result,active:result.agents+result.jobs+result.terminals}
}
export function assertClientReady(graph:{entries:Array<{id:string}>}):void{
 const ids=new Set(graph.entries.map(entry=>entry.id))
 if(['@teloa/client-ui-workbench','@deepseek-ai/dsh-client-ui-conversation','@deepseek-ai/dsh-client-ui-workspace','@teloa/native-gateway'].some(id=>!ids.has(id)))throw Error('工作台客户端尚未完整注册。')
}
export function assertRuntimeGuard(host:{webServer:{teloaAdmissionGuard?:unknown};typertGateway:{teloaAdmissionGuard?:unknown}},gate:unknown){
 if(!gate||host.webServer.teloaAdmissionGuard!==gate||host.typertGateway.teloaAdmissionGuard!==gate)throw Error('原生安装接单闸门未装配。')
}
export const inject=['agents','jobs','sessions','terminalController','connection','clientModules','webServer','typertGateway']
/** 仅 npm 原生发行装配的只读管理通道；复用宿主认证，不暴露凭据、内容或进程信号。 */
export async function apply(ctx:ActivityHost&{webServer:{teloaAdmissionGuard?:unknown};typertGateway:{teloaAdmissionGuard?:unknown};clientModules:{graph:()=>{entries:Array<{id:string}>}};connection:{rpc:{handle:(path:string,handler:(endpoint:string,payload:unknown)=>Promise<unknown>)=>unknown}}}):Promise<void>{
 const {loadAdmission}=await import('./runtime-admission.ts'),gate=await loadAdmission()
 ctx.connection.rpc.handle('/teloa-local-runtime',async(endpoint,payload)=>{
  if(!['activity','readiness','quiesce','resume','sealed'].includes(endpoint)||!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).length)return {ok:false,error:{code:'invalid-request',message:'无效的运行状态请求。'}}
  try{
   assertClientReady(ctx.clientModules.graph());assertRuntimeGuard(ctx,gate)
   if(endpoint==='quiesce'){await gate.quiesce();return {ok:true,value:{sealed:true}}}
   if(endpoint==='resume'){gate.resume();return {ok:true,value:{sealed:false}}}
   if(endpoint==='sealed'){gate.assertQuiescent();return {ok:true,value:{sealed:true}}}
   return {ok:true,value:endpoint==='readiness'?{ready:true}:await readRuntimeActivity(ctx)}
  }catch{return {ok:false,error:{code:'runtime-unavailable',message:'工作台仍有请求待收尾，或运行状态尚未就绪。'}}}
 })
}
