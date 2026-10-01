import {createHash} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import {defineTool,type PreToolDecision} from '@deepseek-ai/dsh-tools'
import {WorkError,isRoleDailyLog,roleDailyLogDiscardInput,roleDailyLogGetInput,roleDailyLogListInput} from '@teloa/contract'
import {resolveSessionLineage,type LineageSession} from './subagent-lineage.ts'
import type {DigitalRole} from '@teloa/contract'
import type {RoleDailyLogActor,RoleDayEvidence,RoleDigestRunIdentity} from '@teloa/backend'

export const roleDailyLogEndpoints=['role-daily-log/list','role-daily-log/get','role-daily-log/discard'] as const
export const roleDayEvidenceToolName='teloa_role_day_evidence'
export const roleDailyDigestSubmitToolName='teloa_role_daily_digest_submit'
export const roleDailyDigestToolNames=[roleDayEvidenceToolName,roleDailyDigestSubmitToolName] as const

type RoleDailyLogOperations={
 list:(actor:RoleDailyLogActor,input:unknown)=>Promise<unknown>
 get:(actor:RoleDailyLogActor,input:unknown)=>Promise<unknown>
 discard:(actor:RoleDailyLogActor,input:unknown)=>Promise<unknown>
}

/** 后台生成之外，打开分身目录也会补齐当天观察及未完成的自动保存。 */
export type RoleDailyLogHabitPorts={
 role:(roleId:string)=>Promise<DigitalRole|undefined>
 ensureForDay:(ownerId:string,role:DigitalRole,nowIso:string)=>Promise<unknown>
}

/** 浏览器只以已认证的本人身份读日志、丢弃日志，不接受调用方声明主体。 */
export function createRoleDailyLogHandler(ownerId:string,get:()=>Promise<RoleDailyLogOperations>,habits:()=>Promise<RoleDailyLogHabitPorts>){
 return async(endpoint:string,payload:unknown)=>{
  if(!(roleDailyLogEndpoints as readonly string[]).includes(endpoint))throw new WorkError('teloa/not-found','未提供此每日日志接口。')
  const service=await get(),actor={ownerId,kind:'human' as const}
  if(endpoint==='role-daily-log/list'){
   const input=roleDailyLogListInput(payload)
   // 生成一律吞掉：目录是读口，观察写不出来（开关关着、设置读不出、证据损坏、岗位读不到）不能连带让已有的日志读不出来。
   try{
    const ports=await habits(),role=await ports.role(input.roleId)
    if(role?.kind==='twin')await ports.ensureForDay(ownerId,role,new Date().toISOString())
   }catch{/* 观察生成失败不影响目录 */}
   return service.list(actor,input)
  }
  if(endpoint==='role-daily-log/get')return service.get(actor,roleDailyLogGetInput(payload))
  return service.discard(actor,roleDailyLogDiscardInput(payload))
 }
}

export type RoleDailyDigestToolPorts={
 owner:string
 run:(sessionId:string)=>Promise<{id:string;sessionId:string;state:string}|null>
 digestRun:(runId:string)=>Promise<RoleDigestRunIdentity|null>
 evidence:(identity:RoleDigestRunIdentity)=>Promise<RoleDayEvidence>
 submit:(identity:RoleDigestRunIdentity,requestId:string,value:unknown)=>Promise<unknown>
}

/** 提交回执身份按「本人 + 当次 Run + 当次调用」派生，同一次调用重放到底幂等。 */
function digestRequestIdentity(owner:string,runId:string,callId:string):string{
 const value=createHash('sha256').update(['teloa-role-daily-digest-tool/v1',owner,runId,roleDailyDigestSubmitToolName,callId].join('\0')).digest('hex')
 return `${value.slice(0,8)}-${value.slice(8,12)}-5${value.slice(13,16)}-a${value.slice(17,20)}-${value.slice(20,32)}`
}

/** 三句固定中文理由：不含会话 id、工具参数、数据库文本或上游异常消息。 */
const digestOnlyReason='这两个工具只能在 Auto Dream 的每日小结运行里使用。'
const digestScopeReason='今日小结只能读当天证据并提交小结。'
const digestUnknownReason='无法核对当前运行是否属于 Auto Dream 的每日小结。'
/**
 * `other` 是确定性否定（当前运行确实不是小结运行），`unknown` 是判不出来（读口抖动、上游失败）。
 * 两者绝不能合流：判不出来时退回岗位授权清单，等于在真实小结运行里静默放开整份授权。
 * `unknown` 再分两级：`run` 是连有没有 Run 都没确认到（小结运行一定有 Run，所以这里不可能身处小结运行，
 * 只拒两个小结工具、其余交既有岗位授权闸）；`digest` 是已确认有 Run 只是分不出类别（可能正身处小结运行，全拒）。
 */
type DigestVerdict={kind:'digest';identity:RoleDigestRunIdentity}|{kind:'other'}|{kind:'unknown';stage:'run'|'digest'}
type DigestExecution={agent?:{session:LineageSession};signal:AbortSignal;callId:unknown}
/** 判定结果按谱系根会话记忆的上限：正常路径由 session/disposed 清掉，上限只是异常路径的兜底。 */
const digestVerdictLimit=512

async function classifyDigestRun(ports:RoleDailyDigestToolPorts,root:LineageSession):Promise<DigestVerdict>{
 let run:{id:string;sessionId:string;state:string}|null
 try{run=await ports.run(root.id)}catch{return {kind:'unknown',stage:'run'}}
 if(!run||run.sessionId!==root.id||!['accepted','active'].includes(run.state))return {kind:'other'}
 let identity:RoleDigestRunIdentity|null
 try{identity=await ports.digestRun(run.id)}catch{return {kind:'unknown',stage:'digest'}}
 return identity?{kind:'digest',identity}:{kind:'other'}
}

