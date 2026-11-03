import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {WorkRecoveryService} from '../src/work/work-recovery.ts'
import {WorkControlService} from '../src/work/work-control.ts'
import {resumePausedSourceTask} from '../src/work/source-task-resume.ts'
import {BusinessTaskSourceUpdateService} from '../src/work/business-task-source-updates.ts'

/** 正常恢复事务及来源任务守卫；原 Run 读取/当前授权端口为具名夹具，不连接 PG 或执行模型。 */
function fixture(){
 const owner='local:test-owner',taskId=randomUUID(),roleId=randomUUID(),controlId=randomUUID(),roundId=randomUUID(),runId=randomUUID(),oldId=randomUUID(),planId=randomUUID(),conversationId=randomUUID(),scope='business_source_resume',stamp=new Date('2026-11-02T00:00:00Z'),sessionId='task-run-source-resume'
 const task:any={id:taskId,owner_id:owner,version:6,content_version:1,state:'paused',definition:{title:'原来源任务',goal:'读取原告警并按固定规则研判',scope},assignee_role_id:roleId,assignee_role_version:4,created_at:stamp,updated_at:stamp}
 const role:any={id:roleId,owner_id:owner,version:4,state:'active',definition:{name:'原岗位',kind:'employee',scopes:[scope],duty:'核对原告警',dataScope:'原业务',executionScope:'只读研判',skills:[],knowledge:[],responsibility:{triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]}},created_at:stamp,updated_at:stamp}
 const control:any={id:controlId,owner_id:owner,version:3,generation:2,state:'paused',kind:'definition',pause_origin:'owner',budget_account_id:randomUUID(),created_at:stamp,updated_at:stamp}
 const lineage={ownerId:owner,rootTaskId:taskId,definition:{planId,definitionVersion:2,occurrenceId:'event:source'},definitionControlId:controlId,roundControlId:roundId}
 const reference={scope,type:'alert',id:'AL-01',version:1,snapshotHash:'a'.repeat(64)},source:any={schema:'teloa.business-task-source/v1',ownerId:owner,taskId,sourceId:'source/list_alerts',reference}
 const run:any={id:runId,taskId,roleId,roleVersion:4,taskVersion:1,linkVersion:1,sessionId,nativeRequestId:randomUUID(),state:'ended',stopRequestedAt:null,evidence:{state:'ended',turn:1,messageSeq:8,endSeq:16,reason:'completed'},lineage,roleSnapshot:{},inputText:JSON.stringify({task:{id:taskId,version:1,...task.definition},businessContext:{taskId,sourceId:source.sourceId,object:reference}})}
 const old={id:oldId,state:'withdrawn',sessionId,nativeRequestId:randomUUID(),inputText:'original-withdrawn-input'},link:any={active:true,source_only:false,version:1,conversation_id:conversationId}
 let valid=true,host=1,notifications=0,taskWrites=0,controlWrites=0,blockedRun=false,effect=false,otherState='active',children=false,denyAuthorization=false,changeHostAfterIntent=false,nativePending=false,goalPending=false,rollbacks=0,commits=0
 let otherGeneration=1,otherProgress:any=null
 const requests=new Map<string,{spec:any;result:any}>(),writes:string[]=[]
 const lease={assertCurrent(){if(!valid)throw Object.assign(Error('revoked'),{code:'teloa/forbidden'})}}
 let beforeTransaction:any
 const query=async(sql:string,args:any[]=[])=>{
  if(sql==='begin'){beforeTransaction=structuredClone({task,control,requests:[...requests]});return {rows:[]}}
  if(sql==='rollback'){rollbacks++;Object.assign(task,beforeTransaction.task);Object.assign(control,beforeTransaction.control);requests.clear();for(const [key,value] of beforeTransaction.requests)requests.set(key,value);return {rows:[]}}
  if(sql==='commit'){commits++;return {rows:[]}}
  if(['begin','commit','rollback'].includes(sql)||sql.startsWith('select pg_advisory'))return {rows:[],rowCount:0}
  if(sql.startsWith('select spec,result from teloa_work_recovery_requests')){const r=requests.get(args[1]);return {rows:r?[r]:[]}}
  if(sql.startsWith('select * from teloa_roles'))return {rows:[role]}
  if(sql.startsWith('select * from teloa_tasks'))return {rows:[task]}
  if(sql.startsWith('select lineage from teloa_task_work_lineage'))return {rows:[{lineage}]}
  if(sql.startsWith('select id,state from teloa_work_controls')||sql.startsWith('select id,state,generation from teloa_work_controls'))return {rows:[{id:roundId,state:otherState,generation:otherGeneration}]}
  if(sql.startsWith('select control_id,generation,pending_run_ids,unknown_operation_ids from teloa_work_control_progress'))return {rows:otherProgress===null?[]:[{control_id:roundId,...otherProgress}]}
  if(sql.startsWith('select source_snapshot'))return {rows:[{source_snapshot:source}]}
  if(sql.startsWith('select 1 from teloa_task_runs'))return {rows:blockedRun?[{exists:1}]:[]}
  if(sql.startsWith('select id from teloa_task_runs')){assert.equal(sql.includes('for share'),false,'任务锁内不再反向锁原执行');return {rows:[{id:runId}]}}
  if(sql.startsWith('select * from teloa_object_conversations'))return {rows:[link]}
  if(sql.startsWith('select name,to_regclass'))return {rows:args[0].map((name:string)=>({name,present:true}))}
  if(sql.startsWith('select id,state,evidence from teloa_task_runs'))return {rows:[{id:runId,state:run.state,evidence:run.evidence},old]}
  if(sql.startsWith('select run_id,reservation_id,state'))return {rows:children?[{state:'started'}]:[]}
  if(sql.startsWith('select * from teloa_task_run_flows')||sql.startsWith('select run_id,native_id'))return {rows:[]}
  if(sql.startsWith('select 1 from teloa_task_run_goal_continuations'))return {rows:goalPending?[{exists:1}]:[]}
  if(sql.startsWith('select 1 from teloa_security_action_executions'))return {rows:effect?[{exists:1}]:[]}
  if(sql.startsWith('update teloa_tasks')){assert.equal(task.state,'paused');assert.equal(task.version,args[2]);writes.push('TaskCAS');taskWrites++;task.state='ready';task.version++;return {rows:[{id:taskId}]}}
  if(sql.startsWith('select to_regclass'))return {rows:[{relation:null}]}
  if(sql.startsWith('select id from teloa_work_controls'))return {rows:[{id:controlId}]}
  if(sql.startsWith('select * from teloa_work_controls'))return {rows:[control]}
  if(sql.startsWith('select * from teloa_work_control_progress'))return {rows:[{generation:control.generation,pending_run_ids:[],unknown_operation_ids:[]}]}
  if(sql.startsWith('update teloa_work_controls')){writes.push('ControlResume');controlWrites++;control.state='active';control.version++;control.generation++;return {rows:[]}}
  if(sql.startsWith('update teloa_work_control_progress'))return {rows:[]}
  if(sql.startsWith('insert into teloa_work_recovery_requests')){requests.set(args[1],{spec:JSON.parse(args[3]),result:JSON.parse(args[4])});if(changeHostAfterIntent)host=2;return {rows:[]}}
  throw Error('未声明的内存事务查询：'+sql)
 }
 const db={query,release(){}},pool={query,connect:async()=>db},identity={id:randomUUID,now:()=>stamp.toISOString()}
 const controls=new WorkControlService(pool as never,identity);Reflect.defineProperty(controls,'publishResume',{value:async()=>{notifications++}})
 const sourceTask={taskId,expectedTaskVersion:6,roleId,expectedRoleVersion:4,sessionId,expectedControlGeneration:2}
 const service=new WorkRecoveryService(pool as never,identity,controls,{hostGeneration:()=>host,ownerAuthority:{authorize:async()=>lease},authorizeResume:async()=>lease,resumeSourceTask:async(client,actor,{task:command,control:current},approval)=>resumePausedSourceTask(client,actor,command,current,approval,{now:identity.now,assertSettled:async()=>{if(nativePending)throw Object.assign(Error('native pending'),{code:'teloa/execution-pending'})},readRun:async()=>run,inspect:async()=>({id:conversationId,ownerId:owner,sessionId,status:'ready'}),authorize:async()=>{if(denyAuthorization)throw Object.assign(Error('grant withdrawn'),{code:'teloa/forbidden'});return lease}})})
 Reflect.defineProperty(service,'candidates',{value:async()=>({control:await controls.get(owner,{controlId}),results:[]})})
 const command={requestId:randomUUID(),controlId,expectedVersion:3,candidateRunIds:[],sourceTask}
 return {owner,task,role,control,run,old,link,source,lineage,service,command,writes,counts:()=>({taskWrites,controlWrites,notifications}),transaction:()=>({rollbacks,commits,requests:requests.size}),changeHostAfterIntent:()=>{changeHostAfterIntent=true},setValid:(v:boolean)=>{valid=v},setHost:(v:number)=>{host=v},unknown:()=>{blockedRun=true},effect:()=>{effect=true},child:()=>{children=true},otherPaused:()=>{otherState='paused'},nativePending:()=>{nativePending=true},goalPending:()=>{goalPending=true},deny:()=>{denyAuthorization=true},otherProgress:(kind:'unknown'|'pending'|'generation'|'missing')=>{otherGeneration=2;otherProgress=kind==='missing'?null:{generation:kind==='generation'?3:2,pending_run_ids:kind==='pending'?[randomUUID()]:[],unknown_operation_ids:kind==='unknown'?['unsettled-other-operation']:[]}}}
}

