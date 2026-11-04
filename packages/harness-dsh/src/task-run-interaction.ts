import type {SessionEvent} from '@deepseek-ai/dsh-session'
import type {TaskRun} from '@teloa/backend'
import {nativeInputIdentity} from './native-input-access.ts'

/** 只认原固定结束位置之后实际受理的本人新输入；不能以旧Run请求或恢复标记获得新交互身份。 */
export function taskRunInteractionRequest(events:readonly SessionEvent[],run:Pick<TaskRun,'state'|'evidence'|'stopRequestedAt'|'nativeRequestId'>,ownsCurrentRoots?:(requestId:string)=>boolean):string|undefined{
 if(run.state!=='ended'||run.evidence?.state!=='ended'||run.evidence.reason!=='completed'||run.stopRequestedAt!==null||events.some((event,index)=>event.seq!==index))return
 const evidence=run.evidence
 let start=-1
 for(let index=0;index<events.length;index++)if(events[index]!.type==='turn/start')start=index
 if(start<=run.evidence.endSeq)return
 const tail=events.slice(start)
 if(tail.some(event=>event.type==='turn/end'))return
 const inputs=tail.filter((event):event is Extract<SessionEvent,{type:'user/message'}>=>event.type==='user/message'&&event.surfaceOp==='append'&&!['agent-instructions','runtime-context','time-context'].includes(event.data.source.kind))
 const direct=inputs.length===1&&inputs[0]!.data.source.kind==='user'?inputs[0]:undefined
 // 后台通知可沿真实独立交互根继续；仅有tool-jobs标记或历史本人消息不能授信。
 const candidates=direct?[direct]:ownsCurrentRoots?events.filter((event):event is Extract<SessionEvent,{type:'user/message'}>=>event.type==='user/message'&&event.surfaceOp==='append'&&event.seq>evidence.endSeq&&event.data.source.kind==='user').reverse():[]
 for(const message of candidates){
  const source=message.data.source
  if(source.kind!=='user'||Object.keys(source).some(key=>!['kind','rpcId'].includes(key)))continue
  const requestId=Reflect.get(source,'rpcId')
  if(typeof requestId!=='string'||!requestId||requestId===run.nativeRequestId)continue
  try{
   const sha=nativeInputIdentity(message.data,requestId).payloadSha256
   const accepted=events.filter(event=>event.type==='agent/inbox/spliced'&&event.seq>evidence.endSeq&&event.seq<message.seq&&event.data.target==='next-turn'&&event.data.inserted.some(input=>input.id===message.data.id&&nativeInputIdentity(input,requestId).payloadSha256===sha))
   if(accepted.length===1&&(direct!==undefined||ownsCurrentRoots?.(requestId)))return requestId
  }catch{/* 当前根不属于本请求时继续核对；历史文本不产生许可。 */}
 }
 return undefined
}
