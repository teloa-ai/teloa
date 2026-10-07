import {WorkError,type WorkCapability,type SessionCapabilitySnapshot} from '@teloa/contract'

export type {WorkCapability} from '@teloa/contract'
export type SessionCapabilityProducer='prompt'|'queue'|'subagent'|'schedule'|'task-run'|'restore'
export type SessionCapabilityReader=(sessionId:string,producer:SessionCapabilityProducer)=>Promise<Readonly<{ownerId:string;capabilities:readonly WorkCapability[]}>>
/** 由服务端已核验的持久身份构造；不接收客户端许可、版本或商业主体。 */
export type WorkAccessRequest=
 |{kind:'capability';capability:WorkCapability;ownerId:string;sessionId:string|null;objectId:string|null;operation:'create'|'edit'|'run'|'resume'}
 |{kind:'task-run-start';ownerId:string;runId:string;taskId:string;sessionId:string;nativeRequestId:string}
 |{kind:'conversation-work-reserve';ownerId:string;requestId:string;sessionId:string}
 |{kind:'plan-occurrence';ownerId:string;planId:string;occurrenceId:string;source:'manual'|'schedule'}
 |{kind:'native-input';sessionId:string;messageId:string;nativeRequestId:string|null;payloadSha256:string;producer:'prompt'|'queue'|'subagent'|'schedule'|'task-run';contextSha256:string}
/** 续作复核由策略区分；未提供时保持新工作复核语义。 */
export type WorkAccessLease={assertCurrent:()=>void;assertContinuationCurrent?:()=>void;releaseUnaccepted?:()=>void}
export type WorkAccessPolicy=(request:Readonly<WorkAccessRequest>)=>Promise<WorkAccessLease>
const denied=()=>new WorkError('teloa/forbidden','当前暂不能开始新工作，请核对运行许可后重试。')
const unavailable=()=>new WorkError('teloa/unavailable','新工作准入策略尚未就绪，请稍后重试。')
const capabilities=new Set<WorkCapability>(['general-agent','parallel-agents','groups','people','automation'])

/** 同一受理同时保留工作与能力证明；续作不能丢掉高级能力的实时复核。 */
export function combineWorkAccessLeases(leases:readonly WorkAccessLease[]):WorkAccessLease{
 const captured=leases.map(lease=>({lease,current:lease.assertCurrent,continuation:lease.assertContinuationCurrent??lease.assertCurrent,release:lease.releaseUnaccepted}))
 const check=(continuation:boolean)=>()=>{for(const item of captured){const result:unknown=Reflect.apply(continuation?item.continuation:item.current,item.lease,[]);if(result!==undefined){void Promise.resolve(result).catch(()=>{});throw denied()}}}
 return Object.freeze({assertCurrent:check(false),assertContinuationCurrent:check(true),releaseUnaccepted(){for(const item of captured){if(!item.release)continue;const value:unknown=Reflect.apply(item.release,item.lease,[]);if(value!==undefined){void Promise.resolve(value).catch(()=>{});throw denied()}}}})
}

