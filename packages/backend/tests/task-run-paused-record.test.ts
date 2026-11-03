import {TaskRunDriver} from '../../harness-dsh/src/task-run-driver.ts'
import {WorkControlService} from '../src/work/work-control.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {TaskRunService,type TaskRun} from '../src/work/task-runs.ts'

/** 仅隔离 record 的事务/CAS/回调分支；完整原 Run 身份读取沿用既有 readVerified 定向证据。 */
function fixture(reason='completed'){
 const owner='owner',id=randomUUID(),taskId=randomUUID(),roleId=randomUUID(),nativeRequestId=randomUUID(),controlId=randomUUID()
 let run={id,taskId,roleId,sessionId:'session',nativeRequestId,state:'active',stopRequestedAt:null,evidence:{state:'active',turn:1,messageSeq:1},lineage:{roundControlId:controlId,definitionControlId:null}} as unknown as TaskRun
 const task={state:'running',version:5,roleId},control={state:'paused',unknown:[] as string[]};let callbacks=0,taskChanges=0;let publication:unknown=null
 const writes:string[]=[]
 const raw=()=>({...run,task_state_version:5,group_publication:publication,owner_result_pending:false})
 const query=async(sql:string,params:unknown[]=[])=>{
  if(['begin','commit','rollback'].includes(sql))return{rows:[],rowCount:0}
  if(sql.startsWith('select * from teloa_task_runs'))return{rows:[raw()],rowCount:1}
  if(sql.startsWith('select c.id,c.state'))return{rows:[{id:controlId,state:control.state,unknown_operation_ids:control.unknown}],rowCount:1}
  if(sql.startsWith('select 1 from teloa_task_run_subagents')||sql.startsWith('select 1 from teloa_task_run_runtime_links'))return{rows:[],rowCount:0}
  if(sql.startsWith('update teloa_tasks')){writes.push('TaskCAS');if(task.state==='running'&&task.version===params[2]&&task.roleId===params[5]){task.state=String(params[3]);task.version++;taskChanges++;return{rows:[],rowCount:1}}return{rows:[],rowCount:0}}
  if(sql.startsWith('update teloa_task_runs')){writes.push('RunEvidence');if(params[4]!==null)publication=JSON.parse(params[4] as string);run={...run,state:params[2] as TaskRun['state'],evidence:JSON.parse(params[3] as string)};return{rows:[raw()],rowCount:1}}
  if(sql.startsWith('select to_regclass'))return{rows:[{present:false}],rowCount:1}
  if(sql.startsWith('select r.id from teloa_task_runs')){assert(sql.includes('t.version=r.task_state_version'));assert(sql.includes('t.assignee_role_id is not distinct from r.role_id'));assert(sql.includes('any($2::text[])'));const evidence=run.evidence,ordinary=evidence?.state==='ended'&&(params[1] as string[]).includes(evidence.reason)&&run.stopRequestedAt===null&&!evidence.inputAnchor;return{rows:run.state==='active'||run.state==='ended'&&(evidence?.state==='ended'&&evidence.reason==='completed'||ordinary)&&task.state==='running'&&task.version===5&&task.roleId===roleId?[{id}]:[],rowCount:1}}
  throw Error('未声明的事务查询：'+sql.split(' ').slice(0,4).join(' '))
 }
 const db={query,release(){}},pool={query,connect:async()=>db};const service=new TaskRunService(pool as never,{id:randomUUID,now:()=>new Date(0).toISOString()},async()=>({id:randomUUID(),ownerId:owner,sessionId:'session',status:'ready'}),{allowedTools:[],onSettled:async()=>{callbacks++}})
 Reflect.defineProperty(service,'readVerified',{value:async(_db:unknown,actor:string,row:Record<string,unknown>)=>{assert.equal(actor,owner);assert.equal(row.id,id);return {...run,state:row.state,evidence:row.evidence}}})
 const input={runId:id,sessionId:'session',nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:1,endSeq:2,reason}}
 return{service,owner,input,task,control,writes,group(){run={...run,groupContext:{} as NonNullable<TaskRun['groupContext']>}},stop(){run={...run,stopRequestedAt:'2026-11-01T00:00:00.000Z'}},run:()=>run,callbacks:()=>callbacks,taskChanges:()=>taskChanges}
}

