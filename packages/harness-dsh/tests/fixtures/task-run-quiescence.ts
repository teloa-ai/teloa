import {createHash,randomUUID} from 'node:crypto'
import assert from 'node:assert/strict'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createRequire} from 'node:module'
import {Context} from '@deepseek-ai/cordis'
import {SessionStore,SessionId,SessionSeq,type SessionEvent} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry,type ProjectionDefinition} from '@deepseek-ai/dsh-session-projection'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import type {TaskRun,TaskRunService} from '@teloa/backend'
import {patchedNativePackage} from './native-patched-package.ts'

type Cleanup={after:(action:()=>unknown)=>void}
export async function quiescenceFixture(t:Cleanup){
 const pkg=await patchedNativePackage<typeof import('@deepseek-ai/dsh-agent-loop')&{inboxProjectionDefinition:ProjectionDefinition<'inbox'>&{wire:NonNullable<ProjectionDefinition<'inbox'>['wire']>}}>(t,{packageName:'@deepseek-ai/dsh-agent-loop',compatBasename:'dsh-agent-loop-0.2.1-rc.2-work-admission'})
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-quiescence-'))),ctx=new Context()
 t.after(async()=>{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true})})
 await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(Jsonl,{root,compression:'none'});ctx.sessionProjections.register(pkg.namespace.inboxProjectionDefinition)
 ctx.provide('workingDirectory',{defaultDirectory:root} as never);ctx.provide('agents',{get:()=>undefined} as never)
 const sessionId=SessionId('quiescent-'+randomUUID()),writer=await ctx.sessionPersistence.create({id:sessionId,version:4,createdAt:1,cwd:root,agentPreset:'worker',isSeeded:false})
 const base={taskId:randomUUID(),roleId:randomUUID(),roleVersion:1,linkVersion:1,sessionId,agentPresetId:'worker',allowedTools:[],skills:[],knowledge:[],memory:[],inputText:'{}',createdAt:'2026-10-25T00:00:00.000Z'}
 const a1:TaskRun={...base,id:randomUUID(),taskVersion:1,nativeRequestId:randomUUID(),state:'ended',stopRequestedAt:null,evidence:{state:'ended',turn:1,messageSeq:1,endSeq:2,reason:'completed'}}
 const events:SessionEvent[]=[{type:'turn/start',seq:SessionSeq(0),time:1,data:{turn:1}},{type:'user/message',seq:SessionSeq(1),time:2,surfaceOp:'append',data:createUserMessage({source:{kind:'user',rpcId:a1.nativeRequestId},content:[{type:'text',text:'原输入'}]})},{type:'turn/end',seq:SessionSeq(2),time:3,data:{turn:1,reason:{kind:'completed'}}}]
 const nativeRequestId=randomUUID(),unknownId=randomUUID(),unknown:TaskRun={...base,id:unknownId,taskVersion:2,nativeRequestId,state:'submission_unknown',stopRequestedAt:base.createdAt,evidence:null,submissionDisposition:{schema:'teloa.task-run-submission-disposition/v1',requestId:randomUUID(),runId:unknownId,sessionId,nativeRequestId,inputSha256:createHash('sha256').update(base.inputText).digest('hex'),runtimeId:randomUUID(),logCut:2,logSha256:createHash('sha256').update(JSON.stringify(events)).digest('hex'),acknowledgedUnknown:true,closedAt:base.createdAt}}
 await writer.append(events);await writer.flush();await writer.close()
 const path=await Reflect.get(ctx.sessionPersistence,'resolveCurrentLog').call(ctx.sessionPersistence,sessionId)
 const appendF1=async(text='本人新核验')=>{
  const start=events.length,turn=events.filter(event=>event.type==='turn/start').length+1
  const f1:TaskRun={...base,id:randomUUID(),taskVersion:turn+1,nativeRequestId:randomUUID(),state:'ended',stopRequestedAt:null,evidence:{state:'ended',turn,messageSeq:start+1,endSeq:start+2,reason:'completed'}}
  const more:SessionEvent[]=[{type:'turn/start',seq:SessionSeq(start),time:start+1,data:{turn}},{type:'user/message',seq:SessionSeq(start+1),time:start+2,surfaceOp:'append',data:createUserMessage({source:{kind:'user',rpcId:f1.nativeRequestId},content:[{type:'text',text}]})},{type:'turn/end',seq:SessionSeq(start+2),time:start+3,data:{turn,reason:{kind:'completed'}}}]
  const handle=await ctx.sessionPersistence.open(sessionId,'write');await handle.append(more);await handle.flush();await handle.close();events.push(...more);return f1
 }
 return {ctx,path,events,a1,unknown,appendF1}
}

