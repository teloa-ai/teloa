import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from './postgres-test-lifecycle.ts'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeArtifactSnapshots} from '../src/work/artifact-snapshots.ts'
import {ArtifactService,initializeArtifacts} from '../src/work/artifacts.ts'

let container:StartedPostgreSqlContainer,pool:Pool
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeArtifactSnapshots(pool);await initializeArtifacts(pool)
 await pool.query(`
  create table teloa_tasks(id uuid primary key,owner_id text not null,request_id uuid not null,request_spec jsonb not null,definition jsonb not null,version integer not null,state text not null,assignee_role_id uuid,assignee_role_version integer,created_at timestamptz not null,updated_at timestamptz not null);
  create table teloa_task_runs(id uuid primary key,owner_id text not null,request_id uuid not null,request_spec jsonb not null,task_id uuid not null,role_id uuid,task_version integer not null,role_version integer,link_version integer not null,session_id text not null,native_request_id uuid not null,state text not null,input_text text not null,created_at timestamptz not null,evidence jsonb,stop_requested_at timestamptz,task_state_version integer);
  create table teloa_group_messages(id uuid primary key,owner_id text not null,group_id uuid not null,run_id uuid,task_id uuid,author_id text not null,text text not null,created_at timestamptz not null);
 `)
})
after(async()=>{await pool?.end();await container?.stop()})

const now=()=>new Date()
/** 只造本用例真正读的行：任务 waiting、角色运行 completed、员工回帖正文。 */
async function fixture(options:{state?:string;runReason?:string;text?:string;roleRun?:boolean}={}){
 const owner=randomUUID(),taskId=randomUUID(),runId=randomUUID(),roleId=randomUUID(),updatedAt=now()
 await pool.query('insert into teloa_tasks values($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10,$11)',[
  taskId,owner,randomUUID(),'{}',JSON.stringify({title:'群任务：整理事实卡片',goal:'完成',scope:'general',groupId:null,skills:[]}),2,options.state??'waiting',roleId,1,updatedAt,updatedAt])
 await pool.query('insert into teloa_task_runs values($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17)',[
  runId,owner,randomUUID(),'{}',taskId,options.roleRun===false?null:roleId,2,options.roleRun===false?null:1,1,'task-run-'+runId,randomUUID(),'ended','{}',now(),
  JSON.stringify({state:'ended',reason:options.runReason??'completed'}),null,1])
 if(options.text!==null)await pool.query('insert into teloa_group_messages values($1,$2,$3,$4,$5,$6,$7,$8)',[
  randomUUID(),owner,randomUUID(),runId,taskId,options.roleRun===false?'self':roleId,options.text??'**整理结果**：三条事实均标注来源，结论可用。',now()])
 const service=new ArtifactService(pool,{id:randomUUID,now:()=>now().toISOString()},async(_owner,expected)=>({source:expected,sessionIds:[]}))
 const source={kind:'task' as const,id:taskId,scope:'general',version:`2 · ${updatedAt.toISOString()}`,title:'群任务：整理事实卡片'}
 return {owner,taskId,runId,roleId,updatedAt,service,source}
}

test('GRP-02 已完成角色运行的最终文本按需定版为当前任务版本的成果，含来源/任务版本/正文摘要，且幂等',async()=>{
 const text='**整理结果**：三条事实均标注来源。'
 const f=await fixture({text})
 const saved=await f.service.materializeTextRunResult(f.owner,f.taskId)
 assert.ok(saved)
 assert.equal(saved!.number,1)
 assert.equal(saved!.source.kind,'task');assert.equal(saved!.source.id,f.taskId)
 assert.equal(saved!.source.version,`2 · ${f.updatedAt.toISOString()}`,'成果来源必须是当前任务版本，结项下拉才能命中')
 assert.equal(saved!.content.sections[0]!.text,text)
 assert.match(saved!.content.note,new RegExp('来源运行 '+f.runId))
 assert.match(saved!.content.note,new RegExp('正文摘要 sha256 '+createHash('sha256').update(text).digest('hex')))
 const again=await f.service.materializeTextRunResult(f.owner,f.taskId)
 assert.deepEqual(again,saved,'重复读取/重复调用不产生重复版本')
 const listed=await f.service.listTask(f.owner,f.source)
 assert.equal(listed.length,1,'结项面读取任务成果即得到该文本成果')
 assert.equal(listed[0]!.source.version,`2 · ${f.updatedAt.toISOString()}`)
})

test('GRP-02 空文本或失败运行不生成成果，结项面仍保持无候选',async()=>{
 const blank=await fixture({text:'   '})
 assert.equal(await blank.service.materializeTextRunResult(blank.owner,blank.taskId),null)
 assert.equal((await pool.query('select count(*)::int n from teloa_artifacts where owner_id=$1',[blank.owner])).rows[0].n,0,'空文本不得伪造成果')
 const failed=await fixture({runReason:'error'})
 await assert.rejects(failed.service.materializeTextRunResult(failed.owner,failed.taskId),{code:'teloa/conflict'})
 assert.equal((await pool.query('select count(*)::int n from teloa_artifacts where owner_id=$1',[failed.owner])).rows[0].n,0,'失败运行不得伪造成果')
 })

test('GRP-02 非角色运行或任务不在等待核对时不定版',async()=>{
 const ownerRun=await fixture({roleRun:false})
 await assert.rejects(ownerRun.service.materializeTextRunResult(ownerRun.owner,ownerRun.taskId),{code:'teloa/conflict'})
 const done=await fixture({state:'completed'})
 assert.equal(await done.service.materializeTextRunResult(done.owner,done.taskId),null)
 assert.equal((await pool.query('select count(*)::int n from teloa_artifacts where owner_id in ($1,$2)',[ownerRun.owner,done.owner])).rows[0].n,0)
})
