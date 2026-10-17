import {setTimeout as pause} from 'node:timers/promises'
import {WorkError,hardwareOperationId,type HardwareOperation,type HardwareBinding,type HardwareReceipt,type HardwareRequestPort,type HardwareScope} from '@teloa/contract'
import type {HardwareStore} from '@teloa/backend'

export type HardwareHostPorts=Readonly<{
 store:HardwareStore;bindingId:string;workSignal:AbortSignal;waitMs?:number
 authorize:()=>Promise<{binding:HardwareBinding;assertCurrent:()=>void}>
 remember?:(nativeRequestId:string)=>void
 dispatch:(operation:HardwareOperation,binding:HardwareBinding,assertCurrent:()=>void,signal:AbortSignal)=>Promise<unknown>
 read:(operation:HardwareOperation,binding:HardwareBinding)=>Promise<HardwareReceipt>
}>
const denied=()=>new WorkError('teloa/forbidden','原硬件请求的授权已变化。')
/** 派发占位在数据库完成；连接取消不撤已经受理的原生工作。 */
export function createHardwareRequestService(ports:HardwareHostPorts):HardwareRequestPort{
 const running=new Map<string,Promise<void>>(),waitMs=ports.waitMs??8000
 if(!Number.isFinite(waitMs)||waitMs<0||waitMs>8000)throw new WorkError('teloa/invalid-input','硬件等待时间不正确。')
 const authorize=async(scope:HardwareScope,operation?:HardwareOperation)=>{
  const authority=await ports.authorize(),{binding}=authority
  authority.assertCurrent()
  if(binding.id!==ports.bindingId||binding.status!=='active'||!binding.scopes.includes(scope)||operation&&(operation.bindingId!==binding.id||operation.grantVersion!==binding.grantVersion))throw denied()
  return authority
 }
 const rawResult=async(op:HardwareOperation,binding:HardwareBinding):Promise<HardwareReceipt>=>{
  try{
   const receipt=await ports.read(op,binding)
   if(receipt.operationId!==op.id)throw denied()
   if(receipt.state==='pending'||receipt.state==='completed'||receipt.state==='needs_approval')await ports.store.recordReceipt(op.id,{state:'accepted',resultRef:receipt.resultRef})
   return receipt
  }catch{return {operationId:op.id,state:'unknown',speakableText:'原请求状态暂时无法核对，请查询原操作，不要重新提交。',resultRef:null}}
 }
 const result=async(id?:string):Promise<HardwareReceipt>=>{
  await authorize('reply.read')
  const op=await ports.store.get(ports.bindingId,id)
  if(!op)throw new WorkError('teloa/not-found','尚未找到这条连接的工作。')
  const {binding}=await authorize('reply.read',op)
  let receipt:HardwareReceipt
  if(op.state==='prepared')receipt={operationId:op.id,state:'prepared',speakableText:'请求已准备，尚未提交。',resultRef:null,expiresAt:op.expiresAt}
  else if(op.state==='rejected')receipt={operationId:op.id,state:'rejected',speakableText:'原请求未获受理，请到 Teloa 查看。',resultRef:null}
  else receipt=await rawResult(op,binding)
  if(receipt.state==='unknown'&&running.has(op.id))receipt={...receipt,state:'pending',speakableText:'正在核对原请求的受理状态，请稍后查询。'}
  await authorize('reply.read',op)
  return receipt
 }
 return Object.freeze({
  async prepare(text:string){
   await authorize('assistant.send')
   const op=await ports.store.prepare(ports.bindingId,text)
   ports.remember?.(op.nativeRequestId)
   await authorize('assistant.send',op)
   return {operationId:op.id,state:'prepared' as const,speakableText:'请求已准备，尚未执行。',resultRef:null,expiresAt:op.expiresAt}
  },
  async submit(id:string,signal?:AbortSignal):Promise<HardwareReceipt>{
   signal?.throwIfAborted()
   if(!hardwareOperationId(id))throw denied()
   await authorize('assistant.send')
   const op=await ports.store.get(ports.bindingId,id)
   if(!op)throw denied()
   const authority=await authorize('assistant.send',op)
   signal?.throwIfAborted()
   if(await ports.store.markDispatching(id)){
    const work=(async()=>{
     try{
      ports.workSignal.throwIfAborted()
      const assertCurrent=()=>{signal?.throwIfAborted();authority.assertCurrent()}
      assertCurrent()
      await ports.dispatch(op,authority.binding,assertCurrent,ports.workSignal)
     }catch{/* 不能凭异常判定未写入；下面只核对原请求。 */}
     try{
      const observed=await rawResult(op,authority.binding)
      if(observed.state==='unknown')await ports.store.recordReceipt(id,{state:'unknown',resultRef:null})
     }catch{/* 状态落存失败保留 dispatching；同样禁止重派。 */}
    })()
    running.set(id,work)
    void work.finally(()=>{if(running.get(id)===work)running.delete(id)}).catch(()=>{})
   }else{
    const current=await ports.store.get(ports.bindingId,id)
    if(!current||current.state==='prepared'||current.state==='rejected')return {operationId:id,state:'rejected',speakableText:'原准备已过期或授权变化，未再次提交。',resultRef:null}
   }
   const deadline=performance.now()+waitMs
   while(true){
    const receipt=await result(id)
    if(!['pending','unknown'].includes(receipt.state)||performance.now()>=deadline)return receipt
    // 取消只结束当前等待。原 Session 的生命期由 workSignal 与最终准入决定。
    if(signal?.aborted)return receipt
    await pause(Math.min(80,Math.max(1,deadline-performance.now())),undefined,{signal:ports.workSignal})
   }
  },
  result,
 })
}
