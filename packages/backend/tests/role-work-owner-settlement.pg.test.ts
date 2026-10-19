import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {setupRoleWork,identity,ownerAuthority} from './role-work-test-fixture.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import {initializeTeloaDatabase} from '../src/work/initialize-database.ts'
import {RoleService} from '../src/work/roles.ts'
import {RoleLifecycleService} from '../src/work/role-lifecycle.ts'
import {TaskService} from '../src/work/tasks.ts'
import {CollaborationService} from '../src/work/collaboration.ts'
import {GroupAgentGrantService} from '../src/work/group-agent-grants.ts'
import {GroupTaskService} from '../src/work/group-tasks.ts'
import {GroupRunMessageService} from '../src/work/group-run-messages.ts'
import {GroupRoutingOutboxService} from '../src/work/group-routing-outbox.ts'
import {readRunGroupContext} from '../src/work/task-run-group-context.ts'
import {TaskRunService} from '../src/work/task-runs.ts'
import {TaskRunRuntimeLinkService,type TaskRunOwnerSettlement} from '../src/work/task-run-runtime-links.ts'
import {ObjectConversationService} from '../src/work/object-conversations.ts'
import {RoleDelegationService} from '../src/work/role-delegations.ts'
import {BusinessTaskService} from '../src/work/business-tasks.ts'
import {fixture as securityFixture,catalog,command,decision} from './security-action-fixture.ts'
import {SecurityActionService} from '../src/security/actions.ts'
import {SecurityApprovalService} from '../src/security/approvals.ts'
import {SecurityActionExecutionService,PgSecurityExecutionExistsReader} from '../src/security/action-executions.ts'
let env:Awaited<ReturnType<typeof setupRoleWork>>
before(async()=>{env=await setupRoleWork();await initializeTeloaDatabase(env.pool)})
after(async()=>{await env.close()})
const sha=(text:string)=>createHash('sha256').update(text).digest('hex')
async function fixture(tools:string[]=[],deliver=true,reason='completed'){
 const pool=env.pool,owner=randomUUID(),role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'固定纯文本群岗位',kind:'employee',scopes:['general'],duty:'核对原消息并回原群',dataScope:'固定原群',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'teloa-standard'}}})
 const groups=new CollaborationService(pool,identity),group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'已交付原群',scope:'general',announcement:'核对原消息',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},memberRoleIds:[role.id]}})
 const source=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'仅核对本次固定目标并回原群。'})
 await new GroupAgentGrantService(pool,identity.now).change(owner,{requestId:randomUUID(),groupId:group.id,roleId:role.id,expectedGroupVersion:group.version,expectedRoleVersion:role.version,action:'save',resources:[],canPost:true,canAutoRun:true})
 const task=(await new GroupTaskService(pool,identity,new TaskService(pool,identity)).create(owner,{requestId:randomUUID(),groupId:group.id,messageId:source.id,expectedGroupVersion:group.version,goal:'仅输出固定纯文本核对结论',assignee:{roleId:role.id,expectedVersion:role.version}})).task
 const sessionId='owner_'+randomUUID().replaceAll('-',''),conversationId=randomUUID(),inspect=async()=>({id:conversationId,ownerId:owner,sessionId,status:'ready'})
 await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:task.version,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(pool,identity,inspect,{allowedTools:tools,groupContext:(db,actor,currentTask,currentRole)=>readRunGroupContext(db,actor,currentTask,currentRole,undefined,pool)})
 const run=await runs.prepare(owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:task.version,roleId:role.id,expectedRoleVersion:role.version,sessionId,expectedLinkVersion:1})
 await runs.claim(owner,{runId:run.id})
 const links=new TaskRunRuntimeLinkService(pool),runtimeId=randomUUID(),nativeId='owner:'+runtimeId+':'+sessionId
 await links.put(owner,{runId:run.id,kind:'job',nativeId,sessionId,payload:{record:'owner',runtimeId,requestId:run.nativeRequestId}})
 const evidence={state:'ended' as const,turn:1,messageSeq:1,endSeq:2,reason},ended=await runs.record(owner,{runId:run.id,sessionId,nativeRequestId:run.nativeRequestId,evidence})
 const outbox=new GroupRoutingOutboxService(pool,identity),publisher=new GroupRunMessageService(pool,identity,undefined,undefined,outbox)
 const posted=deliver?await publisher.post(owner,{requestId:run.nativeRequestId,runId:run.id,text:'已按固定原消息核对，本轮纯文本成果。'}):undefined
 const settleWake=async()=>{const wake=await outbox.claimWake(owner);assert.ok(wake);await outbox.settleWake(owner,{messageId:wake.messageId,leaseGeneration:wake.leaseGeneration,settled:true})}
 await new RoleLifecycleService(pool,identity).change(owner,{roleId:role.id,expectedVersion:role.version,action:'pause',reason:'结束后配置原岗位'})
 const read=()=>new RoleDelegationService(pool,identity,ownerAuthority).get(owner,{roleId:role.id})
 const proof:TaskRunOwnerSettlement={schema:'teloa.task-run-owner-settlement/v1',runId:run.id,nativeId,sessionId,nativeRequestId:run.nativeRequestId,inputSha256:sha(run.inputText),evidence,prefixLength:3,prefixSha256:'a'.repeat(64),observedAt:identity.now()}
 return {pool,owner,role,group,source,task,run:ended,runs,links,nativeId,runtimeId,posted,settleWake,read,proof}
}
test('已completed纯文本群Run只有原宿主登记，正式唯一交付及唤醒收口后允许配置而保留历史',async()=>{
 const missing=await fixture([],false);assert.equal((await missing.read()).canEditExecution,false,'未回群仍保守视为在途')
 const f=await fixture();assert.equal((await f.read()).canEditExecution,false,'正式回帖的后续唤醒尚未收口不能释放')
 await f.settleWake()
 assert.equal((await f.read()).canEditExecution,true,'原生结束、唯一可信原群交付且无真实副作用时，owner登记不能永久封配置')
 assert.equal((await f.links.list(f.owner,{runId:f.run.id})).length,1,'不删除宿主登记')
 assert.deepEqual((await f.runs.get(f.owner,{runId:f.run.id})).evidence,f.run.evidence)
 assert.equal((await f.pool.query('select count(*)::int count from teloa_group_messages where owner_id=$1 and run_id=$2',[f.owner,f.run.id])).rows[0].count,1)
 assert.ok(f.posted!.id)
})

