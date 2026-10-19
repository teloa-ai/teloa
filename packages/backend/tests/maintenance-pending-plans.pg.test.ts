import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {Pool,stopTestContainer} from './postgres-test-lifecycle.ts'
import {assertMaintenanceDatabase} from '../../cli/src/maintenance.ts'
let pool:Pool,container:StartedPostgreSqlContainer
before(async()=>{
 container=await new PostgreSqlContainer('postgres:17-alpine').withPullPolicy({shouldPull:()=>false}).start();pool=new Pool({connectionString:container.getConnectionUri()})
 await pool.query(`create table teloa_task_runs(owner_id text,request_id uuid,state text);
 create table teloa_plan_occurrences(id uuid,owner_id text,task_request_id uuid);
 create table teloa_plan_task_links(claim_id uuid,task_id uuid,owner_id text,task_request_id uuid);
 create table teloa_tasks(id uuid,owner_id text,request_id uuid,state text);
 create table teloa_security_action_executions(state text);
 create table teloa_plugin_installations(state text);`)
},{timeout:120000})
after(async()=>{await pool?.end();await stopTestContainer(container)})
test('停止宿主的原领取和未派发任务可完整保留；运行、错属、未知副作用仍阻止维护',async()=>{
 const claim=randomUUID(),task=randomUUID(),request=randomUUID(),owner='maintenance-owner'
 await pool.query('insert into teloa_plan_occurrences values($1,$2,$3)',[claim,owner,request]);await pool.query('insert into teloa_plan_task_links values($1,$2,$3,$4)',[claim,task,owner,request]);await pool.query("insert into teloa_tasks values($1,$2,$3,'ready')",[task,owner,request])
 const before=(await pool.query('select * from teloa_plan_task_links')).rows
 for(const state of ['ready','paused','blocked','waiting']){await pool.query('update teloa_tasks set state=$1',[state]);await assertMaintenanceDatabase(pool)}
 assert.deepEqual((await pool.query('select * from teloa_plan_task_links')).rows,before,'维护检查不取消、重建或改写原任务来源')
 await pool.query("update teloa_tasks set state='running'");await assert.rejects(assertMaintenanceDatabase(pool),/运行或来源/)
 await pool.query("update teloa_tasks set state='ready',owner_id='other'");await assert.rejects(assertMaintenanceDatabase(pool),/运行或来源/)
 await pool.query('update teloa_tasks set owner_id=$1,request_id=$2',[owner,randomUUID()]);await assert.rejects(assertMaintenanceDatabase(pool),/运行或来源/)
 await pool.query('update teloa_tasks set request_id=$1',[request]);await pool.query("insert into teloa_task_runs values($1,$2,'prepared')",[owner,request]);await assert.rejects(assertMaintenanceDatabase(pool),/运行/)
 await pool.query("update teloa_task_runs set state='ended'");await pool.query("insert into teloa_security_action_executions values('effect_unknown')");await assert.rejects(assertMaintenanceDatabase(pool),/外部执行/)
 await pool.query('delete from teloa_security_action_executions');await pool.query("insert into teloa_plugin_installations values('unknown')");await assert.rejects(assertMaintenanceDatabase(pool),/扩展/)
})
