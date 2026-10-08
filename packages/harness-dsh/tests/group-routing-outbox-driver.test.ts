import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import type {GroupDispatchItem} from '../../contract/src/group-routing-outbox.ts'
import type {GroupRoutingOutboxPorts} from '../src/group-routing-outbox-driver.ts'
import {WorkAccess} from '../../backend/src/work/work-access.ts'
import {setupRoleWork,identity} from '../../backend/tests/role-work-test-fixture.ts'
import {RoleService} from '../../backend/src/work/roles.ts'
import {TaskService} from '../../backend/src/work/tasks.ts'
import {CollaborationService} from '../../backend/src/work/collaboration.ts'
import {GroupAgentGrantService} from '../../backend/src/work/group-agent-grants.ts'
import {GroupTaskService,initializeGroupTasks} from '../../backend/src/work/group-tasks.ts'
import {GroupRoutingDecisionService,initializeGroupRoutingDecisions} from '../../backend/src/work/group-routing-decisions.ts'
import {GroupRoutingOutboxService,initializeGroupRoutingOutbox} from '../../backend/src/work/group-routing-outbox.ts'
import {TaskRunService} from '../../backend/src/work/task-runs.ts'
import {ObjectConversationService} from '../../backend/src/work/object-conversations.ts'
import {readRunGroupContext} from '../../backend/src/work/task-run-group-context.ts'
import {TaskRunDriver} from '../src/task-run-driver.ts'
import {createNativeWorkInput} from '../src/native-work-input.ts'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {nativeProviderFixture} from './fixtures/native-input-provider.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
async function driver(){try{return (await import('../src/group-routing-outbox-driver.ts')).drainGroupRoutingOutbox}catch(error){if((error as NodeJS.ErrnoException).code==='ERR_MODULE_NOT_FOUND')return undefined;throw error}}
function fixture(){
 const owner=randomUUID(),items:GroupDispatchItem[]=[0,1].map(()=>({id:randomUUID(),ownerId:owner,groupId:randomUUID(),messageId:randomUUID(),decisionVersion:1,roleId:randomUUID(),roleVersion:2,requestId:randomUUID(),state:'pending',taskId:null,runId:null,lineage:null,attempts:0,nextAttemptAt:null,leaseGeneration:0})),receipts=new Map<string,{taskId:string|null;runId:string|null;state:string|null}>(),sent:string[]=[],created:string[]=[],prepared:string[]=[],seen:string[]=[]
 let failRole:string|null=null,revoke=false,crash=false
 const outbox={
  pending:async()=>items.filter(i=>!['settled','blocked'].includes(i.state)),
  claim:async(_owner:string,input:{itemId:string;expectedLeaseGeneration:number})=>{const i=items.find(i=>i.id===input.itemId)!;if(i.leaseGeneration!==input.expectedLeaseGeneration)return null;i.state='leased';i.leaseGeneration++;return {...i}},
  assertDispatch:async()=>{if(revoke)throw Object.assign(Error('revoked'),{code:'teloa/forbidden'})},
  taskInput:async(_owner:string,{itemId}:{itemId:string})=>{const i=items.find(i=>i.id===itemId)!;return {requestId:i.requestId,groupId:i.groupId,messageId:i.messageId,expectedGroupVersion:1,goal:'固定目标',assignee:{roleId:i.roleId,expectedVersion:2},trigger:'routed' as const}},
  receipt:async(_owner:string,{itemId}:{itemId:string})=>receipts.get(itemId)??{taskId:null,runId:null,state:null},
  reserveSubmission:async(_owner:string,{itemId}:{itemId:string})=>{items.find(i=>i.id===itemId)!.state='unknown'},
  settle:async(_owner:string,input:any)=>{const i=items.find(i=>i.id===input.itemId)!;Object.assign(i,input);if(crash&&i.id===items[0]!.id){crash=false;throw Error('worker disappeared after receipt commit')}return {...i}},
 }
 const ports={outbox,
  createTask:async(_owner:string,input:any)=>{created.push(input.requestId);const i=items.find(i=>i.requestId===input.requestId)!;if(i.roleId===failRole)throw Error('dependency');const taskId=randomUUID();receipts.set(i.id,{taskId,runId:null,state:null});return {taskId}},
  prepare:async(_owner:string,input:any)=>{prepared.push(input.requestId);const i=items.find(i=>i.requestId===input.requestId)!,r=receipts.get(i.id)!;r.runId=randomUUID();r.state='prepared';return {runId:r.runId}},
  start:async(_owner:string,runId:string)=>{sent.push(runId);const r=[...receipts.values()].find(r=>r.runId===runId)!;r.state='submitting';throw Error('native accepted response lost')},
  readRun:async(_owner:string,runId:string)=>({state:[...receipts.values()].find(r=>r.runId===runId)!.state!}),
  reconcile:async(_owner:string,runId:string)=>{seen.push(runId);const r=[...receipts.values()].find(r=>r.runId===runId)!;return {state:r.state!}},report:()=>{},
 } as unknown as GroupRoutingOutboxPorts
 return {owner,items,ports,receipts,sent,created,prepared,seen,fail:(role:string|null)=>{failRole=role},revoke:()=>{revoke=true},crash:()=>{crash=true}}
}
test('单接收者故障不丢其他待办；重入只补未创建的一位',async()=>{
 const drain=await driver();assert.equal(typeof drain,'function','必须有持久outbox恢复投递器');const f=fixture();f.fail(f.items[1]!.roleId)
 await drain!(f.owner,f.ports,new AbortController().signal)
 assert.equal(f.sent.length,1);f.receipts.get(f.items[0]!.id)!.state='accepted';f.fail(null)
 await drain!(f.owner,f.ports,new AbortController().signal)
 assert.equal(f.sent.length,2);assert.equal(f.created.filter(id=>id===f.items[0]!.requestId).length,1);assert.equal(f.items[0]!.state,'settled')
})
test('提交响应丢失只读原Run，持续未知也不会再次start',async()=>{
 const drain=await driver();assert.equal(typeof drain,'function');const f=fixture();f.items.splice(1)
 await drain!(f.owner,f.ports,new AbortController().signal);await drain!(f.owner,f.ports,new AbortController().signal)
 assert.equal(f.sent.length,1);assert.equal(f.created.length,1);assert.equal(f.prepared.length,1);assert.deepEqual(f.seen,[f.sent[0]]);assert.equal(f.items[0]!.state,'unknown')
})
test('真实PG + 官方Agent Inbox：首位受理后响应丢失，重启恢复第二位，双worker绝不重复原生入箱',{timeout:45000},async t=>{
 const drain=await driver();assert.equal(typeof drain,'function')
 const f=await setupRoleWork();t.after(()=>f.close());await initializeGroupTasks(f.pool);await initializeGroupRoutingDecisions(f.pool);await initializeGroupRoutingOutbox(f.pool)
 const {ctx,agent,other}=await nativeProviderFixture(t),access=new WorkAccess();access.installPolicy(async()=>({assertCurrent(){}}));const native=createNativeWorkInput(ctx,access);t.after(()=>native.close())
 const owner=randomUUID(),roles=new RoleService(f.pool,identity),groups=new CollaborationService(f.pool,identity),grants=new GroupAgentGrantService(f.pool,identity.now),recipients:Awaited<ReturnType<RoleService['create']>>[]=[]
 for(const name of ['原生甲','原生乙']){const role=await roles.create(owner,{requestId:randomUUID(),fields:{name,kind:'employee',scopes:['general'],duty:'核对',dataScope:'授权资料',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'standard'}}});await f.pool.query("update teloa_roles set state='active',version=2 where id=$1",[role.id]);recipients.push({...role,version:2})}
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'真实入箱群',scope:'general',announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},memberRoleIds:recipients.map(r=>r.id)}})
 for(const role of recipients)await grants.change(owner,{requestId:randomUUID(),groupId:group.id,roleId:role.id,expectedGroupVersion:1,expectedRoleVersion:2,action:'save',resources:[],canPost:true,canAutoRun:true})
 const message=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:1,text:'两位核对'}),decisions=new GroupRoutingDecisionService(f.pool,identity),outbox=new GroupRoutingOutboxService(f.pool,identity)
 const decision={kind:'routed' as const,respond:recipients.map(r=>r.id),reactions:[],hops:0,candidateIds:recipients.map(r=>r.id),truncatedCandidates:false,stopMessageId:null,at:identity.now()}
 const items=await decisions.withTopicLock(owner,group.id,message.id,async db=>{await decisions.record(db,owner,{groupId:group.id,messageId:message.id,decision});return outbox.recordRecipients(db,owner,{groupId:group.id,messageId:message.id,decision,decisionVersion:1})})
 const agents=new Map([[recipients[0]!.id,agent],[recipients[1]!.id,other]]),conversations=new Map([[agent.id,randomUUID()],[other.id,randomUUID()]]),inspect=async(_owner:string,sessionId:string)=>({id:conversations.get(sessionId as typeof agent.id)!,ownerId:owner,sessionId,status:'ready'}),runs=new TaskRunService(f.pool,identity,inspect,{allowedTools:[],groupContext:(db,actor,task,role)=>readRunGroupContext(db,actor,task,role,undefined,f.pool)}),tasks=new GroupTaskService(f.pool,identity,new TaskService(f.pool,identity)),sent:string[]=[]
 let failSecond=true
 const runDriver=new TaskRunDriver(runs,{check:async()=>{},stop:async()=>{},events:async run=>agents.get(run.roleId)!.session.snapshotEvents(),send:async(run,signal)=>{
  const target=agents.get(run.roleId)!,input=createUserMessage({source:{kind:'user',rpcId:run.nativeRequestId},content:[{type:'text',text:run.inputText}]})
  await native.withNewInput(target,input,{producer:'task-run',identity:run.id},()=>target.inbox.append('next-turn',input),signal);sent.push(run.id)
  if(run.roleId===recipients[0]!.id)throw Error('原生已受理但传输响应丢失')
 }})
 const ports:GroupRoutingOutboxPorts={outbox,createTask:async(actor,input)=>{if(failSecond&&input.assignee?.roleId===recipients[1]!.id)throw Error('第二位暂时断线');return {taskId:(await tasks.create(actor,input)).task.id}},prepare:async(actor,input)=>{
  const row=(await f.pool.query('select assignee_role_id from teloa_tasks where owner_id=$1 and id=$2',[actor,input.taskId])).rows[0],roleId=row.assignee_role_id as string,sessionId=agents.get(roleId)!.id
  const existing=(await f.pool.query('select 1 from teloa_object_conversations where owner_id=$1 and object_id=$2 and kind=$3',[actor,input.taskId,'task'])).rows[0]
  if(!existing)await new ObjectConversationService(f.pool,inspect,identity.now).change(actor,{requestId:randomUUID(),kind:'task',objectId:input.taskId,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
  const run=await runs.prepare(actor,{...input,roleId,expectedRoleVersion:2,sessionId,expectedLinkVersion:1});return {runId:run.id}
 },start:(actor,runId,signal)=>runDriver.start(actor,{runId},signal),readRun:(actor,runId)=>runs.get(actor,{runId}),reconcile:(actor,runId,signal)=>runDriver.reconcile(actor,{runId},signal),report:()=>{}}
 await drain!(owner,ports,new AbortController().signal)
 assert.equal(agent.inbox.nextTurn.length,1,JSON.stringify((await f.pool.query('select role_id,state,reason,task_id,run_id from teloa_group_routing_outbox where owner_id=$1',[owner])).rows));assert.equal(other.inbox.nextTurn.length,0);assert.equal(sent.length,1)
 const first=await outbox.receipt(owner,{itemId:items.find(i=>i.roleId===recipients[0]!.id)!.id});assert.equal(first.state,'submitting')
 await f.pool.query("update teloa_group_routing_outbox set next_attempt_at=now()-interval '1 second' where owner_id=$1 and state='unknown'",[owner]);failSecond=false
 await Promise.all([drain!(owner,ports,new AbortController().signal),drain!(owner,ports,new AbortController().signal)])
 assert.equal(agent.inbox.nextTurn.length,1);assert.equal(other.inbox.nextTurn.length,1);assert.equal(sent.length,2)
 assert.equal((await f.pool.query('select count(*)::int n from teloa_tasks where owner_id=$1',[owner])).rows[0].n,2);assert.equal((await f.pool.query('select count(*)::int n from teloa_task_runs where owner_id=$1',[owner])).rows[0].n,2)
 // 从真实原生队列核验同一 nativeRequestId 后回填原 Run；不创建新的请求或触发模型。
 const saved=await runs.get(owner,{runId:first.runId!});assert.equal(agent.inbox.nextTurn[0]!.source.kind,'user');assert.equal((agent.inbox.nextTurn[0]!.source as {rpcId?:string}).rpcId,saved.nativeRequestId)
 await runs.record(owner,{runId:saved.id,sessionId:saved.sessionId,nativeRequestId:saved.nativeRequestId,evidence:{state:'accepted'}})
 await f.pool.query("update teloa_group_routing_outbox set next_attempt_at=now()-interval '1 second' where owner_id=$1 and state='unknown'",[owner]);await drain!(owner,ports,new AbortController().signal)
 assert.equal(sent.length,2);assert.equal((await f.pool.query("select count(*)::int n from teloa_group_routing_outbox where owner_id=$1 and state='settled'",[owner])).rows[0].n,2)
})