test('非零工具必须有宿主固定终态回执，回执严绑原Run/输入/owner且不可改写',async()=>{
 const f=await fixture(['get_goal']);await f.settleWake()
 assert.equal((await f.read()).canEditExecution,false,'不能以工具名字、已结束或空jobs冒充宿主核验')
 await f.links.recordOwnerSettlement(f.owner,f.proof)
 assert.equal((await f.read()).canEditExecution,true)
 const stored=(await f.pool.query('select owner_settlement from teloa_task_run_runtime_links where run_id=$1',[f.run.id])).rows[0].owner_settlement
 assert.deepEqual(stored,f.proof)
 const originalLinks=await f.links.list(f.owner,{runId:f.run.id});assert.equal(originalLinks.length,1);await f.links.put(f.owner,originalLinks[0]!)
 assert.deepEqual((await f.pool.query('select owner_settlement from teloa_task_run_runtime_links where run_id=$1',[f.run.id])).rows[0].owner_settlement,stored,'原登记幂等写回不清除独立终态回执')
 await f.links.recordOwnerSettlement(f.owner,{...f.proof,observedAt:identity.now()})
 assert.deepEqual((await f.pool.query('select owner_settlement from teloa_task_run_runtime_links where run_id=$1',[f.run.id])).rows[0].owner_settlement,stored,'幂等保留首次核验回执')
 for(const bad of [{...f.proof,nativeId:'owner:foreign:'+f.run.sessionId},{...f.proof,nativeRequestId:randomUUID()},{...f.proof,sessionId:'foreign-session'},{...f.proof,inputSha256:'b'.repeat(64)},{...f.proof,prefixLength:4},{...f.proof,prefixSha256:'b'.repeat(64)},{...f.proof,evidence:{...f.proof.evidence,reason:'interrupted'}},{...f.proof,observedAt:new Date(Date.now()+60000).toISOString()}])await assert.rejects(f.links.recordOwnerSettlement(f.owner,bad))
 await assert.rejects(f.links.recordOwnerSettlement('foreign-owner',f.proof))
 assert.deepEqual((await f.pool.query('select owner_settlement from teloa_task_run_runtime_links where run_id=$1',[f.run.id])).rows[0].owner_settlement,stored)
})

