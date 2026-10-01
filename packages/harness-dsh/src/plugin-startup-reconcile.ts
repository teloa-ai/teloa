type Ports={list:()=>Promise<string[]>;reconcile:(id:string)=>Promise<unknown>;report:(id:string,code:string)=>void}
/** 只从错误里取契约错误码；宿主日志不落 message，避免把内部细节写进日志。 */
export const codeOf=(error:unknown,fallback:string)=>
 error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'&&/^teloa\/[a-z-]+$/.test(error.code)?error.code:fallback

/**
 * 插件安装的中断只会跨重启发生，所以这是一次性核对而不是周期循环：
 * 每两秒读一遍 node_modules 没有意义，代价却是实打实的磁盘 IO。
 * 串行、单条失败不阻塞其余、错误只记告警——装配流程不能被一条坏记录挡住。
 */
export async function reconcileInterruptedPluginInstallations(ports:Ports):Promise<void>{
 let ids:string[]
 try{ids=await ports.list()}catch(error){ports.report('directory',codeOf(error,'teloa/storage-corrupt'));return}
 for(const id of ids){
  try{await ports.reconcile(id)}catch(error){ports.report(id,codeOf(error,'teloa/dependency-unavailable'))}
 }
}