/**
 * 两个工具走自授权集，因此每次运行都可见；它们自身必须 fail-closed：
 * 当前 Run 所属任务的计划来源不是 {kind:'system-digest'} 时一律 {kind:'deny'}，理由固定中文。
 * 反过来，判定成立的小结运行里只放行这两个工具——岗位授权清单可能比这宽。
 */
export function registerRoleDailyDigestTools(ctx:Context,ports:RoleDailyDigestToolPorts){
 const verdicts=new Map<string,Promise<DigestVerdict>>()
 const verdictOf=(exec:DigestExecution):Promise<DigestVerdict>=>{
  if(!exec.agent)return Promise.resolve({kind:'other'})
  // 取消时连 Run 都没去读，因此不能按「确认没有 Run」办：那会让已取消的非小结工具照旧走 next()。
  // 判不出来即全拒（`digest` 级），与其余读不出来的情形一致。
  if(exec.signal.aborted)return Promise.resolve({kind:'unknown',stage:'digest'})
  let root:LineageSession
  try{root=resolveSessionLineage(ctx,exec.agent.session).root}catch{return Promise.resolve({kind:'other'})}
  const key=root.id,cached=verdicts.get(key)
  if(cached)return cached
  // 判不出来不进缓存：读口抖动不该钉死整条运行，下一次调用要能重新判。
  const pending=classifyDigestRun(ports,root).then(verdict=>{if(verdict.kind==='unknown')verdicts.delete(key);return verdict})
  verdicts.set(key,pending)
  if(verdicts.size>digestVerdictLimit){const oldest=verdicts.keys().next();if(!oldest.done)verdicts.delete(oldest.value)}
  return pending
 }
 const authorize=async(exec:DigestExecution):Promise<RoleDigestRunIdentity>=>{
  const verdict=await verdictOf(exec)
  if(verdict.kind==='digest')return verdict.identity
  throw new WorkError('teloa/forbidden',verdict.kind==='unknown'?digestUnknownReason:digestOnlyReason)
 }
 ctx.tools.register(defineTool({
  name:roleDayEvidenceToolName,
  description:'读取当天与当前执行员工有关的五类证据：运行、成果版本、审批结果、本人修订、群回帖。日期与员工由当前运行固定，不接受参数。读不出任一类时整次失败，不返回空清单。',
  parameters:{},
  output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
  execute:async(args,exec)=>{
   if(args&&typeof args==='object'&&Object.keys(args).length>0)throw new WorkError('teloa/invalid-input','当日证据工具不接受任何参数。')
   const identity=await authorize(exec)
   return JSON.stringify(await ports.evidence(identity))
  },
 }))
 ctx.tools.register(defineTool({
  name:roleDailyDigestSubmitToolName,
  description:'一次性提交今天的工作日志、至多 3 条员工记忆候选与至多 3 条建议撤回。候选的来源由服务端固定为今天这份日志，不接受自选来源。记忆经来源与范围校验后自动保存并生效；建议撤回仍由本人决定。',
  parameters:{
   title:{type:'string',required:true},
   markdown:{type:'string',required:true},
   candidates:{type:'array',required:true,items:{type:'object',additionalProperties:false,properties:{title:{type:'string',required:true},markdown:{type:'string',required:true},scopeIds:{type:'array',required:true,items:{type:'string'}}}}},
   pruneHints:{type:'array',required:true,items:{type:'object',additionalProperties:false,properties:{memoryId:{type:'string',required:true},reason:{type:'string',required:true}}}},
  },
  output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
  execute:async(args,exec)=>{
   const identity=await authorize(exec)
   const requestId=digestRequestIdentity(ports.owner,identity.runId,String(exec.callId))
   const saved=await ports.submit(identity,requestId,args)
   const log=saved&&typeof saved==='object'&&!Array.isArray(saved)?(saved as {log?:unknown}).log:undefined
   // 回包必须是本次运行当天、本岗位的那一份日志；对不上一律不回给模型。
   if(!isRoleDailyLog(log)||log.ownerId!==ports.owner||log.roleId!==identity.roleId||log.roleVersion!==identity.roleVersion||log.day!==identity.day||log.runId!==identity.runId)throw new WorkError('teloa/invalid-host-response','每日日志服务返回了与当前运行身份不一致的小结。')
   return JSON.stringify({requestId,result:saved})
  },
 }))
 const offPre=ctx.on('tools/pre-execute',async(exec,next):Promise<PreToolDecision>=>{
  const digestTool=(roleDailyDigestToolNames as readonly string[]).includes(exec.name)
  const verdict=await verdictOf(exec)
  const deny=(reason:string):PreToolDecision=>({kind:'deny',reason})
  // 已确认有 Run 只是分不出类别时两类工具都拒：退回岗位授权清单等于在真实小结运行里静默放开整份授权。
  // 连 Run 都确认不到时只拒两个小结工具：那不可能是小结运行，其余工具照旧交既有岗位授权闸作答。
  if(verdict.kind==='unknown')return digestTool||verdict.stage==='digest'?deny(digestUnknownReason):next()
  if(verdict.kind==='other')return digestTool?deny(digestOnlyReason):next()
  return digestTool?next():deny(digestScopeReason)
 })
 // 记忆按会话而不是按调用：清理跟着会话结束走，同一次运行里的多次工具调用共用一次判定。
 const offDisposed=ctx.on('session/disposed',session=>{verdicts.delete(String(session.id))})
 return ()=>{offPre();offDisposed()}
}
