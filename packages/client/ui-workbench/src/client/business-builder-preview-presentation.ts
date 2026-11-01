import type {AssistantMessageNode} from '@deepseek-ai/dsh-client-ui-conversation/client'
export type BusinessPreviewEvent={type:string;seq:number;ignorable?:boolean;data:any}
type Event=BusinessPreviewEvent
const recordType='plugin:teloa/business-builder-preview'
const digest=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const positive=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>0

/** 只匹配宿主同session/原turn/step/原message的完整记录链；不依据JSON外形或当前会话模式隐藏回答。 */
export function readBusinessBuilderPreviewMessage(sessionId:string,node:Pick<AssistantMessageNode,'seq'|'turn'|'step'|'messageId'>,entries:readonly {event:Event}[]){
 const events=entries.map(row=>row.event),before=events.filter(event=>event.seq<=node.seq)
 const record=(event:Event)=>event.type===recordType&&event.ignorable===true&&event.data?.sessionId===sessionId
 const prepared=before.filter(event=>record(event)&&event.data.kind==='prepared'&&event.data.turn===node.turn&&event.data.step===node.step).at(-1)
 if(!prepared)return null
 const p=prepared.data
 if(typeof p.owner!=='string'||!p.owner||typeof p.draftId!=='string'||!p.draftId||typeof p.requestId!=='string'||!p.requestId||typeof p.messageId!=='string'||!p.messageId||!positive(p.revision)||!digest(p.draftHash)||!digest(p.fingerprint))return null
 const start=before.filter(event=>event.type==='turn/start').at(-1)
 if(!start||start.data.turn!==node.turn||start.seq>=prepared.seq)return null
 const mode=events.filter(event=>event.seq<prepared.seq&&record(event)&&event.data.kind==='mode').at(-1)?.data
 if(!mode||mode.mode!=='preview'||mode.owner!==p.owner||mode.draftId!==p.draftId||mode.requestId!==p.modeRequestId||!positive(mode.revision)||mode.revision>p.revision)return null
 const step=before.find(event=>event.seq>prepared.seq&&event.type==='step/start'&&event.data.turn===node.turn&&event.data.step===node.step)
 const user=before.find(event=>event.seq>prepared.seq&&event.type==='user/message'&&event.data.id===p.messageId&&event.data.source?.kind==='user')
 if(!step||!user)return null
 const answer=before.find(event=>event.seq===node.seq&&event.type==='assistant/message')
 if(node.messageId!==undefined&&(!answer||answer.data.turn!==node.turn||answer.data.step!==node.step||answer.data.message.id!==node.messageId))return null
 const settled=events.filter(event=>event.seq>(answer?.seq??prepared.seq)&&record(event)&&event.data.kind==='settled'&&event.data.requestId===p.requestId).at(-1)?.data
 if(settled){
  if(settled.owner!==p.owner||settled.draftId!==p.draftId)return null
  if(settled.state==='saved'&&settled.revision===p.revision+1&&digest(settled.hash))return {state:'saved' as const}
  if((settled.state==='failed'||settled.state==='unknown')&&settled.revision===p.revision)return {state:settled.state as 'failed'|'unknown'}
  return null
 }
 const end=events.find(event=>event.seq>prepared.seq&&event.type==='turn/end'&&event.data.turn===node.turn)
 return {state:!end?'generating':end.data.reason?.kind==='aborted'?'cancelled':end.data.reason?.kind==='error'?'failed':'unknown'} as const
}

