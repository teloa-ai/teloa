import {WorkError} from '@teloa/contract'

/** 由服务端已核验的持久身份构造；不接收客户端许可、版本或商业主体。 */
export type WorkAccessRequest=
 |{kind:'task-run-start';ownerId:string;runId:string;taskId:string;sessionId:string;nativeRequestId:string}
 |{kind:'conversation-work-reserve';ownerId:string;requestId:string;sessionId:string}
 |{kind:'plan-occurrence';ownerId:string;planId:string;occurrenceId:string;source:'manual'|'schedule'}
export type WorkAccessLease={assertCurrent:()=>void}
export type WorkAccessPolicy=(request:Readonly<WorkAccessRequest>)=>Promise<WorkAccessLease>
const denied=()=>new WorkError('teloa/forbidden','当前暂不能开始新工作，请核对运行许可后重试。')
const unavailable=()=>new WorkError('teloa/unavailable','新工作准入策略尚未就绪，请稍后重试。')

/** 只负责进程内准入；Free 默认允许，受管宿主必须在启动前要求并安装唯一策略。 */
export class WorkAccess{
 private required=false
 private policy:WorkAccessPolicy|undefined
 private epoch=0
 requirePolicy():void{if(!this.required){this.required=true;this.epoch++}}
 installPolicy(policy:WorkAccessPolicy):void{
  if(typeof policy!=='function')throw denied()
  if(this.policy===policy)return
  if(this.policy!==undefined)throw denied()
  this.policy=policy;this.epoch++
 }
 async authorize(request:Readonly<WorkAccessRequest>):Promise<WorkAccessLease>{
  const fixed=Object.freeze({...request}),policy=this.policy,epoch=this.epoch
  if(!policy&&this.required)throw unavailable()
  let raw:WorkAccessLease
  try{raw=policy?await policy(fixed):{assertCurrent:()=>{}}}catch{throw denied()}
  if(!raw||typeof raw!=='object')throw denied()
  let assertion:WorkAccessLease['assertCurrent']
  try{assertion=raw.assertCurrent}catch{throw denied()}
  if(typeof assertion!=='function')throw denied()
  const lease=Object.freeze({assertCurrent:()=>{
   if(this.epoch!==epoch)throw denied()
   try{
    const returned:unknown=assertion.call(raw)
    if(returned!==undefined){
     // JS 策略也不能把最终同步闸变成未等待的 Promise；接住拒绝再关闭准入。
     void Promise.resolve(returned).catch(()=>{})
     throw denied()
    }
   }catch{throw denied()}
  }})
  lease.assertCurrent()
  return lease
 }
}
export const workAccess=new WorkAccess()
