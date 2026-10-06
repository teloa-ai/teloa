import {AsyncLocalStorage} from 'node:async_hooks'

/** 只由原生安装器关闭；源码与容器宿主保持开启。追踪派发过程，不把订阅寿命算作工作。 */
export class RuntimeAdmission {
 private closed=false
 private active=0
 private scope=new AsyncLocalStorage<{active:boolean}>()
 private queue:Array<()=>void>=[]
 private lease:ReturnType<typeof setTimeout>|undefined
 get deferred(){return this.queue.length}
 async run<T>(work:()=>Promise<T>|T):Promise<T>{
  if(this.closed&&!this.scope.getStore()?.active)throw Error('服务正在停止，请稍后重试。')
  this.active++
  const ticket={active:true}
  try{return await this.scope.run(ticket,work)}finally{ticket.active=false;this.active--}
 }
 /** 只读观察仍须入站准入；等待通知不计作工作，也不授予嵌套派发票据。 */
 async observe<T>(read:()=>Promise<T>|T):Promise<T>{
  if(this.closed)throw Error('服务正在停止，请稍后重试。')
  return this.scope.run({active:false},read)
 }
 /** 群消息已落库后的异步接力不可丢失；关闸时保留，停止检查发现它后解闸。 */
 defer<T>(work:()=>Promise<T>):Promise<T>{
  if(!this.closed||this.scope.getStore()?.active)return this.run(work)
  return new Promise<T>((resolve,reject)=>this.queue.push(()=>{void this.run(work).then(resolve,reject)}))
 }
 async quiesce(timeout=2000):Promise<void>{
  if(this.closed)throw Error('服务正在停止。')
  this.closed=true
  // 控制进程失联也不能永久封住工作台。
  this.lease=setTimeout(()=>this.resume(),30_000);this.lease.unref?.()
  const deadline=Date.now()+timeout
  while(this.active){
   if(Date.now()>=deadline){this.resume();throw Error('在途请求尚未收尾，请稍后停止。')}
   await new Promise<void>(done=>setTimeout(done,5))
  }
 }
 assertQuiescent(){if(!this.closed||this.active||this.deferred)throw Error('仍有工作待收尾，不能停止。')}
 resume(){this.closed=false;clearTimeout(this.lease);this.lease=undefined;const pending=this.queue.splice(0);for(const work of pending)work()}
}
export const runtimeAdmission=new RuntimeAdmission()
