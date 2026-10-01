/**
 * 已打开的正式群只做一次延迟重读；成功回传仍完全由服务端群消息目录决定。
 * 页面收到新目录后会重新渲染并安排下一轮，卸载或切群时取消这次读取。
 */
export function scheduleGroupMessageRefresh(refresh:()=>Promise<void>,schedule:(work:()=>void)=>()=>void=work=>{
 const timer=setTimeout(work,4000)
 return ()=>clearTimeout(timer)
}):()=>void{
 let cancelled=false
 const cancelTimer=schedule(()=>{if(!cancelled)void refresh().catch(()=>undefined)})
 return ()=>{cancelled=true;cancelTimer()}
}