/** 固定查询回放只供单测；真实取消/暂停/恢复事务另由具名PG用例验证。 */
export async function cancelledQuiescenceFixture(t:Cleanup){
 const f=await quiescenceFixture(t),owner=randomUUID(),runtimeId=randomUUID(),attemptId=randomUUID(),requestId=randomUUID()
 const {submissionDisposition:_disposition,...original}=f.unknown
 const cancelled:TaskRun={...original,state:'withdrawn'},history=[f.a1,cancelled]
 const receipt={schema:'teloa.task-run-unpublished-cancellation/v1',requestId,identity:{runId:cancelled.id,sessionId:cancelled.sessionId,nativeRequestId:cancelled.nativeRequestId,inputSha256:createHash('sha256').update(cancelled.inputText).digest('hex')},runtimeId,attemptIds:[attemptId],latestAttemptId:attemptId,logCut:f.events.length-1,logSha256:createHash('sha256').update(JSON.stringify(f.events)).digest('hex'),stopRequestedAt:cancelled.stopRequestedAt!,cancelledAt:'2026-10-25T00:00:01.000Z'}
 const saved={request_id:requestId,receipt,audit:null as unknown},queries:string[]=[],cancellations=new Map([[cancelled.id,saved]])
 const maintained=()=>{const first=randomUUID();receipt.attemptIds.unshift(first);saved.audit={schema:'teloa.task-run-maintenance/v1',source:'maintenance-process-exit',installId:randomUUID(),requestId,runId:cancelled.id,processReceipt:{schema:'teloa.maintenance-process-exit/v1',signal:'SIGTERM',supervisor:{pid:101,pidVersion:1,uniqueId:'101'},child:{pid:102,pidVersion:1,uniqueId:'102'},exited:[101,102],bindingSha256:'a'.repeat(64)},backupSha256:'b'.repeat(64),logFileSha256:'c'.repeat(64)}}
 let absent=false,effects=false
 const links=()=>history.map(run=>({owner_id:owner,run_id:run.id,kind:'job',native_id:`owner:${runtimeId}:${run.sessionId}`,session_id:run.sessionId,payload:{record:'owner',runtimeId,requestId:run.nativeRequestId},owner_settlement:null}))
 // 真实Client/Pool仅提供类型完整的测试端口；连接方法完全替换，绝不连接任何默认库。
 type DB=Parameters<TaskRunService['readVerifiedInTransaction']>[0]
 const {Client,Pool}=createRequire(import.meta.resolve('@teloa/backend'))('pg') as {Client:new(config:object)=>Omit<DB,'release'>;Pool:new(config:object)=>TaskRunService['pool']}
 const config={host:'127.0.0.1',port:1,user:'quiescence-unit',database:'quiescence-unit',password:''},db=Object.assign(new Client(config),{release(){}}),pool=new Pool(config)
 db.query=(async(text:string,values:unknown[]=[])=>{
  queries.push(text)
  let rows:Record<string,unknown>[]=[]
  if(['begin','commit','rollback'].includes(text)){}
  else if(text.includes("state='withdrawn'"))rows=!absent&&values[0]===owner&&history.some(run=>run.id===values[1]&&run.state==='withdrawn')?[{id:values[1]}]:[]
  else if(text.includes('from teloa_task_runs'))rows=values[0]===owner?history.map(run=>({id:run.id})):[]
  else if(text.includes('from teloa_tasks'))rows=values[0]===owner?[{id:f.a1.taskId}]:[]
  else if(text.includes('from teloa_task_run_unpublished_cancellations'))rows=!absent&&cancellations.has(String(values[1]))?[cancellations.get(String(values[1]))!]:[]
  else if(text.includes('from teloa_task_run_submissions')){const r=cancellations.get(String(values[1]))?.receipt;rows=r?r.attemptIds.map(id=>({attempt_id:id,state:'not-published',runtime_id:r.runtimeId,session_id:r.identity.sessionId,native_request_id:r.identity.nativeRequestId,input_sha256:r.identity.inputSha256,settled_at:new Date(r.cancelledAt)})):[]}
  else if(text.includes('from teloa_task_run_runtime_links'))rows=links().filter(row=>Array.isArray(values[1])?(values[1] as string[]).includes(row.run_id):row.run_id===values[1])
  else if(text.startsWith('select 1 from '))rows=effects?[{present:1}]:[]
  else assert.fail('未登记的单元查询：'+text)
  return {rows,rowCount:rows.length,command:'SELECT',oid:0,fields:[]}
 }) as typeof db.query
 pool.connect=(async()=>db) as typeof pool.connect
 t.after(()=>pool.end())
 const readRun:import('@teloa/backend').TaskRunService['readVerifiedInTransaction']=async(_db,actor,id)=>{assert.equal(actor,owner);const run=history.find(row=>row.id===id);assert(run);return structuredClone(run)}
 return {...f,owner,cancelled,history,receipt,saved,queries,maintained,addCancelled:()=>{const run:TaskRun={...cancelled,id:randomUUID(),taskVersion:history.length+1,nativeRequestId:randomUUID()};const next=structuredClone(receipt);next.requestId=randomUUID();next.identity={...next.identity,runId:run.id,nativeRequestId:run.nativeRequestId};next.attemptIds=[randomUUID()];next.latestAttemptId=next.attemptIds[0]!;next.logCut=f.events.length-1;next.logSha256=createHash('sha256').update(JSON.stringify(f.events)).digest('hex');cancellations.set(run.id,{request_id:next.requestId,receipt:next,audit:null});history.push(run);return run},reader:{pool,readRun},absent:(value:boolean)=>{absent=value},effects:(value:boolean)=>{effects=value},appendCompleted:async()=>{const next=await f.appendF1('本人新请求引用旧取消身份 '+cancelled.nativeRequestId+'，不重放旧请求');history.push(next);return next}}
}

export {SessionId,SessionSeq,createUserMessage}
export type {SessionEvent}
