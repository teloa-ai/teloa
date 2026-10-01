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
 * deliver 依次调各适配器（primary 在前，IM 等追加在后），任一成功即回执 `broadcast:<idempotencyKey>`，
 * 全部失败才抛最后一个错误。单个适配器失败不影响其它适配器投递，失败只记 channel 与错误码（不记原文）；
 * signal 已中止时不调任何适配器。
 */
export function createBroadcastNotificationAdapter(primary:NotificationChannelAdapter,logger:BroadcastLogger):BroadcastNotificationAdapter{
 const extra=new Set<NotificationChannelAdapter>()
 return {
  channel:primary.channel,
  add(adapter){extra.add(adapter);return ()=>{extra.delete(adapter)}},
  async deliver(input,signal){
   signal.throwIfAborted()
   let delivered=false,lastError:unknown
   for(const adapter of [primary,...extra]){
    try{await adapter.deliver(input,signal);delivered=true}
    catch(error){
     lastError=error
     const code=error instanceof Error&&'code' in error&&typeof error.code==='string'&&safeErrorCode.test(error.code)?error.code:'unknown'
     logger.warn('通知适配器投递失败：channel=%s code=%s',adapter.channel,code)
    }
   }
   if(!delivered)throw lastError
   return {receiptId:'broadcast:'+input.idempotencyKey}
  },
 }
}
