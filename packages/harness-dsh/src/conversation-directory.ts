import {WorkError} from '@teloa/contract'

/** 只发布目录失效版本；目录内容仍由原 conversations/list 读取。 */
export class ConversationDirectoryChanges {
 private revision=0
 private closed=false
 private readonly waiters=new Set<()=>void>()

 async mutate<T>(operation:()=>Promise<T>):Promise<T>{
  const value=await operation()
  if(!this.closed){this.revision++;for(const wake of this.waiters)wake()}
  return value
 }

 async watch(payload:unknown,signal:AbortSignal):Promise<{revision:number}>{
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(key=>key!=='revision'))throw new WorkError('teloa/invalid-input','会话目录请求格式无效。')
  const input=payload as {revision?:unknown}
  if(input.revision!==undefined&&(!Number.isSafeInteger(input.revision)||(input.revision as number)<0))throw new WorkError('teloa/invalid-input','会话目录版本无效。')
  signal.throwIfAborted()
  if(this.closed)throw new WorkError('teloa/host-unavailable','会话目录订阅已关闭。')
  // 先取版本再读目录；读取与下一次 watch 之间的写入仍使版本不一致。
  if(input.revision!==this.revision)return {revision:this.revision}
  return new Promise((resolve,reject)=>{
   const finish=(error?:unknown)=>{
    clearTimeout(timer);signal.removeEventListener('abort',abort);this.waiters.delete(wake)
    error===undefined?resolve({revision:this.revision}):reject(error)
   }
   const wake=()=>finish(this.closed?new WorkError('teloa/host-unavailable','会话目录订阅已关闭。'):undefined)
   const abort=()=>finish(signal.reason)
   const timer=setTimeout(wake,20_000)
   this.waiters.add(wake);signal.addEventListener('abort',abort,{once:true})
  })
 }

 dispose():void{
  if(this.closed)return
  this.closed=true
  for(const wake of this.waiters)wake()
 }
}