test('143 defer内部终态只写Run，不改Task/控制或调用onSettled；正常恢复精确CAS一次',async()=>{
 const f=fixture(),before=structuredClone({task:f.task,control:f.control});await f.service.record(f.owner,f.input,{deferSettlement:true});assert.equal(f.run().state,'ended');assert.deepEqual({task:f.task,control:f.control},before);assert.equal(f.callbacks(),0);assert.equal(f.taskChanges(),0);assert.deepEqual(await f.service.outstanding(f.owner),[f.input.runId])
 await assert.rejects(f.service.settleDeferred(f.owner,f.input),{code:'teloa/conflict'});assert.equal(f.callbacks(),0)
 f.control.state='active';await Promise.all([f.service.settleDeferred(f.owner,f.input),f.service.settleDeferred(f.owner,f.input)]);assert.equal(f.task.state,'waiting');assert.equal(f.taskChanges(),1);assert.equal(f.callbacks(),1);assert.deepEqual(await f.service.outstanding(f.owner),[])
 await f.service.settleDeferred(f.owner,f.input);assert.equal(f.taskChanges(),1);assert.equal(f.callbacks(),1)
})

test('143 后续Task版本/归属决定不被deferred恢复覆盖或重复交付',async()=>{
 for(const kind of ['version','role'] as const){const f=fixture();await f.service.record(f.owner,f.input,{deferSettlement:true});f.control.state='active';if(kind==='version')f.task.version++;else f.task.roleId=randomUUID();const task=structuredClone(f.task);await f.service.settleDeferred(f.owner,f.input);assert.deepEqual(f.task,task);assert.equal(f.callbacks(),0);assert.equal(f.taskChanges(),0);assert.deepEqual(await f.service.outstanding(f.owner),[])}
})

test('143 flags不属于public JSON；预先active/unknown控制不能借defer写终态',async()=>{
 const f=fixture();await assert.rejects(f.service.record(f.owner,{...f.input,deferSettlement:true}));assert.equal(f.writes.length,0)
 for(const phase of ['active','unknown','stop'] as const){const x=fixture();if(phase==='active')x.control.state='active';else if(phase==='unknown')x.control.unknown=['unknown-effect'];else x.stop();await assert.rejects(x.service.record(x.owner,x.input,{deferSettlement:true}),{code:'teloa/conflict'});assert.equal(x.run().state,'active');assert.equal(x.writes.length,0);assert.equal(x.callbacks(),0)}
})

test('143 缺省record保持原Task等待与onSettled行为',async()=>{
 const f=fixture();await f.service.record(f.owner,f.input);assert.equal(f.task.state,'waiting');assert.equal(f.taskChanges(),1);assert.equal(f.callbacks(),1)
})

test('153 暂停可登记真实失败终态；显式恢复后精确结算一次且不发布成果',async()=>{
 for(const reason of ['aborted','blocked','error','max-tokens','interrupted']){
  const f=fixture(reason),before=structuredClone({task:f.task,control:f.control})
  await f.service.record(f.owner,f.input,{deferSettlement:true})
  assert.equal(f.run().state,'ended');assert.deepEqual({task:f.task,control:f.control},before);assert.equal(f.callbacks(),0);assert.deepEqual(await f.service.outstanding(f.owner),[f.input.runId])
  const ports={check:async()=>{},send:async()=>{throw Error('不能重发')},stop:async()=>{throw Error('不能重启')},events:async()=>{throw Error('终态不重读或重跑原生轮')},controlState:async()=>f.control.state,publishOwnerResult:async()=>{throw Error('失败不发布成果')},publishGroupResult:async()=>{throw Error('失败不发布成果')}}
  const driver=new TaskRunDriver(f.service,ports as never)
  await driver.reconcile(f.owner,{runId:f.input.runId});assert.deepEqual(f.task,before.task);assert.equal(f.callbacks(),0)
  f.control.state='active';await driver.reconcile(f.owner,{runId:f.input.runId})
  assert.equal(f.task.state,reason==='aborted'?'paused':'blocked');assert.equal(f.taskChanges(),1);assert.equal(f.callbacks(),1)
  await driver.reconcile(f.owner,{runId:f.input.runId});assert.equal(f.taskChanges(),1);assert.equal(f.callbacks(),1);assert.deepEqual(await f.service.outstanding(f.owner),[])
 }
})

test('153 非固定终态、未知操作及后续Task归属变化不能借失败延期结算越过边界',async()=>{
 for(const reason of ['forked','future-reason']){const f=fixture(reason);await assert.rejects(f.service.record(f.owner,f.input,{deferSettlement:true}),{code:'teloa/conflict'});assert.equal(f.writes.length,0)}
 const unknown=fixture('error');unknown.control.unknown=['unknown-effect'];await assert.rejects(unknown.service.record(unknown.owner,unknown.input,{deferSettlement:true}),{code:'teloa/conflict'});assert.equal(unknown.writes.length,0)
 for(const kind of ['version','role'] as const){const f=fixture('interrupted');await f.service.record(f.owner,f.input,{deferSettlement:true});f.control.state='active';if(kind==='version')f.task.version++;else f.task.roleId=randomUUID();const task=structuredClone(f.task);assert.equal((await f.service.settleDeferred(f.owner,f.input)).disposition,'inapplicable');assert.deepEqual(f.task,task);assert.equal(f.callbacks(),0)}
})


