import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {WorkError} from '@teloa/contract'
import {setupRoleWork,roleFixture,identity} from '../../backend/tests/role-work-test-fixture.ts'
import {initializeWorkControl,WorkControlService} from '../../backend/src/work/work-control.ts'
import {WorkLineageService} from '../../backend/src/work/work-lineage.ts'
import {WorkControlDriver} from '../src/work-control-driver.ts'

test('真实PG：宿主重启暂停只剩无会话、无 link 的 configuration_failed Run 时，不读执行日志即由 pausing 收口为 paused',{timeout:60000},async t=>{
 const f=await setupRoleWork();t.after(()=>f.close())
 await initializeWorkControl(f.pool)
 const {owner,role,taskId}=await roleFixture(f.pool,'employee'),lineage=new WorkLineageService(f.pool,identity),db=await f.pool.connect()
 let source
 try{await db.query('begin');source=await lineage.bindTask(db,owner,{taskId,source:{kind:'owner-task',taskId}});await db.query('commit')}finally{db.release()}
 const runId=randomUUID(),sessionId='task-run-'+randomUUID()
 await f.pool.query(`insert into teloa_task_runs(id,owner_id,request_id,request_spec,task_id,role_id,task_version,role_version,link_version,session_id,native_request_id,state,input_text,created_at,evidence,configuration_error)
 values($1,$2,$3,'{}',$4,$5,1,1,0,$6,$7,'configuration_failed','{}',now(),null,$8)`,[runId,owner,randomUUID(),taskId,role.id,sessionId,randomUUID(),JSON.stringify({code:'teloa/invalid-input',stage:'session-create',message:'创建需要有效的请求 ID 与工作标题。'})])
 let host=1,events=0,driver:WorkControlDriver|undefined
 const service=new WorkControlService(f.pool,identity,{hostGeneration:()=>host,ownerAuthority:{authorize:async()=>({assertCurrent(){}})},inspectRun:async(value,input)=>driver!.inspectRun(value,input)})
 driver=new WorkControlDriver({controls:service,runs:{get:async()=>({id:runId,state:'configuration_failed',sessionId})},lineage,driver:{stop:async()=>{throw Error('配置失败 Run 不应走业务停止')}},ports:{stop:async()=>{throw Error('配置失败 Run 不应走原生停止')},goalObservation:async()=>null,events:async()=>{events++;throw new WorkError('teloa/forbidden','执行会话身份未就绪。')}},runtimeLinks:{list:async()=>[]}} as never)
 host=2;const [restart]=await service.disarmForRestart(owner,{hostGeneration:2})
 assert.equal(restart?.id,source.roundControlId);assert.equal(restart.state,'pausing');assert.deepEqual(restart.pendingRunIds,[runId])
 const settled=await driver.apply(owner,restart,new AbortController().signal)
 assert.equal(settled.state,'paused');assert.equal(events,0)
 assert.equal((await service.get(owner,{controlId:restart.id})).state,'paused')
})
