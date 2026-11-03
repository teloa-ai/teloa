export type CitationActivationState<T>={status:'loading'}|{status:'unavailable'}|{status:'ready';value:T}
/** 每次激活先撤去旧正文，再核验；取消或失活后的晚答不能恢复正文。 */
export function watchCitationActivation<T>(port:{focus:EventTarget;visibility:EventTarget;visible:()=>boolean;current:()=>boolean;read:(signal:AbortSignal)=>Promise<T>;publish:(state:CitationActivationState<T>)=>void}):()=>void{
 let live=true,revision=0,abort:AbortController|undefined
 const refresh=()=>{
  const turn=++revision;abort?.abort();abort=new AbortController();const signal=abort.signal
  if(!port.visible()||!port.current()){port.publish({status:'unavailable'});return}
  port.publish({status:'loading'})
  void Promise.resolve().then(()=>{signal.throwIfAborted();return port.read(signal)}).then(value=>{
   if(live&&turn===revision&&!signal.aborted)port.publish(port.visible()&&port.current()?{status:'ready',value}:{status:'unavailable'})
  },()=>{if(live&&turn===revision&&!signal.aborted)port.publish({status:'unavailable'})})
 }
 port.focus.addEventListener('focus',refresh);port.visibility.addEventListener('visibilitychange',refresh);refresh()
 return()=>{live=false;++revision;abort?.abort();port.focus.removeEventListener('focus',refresh);port.visibility.removeEventListener('visibilitychange',refresh)}
}