function publicationPorts(run:TaskRun,publish:(fresh:TaskRun,text:string)=>Promise<void>,control:()=>Promise<'active'>){
 const events=[{seq:0,time:0,type:'turn/start',data:{turn:1}},{seq:1,time:1,type:'user/message',surfaceOp:'append',data:{id:'owner-message',role:'user',source:{kind:'user',rpcId:run.nativeRequestId},content:[{type:'text',text:'合成请求'}]}},{seq:2,time:2,type:'assistant/message',surfaceOp:'append',data:{turn:1,stream:[],message:{role:'assistant',content:[{type:'text',text:'完整合成回传'}]}}},{seq:3,time:3,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}]
 return {check:async()=>{},send:async()=>{throw Error('不能重发')},stop:async()=>{throw Error('不能重启')},controlState:control,events:async()=>events as never,publishGroupResult:publish}
}

test('143 final5 RED legacy ended用真实stateForRun无lineage冲突，原正常发布仍应可达',async()=>{
 const f=fixture();f.group();await f.service.record(f.owner,{...f.input,evidence:{...f.input.evidence,endSeq:3}})
 const {lineage:_lineage,...legacy}=f.run();let published=0,controlReads=0
 const row={id:legacy.taskId,owner_id:f.owner,request_id:randomUUID(),definition:{title:'合成任务',goal:'合成目标',scope:'general',groupId:null,skills:[]},version:1,state:'waiting',assignee_role_id:null,assignee_role_version:null,created_at:new Date(0),updated_at:new Date(0)}
 const query=async(sql:string)=>{if(sql.startsWith('select task_id'))return{rows:[{task_id:legacy.taskId}]};if(sql.startsWith('select * from teloa_tasks'))return{rows:[row]};if(sql.startsWith('select to_regclass'))return{rows:[{relation:null}]};throw Error('未声明只读SQL')}
 const controls=new WorkControlService({query,connect:async()=>({query,release(){}})} as never,{id:randomUUID,now:()=>new Date(0).toISOString()})
 await assert.rejects(controls.stateForRun(f.owner,{runId:legacy.id}),{code:'teloa/conflict'})
 const ports=publicationPorts(legacy as TaskRun,async(_run,text)=>{assert.equal(text,'完整合成回传');published++},async()=>{controlReads++;return await controls.stateForRun(f.owner,{runId:legacy.id}) as 'active'})
 const service={get:async()=>legacy,record:f.service.record.bind(f.service),settleDeferred:f.service.settleDeferred?.bind(f.service)}
 const result=await new TaskRunDriver(service as never,ports).reconcile(f.owner,{runId:legacy.id});assert.equal(result.state,'ended');assert.equal(published,1);assert.equal(controlReads,0)
})

test('143 final5 RED 真实record CAS漂移不能继续调用不要求publication登记的群发布port',async()=>{
 const f=fixture();f.group();await f.service.record(f.owner,{...f.input,evidence:{...f.input.evidence,endSeq:3}},{deferSettlement:true});f.control.state='active';f.task.version++
 let published=0;const ports=publicationPorts(f.run(),async()=>{published++},async()=> 'active')
 const driver=new TaskRunDriver(f.service,ports);await driver.reconcile(f.owner,{runId:f.input.runId});assert.equal(f.callbacks(),0);assert.equal(f.taskChanges(),0);assert.equal(published,0)
})

test('143 正常既存pending发布保持幂等路径，结算返回新Run并明确pending或stale',async()=>{
 const f=fixture();f.group();f.control.state='active';await f.service.record(f.owner,{...f.input,evidence:{...f.input.evidence,endSeq:3}});f.task.version++
 const pending=await f.service.settleDeferred(f.owner,{...f.input,evidence:{...f.input.evidence,endSeq:3}});assert.equal(pending.disposition,'pending-publication');assert.equal(pending.run.state,'ended');assert.equal(f.callbacks(),1)
 let published=0;const ports=publicationPorts(f.run(),async(fresh,text)=>{assert.equal(fresh,pending.run);assert.equal(text,'完整合成回传');published++},async()=> 'active')
 // The backend returns a new saved projection, never the original public object captured before settlement.
 const fresh={...pending.run};const service={get:async()=>f.run(),settleDeferred:async()=>({...pending,run:fresh})};ports.publishGroupResult=async(run,text)=>{assert.equal(run,fresh);assert.equal(text,'完整合成回传');published++}
 await new TaskRunDriver(service as never,ports).reconcile(f.owner,{runId:f.input.runId});assert.equal(published,1)
 const stale=fixture();await stale.service.record(stale.owner,stale.input,{deferSettlement:true});stale.control.state='active';stale.task.version++;const denied=await stale.service.settleDeferred(stale.owner,stale.input);assert.equal(denied.disposition,'inapplicable')
})