test('宿主回执或旧群兼容均不放行待群发布、坏归属、真正job、子流及未知关联',async()=>{
 for(const sealed of [false,true]){
  const f=await fixture(sealed?['get_goal']:[]);await f.settleWake();if(sealed)await f.links.recordOwnerSettlement(f.owner,f.proof)
  assert.equal((await f.read()).canEditExecution,true)
  const blocked=async(label:string,sql:string,values:unknown[],restore:string,restoreValues:unknown[])=>{
   await f.pool.query(sql,values)
   try{assert.equal((await f.read()).canEditExecution,false,label)}finally{await f.pool.query(restore,restoreValues)}
   assert.equal((await f.read()).canEditExecution,true,'恢复测试原事实后仍可配置：'+label)
  }
  for(const state of ['retrying','blocked'])await blocked('待发布或发布受阻仍保留在途', 'update teloa_task_runs set group_publication=$2 where id=$1',[f.run.id,JSON.stringify({state,code:'teloa/unavailable',attempts:1,at:identity.now()})],'update teloa_task_runs set group_publication=null where id=$1',[f.run.id])
  await blocked('待发布时刻不能误当已交付','update teloa_task_runs set group_publication_next_at=now() where id=$1',[f.run.id],'update teloa_task_runs set group_publication_next_at=null where id=$1',[f.run.id])
  await blocked('回帖待路由仍不能改变岗位授权',"update teloa_group_routing_wakes set state='pending' where owner_id=$1 and message_id=$2",[f.owner,f.posted!.id],"update teloa_group_routing_wakes set state='settled' where owner_id=$1 and message_id=$2",[f.owner,f.posted!.id])
  await blocked('回帖请求必须是原native身份','update teloa_group_messages set request_id=$2 where id=$1',[f.posted!.id,randomUUID()],'update teloa_group_messages set request_id=$2 where id=$1',[f.posted!.id,f.run.nativeRequestId])
  await blocked('不能用另一主群位置冒领原话题回执','update teloa_group_messages set root_id=null where id=$1',[f.posted!.id],'update teloa_group_messages set root_id=$2 where id=$1',[f.posted!.id,f.source.id])
  await assert.rejects(f.pool.query('update teloa_group_run_sources set source_hash=$3 where owner_id=$1 and message_id=$2',[f.owner,f.posted!.id,'b'.repeat(64)]),/immutable/,'可信作者和谱系快照由正式不可变约束保护，不绕过约束伪造坏历史')
  const duplicate=randomUUID()
  await blocked('同Run两条群回执不能当唯一交付',"insert into teloa_group_messages select (jsonb_populate_record(null::teloa_group_messages,to_jsonb(m)||jsonb_build_object('id',$2::text,'request_id',$3::text))).* from teloa_group_messages m where id=$1",[f.posted!.id,duplicate,randomUUID()],'delete from teloa_group_messages where id=$1',[duplicate])
  for(const kind of ['job','external','owner']){
   const nativeId=kind==='job'?f.runtimeId+':live':kind==='owner'?'owner:other:'+f.run.sessionId:'external:unknown',payload=kind==='job'?{record:'job',runtimeId:f.runtimeId,requestId:f.run.nativeRequestId,jobId:'live',status:'running'}:kind==='owner'?{record:'owner',runtimeId:'other',requestId:f.run.nativeRequestId}:{provider:'codex',runtimeId:f.runtimeId,requestId:f.run.nativeRequestId,reservationId:nativeId,workspaceRoot:'/tmp/owner-settlement-test',status:'unknown'}
   await blocked('真实或未知运行关联不能借宿主回执放行：'+kind,'insert into teloa_task_run_runtime_links(owner_id,run_id,kind,native_id,session_id,payload) values($1,$2,$3,$4,$5,$6)',[f.owner,f.run.id,kind==='owner'?'job':kind,nativeId,f.run.sessionId,JSON.stringify(payload)],'delete from teloa_task_run_runtime_links where owner_id=$1 and run_id=$2 and native_id=$3',[f.owner,f.run.id,nativeId])
  }
  const child=randomUUID(),flow=randomUUID()
  await blocked('有任何子登记均不得使用owner-only例外',"insert into teloa_task_run_subagents(owner_id,run_id,reservation_id,state,created_at,ended_at,stop_reason) values($1,$2,$3,'abandoned',now(),now(),'unknown')",[f.owner,f.run.id,child],'delete from teloa_task_run_subagents where owner_id=$1 and run_id=$2 and reservation_id=$3',[f.owner,f.run.id,child])
  await blocked('有流程登记均不得使用owner-only例外',"insert into teloa_task_run_flows(flow_id,owner_id,run_id,request_id,request_spec,definition_version,state,steps,created_at,updated_at) values($1,$2,$3,$4,'{}',1,'completed','[]',now(),now())",[flow,f.owner,f.run.id,randomUUID()],'delete from teloa_task_run_flows where flow_id=$1',[flow])
  await blocked('冻结快照损坏不消费收口证明',"update teloa_task_runs set input_text='{}' where id=$1",[f.run.id],'update teloa_task_runs set input_text=$2 where id=$1',[f.run.id,f.run.inputText])
  if(sealed)await blocked('持久回执哈希损坏不放行','update teloa_task_run_runtime_links set owner_settlement=$3 where owner_id=$1 and run_id=$2',[f.owner,f.run.id,JSON.stringify({...f.proof,inputSha256:'b'.repeat(64)})],'update teloa_task_run_runtime_links set owner_settlement=$3 where owner_id=$1 and run_id=$2',[f.owner,f.run.id,JSON.stringify(f.proof)])
 }
})

