type Stop=()=>void|Promise<void>

/** Cordis 独立 effect 并行卸载；数据库显式等待后台循环停止及回填结束。 */
export function createHostShutdown(close:Stop){
 const callbacks:Stop[]=[]
 let stopping:Promise<void>|undefined
 const beforeClose=(stop:Stop)=>{
  if(stopping)throw Error('宿主正在关闭，不能注册后台循环。')
  callbacks.push(stop)
 }
 const stop=():Promise<void>=>stopping??=(async()=>{
  const results=await Promise.allSettled(callbacks.map(callback=>Promise.resolve().then(callback)))
  await close()
  const errors=results.flatMap(result=>result.status==='rejected'?[result.reason]:[])
  if(errors.length)throw new AggregateError(errors,'后台循环关闭失败。')
 })()
 return {beforeClose,stop}
}
