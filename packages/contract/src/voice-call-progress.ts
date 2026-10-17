import {WorkError} from './work-error.ts'
import {readTranscriptCommit,readVoiceCall,voiceCallContextKeys,sameVoiceCallContext,type TranscriptCommit,type VoiceCall} from './voice-calls.ts'
import {workTaskStates,type WorkTask} from './tasks.ts'

export const voiceCallProgressLimit=50
export type VoiceCallProgressWork=Readonly<{taskId:string;title:string;status:WorkTask['state']}>
/** 宿主只读投影；完成状态必须来自持久Task，不能由语音回答或模型声明生成。 */
export type VoiceCallProgress=Readonly<{callId:string;callGeneration:string;sessionId:string;transcripts:readonly TranscriptCommit[];work:readonly VoiceCallProgressWork[]}>
const invalid=():never=>{throw new WorkError('teloa/invalid-host-response','通话进度与原通话身份或已受理工作不一致。')}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
function exact(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return invalid()
 const descriptors=Object.getOwnPropertyDescriptors(value)
 if(Reflect.ownKeys(value).length!==keys.length||Object.keys(descriptors).some(key=>!keys.includes(key)||!('value'in descriptors[key]!)))return invalid()
 return value as Record<string,unknown>
}
/** expectedCall 由原本人通话回执提供；结构读器本身不证明任务归属或封口生产者。 */
export function readVoiceCallProgress(value:unknown,expectedCall?:VoiceCall):VoiceCallProgress{
 const row=exact(value,['callId','callGeneration','sessionId','transcripts','work'])
 if(!uuid(row.callId)||!uuid(row.callGeneration)||typeof row.sessionId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(row.sessionId)||!Array.isArray(row.transcripts)||!Array.isArray(row.work)||row.transcripts.length>voiceCallProgressLimit||row.work.length>voiceCallProgressLimit)return invalid()
 const callId=row.callId.toLowerCase(),callGeneration=row.callGeneration.toLowerCase(),sessionId=row.sessionId,call=expectedCall===undefined?undefined:readVoiceCall(expectedCall)
 if(call&&(call.id!==callId||call.callGeneration!==callGeneration||call.sessionId!==sessionId))return invalid()
 const turns=new Set<string>(),commits=new Set<string>(),transcripts=row.transcripts.map(value=>{
  const fields=exact(value,[...voiceCallContextKeys(value),'callId','callGeneration','turnId','speaker','source','revision','text','closed','complete','producerReceipt','id','contentSha256'])
  exact(fields.source,['kind','providerId','audioSha256','sealReceiptId','sttReceiptId'])
  const commit=readTranscriptCommit(fields)
  if(commit.callId!==callId||commit.callGeneration!==callGeneration||commit.sessionId!==sessionId||turns.has(commit.turnId)||commits.has(commit.id)||call&&(!sameVoiceCallContext(commit,call)))return invalid()
  turns.add(commit.turnId);commits.add(commit.id);return commit
 })
 const tasks=new Set<string>(),work=row.work.map(value=>{
  const task=exact(value,['taskId','title','status'])
  if(!uuid(task.taskId)||tasks.has(task.taskId.toLowerCase())||typeof task.title!=='string'||!task.title.trim()||task.title.length>120||!workTaskStates.includes(task.status as WorkTask['state']))return invalid()
  tasks.add(task.taskId.toLowerCase());return Object.freeze({taskId:task.taskId.toLowerCase(),title:task.title,status:task.status as WorkTask['state']})
 })
 return Object.freeze({callId,callGeneration,sessionId,transcripts:Object.freeze(transcripts),work:Object.freeze(work)})
}
