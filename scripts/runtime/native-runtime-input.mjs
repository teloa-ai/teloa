import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'

const core=createRequire(new URL('../../packages/harness-dsh/package.json',import.meta.url))
const {TeloaNativeInput,nativeInputRecoveryCandidate,nativeInputRestoreVersion,nativeInputRecoveryCandidateVersion}=await import(pathToFileURL(core.resolve('@teloa/harness-dsh/native-input-provider')).href)
const {Session,SessionId,SessionLogOffset}=await import(pathToFileURL(core.resolve('@deepseek-ai/dsh-session')).href)
if(nativeInputRestoreVersion!==1||nativeInputRecoveryCandidateVersion!==1)throw Error('公共核心没有严格冷恢复契约。')
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value
const digest=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const denied=()=>Error('冷恢复缺少完整持久根授权或当前本人恢复票据。')
const invoke=(lease)=>{if(typeof lease?.assertCurrent!=='function')throw denied();const result=lease.assertCurrent();if(result!==undefined){void Promise.resolve(result).catch(()=>{});throw denied()}}

/** 只消费固定常驻服务的逐根证明；完整 Inbox 候选不构成授权，也不能用挑选的子集恢复。 */
export function createManagedNativeRestore(ctx){
 return async input=>{
  if(!input||Object.keys(input).sort().join(',')!=='messages,sessionId,signal,snapshot'||Object.values(Object.getOwnPropertyDescriptors(input)).some(value=>!Object.hasOwn(value,'value'))||!(input.signal instanceof AbortSignal))throw denied()
  input.signal.throwIfAborted()
  const {snapshot}=input,fingerprint=digest([input.sessionId,snapshot,input.messages])
  if(snapshot.header.id!==input.sessionId)throw denied()
  const session=Session.create(SessionId(input.sessionId),snapshot.events,snapshot.header,SessionLogOffset(snapshot.inheritedEventCount)),inbox=ctx.sessionProjections.stateOf(session,'inbox')
  const candidate=nativeInputRecoveryCandidate({snapshot,inbox})
  if(!candidate||digest(candidate.messages)!==digest(input.messages))throw denied()
  const provider=ctx.get('teloaResidentInputAdmission'),authorize=provider?.authorizeRestoreRoots
  if(typeof authorize!=='function')throw denied()
  const current=()=>{input.signal.throwIfAborted();if(ctx.get('teloaResidentInputAdmission')!==provider||digest([input.sessionId,input.snapshot,input.messages])!==fingerprint)throw denied()}
  current()
  const proof=await Reflect.apply(authorize,provider,[input,candidate])
  current()
  if(!proof||!Array.isArray(proof.roots)||proof.roots.length!==candidate.roots.length||digest(proof.roots)!==digest(candidate.roots))throw denied()
  invoke(proof);current()
  return Object.freeze({roots:candidate.roots,assertCurrent(){current();invoke(proof);current();return undefined}})
 }
}

/** 组合入口固定恢复策略；用户 profile 的 JSON 配置不能关闭常驻授权或替换恢复函数。 */
export default class ManagedNativeRuntimeInput extends TeloaNativeInput{
 constructor(ctx,config={}){
  if(!config||typeof config!=='object'||Array.isArray(config)||Object.keys(config).some(key=>!['requireResident'].includes(key))||config.requireResident===false)throw denied()
  super(ctx,{requireResident:true,restore:createManagedNativeRestore(ctx)})
 }
}
