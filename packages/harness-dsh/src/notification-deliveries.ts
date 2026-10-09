type Delivery={
 id:string;ownerId:string;claimId:string;planId:string;taskId:string;runId:string
 policy:'always'|'attention'|'failure';conclusion:'policy-always'|'attention-required'|'execution-failed'
 attemptToken:string|null
}

type DeliveryService={
 materialize:(owner:string,input:{channel:string;limit:number;now:string})=>Promise<{deliveryIds:string[]}>
 claim:(owner:string,input:{deliveryId:string;now:string})=>Promise<Delivery|null>
 complete:(owner:string,input:{deliveryId:string;attemptToken:string;receiptId:string;now:string})=>Promise<unknown>
 fail:(owner:string,input:{deliveryId:string;attemptToken:string;code:string;now:string})=>Promise<unknown>
}

export type NotificationChannelInput={
 idempotencyKey:string;ownerId:string;claimId:string;planId:string;taskId:string;runId:string
 policy:Delivery['policy'];conclusion:Delivery['conclusion']
}

export type NotificationChannelAdapter={
 channel:string
 /** 插件已加载不代表本人有接收目标；已配置但离线仍返回 true，读取失败必须抛出。 */
 isConfigured?:(ownerId:string)=>Promise<boolean>
 /** 重试沿用同一 idempotencyKey；适配器须按该身份去重，并返回原成功回执。 */
 deliver:(input:NotificationChannelInput,signal:AbortSignal)=>Promise<{receiptId:string}>
}

type DriverOptions={now:()=>string;limit:number}

export class NotificationDeliveryDriver{
 readonly service:DeliveryService
 readonly adapter:NotificationChannelAdapter
 readonly options:DriverOptions
 constructor(service:DeliveryService,adapter:NotificationChannelAdapter,options:DriverOptions){
  this.service=service;this.adapter=adapter;this.options=options
 }
 async deliver(owner:string,signal:AbortSignal):Promise<{materialized:number;attempted:number;delivered:number;failed:number}>{
  signal.throwIfAborted()
  const materialized=await this.service.materialize(owner,{channel:this.adapter.channel,limit:this.options.limit,now:this.options.now()})
  let attempted=0,delivered=0,failed=0
  for(const deliveryId of materialized.deliveryIds){
   signal.throwIfAborted()
   const delivery=await this.service.claim(owner,{deliveryId,now:this.options.now()})
   if(!delivery)continue
   attempted+=1
   if(!delivery.attemptToken)throw new Error('claimed notification delivery has no attempt token')
   try{
    const receipt=await this.adapter.deliver({
     idempotencyKey:delivery.id,ownerId:delivery.ownerId,claimId:delivery.claimId,planId:delivery.planId,
     taskId:delivery.taskId,runId:delivery.runId,policy:delivery.policy,conclusion:delivery.conclusion,
    },signal)
    signal.throwIfAborted()
    await this.service.complete(owner,{deliveryId:delivery.id,attemptToken:delivery.attemptToken,receiptId:receipt.receiptId,now:this.options.now()})
    delivered+=1
   }catch(error){
    signal.throwIfAborted()
    await this.service.fail(owner,{deliveryId:delivery.id,attemptToken:delivery.attemptToken,code:'teloa/notification-unavailable',now:this.options.now()})
    failed+=1
   }
  }
  return {materialized:materialized.deliveryIds.length,attempted,delivered,failed}
 }
}

type LocalLogger={info:(format:string,...values:unknown[])=>void}

export function createLocalNotificationAdapter(logger:LocalLogger):NotificationChannelAdapter{
 return {
  channel:'local-log',
  async deliver(input,signal){
   signal.throwIfAborted()
   logger.info('通知投递 %s：plan=%s occurrence=%s task=%s run=%s policy=%s conclusion=%s',input.idempotencyKey,input.planId,input.claimId,input.taskId,input.runId,input.policy,input.conclusion)
   return {receiptId:'local-log:'+input.idempotencyKey}
  },
 }
}

export type BroadcastNotificationAdapter=NotificationChannelAdapter&{add(adapter:NotificationChannelAdapter):()=>void}

type BroadcastLogger={warn:(format:string,...values:unknown[])=>void}

const safeErrorCode=/^[A-Za-z0-9_./-]{1,64}$/

/**
 * channel 沿用 primary.channel：后端按 channel 去重（stableId 与已投递判定都含 channel），
 * 换成广播适配器后升级前已投递的运行不会重投；IM 等追加适配器只是旁路投递，不进入去重键。
 * 已配置的追加适配器全部成功才回执 `broadcast:<idempotencyKey>`；日志成功不能抵消实际发送失败。
 * 没有本人配置的追加目标时保持 primary 行为；已配置但离线保留失败，下一次沿原编号重试。
 * 重试继续向适配器提供相同幂等键；成功侧须自行去重。本函数不承诺外部渠道跨重启恰好一次。
 * 候选集合在本次开始时固定，调用前复核注册；中途移除不发送，新挂接留到下次。
 * 失败只记 channel 与错误码（不记原文）；signal 中止时停止后续调用并保留真实租约状态。
 */
export function createBroadcastNotificationAdapter(primary:NotificationChannelAdapter,logger:BroadcastLogger):BroadcastNotificationAdapter{
 const extra=new Set<NotificationChannelAdapter>()
 return {
  channel:primary.channel,
  add(adapter){extra.add(adapter);return ()=>{extra.delete(adapter)}},
  async deliver(input,signal){
   signal.throwIfAborted()
   const targets=[...extra]
   let localDelivered=false,required=false,failed=false,lastError:unknown
   const report=(adapter:NotificationChannelAdapter,error:unknown)=>{
     const code=error instanceof Error&&'code' in error&&typeof error.code==='string'&&safeErrorCode.test(error.code)?error.code:'unknown'
     logger.warn('通知适配器投递失败：channel=%s code=%s',adapter.channel,code)
   }
   try{await primary.deliver(input,signal);signal.throwIfAborted();localDelivered=true}
   catch(error){signal.throwIfAborted();lastError=error;report(primary,error)}
   for(const adapter of targets){
    signal.throwIfAborted()
    if(!extra.has(adapter))continue
    let sending=false
    try{
     const configured=adapter.isConfigured?await adapter.isConfigured(input.ownerId):true
     signal.throwIfAborted()
     if(!extra.has(adapter))continue
     if(typeof configured!=='boolean')throw new Error('notification target configuration is invalid')
     if(!configured)continue
     required=true
     sending=true
     await adapter.deliver(input,signal)
     signal.throwIfAborted()
    }catch(error){
     signal.throwIfAborted()
     if(!sending&&!extra.has(adapter))continue
     failed=true;lastError=error;report(adapter,error)
    }
   }
   if(failed||!required&&!localDelivered)throw lastError
   return {receiptId:'broadcast:'+input.idempotencyKey}
  },
 }
}
