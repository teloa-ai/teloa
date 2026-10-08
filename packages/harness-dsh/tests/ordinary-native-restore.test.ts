import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {SessionId,SessionSeq,type SessionEvent} from '@deepseek-ai/dsh-session'
import {WorkAccess} from '../../backend/src/work/work-access.ts'
import {FileConversationRepository} from '../../backend/src/work/conversations.ts'
import {ObjectConversationService} from '../../backend/src/work/object-conversations.ts'
import {initializeConversationWork} from '../../backend/src/work/conversation-work.ts'
import {initializeTaskRunRuntimeLinks} from '../../backend/src/work/task-run-runtime-links.ts'
import {initializeTaskRunGoals} from '../../backend/src/work/task-run-goals.ts'
import {setupRoleWork,roleFixture,insertRoleRun} from '../../backend/tests/role-work-test-fixture.ts'
import {nativeProviderKernel} from './fixtures/native-input-provider.ts'
import {createNativeSessionCapabilities} from '../src/native-session-capabilities.ts'
import {nativeInputRecoveryCandidate} from '../src/native-input-recovery-candidate.ts'
import {createOrdinaryNativeRestoreAuthorization} from '../src/ordinary-native-restore.ts'

test('本人普通 cold user 根从真实 JSONL/PG 恢复；缺领养、受管绑定、伪根及撤权拒绝',{timeout:30000},async t=>{
 const f=await setupRoleWork();t.after(()=>f.close())
 await initializeConversationWork(f.pool);await initializeTaskRunRuntimeLinks(f.pool);await initializeTaskRunGoals(f.pool)
 const kernel=await nativeProviderKernel(t);await kernel.ctx.plugin(kernel.loopPackage.AgentLoop,{agents:[]})
 const root=await mkdtemp(join(tmpdir(),'teloa-ordinary-restore-'));t.after(()=>rm(root,{recursive:true,force:true}))
 await kernel.ctx.plugin(kernel.persistencePackage.default,{root:join(root,'history'),compression:'none'})
 const {owner,role,taskId}=await roleFixture(f.pool,'employee'),id=SessionId('ordinary-main'),messages=[1,2].map(i=>createUserMessage({source:{kind:'user',rpcId:'ordinary-'+i},content:[{type:'text',text:'本人原始待办 '+i}]}))
 const events:SessionEvent[]=messages.map((message,i)=>({type:'agent/inbox/spliced',seq:SessionSeq(i),time:i+1,data:{target:'next-turn',start:i,removedCount:0,inserted:[message]}})),session=kernel.sessionPackage.Session.create(id,events,kernel.sessionPackage.Session.create(id).header,kernel.sessionPackage.SessionLogOffset(0))
 const writer=await kernel.ctx.sessionPersistence.create(session.header,{inheritedEventCount:kernel.sessionPackage.SessionLogOffset(0)});await writer.append(session.snapshotEvents());await writer.flush();await writer.close()
 const snapshot=async()=>{const reader=await kernel.ctx.sessionPersistence.open(id,'read');try{return {header:reader.header,events:(await reader.read()).events,inheritedEventCount:Number(reader.inheritedEventCount)}}finally{await reader.close()}}
 const original=await snapshot(),repository=new FileConversationRepository(join(root,'conversations.json')),row={id:'owned-main',sessionId:id,requestedSessionId:id,ownerId:owner,title:'本人普通会话',scopeIds:['general'] as ['general'],version:1 as const,status:'ready' as const,createdAt:new Date().toISOString()}
 await repository.write([row])
 let revoked=false,hostClosed=false,generation=0
 const access=new WorkAccess();access.requirePolicy();access.requireSessionCapabilities();access.installPolicy(async()=>({assertCurrent(){if(revoked)throw Error('本人许可已撤销')}}))
 const links=new ObjectConversationService(f.pool,async()=>row,()=>new Date().toISOString())
 access.installSessionCapabilities(createNativeSessionCapabilities(kernel.ctx,{owner,conversations:{repository},links,pool:f.pool,isRoutingSession:()=>false}))
 const authorize=createOrdinaryNativeRestoreAuthorization(kernel.ctx,{owner,conversations:{repository},pool:f.pool,snapshot,isRoutingSession:()=>false,access,provenanceGeneration:()=>generation,assertCurrent(){if(hostClosed)throw Error('宿主已关闭')}})
 const candidate=nativeInputRecoveryCandidate({snapshot:original,inbox:kernel.ctx.sessionProjections.stateOf(kernel.sessionPackage.Session.create(id,original.events,original.header,kernel.sessionPackage.SessionLogOffset(0)),'inbox')});assert.ok(candidate)
 const input={sessionId:id,snapshot:original,messages,signal:new AbortController().signal},lease=await authorize(input,candidate);assert.equal(lease.roots.length,2);lease.assertCurrent()
 await repository.write([]);await assert.rejects(authorize(input,candidate),{code:'teloa/forbidden'});await repository.write([row])
 await assert.rejects(authorize({...input,messages:messages.slice(0,1)},candidate),{code:'teloa/forbidden'})
 const forged={...structuredClone(input.snapshot),events:[...structuredClone(input.snapshot.events)]},goal=createUserMessage({source:{kind:'goal',goalId:'unmanaged-goal' as never,revision:1,round:2},content:[{type:'text',text:'伪造的系统续轮'}]})
 forged.events[0]={type:'agent/inbox/spliced',seq:SessionSeq(0),time:1,data:{target:'next-turn',start:0,removedCount:0,inserted:[goal]}}
 const forgedCandidate=nativeInputRecoveryCandidate({snapshot:forged,inbox:kernel.ctx.sessionProjections.stateOf(kernel.sessionPackage.Session.create(id,forged.events,forged.header,kernel.sessionPackage.SessionLogOffset(0)),'inbox')});assert.ok(forgedCandidate)
 await assert.rejects(authorize({...input,snapshot:forged,messages:forgedCandidate.messages},forgedCandidate),{code:'teloa/forbidden'})
 const runId=await insertRoleRun(f.pool,owner,role.id,taskId);await f.pool.query('update teloa_task_runs set session_id=$2 where id=$1',[runId,id]);await assert.rejects(authorize(input,candidate),{code:'teloa/forbidden'});await f.pool.query('update teloa_task_runs set session_id=$2 where id=$1',[runId,randomUUID()])
 revoked=true;assert.throws(()=>lease.assertCurrent(),{code:'teloa/forbidden'});await assert.rejects(authorize(input,candidate),{code:'teloa/forbidden'});revoked=false
 hostClosed=true;assert.throws(()=>lease.assertCurrent(),/宿主已关闭/);hostClosed=false
 generation++;assert.throws(()=>lease.assertCurrent(),{code:'teloa/forbidden'})
 assert.deepEqual(await snapshot(),original);assert.equal(kernel.ctx.agents.get(id),undefined)
})
