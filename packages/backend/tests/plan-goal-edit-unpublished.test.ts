import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {readBusinessSourceGoalEdit} from '../src/work/plan-occurrences.ts'
import {goalEditFixture as fixture} from './fixtures/plan-goal-edit-unpublished.ts'
const hash=(v:string)=>createHash('sha256').update(v).digest('hex')

test('goal-only编辑在正常未发布取消后仍保留历史资格，原Run/来源/审批回执不改',async()=>{
 const f=fixture(),before=structuredClone({task:f.taskRow,claim:f.claim,update:f.update,run:f.runRow,receipt:f.receipt,edit:f.edit}),proof=await f.read()
 assert.equal(proof?.taskId,f.task.id);assert.equal(proof?.editVersion,4);assert.equal(proof?.goal,f.task.goal)
 assert.deepEqual({task:f.taskRow,claim:f.claim,update:f.update,run:f.runRow,receipt:f.receipt,edit:f.edit},before)
})

test('既有continued/accepted编辑资格兼容，取消专用读取不扩大普通执行入口',async()=>{
 for(const state of ['continued','accepted']){const f=fixture();f.update.state=state;f.state.receipt=false;assert.equal((await f.read())?.editVersion,4)}
})

test('needs-user只有同owner/Task/Run/版本/来源hash的typed取消可用，缺失或未知一律拒绝',async()=>{
 for(const change of ['reason','foreign-update','foreign-run','run-task','run-version','role','role-version','goal','source-hash','source-version','receipt','receipt-input','attempt-accepted','attempt-unknown','effect','ordinary-stop','audit','current','edit','request'] as const){
  const f=fixture()
  if(change==='reason')f.update.reason='teloa/submission-unknown'
  if(change==='foreign-update')f.update.owner_id=randomUUID()
  if(change==='foreign-run')f.runRow.owner_id=randomUUID()
  if(change==='run-task')f.runRow.task_id=randomUUID()
  if(change==='run-version')f.runRow.task_version=6
  if(change==='role')f.runRow.role_id=randomUUID()
  if(change==='role-version')f.runRow.role_version=3
  if(change==='goal'){const input=JSON.parse(f.runRow.input_text);input.task.goal='未经本人编辑的新目标';f.runRow.input_text=JSON.stringify(input)}
  if(change==='source-hash')f.update.snapshot_hash='d'.repeat(64)
  if(change==='source-version')f.update.object_version=3
  if(change==='receipt')f.state.receipt=false
  if(change==='receipt-input')f.receipt.identity.inputSha256='e'.repeat(64)
  if(change==='attempt-accepted')f.attempt.state='accepted'
  if(change==='attempt-unknown')f.attempt.state='dispatching'
  if(change==='effect')f.state.effect=true
  if(change==='ordinary-stop')f.runRow.state='ended'
  if(change==='audit')Object.assign(f.cancellation,{audit:{schema:'unknown'}})
  if(change==='current')f.state.current=false
  if(change==='edit')f.edit.result.definition={...f.edit.result.definition,goal:'无回执的目标'}
  if(change==='request')f.taskRow.request_spec={...f.taskRow.request_spec,fields:{...f.taskRow.request_spec.fields,title:'篡改原创建请求'}}
  assert.equal(await f.read(),undefined,change)
 }
})

test('编辑内容/版本或owner变化后不借旧取消凭据继续',async()=>{
 const f=fixture();assert.equal(await readBusinessSourceGoalEdit(f.db,'foreign-owner',f.task,f.claim.id,'核对合成来源v1'),undefined)
 assert.equal(await readBusinessSourceGoalEdit(f.db,f.owner,{...f.task,version:8},f.claim.id,'核对合成来源v1'),undefined)
 assert.equal(await readBusinessSourceGoalEdit(f.db,f.owner,{...f.task,goal:'本人后来新目标'},f.claim.id,'核对合成来源v1'),undefined)
})

test('已确认的新请求只复用同一typed原凭据，陌生确认/错hash/并列确认拒绝',async()=>{
 const {errorRecoveryNotice}=await import('@teloa/contract'),{workEventDigest}=await import('../src/work/work-event-digest.ts')
 for(const mutation of ['none','foreign-task','foreign-source','foreign-native','receipt-hash','parallel'] as const){
  const f=fixture(),following={schema:'teloa.task-run-source-followup/v1',kind:'error-recovery',requestId:randomUUID(),taskId:f.task.id,taskVersion:7,sessionId:f.runRow.session_id,originalRunId:f.runRow.id,originalNativeRequestId:f.runRow.native_request_id,originalInputSha256:hash(f.runRow.input_text),originalEvidenceSha256:workEventDigest({domain:'teloa.source-followup-unpublished-cancellation/v1',receipt:f.receipt}),sourceUpdateId:f.update.id,sourceTaskVersion:5,sourceEventId:f.update.event_id,reference:{scope:f.update.scope_id,type:f.update.object_type,id:f.update.object_id,version:2,snapshotHash:f.update.snapshot_hash},instruction:f.task.goal,confirmedAt:'2026-09-01T01:00:00.000Z',notice:errorRecoveryNotice}
  if(mutation==='foreign-task')following.taskId=randomUUID()
  if(mutation==='foreign-source')following.sourceUpdateId=randomUUID()
  if(mutation==='foreign-native')following.originalNativeRequestId=randomUUID()
  if(mutation==='receipt-hash')following.originalEvidenceSha256='f'.repeat(64)
  f.state.following=[{binding:following}]
  if(mutation==='parallel')f.state.following.push({binding:{...following,requestId:randomUUID()}})
  assert.equal(!!await f.read(),mutation==='none',mutation)
 }
})

test('合法维护取消审计由原validator核验，不额外误拒；篡改退出证明仍拒',async()=>{
 // 复用 task-run-maintenance.pg.test.ts 的双进程审计形状；这里只核元数据，不启动进程或PG。
 for(const corrupt of [false,true]){
  const f=fixture(),audit={schema:'teloa.task-run-maintenance/v1',source:'maintenance-process-exit',installId:randomUUID(),requestId:f.receipt.requestId,runId:f.runRow.id,processReceipt:{schema:'teloa.maintenance-process-exit/v1',bindingSha256:'b'.repeat(64),supervisor:{pid:100,pidVersion:10,uniqueId:'1000',uid:501,children:[101]},child:{pid:101,pidVersion:11,uniqueId:'1001',uid:501,ppid:100,parentUniqueId:'1000',children:[]},exited:corrupt?[100]:[100,101],signal:'SIGTERM'},backupSha256:'c'.repeat(64),logFileSha256:'d'.repeat(64)}
  Object.assign(f.cancellation,{audit});assert.equal(!!await f.read(),!corrupt)
 }
})