test('J07 原paused来源任务通过一次正常本人恢复变ready，同Task/SID且原Run/来源不变',async()=>{
 const f=fixture(),before=structuredClone({run:f.run,old:f.old,source:f.source,lineage:f.lineage})
 const result=await f.service.resume(f.owner,f.command);assert.equal(result.state,'active');assert.equal(f.task.state,'ready');assert.equal(f.task.version,7);assert.equal(f.task.content_version,1)
 assert.deepEqual({run:f.run,old:f.old,source:f.source,lineage:f.lineage},before);assert.deepEqual(f.counts(),{taskWrites:1,controlWrites:1,notifications:1})
 assert.deepEqual(await f.service.resume(f.owner,f.command),result);assert.equal(f.counts().taskWrites,1)
})
test('J07 已active控制仍可明确恢复原Task；不带Task的旧恢复不隐式改Task',async()=>{
 const f=fixture();f.control.state='active';const result=await f.service.resume(f.owner,f.command);assert.equal(result.version,3);assert.equal(f.task.state,'ready');assert.equal(f.counts().controlWrites,0)
 const g=fixture(),{sourceTask:_,...old}=g.command;await g.service.resume(g.owner,old);assert.equal(g.task.state,'paused');assert.equal(g.counts().taskWrites,0)
})
test('J07 角色/Task版本、SID、来源或另一控制变化均拒绝且不改Task',async()=>{
 for(const kind of ['task-version','retired','role-version','sid','source','round','link','control-generation'] as const){const f=fixture();if(kind==='task-version')f.task.version++;if(kind==='retired')f.role.state='retired';if(kind==='role-version')f.role.version++;if(kind==='sid')f.command.sourceTask.sessionId='another-session';if(kind==='source')f.source.reference={...f.source.reference,id:'AL-02'};if(kind==='round')f.otherPaused();if(kind==='link')f.link.version++;if(kind==='control-generation')f.control.generation++
  await assert.rejects(f.service.resume(f.owner,f.command),{code:'teloa/version-conflict'});assert.equal(f.task.state,'paused');assert.equal(f.counts().taskWrites,0)
 }
})
test('J07 未知执行、未结束子工作、外部效果或撤销授权不能借空候选恢复',async()=>{
 for(const block of ['unknown','child','effect','deny','revoke','nativePending','goalPending'] as const){const f=fixture();if(block==='unknown')f.unknown();if(block==='child')f.child();if(block==='effect')f.effect();if(block==='deny')f.deny();if(block==='revoke')f.setValid(false);if(block==='nativePending')f.nativePending();if(block==='goalPending')f.goalPending()
  await assert.rejects(f.service.resume(f.owner,f.command));assert.equal(f.task.state,'paused');assert.equal(f.counts().taskWrites,0)
 }
})
test('J07 planned restart 不携带本人Task恢复意图，旧已撤回Run不能加入空候选',async()=>{
 const f=fixture();await assert.rejects(f.service.resume(f.owner,f.command,{generation:2}),{code:'teloa/version-conflict'});assert.equal(f.counts().taskWrites,0)
 await assert.rejects(f.service.resume(f.owner,{...f.command,candidateRunIds:[f.old.id]}),{code:'teloa/version-conflict'});assert.equal(f.counts().taskWrites,0)
})

