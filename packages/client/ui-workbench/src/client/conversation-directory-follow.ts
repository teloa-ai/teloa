type Source<T>={getSnapshot():T;subscribe(listener:()=>void):()=>void}
type Port={
 state:Source<'connected'|'disconnected'|'connecting'|undefined>
 generation:Source<object|undefined>
 watch(revision:number|undefined,signal:AbortSignal):Promise<unknown>
 refresh(signal:AbortSignal):Promise<boolean>
}

function retryDelay(signal:AbortSignal):Promise<void>{
 if(signal.aborted)return Promise.resolve()
 return new Promise(resolve=>{
  const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve()}
  const timer=setTimeout(done,1000)
  signal.addEventListener('abort',done,{once:true})
 })
}

/** 连接世代仅刷新原业务目录，不获得会话选择、输入或执行权限。 */
export function followConversationDirectory(port:Port):()=>void{
 let disposed=false,active:{generation:object;controller:AbortController}|undefined
 const follow=async(signal:AbortSignal)=>{
  let revision:number|undefined
  while(!signal.aborted){
   try{
    const value=await port.watch(revision,signal)
    if(signal.aborted)return
    if(!value||typeof value!=='object'||Object.keys(value).length!==1||!('revision'in value)||!Number.isSafeInteger(value.revision)||(value.revision as number)<0)throw Error('会话目录版本回执无效。')
    const next=value.revision as number
    if(next!==revision){
     const refreshed=await port.refresh(signal)
     if(signal.aborted)return
     if(!refreshed){await retryDelay(signal);continue}
     revision=next
    }
   }catch{
    if(signal.aborted)return
    await retryDelay(signal)
   }
  }
 }
 const synchronize=()=>{
  const generation=port.state.getSnapshot()==='connected'?port.generation.getSnapshot():undefined
  if(disposed||active?.generation===generation)return
  active?.controller.abort();active=undefined
  if(generation===undefined)return
  const controller=new AbortController()
  active={generation,controller}
  void follow(controller.signal)
 }
 const off=[port.state.subscribe(synchronize),port.generation.subscribe(synchronize)]
 synchronize()
 return()=>{disposed=true;for(const dispose of off)dispose();active?.controller.abort();active=undefined}
}