test('失败终态（error）群Run：宿主收口证明且无任何发布残留才放行；无证明、待发布、outbox、残留回帖、结果文件、子登记一律保守阻断',async()=>{
 // 实跑形状：Run ended、evidence.reason=error、group_publication/next_at 为 null、manifest files 为空、runtime link 带 owner_settlement。
 const unproven=await fixture([],false,'error')
 assert.equal((await unproven.read()).canEditExecution,false,'零工具旧例外不对失败终态放行：没有宿主证明保持保守')
 const f=await fixture(['get_goal'],false,'error')
 assert.equal((await f.read()).canEditExecution,false,'没有宿主收口证明不放行')
 await f.links.recordOwnerSettlement(f.owner,f.proof)
 assert.equal((await f.read()).canEditExecution,true,'宿主已证明 error 终态；契约对失败终态不排发布、库中无任何残留，不得永久阻断后续委托')
 assert.equal((await f.pool.query('select count(*)::int count from teloa_group_messages where owner_id=$1 and run_id=$2',[f.owner,f.run.id])).rows[0].count,0,'放行不伪造任何成功交付')
 assert.deepEqual((await f.runs.get(f.owner,{runId:f.run.id})).evidence,f.run.evidence,'不改写终态证据')
 const blocked=async(label:string,sql:string,values:unknown[],restore:string,restoreValues:unknown[])=>{
  await f.pool.query(sql,values)
  try{assert.equal((await f.read()).canEditExecution,false,label)}finally{await f.pool.query(restore,restoreValues)}
  assert.equal((await f.read()).canEditExecution,true,'恢复测试原事实后仍可配置：'+label)
 }
 for(const state of ['retrying','blocked'])await blocked('失败终态仍有待发布或发布受阻记录时保守在途','update teloa_task_runs set group_publication=$2 where id=$1',[f.run.id,JSON.stringify({state,code:'teloa/unavailable',attempts:1,at:identity.now()})],'update teloa_task_runs set group_publication=null where id=$1',[f.run.id])
 await blocked('待发布时刻不能误当已收口','update teloa_task_runs set group_publication_next_at=now() where id=$1',[f.run.id],'update teloa_task_runs set group_publication_next_at=null where id=$1',[f.run.id])
 await blocked('失败终态留有结果文件残留不放行','update teloa_task_runs set group_result_manifest=$2 where id=$1',[f.run.id,JSON.stringify({files:[{path:'报告.md',sha256:'c'.repeat(64)}],noVision:false})],'update teloa_task_runs set group_result_manifest=$2 where id=$1',[f.run.id,JSON.stringify({files:[],noVision:false})])
 const stray=randomUUID()
 await blocked('失败终态却存在以该Run为作者的群回帖，是未核实的发布残留','insert into teloa_group_messages(id,owner_id,group_id,request_id,request_spec,root_id,author_id,text,reference_snapshot,created_at,task_id,run_id) values($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb,$10,$11,$12)',[stray,f.owner,f.group.id,randomUUID(),'{}',f.source.id,f.role.id,'残留回帖','[]',identity.now(),f.task.id,f.run.id],'delete from teloa_group_messages where id=$1',[stray])
 await f.pool.query("insert into teloa_group_routing_decisions(owner_id,group_id,message_id,decision,created_at) values($1,$2,$3,'{}'::jsonb,now()) on conflict do nothing",[f.owner,f.group.id,f.source.id])
 const outbox=randomUUID()
 // 路由决策是不可变历史，测试同样保留到隔离容器退役，不删除以掩盖约束。
 await blocked('该Run仍有未定案的投递outbox不放行',"insert into teloa_group_routing_outbox(id,owner_id,group_id,message_id,decision_version,role_id,role_version,request_id,group_version,state,task_id,run_id,created_at) values($1,$2,$3,$4,1,$5,1,$6,1,'pending',$7,$8,now())",[outbox,f.owner,f.group.id,f.source.id,f.role.id,randomUUID(),f.task.id,f.run.id],'delete from teloa_group_routing_outbox where id=$1',[outbox])
 const child=randomUUID()
 await blocked('有子登记均不得放行',"insert into teloa_task_run_subagents(owner_id,run_id,reservation_id,state,created_at,ended_at,stop_reason) values($1,$2,$3,'abandoned',now(),now(),'unknown')",[f.owner,f.run.id,child],'delete from teloa_task_run_subagents where owner_id=$1 and run_id=$2 and reservation_id=$3',[f.owner,f.run.id,child])
 await blocked('持久回执损坏不放行','update teloa_task_run_runtime_links set owner_settlement=$3 where owner_id=$1 and run_id=$2',[f.owner,f.run.id,JSON.stringify({...f.proof,inputSha256:'b'.repeat(64)})],'update teloa_task_run_runtime_links set owner_settlement=$3 where owner_id=$1 and run_id=$2',[f.owner,f.run.id,JSON.stringify(f.proof)])
})

