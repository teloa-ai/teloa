import {useEffect,useRef,useState} from 'react'

/** 只读轮询与用户操作分开取消；标签页隐藏不取消操作 RPC，更不调用后台任务取消端点。 */
export function useRetrievalSnapshot<T>(read:(signal:AbortSignal)=>Promise<T>,identity:unknown,enabled=true){
 const readRef=useRef(read);readRef.current=read
 const [value,setValue]=useState<T>(),[readError,setReadError]=useState<unknown>(),[actionError,setActionError]=useState<unknown>(),[busy,setBusy]=useState(false)
 const scope=useRef<{controller:AbortController;generation:number;busy:boolean}>()
 useEffect(()=>{
  setValue(undefined);setReadError(undefined);setActionError(undefined);setBusy(false)
  if(!enabled)return
  const current={controller:new AbortController(),generation:0,busy:false};scope.current=current
  let timer:ReturnType<typeof setTimeout>|undefined,reading:AbortController|undefined
  const visible=()=>!current.controller.signal.aborted&&document.visibilityState==='visible'
  const clearTimer=()=>{clearTimeout(timer);timer=undefined}
  const schedule=()=>{clearTimer();if(visible())timer=setTimeout(()=>void poll(),1500)}
  const poll=async(force=false)=>{
   if(!visible())return
   clearTimer()
   // 显示事件立即读；操作仍在途时读取可以完成，但不能覆盖该操作的回执。
   if(current.busy&&!force){schedule();return}
   reading?.abort()
   const controller=new AbortController(),generation=++current.generation;reading=controller
   try{
    const next=await readRef.current(controller.signal)
    if(!controller.signal.aborted&&visible()&&!current.busy&&generation===current.generation){setValue(next);setReadError(undefined)}
   }catch(reason){if(!controller.signal.aborted&&visible()&&!current.busy&&generation===current.generation)setReadError(reason)}
   finally{if(reading===controller){reading=undefined;schedule()}}
  }
  const visibility=()=>{
   clearTimer();current.generation++
   reading?.abort();reading=undefined
   if(visible())void poll(true)
  }
  document.addEventListener('visibilitychange',visibility)
  void poll()
  return ()=>{
   current.controller.abort();reading?.abort();reading=undefined;clearTimer()
   document.removeEventListener('visibilitychange',visibility);scope.current=undefined
  }
 },[identity,enabled])
 const run=async(action:(signal:AbortSignal)=>Promise<T>)=>{
  const current=scope.current;if(!current||current.busy||current.controller.signal.aborted)return
  current.busy=true;current.generation++;setBusy(true);setActionError(undefined)
  try{const next=await action(current.controller.signal);if(!current.controller.signal.aborted)setValue(next)}catch(reason){if(!current.controller.signal.aborted)setActionError(reason)}
  finally{current.generation++;current.busy=false;if(!current.controller.signal.aborted)setBusy(false)}
 }
 return {value,error:actionError??readError,readFailed:readError!==undefined,busy,run}
}
