import type {Context} from '@deepseek-ai/cordis'
import {SessionId} from '@deepseek-ai/dsh-session'
import type {ConversationService,ObjectConversationService,PlanService,SessionCapabilityReader,WorkCapability} from '@teloa/backend'
import {workAccess,sessionInput,type WorkAccess} from '@teloa/backend'
import {WorkError,type SessionCapabilitySnapshot} from '@teloa/contract'
import {resolveSessionLineage} from './subagent-lineage.ts'

type Ports={owner:string;conversations:Pick<ConversationService,'repository'>;links:Pick<ObjectConversationService,'bySession'>;pool:Pick<PlanService['pool'],'query'>;isRoutingSession:(sessionId:string)=>boolean}

/** owner 由原宿主固定，客户端只提交 sessionId；读取历史不申请执行许可。 */
export async function readNativeSessionCapabilities(owner:string,input:unknown,access:Pick<WorkAccess,'readSessionCapabilities'>=workAccess):Promise<SessionCapabilitySnapshot>{
 return access.readSessionCapabilities(owner,sessionInput(input))
}

/** 只读取本人已落盘关联及实际 Agent 谱系；冷恢复不 resolve/activate 会话。 */
export function createNativeSessionCapabilities(ctx:Pick<Context,'agents'>,ports:Ports):SessionCapabilityReader{
 return async(sessionId,producer)=>{
  const actual=ctx.agents.get(SessionId(sessionId)),root=actual?resolveSessionLineage(ctx,actual.session).root.id:sessionId
  const capabilities=new Set<WorkCapability>()
  if(producer==='subagent'||actual?.session.header.origin==='subagent')capabilities.add('parallel-agents')
  if(producer==='schedule')capabilities.add('automation')
  if(ports.isRoutingSession(root))capabilities.add('groups')
  else{
   // 直接读快照，避免等待正在创建该会话的队列或反向激活冷日志。
   const binding=(await ports.conversations.repository.read()).find(row=>row.sessionId===root)
   if(!binding||binding.ownerId!==ports.owner||binding.status!=='ready')throw new WorkError('teloa/forbidden','当前会话没有可核验的本人工作归属。')
   const links=await ports.links.bySession(ports.owner,{sessionId:root})
   if(binding.requestedRoleId||binding.purpose==='task-run'||links.some(link=>link.kind==='role'||link.kind==='task'))capabilities.add('people')
   const runs=(await ports.pool.query('select role_id,group_context_hash,plan_context_hash from teloa_task_runs where owner_id=$1 and session_id=$2',[ports.owner,root])).rows
   for(const run of runs){
    if(run.role_id)capabilities.add('people')
    if(run.group_context_hash!==null)capabilities.add('groups')
    if(run.plan_context_hash!==null)capabilities.add('automation')
   }
   if((await ports.pool.query('select 1 from teloa_conversation_work_requests where owner_id=$1 and session_id=$2 union all select 1 from teloa_conversation_work_contexts where owner_id=$1 and session_id=$2 and role_id is not null limit 1',[ports.owner,root])).rows.length)capabilities.add('people')
  }
  if(!capabilities.size)capabilities.add('general-agent')
  return Object.freeze({ownerId:ports.owner,capabilities:Object.freeze([...capabilities])})
 }
}