test('J07 恢复事务最后宿主世代变化回滚Task与control，不留下半恢复',async()=>{const f=fixture();f.changeHostAfterIntent();await assert.rejects(f.service.resume(f.owner,f.command),{code:'teloa/version-conflict'});assert.equal(f.task.state,'paused');assert.equal(f.task.version,6);assert.equal(f.control.state,'paused');assert.deepEqual(f.transaction(),{rollbacks:1,commits:0,requests:0});assert.equal(f.counts().notifications,0)})

test('J07 原来源更新服务在paused保持pending，明确恢复后沿同Task正常continued且不创建Run',async()=>{
 const f=fixture();f.control.state='active'
 const original=structuredClone({run:f.run,source:f.source,lineage:f.lineage}),stamp=new Date('2026-11-02T00:00:00Z')
 const row:any={id:randomUUID(),owner_id:f.owner,task_id:f.task.id,plan_id:f.lineage.definition.planId,event_id:randomUUID(),scope_id:f.source.reference.scope,object_type:'alert',object_id:'AL-01',object_version:3,snapshot_hash:'b'.repeat(64),state:'pending',task_version:null,run_id:null,reason:null,created_at:stamp,updated_at:stamp}
 const query=async(sql:string,args:any[]=[])=>{
  if(['begin','commit','rollback'].includes(sql))return {rows:[]}
  if(sql.startsWith('select * from teloa_business_task_source_updates'))return {rows:[row]}
  if(sql.startsWith('select t.state,t.version'))return {rows:[{...f.task,role_version:f.role.version,role_state:f.role.state}]}
  if(sql.startsWith('select state from teloa_task_runs'))return {rows:[{state:f.old.state}]}
  if(sql.startsWith('select p.state,p.work_definition'))return {rows:[{state:'active',work_definition:{},control_state:f.control.state}]}
  if(sql.startsWith('select snapshot_hash'))return {rows:[{snapshot_hash:row.snapshot_hash}]}
  if(sql.startsWith('select lineage'))return {rows:[{lineage:f.lineage}]}
  if(sql.startsWith('select state from teloa_work_controls'))return {rows:[{state:'active'}]}
  if(sql.startsWith('update teloa_tasks')){assert.equal(f.task.state,'ready');f.task.version++;return {rows:[{version:f.task.version}]}}
  if(sql.startsWith("update teloa_business_task_source_updates set state='continued'")){row.state='continued';row.task_version=args[2];return {rows:[row]}}
  throw Error('未声明的来源续办查询：'+sql)
 }
 const db={query,release(){}},updates=new BusinessTaskSourceUpdateService({query,connect:async()=>db} as never,{id:randomUUID,now:()=>stamp.toISOString()})
 assert.equal((await updates.continueTask(f.owner,row.id)).state,'pending');assert.equal(f.task.version,6)
 await f.service.resume(f.owner,f.command);assert.equal(f.task.version,7)
 const continued=await updates.continueTask(f.owner,row.id);assert.equal(continued.state,'continued');assert.equal(continued.taskId,f.task.id);assert.equal(continued.taskVersion,8);assert.equal(continued.runId,null)
 assert.deepEqual({run:f.run,source:f.source,lineage:f.lineage},original)
 await updates.continueTask(f.owner,row.id);assert.equal(f.task.version,8)
})


test('J07 另一个控制的active不能代替同代空进展证明，未知/未清/错代/高代缺失均拒绝',async()=>{
 for(const kind of ['unknown','pending','generation','missing'] as const){
  const f=fixture();f.otherProgress(kind)
  await assert.rejects(f.service.resume(f.owner,f.command),{code:['unknown','pending'].includes(kind)?'teloa/execution-pending':'teloa/version-conflict'})
  assert.equal(f.task.state,'paused');assert.equal(f.task.version,6);assert.equal(f.counts().taskWrites,0)
  assert.deepEqual(f.transaction(),{rollbacks:1,commits:0,requests:0})
 }
})
