import {isRecord,WorkError} from '@teloa/contract'
import type {WorkEventPorts} from '@teloa/backend'

type Verifier=NonNullable<WorkEventPorts['businessOrigin']>
type Db=Parameters<Verifier>[0]
type NativeOriginSession={sessionId:string;events:readonly unknown[];isOwnSeq:(seq:number)=>boolean}
type OriginRun={id:string;ownerId:string;sessionId:string;nativeRequestId:string}
type Ports={
 conversation:(owner:string,sessionId:string)=>Promise<{ownerId:string;sessionId:string;status:string}>
 session:(sessionId:string)=>Promise<NativeOriginSession>
 run:(db:Db,owner:string,sessionId:string,nativeRequestId:string|undefined)=>Promise<{run:OriginRun|null;hasRuns:boolean}>
}
const denied=()=>new WorkError('teloa/forbidden','业务修改的原消息或执行来源不可核对。')

function originalMessage(session:NativeOriginSession,origin:Parameters<Verifier>[2]){
 if(session.sessionId!==origin.sessionId||!Number.isSafeInteger(origin.seq)||origin.seq<0||!session.isOwnSeq(origin.seq))throw denied()
 const matches=session.events.filter(value=>isRecord(value)&&value.seq===origin.seq)
 const event=matches[0]
 if(matches.length!==1||!isRecord(event)||event.type!=='user/message'||event.surfaceOp!=='append'||!isRecord(event.data)||event.data.id!==origin.messageId||!isRecord(event.data.source)||event.data.source.kind!=='user')throw denied()
 const requestId=event.data.source.rpcId
 if(requestId!==undefined&&(typeof requestId!=='string'||!requestId))throw denied()
 return requestId as string|undefined
}

/** 只核对持久原消息，历史批准采用不猜最新轮次，也不把没有Run的本人消息冒成Plan产物。 */
export function createBusinessEventOriginVerifier(owner:string,ports:Ports):Verifier{
 return async(db,actor,origin)=>{
  if(!owner.trim()||actor!==owner)throw denied()
  const binding=await ports.conversation(actor,origin.sessionId)
  if(binding.ownerId!==owner||binding.sessionId!==origin.sessionId||binding.status!=='ready')throw denied()
  const requestId=originalMessage(await ports.session(origin.sessionId),origin)
  const found=await ports.run(db,actor,origin.sessionId,requestId)
  // 原消息可能在异步读取期间切换；不得把旧查询结果附给另一原生输入。
  if(originalMessage(await ports.session(origin.sessionId),origin)!==requestId)throw denied()
  if(found.run){
   const run=found.run
   if(!found.hasRuns||run.ownerId!==owner||run.sessionId!==origin.sessionId||requestId===undefined||run.nativeRequestId!==requestId)throw denied()
   return {kind:'task-run',runId:run.id}
  }
  if(found.hasRuns)throw denied()
  return {kind:'ordinary-conversation'}
 }
}
