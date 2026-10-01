import type {BindingState} from './binding-client.js'

export type SessionBrowserStopState='ready'|'unconfirmed'|'isolated'
export type SessionBrowserStopSnapshot={status:SessionBrowserStopState|'loading'|'failed';checking:boolean}
export function readSessionBrowserStopState(value:unknown):SessionBrowserStopState{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||!('state' in value)||!['ready','unconfirmed','isolated'].includes(value.state as string))throw Error('Invalid browser stop status.')
 return value.state as SessionBrowserStopState
}

/** 原生目录身份与普通绑定都明确后才读取；fork 的父关系不等同于子助手。 */
export function sessionBrowserStopBindingReady(sessionId:string,binding:Pick<BindingState,'sessionId'|'status'|'conversation'>,known:boolean,nativeChild:boolean):boolean{
 return known&&!nativeChild&&binding.sessionId===sessionId&&binding.status==='ready'&&binding.conversation?.sessionId===sessionId&&binding.conversation.status==='ready'
}

/** 只投影当前 liveAgent 的读口；历史提示不代表当前浏览器状态。 */
export function createSessionBrowserStopReader(read:()=>Promise<unknown>,subscribeActivity:(listener:()=>void)=>()=>void,canRead:()=>boolean=()=>true){
 let snapshot:SessionBrowserStopSnapshot={status:'loading',checking:true},generation=0,attached=false
 let pending:{again:boolean;promise:Promise<void>}|undefined
 const listeners=new Set<()=>void>()
 const update=(next:SessionBrowserStopSnapshot)=>{snapshot=next;for(const listener of listeners)listener()}
 const waitForBinding=()=>{
  generation++;pending=undefined
  if(snapshot.status!=='loading'||snapshot.checking)update({status:'loading',checking:false})
 }
 const check=():Promise<void>=>{
  if(!attached)return Promise.resolve()
  if(!canRead()){waitForBinding();return Promise.resolve()}
  if(pending){pending.again=true;return pending.promise}
  const current=generation,job={again:false,promise:Promise.resolve()}
  pending=job
  update({...snapshot,checking:true})
  job.promise=(async()=>{
   do{
    job.again=false
    let status:SessionBrowserStopSnapshot['status']
    try{status=readSessionBrowserStopState(await read())}catch{status='failed'}
    if(!attached||current!==generation)return
    if(!canRead()){waitForBinding();return}
    update({status,checking:job.again})
   }while(job.again)
  })().finally(()=>{if(pending===job){pending=undefined;if(job.again)void check()}})
  return job.promise
 }
 return {
  getSnapshot:()=>snapshot,
  subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}},
  check,
  attach:()=>{
   attached=true;generation++;pending=undefined;update({status:'loading',checking:true})
   const off=subscribeActivity(()=>{void check()})
   void check()
   return()=>{attached=false;generation++;pending=undefined;off()}
  },
 }
}
export type SessionBrowserStopReader=ReturnType<typeof createSessionBrowserStopReader>
