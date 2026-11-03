import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {interruptedTurnClosers,type SessionEvent,type UserMessage} from '@deepseek-ai/dsh-session'
import {taskRunEvidenceProofEnd,type AcceptedInboxFailureEvidence,type TaskRun} from '@teloa/backend'
import {taskInputWithoutMemory} from './task-memory-input.ts'
import {nativeInputIdentity} from './native-input-access.ts'
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
/** 仅接受唯一本人受理→开始→消费前缀；无user/header/step/tool/其他活动。 */
function acceptedPrefix(run:Pick<TaskRun,'nativeRequestId'|'inputText'>,events:readonly SessionEvent[],inheritedEventCount:number){
 if(inheritedEventCount!==0||events.length<3)return null
 let accepted=-1,start=-1,consumed=-1,turn=-1,message:UserMessage|undefined
 const queues:{[key:string]:UserMessage[]}={'next-turn':[],'next-step':[]}
 for(let i=0;i<events.length;i++){
  const e=events[i]!
  if(e.seq!==i||!Number.isSafeInteger(e.time)||e.time<0)return null
  if(['permission/preset','sandbox/mode','approval/policy','session/end-seed'].includes(e.type)){
   if(accepted!==-1||e.type==='session/end-seed'&&Object.keys(e.data).length!==0)return null
   continue
  }
  if(e.type==='agent/inbox/spliced'){
   const d=e.data,q=queues[d.target]
   if(!q||d.outcome!==undefined||!Number.isSafeInteger(d.start)||d.start<0||d.start>q.length||!Number.isSafeInteger(d.removedCount??0)||(d.removedCount??0)<0||(d.removedCount??0)>q.length-d.start)return null
   if(d.inserted.length){
    if(accepted!==-1||d.target!=='next-turn'||d.start!==0||(d.removedCount??0)!==0||d.inserted.length!==1||start!==-1)return null
    const m=d.inserted[0]!
    if(m.role!=='user'||m.source.kind!=='user'||Reflect.get(m.source,'rpcId')!==run.nativeRequestId||m.content.length===0||m.content.some(b=>b.type!=='text')||m.content[0]?.type!=='text'||![run.inputText,taskInputWithoutMemory(run.inputText)].includes(m.content[0].text))return null
    message=m;accepted=i
   }else{
    if(start===-1||consumed!==-1||d.target!=='next-turn'||d.start!==0||d.removedCount!==1||q.length!==1||!isDeepStrictEqual(q[0],message))return null
    consumed=i
   }
   q.splice(d.start,d.removedCount??0,...d.inserted)
  }else if(e.type==='turn/start'){
   if(accepted===-1||start!==-1||!Number.isSafeInteger(e.data.turn)||e.data.turn<0)return null
   start=i;turn=e.data.turn
  }else return null
 }
 return message&&consumed===events.length-1&&!queues['next-turn']!.length&&!queues['next-step']!.length?{accepted,start,consumed,turn,message}:null
}
/** 只为既有独占writer封口提供资格；不执行、发布或重放任何输入。 */
export function canSealAcceptedInboxInterruption(run:Pick<TaskRun,'nativeRequestId'|'inputText'>,events:readonly SessionEvent[],inheritedEventCount=0):boolean{return acceptedPrefix(run,events,inheritedEventCount)!==null}
/** 旧error形状不变；中断必须是官方closer及紧邻empty恢复seal，endSeq仍指turn/end。 */
export function acceptedInboxErrorEvidence(run:Pick<TaskRun,'nativeRequestId'|'inputText'>,events:readonly SessionEvent[],inheritedEventCount=0):AcceptedInboxFailureEvidence|null{
 if(events.some((e,i)=>e.seq!==i||!Number.isSafeInteger(e.time)||e.time<0))return null
 const end=events.findIndex(e=>e.type==='turn/end');if(end<0)return null
 const prefix=events.slice(0,end),p=acceptedPrefix(run,prefix,inheritedEventCount),e=events[end]
 if(!p||e?.type!=='turn/end'||e.data.turn!==p.turn)return null
 const identity=nativeInputIdentity(p.message,run.nativeRequestId),common={acceptedSeq:p.accepted,turnStartSeq:p.start,consumedSeq:p.consumed,messageId:identity.messageId,payloadSha256:identity.payloadSha256,inputSha256:createHash('sha256').update(run.inputText).digest('hex'),prefixSha256:hash(events)}
 if(e.data.reason.kind==='error'&&end===events.length-1)return {state:'ended',turn:p.turn,messageSeq:p.accepted,endSeq:end,reason:'error',inputAnchor:{kind:'accepted-inbox-error',...common,errorSha256:hash(e.data.reason)}}
 const seal=events[end+1],closers=interruptedTurnClosers(prefix)
 if(e.data.reason.kind!=='interrupted'||end+2!==events.length||closers.length!==1||!isDeepStrictEqual(closers[0],e)||seal?.type!=='session/end-seed'||Object.keys(seal.data).length!==0||seal.time<e.time)return null
 return {state:'ended',turn:p.turn,messageSeq:p.accepted,endSeq:end,reason:'interrupted',inputAnchor:{kind:'accepted-inbox-interrupted',...common,resumeSealSeq:seal.seq,reasonSha256:hash(e.data.reason)}}
}

/** 历史只读允许结束后的普通empty seed元数据；不认领后续输入/轮次或其他活动。 */
export function verifiedAcceptedInboxError(run:Pick<TaskRun,'nativeRequestId'|'inputText'|'evidence'>,events:readonly SessionEvent[],inheritedEventCount=0):AcceptedInboxFailureEvidence|null{
 const e=run.evidence
 if(e?.state!=='ended'||!e.inputAnchor)return null
 const fixed=acceptedInboxErrorEvidence(run,events.slice(0,taskRunEvidenceProofEnd(e)+1),inheritedEventCount)
 if(!isDeepStrictEqual(fixed,e)||events.some((event,index)=>event.seq!==index)||events.slice(taskRunEvidenceProofEnd(e)+1).some(event=>event.type!=='session/end-seed'||Object.keys(event.data).length!==0))return null
 return fixed
}
