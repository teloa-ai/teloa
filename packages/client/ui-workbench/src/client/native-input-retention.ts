import type {InputState} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {SessionBinding,SessionReference} from '@deepseek-ai/dsh-api-session-controller/client'
import type {SessionId} from '@deepseek-ai/dsh-session'
type Source<T>={getSnapshot:()=>T;subscribe:(listener:()=>void)=>()=>void}
type Ports={current:Source<SessionId|undefined>;owner:Source<string|null>;sessions:{binding:(id:SessionId)=>SessionBinding|undefined;list:Pick<Source<unknown>,'subscribe'>;retain:(id:SessionId,options:{source:'teloaDraftInput'})=>SessionReference};input:(binding:SessionBinding)=>Source<InputState>;monitor:(binding:SessionBinding)=>Source<boolean>}
declare module '@deepseek-ai/dsh-api-session-controller/client'{interface SessionReferenceSourceMap{teloaDraftInput:unknown}}
type Entry={binding:SessionBinding;reference?:SessionReference;off:Array<()=>void>}
/** 只延长官方作用域生命周期；不保存输入快照或附件。纯文本仍沿官方持久镜像。 */
export function retainNativeInputs(ports:Ports):()=>void{
 const entries=new Map<SessionId,Entry>(),formerOwnerBindings=new WeakSet<SessionBinding>()
 let owner:string|null=null,disposed=false,running=false,again=false
 const remove=(entry:Entry)=>{
  entries.delete(entry.binding.sessionId)
  for(const off of entry.off)off()
  entry.reference?.release()
 }
 const reconcile=()=>{
  const nextOwner=ports.owner.getSnapshot()
  if(nextOwner!==null&&nextOwner!==owner){
   owner=nextOwner
   for(const entry of [...entries.values()]){formerOwnerBindings.add(entry.binding);remove(entry)}
  }
  const current=ports.current.getSnapshot()
  for(const entry of [...entries.values()]){
   if(ports.sessions.binding(entry.binding.sessionId)!==entry.binding||!entry.reference&&current!==entry.binding.sessionId)remove(entry)
  }
  const binding=nextOwner!==null&&current?ports.sessions.binding(current):undefined
  if(binding&&!formerOwnerBindings.has(binding)&&!entries.has(binding.sessionId)){
   const entry:Entry={binding,off:[]};entries.set(binding.sessionId,entry)
   entry.off=[ports.input(binding).subscribe(update),binding.session.subscribe(update),ports.monitor(binding).subscribe(update)]
  }
  for(const entry of entries.values()){
   if(entry.reference)continue
   const input=ports.input(entry.binding).getSnapshot()
   const needed=input.attachmentIds.length>0||input.occurrences.length>0||input.queue.length>0||input.phase!=='plain'||input.claim!==undefined||entry.binding.session.getSnapshot().pendingSubmissions.length>0||ports.monitor(entry.binding).getSnapshot()
   if(!needed)continue
   const reference=ports.sessions.retain(entry.binding.sessionId,{source:'teloaDraftInput'})
   // 历史读取失败不等于浏览器草稿可丢弃；引用仍由本作用域生命周期管理。
   void reference.ready.catch(()=>{})
   let matching=false
   try{matching=!disposed&&entries.get(entry.binding.sessionId)===entry&&reference.binding===entry.binding}
   catch{/* retain 的同步通知可能已退休原 generation；公开 binding getter 此时会抛。 */}
   if(!matching){reference.release();continue}
   entry.reference=reference
  }
  // rc.1 未公开 detached send 的完整在途状态。空 input/pending 可能只是序列化间隙，
  // 已持有的引用不能据此或超时释放；只在 owner/binding 失效或插件销毁时回收。
 }
 function update(){
  if(disposed)return
  if(running){again=true;return}
  running=true
  try{do{again=false;reconcile()}while(again&&!disposed)}finally{running=false}
 }
 const off=[ports.current.subscribe(update),ports.owner.subscribe(update),ports.sessions.list.subscribe(update)]
 update()
 return()=>{if(disposed)return;disposed=true;for(const dispose of off)dispose();for(const entry of [...entries.values()])remove(entry)}
}
