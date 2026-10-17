import {WorkError,type VoiceCallStartInput} from '@teloa/contract'
import type {VoiceCallContextLease} from './voice-call-runtime.ts'

type NativeBinding=Readonly<{session:object;fingerprint:string}>
type Ports=Readonly<{
 owner:string
 readNativeBinding:(sessionId:string)=>NativeBinding|null
 roleEpoch:(roleId:string)=>number
 subscribeRole:(roleId:string,invalidate:()=>void)=>()=>void
}>
const stale=()=>new WorkError('teloa/forbidden','当前通话的身份或会话已变化，请重新打开会话。')

/** 捕获实际原生会话及当前角色世代；关联修改和宿主收尾同步撤销媒体，不停止业务工作。 */
export function createVoiceContextAuthority(ports:Ports){
 const leases=new Map<string,Set<AbortController>>()
 const sessionEpochs=new Map<string,number>()
 let disposed=false
 const invalidateSession=(sessionId:string)=>{
  sessionEpochs.set(sessionId,(sessionEpochs.get(sessionId)??0)+1)
  for(const controller of [...leases.get(sessionId)??[]])controller.abort(stale())
 }
 const capture=(input:Readonly<VoiceCallStartInput>):VoiceCallContextLease=>{
  if(disposed)throw stale()
  const original=ports.readNativeBinding(input.sessionId),epoch=input.target==='assistant'?0:ports.roleEpoch(input.roleId),sessionEpoch=sessionEpochs.get(input.sessionId)??0
  if(!original||typeof original.fingerprint!=='string'||!original.fingerprint||!Number.isSafeInteger(epoch)||epoch<0)throw stale()
  const controller=new AbortController(),active=leases.get(input.sessionId)??new Set<AbortController>()
  leases.set(input.sessionId,active);active.add(controller)
  let released=false
  const unsubscribe=input.target==='assistant'?()=>{}:ports.subscribeRole(input.roleId,()=>controller.abort(stale()))
  const assertCurrent=()=>{
   const current=ports.readNativeBinding(input.sessionId)
   if(disposed||released||controller.signal.aborted||(sessionEpochs.get(input.sessionId)??0)!==sessionEpoch||(input.target!=='assistant'&&ports.roleEpoch(input.roleId)!==epoch)||!current||current.session!==original.session||current.fingerprint!==original.fingerprint)throw stale()
  }
  const release=()=>{
   if(released)return
   released=true;unsubscribe();active.delete(controller)
   if(active.size===0&&leases.get(input.sessionId)===active)leases.delete(input.sessionId)
  }
  try{assertCurrent()}catch(error){release();throw error}
  return Object.freeze({signal:controller.signal,assertCurrent,release})
 }
 const dispose=()=>{if(disposed)return;disposed=true;for(const sessionId of [...leases.keys()])invalidateSession(sessionId)}
 return Object.freeze({owner:ports.owner,capture,invalidateSession,dispose})
}
