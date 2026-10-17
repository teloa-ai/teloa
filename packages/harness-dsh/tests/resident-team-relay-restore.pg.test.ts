import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {SessionId,SessionSeq,SessionLogOffset,type SessionEvent} from '@deepseek-ai/dsh-session'
import {createUserMessage,LlmAdapter,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {initializeTeloaDatabase,ResourceService,RoleService,TaskService,ConversationWorkService,TaskRunService,ObjectConversationService,TaskRunRuntimeLinkService,TaskRunSubagentService} from '@teloa/backend'
import {setupRoleWork,identity} from '../../backend/tests/role-work-test-fixture.ts'
import {testRoleResponsibility} from '../../backend/tests/role-test-fixture.ts'
import {createPublicReferenceCatalog} from '../../mcp-reference/src/local.ts'
import {patchedCorePackages} from './fixtures/native-final-session.ts'
import {TeloaNativeInput,requireNativeInputProvider} from '../src/native-input-provider.ts'
import {createResidentWorkRuntime} from '../src/resident-work-runtime.ts'
import {nativeInputRecoveryCandidate} from '../src/native-input-recovery-candidate.ts'
import {textAnswer} from './fixtures/native-hot-causality.ts'

test('真实 PG/JSONL 与 Loop：恢复未领取的 Team relay，只认本人原 Run、成员预留及父子链',{timeout:45000},async t=>{
 const f=await setupRoleWork(),directory=await mkdtemp(join(tmpdir(),'teloa-relay-restore-'))
 const graph=await patchedCorePackages(t),ctx=new Context()
 let resident:Awaited<ReturnType<typeof createResidentWorkRuntime>>|undefined
 t.after(async()=>{resident?.close();await ctx.fiber.dispose();await f.close();await rm(directory,{recursive:true,force:true})})
 await initializeTeloaDatabase(f.pool)
 for(const plugin of [graph.llmPackage.LlmRuntime,graph.sessionPackage.SessionStore,SessionProjectionRegistry,SystemPrompt,graph.toolsPackage.ToolRuntime,graph.agentPackage.AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(graph.persistencePackage,{root:directory,compression:'none'})
 const inbox=(snapshot:Parameters<NonNullable<typeof resident>['authorizeRestoreRoots']>[0]['snapshot'])=>ctx.sessionProjections.stateOf(graph.sessionPackage.Session.create(SessionId(snapshot.header.id),snapshot.events,snapshot.header,SessionLogOffset(snapshot.inheritedEventCount)),'inbox')
 await ctx.plugin(TeloaNativeInput,{restore:async input=>{
  const candidate=nativeInputRecoveryCandidate({snapshot:input.snapshot,inbox:inbox(input.snapshot)})
  assert.ok(candidate);return resident!.authorizeRestoreRoots(input,candidate)
 }})
 await ctx.plugin(graph.loopPackage.AgentLoop,{agents:[]})
 const owner=randomUUID(),role=await new RoleService(f.pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'恢复核对',kind:'employee',scopes:['general'],duty:'核对原任务',dataScope:'原资料',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'teloa-standard'}}})
 await f.pool.query("update teloa_roles set state='active',version=3 where owner_id=$1 and id=$2",[owner,role.id])
 const parentSession='parent-'+randomUUID(),sessionId=SessionId('run-'+randomUUID()),childId=SessionId('child-'+randomUUID()),reservationId='member-'+randomUUID()
 const conversations=new Map<string,string>()
 const inspect=async(_owner:string,id:string)=>{
  if(!conversations.has(id))conversations.set(id,randomUUID())
  return {id:conversations.get(id)!,ownerId:owner,sessionId:id,status:'ready'}
 }
 const requests=new ConversationWorkService(f.pool,identity.now,async()=>({ownerId:owner,sessionId:parentSession,status:'ready',submitted:false}))
 const parent=await requests.reserve(owner,{requestId:randomUUID(),sessionId:parentSession,messageId:'human',messageSeq:1,kind:'task',scope:'general',title:'复核原目标',goal:'取得团队复核结果',roleId:role.id,expectedRoleVersion:3})
 const runs=new TaskRunService(f.pool,identity,inspect)
 resident=await createResidentWorkRuntime(ctx,{owner,pool:f.pool,identity,nativeInput:requireNativeInputProvider(ctx).input,ownerAuthority:{authorize:async()=>({assertCurrent(){}})},runs:async()=>runs,resources:new ResourceService(f.pool,createPublicReferenceCatalog(),identity),dailyLogs:async()=>{throw Error('恢复不生成日志')},executionScope:(db,actor,id,mode)=>runs.executionScopeInTransaction(db,actor,{runId:id,mode}),verifyInitialMessage:async()=>false,report:()=>{}})
 ctx.provide('teloaResidentInputAdmission',resident)
 const task=await new TaskService(f.pool,identity).createForConversation(owner,{sessionId:parentSession,requestId:parent.requestId,roleId:role.id})
 const linked=await new ObjectConversationService(f.pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const prepared=await runs.prepare(owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:3,sessionId,expectedLinkVersion:linked.version}),claimed=await runs.claim(owner,{runId:prepared.id})
 const run=await runs.record(owner,{runId:prepared.id,sessionId,nativeRequestId:claimed.run.nativeRequestId,evidence:{state:'accepted'}})
 const children=new TaskRunSubagentService(f.pool,identity)
 await children.reserve(owner,{runId:run.id,reservationId,limit:6});await children.bind(owner,{reservationId,childSessionId:childId,depth:1});await children.settle(owner,{childSessionId:childId,stopReason:'completed'})
 const links=new TaskRunRuntimeLinkService(f.pool)
 await links.put(owner,{runId:run.id,kind:'team',nativeId:reservationId,sessionId,payload:{requestId:run.nativeRequestId,reservationId,name:'helper'}})
 const initial=createUserMessage({source:{kind:'user',rpcId:run.nativeRequestId},content:[{type:'text',text:run.inputText}]})
 const message=createUserMessage({source:{kind:'agent-message',form:'relay',senderSessionId:childId},content:[{type:'text',text:'Team message from helper:'},{type:'text',text:'PERSISTED_TEAM_RELAY'}]})
 const row=(type:string,data:unknown,seq:number,surfaceOp?:string)=>({type,data,seq:SessionSeq(seq),time:seq+1,...surfaceOp?{surfaceOp}:{}}) as SessionEvent
 const events=[row('turn/start',{turn:1},0),row('user/message',initial,1,'append'),row('turn/end',{turn:1,reason:{kind:'completed'}},2),row('team/member',{version:2,teamId:sessionId,member:{id:childId,name:'helper',description:'复核',provider:'spawn',context:'fresh',phase:'active'}},3),row('agent/inbox/spliced',{target:'next-turn',start:0,removedCount:0,inserted:[message]},4)]
 const header={...graph.sessionPackage.Session.create(sessionId).header,delegationDepth:0}
 for(const [meta,history] of [[header,events],[{...graph.sessionPackage.Session.create(childId).header,parentSession:sessionId,delegationDepth:1},[]]] as const){
  const writer=await ctx.sessionPersistence.create(meta,{inheritedEventCount:SessionLogOffset(0)});await writer.append(history);await writer.flush();await writer.close()
 }
 const snapshot={header,events,inheritedEventCount:0},candidate=nativeInputRecoveryCandidate({snapshot,inbox:inbox(snapshot)});assert.ok(candidate)
 const reader=await ctx.sessionPersistence.open(sessionId,'read')
 try{
  const persisted={header:reader.header,events:(await reader.read()).events,inheritedEventCount:Number(reader.inheritedEventCount)}
  assert.deepEqual(persisted,snapshot)
  assert.ok(nativeInputRecoveryCandidate({snapshot:persisted,inbox:inbox(persisted)}))
 }finally{await reader.close()}
 const input={sessionId,snapshot,messages:[message],signal:new AbortController().signal}
 let restores=0
 ctx.provide('sessionController',{resolveAgent:async()=>{
  restores++
  await f.pool.query('update teloa_task_run_subagents set reservation_id=$3 where owner_id=$1 and child_session_id=$2',[owner,childId,'wrong-reservation'])
  await assert.rejects(resident!.authorizeRestoreRoots(input,candidate),{code:'teloa/unavailable'})
  await f.pool.query('update teloa_task_run_subagents set reservation_id=$3 where owner_id=$1 and child_session_id=$2',[owner,childId,reservationId])
  const proof=await resident!.authorizeRestoreRoots(input,candidate);proof.assertCurrent()
  return (await ctx.agents.resume({resumeSessionId:sessionId,agentOptions:{provider:'restore-test',model:'fixed'}})).agent
 }} as never)
 let modelCalls=0
 class Answer extends LlmAdapter{
  override async resolveModel(provider:string,model:string){return {provider,id:model,name:model}}
  async *stream(options:GenerateOptions):AsyncIterable<StreamChunk>{modelCalls++;assert.ok(JSON.stringify(options.messages).includes('PERSISTED_TEAM_RELAY'));for(const chunk of textAnswer)yield chunk}
 }
 ctx.llm.registerAdapter(['restore-test'],new Answer())
 await f.pool.query("update teloa_work_controls set state='paused' where owner_id=$1 and id=$2",[owner,run.lineage!.roundControlId])
 const control=await resident.controls.get(owner,{controlId:run.lineage!.roundControlId})
 const pending=await resident.recovery.inspect(owner,{controlId:control.id});assert.equal(pending.length,1);assert.equal(pending[0]!.reason,'accepted')
 const request={requestId:randomUUID(),controlId:control.id,expectedVersion:control.version,candidateRunIds:[run.id]}
 await resident.ownerRpc('work-recovery/resume',request,new AbortController().signal)
 await ctx.agents.get(sessionId)!.whenIdle()
 assert.equal(modelCalls,1);assert.equal(restores,1)
 await resident.ownerRpc('work-recovery/resume',request,new AbortController().signal)
 assert.equal(restores,1);assert.equal(modelCalls,1)
})