test('真实未知安全执行不能借已结束宿主证明解除配置保护，正式效果收口后才放行',async()=>{
 const pool=env.pool,security=await securityFixture(pool),owner=security.principal.ownerId
 const role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'固定安全核对岗位',kind:'employee',scopes:['SOC'],duty:'核对原告警',dataScope:'固定原告警',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'teloa-standard'}}})
 const task=(await new BusinessTaskService(pool,identity,new TaskService(pool,identity)).create(security.principal,{requestId:randomUUID(),reference:security.source.reference,goal:'核对固定原告警',assignee:{roleId:role.id,expectedVersion:role.version}})).task
 const actions=new SecurityActionService(pool,identity,catalog,security.journal,new PgSecurityExecutionExistsReader()),approvals=new SecurityApprovalService(pool,identity,catalog,security.journal)
 const proposed=await actions.propose(security.principal,{...security.proposal,requestId:randomUUID(),taskId:task.id,expectedTaskVersion:task.version}),submitted=await actions.submit(security.principal,command(proposed))
 await approvals.decide(security.principal,decision(submitted))
 const approved=await actions.get(security.principal,{actionId:proposed.id}),executions=new SecurityActionExecutionService(pool,identity,approvals,security.journal)
 const sessionId='effect_'+randomUUID().replaceAll('-',''),conversationId=randomUUID(),inspect=async()=>({id:conversationId,ownerId:owner,sessionId,status:'ready'})
 await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:task.version,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(pool,identity,inspect,{allowedTools:['get_goal']}),prepared=await runs.prepare(owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:task.version,roleId:role.id,expectedRoleVersion:role.version,sessionId,expectedLinkVersion:1})
 await runs.claim(owner,{runId:prepared.id})
 const links=new TaskRunRuntimeLinkService(pool),runtimeId=randomUUID(),nativeId='owner:'+runtimeId+':'+sessionId
 await links.put(owner,{runId:prepared.id,kind:'job',nativeId,sessionId,payload:{record:'owner',runtimeId,requestId:prepared.nativeRequestId}})
 const evidence={state:'ended' as const,turn:1,messageSeq:1,endSeq:2,reason:'completed'},run=await runs.record(owner,{runId:prepared.id,sessionId,nativeRequestId:prepared.nativeRequestId,evidence})
 await links.recordOwnerSettlement(owner,{schema:'teloa.task-run-owner-settlement/v1',runId:run.id,nativeId,sessionId,nativeRequestId:run.nativeRequestId,inputSha256:sha(run.inputText),evidence,prefixLength:3,prefixSha256:'a'.repeat(64),observedAt:identity.now()})
 await new RoleLifecycleService(pool,identity).change(owner,{roleId:role.id,expectedVersion:role.version,action:'pause',reason:'等待真实安全效果后配置'})
 const read=()=>new RoleDelegationService(pool,identity,ownerAuthority).get(owner,{roleId:role.id})
 assert.equal((await read()).canEditExecution,true)
 const claimed=await executions.claim(security.principal,command(approved))
 assert.equal((await read()).canEditExecution,false,'dispatching 的实际副作用尚未收口')
 await executions.markUnknown(security.principal,{operationId:claimed.execution.operationId,reason:'目标回执尚未核实'})
 assert.equal((await read()).canEditExecution,false,'unknown 效果不能被原生 turn/end 或宿主回执覆盖')
 await executions.recordEffect(security.principal,{operationId:claimed.execution.operationId,receipt:{status:'succeeded',receiptId:'verified-original-effect',detail:'固定目标效果已核对',observedAt:identity.now(),targets:[{target:'prod-03',state:'succeeded'}]}})
 assert.equal((await read()).canEditExecution,true,'只在正式效果回执收口后解除保护')
 assert.equal((await links.list(owner,{runId:run.id})).length,1,'保留宿主历史登记')
})
