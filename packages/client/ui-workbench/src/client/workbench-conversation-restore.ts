import type {BindingClient} from './binding-client.js'

type SessionSource={getSnapshot():string|undefined;subscribe(listener:()=>void):()=>void}
type RestoreWork=Pick<BindingClient,'refreshDirectory'|'getDirectorySnapshot'|'getSnapshot'|'subscribe'|'openSessionResult'>
const unavailable=()=>Object.assign(Error(),{code:'teloa/source-unavailable'})

/** 地址代表本人仍有效的读取意图；连接的默认回填不能替换它，新导航则立即取消。 */
export async function restoreWorkbenchConversation(work:RestoreWork,mainSession:SessionSource,id:string,current:()=>boolean,navigationSignal?:AbortSignal):Promise<string|undefined>{
 const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(),12000)
 const valid=()=>current()&&!navigationSignal?.aborted
 const cancel=()=>deadline.abort()
 navigationSignal?.addEventListener('abort',cancel,{once:true})
 if(navigationSignal?.aborted)cancel()
 const read=async<T>(request:Promise<T>):Promise<T|undefined>=>{
  let aborted=()=>{}
  try{return await Promise.race([request,new Promise<undefined>((resolve,reject)=>{
   aborted=()=>{if(!valid())resolve(undefined);else if(deadline.signal.aborted)reject(unavailable())}
   deadline.signal.addEventListener('abort',aborted,{once:true});aborted()
  })])}finally{deadline.signal.removeEventListener('abort',aborted)}
 }
 const wait=async(ready:()=>boolean):Promise<boolean>=>{
  if(!valid())return false
  if(deadline.signal.aborted)throw unavailable()
  if(ready())return true
  const cleanups:(()=>void)[]=[]
  try{return await new Promise<boolean>((resolve,reject)=>{
   const check=()=>{if(!valid())resolve(false);else if(deadline.signal.aborted)reject(unavailable());else if(ready())resolve(true)}
   cleanups.push(mainSession.subscribe(check),work.subscribe(check))
   navigationSignal?.addEventListener('abort',check,{once:true});deadline.signal.addEventListener('abort',check,{once:true})
   cleanups.push(()=>navigationSignal?.removeEventListener('abort',check),()=>deadline.signal.removeEventListener('abort',check))
   check()
  })}finally{for(const dispose of cleanups)dispose()}
 }
 try{
  if(!valid())return
  // 返回本次读取的行，不借用可能已被目录订阅下一轮刷新覆盖的加载状态。
  const rows=await read(work.refreshDirectory(deadline.signal))
  if(!valid())return
  if(!rows)throw work.getDirectorySnapshot().error??unavailable()
  const row=rows.find(row=>row.id===id&&row.status==='ready')
  if(!row)throw unavailable()
  while(await wait(()=>{
   const selected=mainSession.getSnapshot(),binding=work.getSnapshot()
   return selected!==undefined&&binding.sessionId===selected&&binding.status!=='loading'
  })){
   const before=work.getSnapshot(),selected=mainSession.getSnapshot()
   const opened=await read(work.openSessionResult(row.sessionId,deadline.signal,valid))
   if(!valid())return
   if(opened==='cancelled'){
    // 只有连接回填确实改变了绑定时才继续同一读取意图，不重做没有状态变化的取消。
    if(before===work.getSnapshot()&&selected===mainSession.getSnapshot())return
    continue
   }
   if(await wait(()=>{
    const binding=work.getSnapshot()
    return mainSession.getSnapshot()===row.sessionId&&binding.status==='ready'&&binding.conversation?.id===row.id&&binding.conversation.sessionId===row.sessionId
   }))return row.sessionId
   return
  }
 }finally{clearTimeout(timer);navigationSignal?.removeEventListener('abort',cancel)}
}
