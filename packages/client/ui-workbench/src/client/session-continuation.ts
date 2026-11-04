export type SessionContinuationState={available:boolean;busy:boolean;error:boolean}
type Facts={identity:object;current:boolean;ready:boolean;running:boolean;pending:boolean;blocked:boolean}
type Status={sessionId:string;available:boolean;prefixSha256?:string}
type Ports={sessionId:string;facts:()=>Facts;subscribe:(listener:()=>void)=>()=>void;inspect:()=>Promise<Status>;resume:(prefixSha256:string)=>Promise<unknown>}

/** 导航、历史与重连只读状态；唯一执行点是本人点击continue。 */
export function createSessionContinuation(ports:Ports){
 let state:SessionContinuationState={available:false,busy:false,error:false},prefix:string|undefined,generation=0,queued=false,stop:(()=>void)|undefined
 const listeners=new Set<()=>void>()
 const notify=()=>{for(const listener of listeners)listener()}
 const set=(next:SessionContinuationState)=>{if(JSON.stringify(next)!==JSON.stringify(state)){state=next;notify()}}
 const eligible=(f:Facts)=>f.current&&f.ready&&!f.running&&!f.pending&&!f.blocked
 const refresh=()=>{
  if(queued||state.busy)return
  queued=true;queueMicrotask(()=>{
   queued=false;const epoch=++generation,before=ports.facts()
   if(!eligible(before)){prefix=undefined;set({available:false,busy:false,error:false});return}
   void ports.inspect().then(value=>{
    const now=ports.facts()
    if(epoch!==generation||!listeners.size||now.identity!==before.identity||!eligible(now))return
    if(value.sessionId!==ports.sessionId||typeof value.available!=='boolean'||value.available&&(typeof value.prefixSha256!=='string'||!/^([a-f0-9]{64})$/.test(value.prefixSha256)))throw Error('恢复状态无法核对')
    // 未知响应保留原票据供显式重试；只读刷新不能静默换成另一次继续或清掉提示。
    const error=state.error&&value.available
    if(!error)prefix=value.available?value.prefixSha256:undefined
    set({available:value.available,busy:false,error})
   }).catch(()=>{if(epoch===generation&&listeners.size){prefix=undefined;set({available:false,busy:false,error:true})}})
  })
 }
 return {
  getSnapshot:()=>state,
  subscribe(listener:()=>void){listeners.add(listener);if(listeners.size===1){stop=ports.subscribe(refresh);refresh()}return()=>{listeners.delete(listener);if(!listeners.size){generation++;stop?.();stop=undefined}}},
  async continue(){
   const before=ports.facts(),original=prefix
   if(state.busy||!state.available||!original||!eligible(before))throw Error('原会话暂不能恢复')
   generation++;set({available:true,busy:true,error:false})
   try{
    const now=ports.facts();if(now.identity!==before.identity||!eligible(now))throw Error('会话已变化')
    await ports.resume(original)
    prefix=undefined;set({available:false,busy:false,error:false})
   }catch(error){set({available:true,busy:false,error:true});throw error}
   finally{refresh()}
  },
 }
}