/** 只负责进程内准入；社区版默认允许，受管宿主必须在启动前要求并安装唯一策略。 */
export class WorkAccess{
 private required=false
 private policy:WorkAccessPolicy|undefined
 private epoch=0
 private sessionCapabilities:SessionCapabilityReader|undefined
 private sessionCapabilitiesRequired=false
 requirePolicy():void{if(!this.required){this.required=true;this.epoch++}}
 /** 受管调用方在启动前要求真实分类，避免旧核心或装配遗漏降级成普通会话。 */
 requireSessionCapabilities():void{this.requirePolicy();if(!this.sessionCapabilitiesRequired){this.sessionCapabilitiesRequired=true;this.epoch++}}
 installSessionCapabilities(reader:SessionCapabilityReader):void{
  if(typeof reader!=='function'||this.sessionCapabilities&&this.sessionCapabilities!==reader)throw denied()
  if(this.sessionCapabilities===reader)return
  this.sessionCapabilities=reader;this.epoch++
 }
 /** 仅释放所属宿主的读取器；旧宿主迟到清理不能撤销后继宿主的分类。 */
 releaseSessionCapabilities(reader:SessionCapabilityReader):void{
  if(this.sessionCapabilities!==reader)return
  this.sessionCapabilities=undefined;this.epoch++
 }
 /** 同一真实分类供执行与纯读复用；读侧不调用许可策略，也不返回主体或私有对象。 */
 private async classifySessionCapabilities(sessionId:string,producer:SessionCapabilityProducer):Promise<Awaited<ReturnType<SessionCapabilityReader>>>{
  const reader=this.sessionCapabilities,epoch=this.epoch
  if(!reader)throw unavailable()
  let current:Awaited<ReturnType<SessionCapabilityReader>>
  try{current=await reader(sessionId,producer)}catch{throw denied()}
  if(this.epoch!==epoch||!current||typeof current.ownerId!=='string'||!current.ownerId.trim()||!Array.isArray(current.capabilities)||current.capabilities.length===0||current.capabilities.some(capability=>!capabilities.has(capability)))throw denied()
  return Object.freeze({ownerId:current.ownerId,capabilities:Object.freeze([...new Set(current.capabilities)])})
 }
 async readSessionCapabilities(ownerId:string,sessionId:string):Promise<SessionCapabilitySnapshot>{
  try{
   // prompt 只表示中性直接输入；员工、群、计划及子会话仍由真实关联和谱系决定。
   const current=await this.classifySessionCapabilities(sessionId,'prompt')
   if(!ownerId||current.ownerId!==ownerId)throw denied()
   return Object.freeze({schema:'teloa.session-capabilities/v1',sessionId,status:'ready',requiredCapabilities:current.capabilities})
  }catch{return Object.freeze({schema:'teloa.session-capabilities/v1',sessionId,status:'unavailable',requiredCapabilities:null})}
 }
 async authorizeSessionCapabilities(sessionId:string,producer:SessionCapabilityProducer):Promise<WorkAccessLease>{
  if(!this.policy&&!this.required)return combineWorkAccessLeases([])
  const reader=this.sessionCapabilities,epoch=this.epoch
  if(!reader){if(this.sessionCapabilitiesRequired)throw unavailable();return combineWorkAccessLeases([])}
  const current=await this.classifySessionCapabilities(sessionId,producer)
  const leases:WorkAccessLease[]=[]
  for(const capability of new Set(current.capabilities))leases.push(await this.authorize({kind:'capability',capability,ownerId:current.ownerId,sessionId,objectId:sessionId,operation:producer==='restore'?'resume':'run'}))
  if(this.epoch!==epoch)throw denied()
  return combineWorkAccessLeases(leases)
 }
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
  let assertion:WorkAccessLease['assertCurrent'],continuation:WorkAccessLease['assertContinuationCurrent'],release:WorkAccessLease['releaseUnaccepted']
  try{assertion=raw.assertCurrent;continuation=raw.assertContinuationCurrent;release=raw.releaseUnaccepted}catch{throw denied()}
  if(typeof assertion!=='function'||(continuation!==undefined&&typeof continuation!=='function')||(release!==undefined&&typeof release!=='function'))throw denied()
  const wrap=(check:()=>void)=>()=>{
   if(this.epoch!==epoch)throw denied()
   try{
    const returned:unknown=Reflect.apply(check,raw,[])
    if(returned!==undefined){
     // JS 策略也不能把最终同步闸变成未等待的 Promise；接住拒绝再关闭准入。
     void Promise.resolve(returned).catch(()=>{})
     throw denied()
    }
    if(this.epoch!==epoch)throw denied()
   }catch{throw denied()}
  }
  const lease=Object.freeze({assertCurrent:wrap(assertion),assertContinuationCurrent:wrap(continuation??assertion),...(release?{releaseUnaccepted(){const value:unknown=Reflect.apply(release!,raw,[]);if(value!==undefined){void Promise.resolve(value).catch(()=>{});throw denied()}}}:{})})
  try{lease.assertCurrent()}catch(error){lease.releaseUnaccepted?.();throw error}
  return lease
 }
}
export const workAccess=new WorkAccess()
