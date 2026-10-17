import {AsyncLocalStorage} from 'node:async_hooks'
import {WorkError,readTranscriptCommit,type TranscriptCommit} from '@teloa/contract'
import type {WorkAccessLease} from '@teloa/backend'
import type {ControllerInputCandidate} from './native-producer-admission.ts'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {UserMessage} from '@deepseek-ai/dsh-session'

type VoiceInput=Readonly<{original:TranscriptCommit;fixed:TranscriptCommit;mode:'queue'|'steer';assertCurrent:()=>void}>
export type AcceptedVoiceMessage=Readonly<{sessionId:string;callId:string;callGeneration:string;inputId:string;standalone:boolean}>
const forbidden=()=>new WorkError('teloa/forbidden','当前语音输入不属于本人原会话。')

/** 本人物理宿主专用；UUID 是关联键，实际来源由不可序列化的 async scope 与 service 断言共同证明。 */
export class NativeVoiceInputAdmissions{
 readonly #requests=new Map<string,VoiceInput>()
 readonly #scope=new AsyncLocalStorage<VoiceInput>()
 readonly #candidates=new WeakMap<VoiceInput,{agent:Agent;messageId:UserMessage['id'];standalone:boolean}>()
 readonly #accepted=new WeakMap<UserMessage,{agent:Agent;binding:AcceptedVoiceMessage}>()
 #closed=false
 #assert(entry:VoiceInput):void{
  if(this.#closed||this.#requests.get(entry.fixed.id)!==entry)throw forbidden()
  try{
   const returned:unknown=entry.assertCurrent()
   if(returned!==undefined){void Promise.resolve(returned).catch(()=>{});throw forbidden()}
  }catch{throw forbidden()}
 }
 /** 仅 host 调用；一次调用即固定原请求，回执未知也不能再次 dispatch 或改绑会话。 */
 async withPrompt<T>(commit:TranscriptCommit,assertCurrent:()=>void,dispatch:()=>Promise<T>,mode:'queue'|'steer'='queue'):Promise<T>{
  if(this.#closed||typeof assertCurrent!=='function'||typeof dispatch!=='function'||mode!=='queue'&&mode!=='steer')throw forbidden()
  const fixed=readTranscriptCommit(commit)
  if(this.#requests.has(fixed.id))throw new WorkError('teloa/conflict','原语音输入已经尝试，只能核对同一请求。')
  const entry=Object.freeze({original:commit,fixed,mode,assertCurrent})
  this.#requests.set(fixed.id,entry)
  this.#assert(entry)
  try{return await this.#scope.run(entry,dispatch)}finally{this.#candidates.delete(entry)}
 }
 /** 官方 Controller 已解析 Agent/message 后捕获，附加到同一个最终 Session guard。 */
 controller(candidate:ControllerInputCandidate):WorkAccessLease|undefined{
  if(candidate.kind!=='prompt')return undefined
  const entry=this.#requests.get(candidate.requestId)
  if(!entry)return undefined // 普通输入仍由原 WorkAccess、角色与最终 Session 准入处理。
  if(this.#scope.getStore()!==entry)throw forbidden()
  const check=()=>{
   this.#assert(entry)
   const {message}=candidate,{fixed}=entry
   if(candidate.agent.id!==fixed.sessionId||candidate.agent.session.id!==fixed.sessionId||candidate.requestId!==fixed.id||candidate.mode!==entry.mode||message.role!=='user'||message.source.kind!=='user'||!('rpcId' in message.source)||message.source.rpcId!==fixed.id||message.content.length!==1||message.content[0]?.type!=='text'||message.content[0].text!==fixed.text)throw forbidden()
  }
  check()
  this.#candidates.set(entry,{agent:candidate.agent,messageId:candidate.message.id,standalone:entry.mode==='queue'&&candidate.agent.status==='idle'&&candidate.agent.inbox.nextTurn.length===0&&candidate.agent.inbox.nextStep.length===0})
  return Object.freeze({
   assertCurrent:check,
   // 只约束首次发布；实际受理后的因果和执行许可由已有续作租约保留，媒体结束不撤工作。
   assertContinuationCurrent(){},
  })
 }
 /** 仅由宿主 Inbox 事件调用；Session 的 canonical 快照必须仍在同一次已准入的发布链内。 */
 captureInserted(agent:Agent,message:UserMessage):void{
  const entry=this.#scope.getStore(),candidate=entry&&this.#candidates.get(entry)
  if(this.#closed||!entry||!candidate||candidate.agent!==agent||this.#requests.get(entry.fixed.id)!==entry)return
  const {fixed}=entry
  if(agent.id!==fixed.sessionId||agent.session.id!==fixed.sessionId||message.id!==candidate.messageId||message.source.kind!=='user'||!('rpcId'in message.source)||message.source.rpcId!==fixed.id||message.content.length!==1||message.content[0]?.type!=='text'||message.content[0].text!==fixed.text)return
  this.#candidates.delete(entry)
  this.#accepted.set(message,{agent,binding:Object.freeze({sessionId:fixed.sessionId,callId:fixed.callId,callGeneration:fixed.callGeneration,inputId:fixed.id,standalone:candidate.standalone})})
 }
 /** 已受理来源不因媒体挂断撤销；只有同一活跃宿主内的精确 Agent/消息对象可读。 */
 readAcceptedMessage(agent:Agent,message:UserMessage):AcceptedVoiceMessage|undefined{
  const accepted=this.#accepted.get(message)
  return !this.#closed&&accepted?.agent===agent&&accepted.binding.sessionId===agent.id&&agent.session.id===agent.id?accepted.binding:undefined
 }
 close():void{this.#closed=true}
}
