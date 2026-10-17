import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeProjects,ProjectService} from '../src/work/projects.ts'
import {initializeBusinessSpaces} from '../src/work/business-spaces.ts'
import {initializeProjectContext,ProjectContextService} from '../src/work/project-context.ts'
let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()}
before(async()=>{container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeBusinessSpaces(pool);await initializeProjects(pool);await initializeProjectContext(pool)},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})
async function fixture(){
 const owner=randomUUID(),projects=new ProjectService(pool,identity),service=new ProjectContextService(pool,identity)
 const create=()=>projects.create(owner,{requestId:randomUUID(),fields:{scope:'general',title:'项目',goal:'完成实际工作',dueDate:null,state:'planning',links:[],references:[]}})
 return {owner,service,projects,a:await create(),b:await create()}
}
const entry=(markdown='第一版')=>({kind:'save-entry' as const,entryId:null,entryKind:'memory' as const,topic:'已验证经验',markdown})
test('真实 PG：撤回历史不消耗有效额度，分享新版本由接收方明确采用',async()=>{
 const f=await fixture()
 await pool.query("insert into teloa_project_context_entries(id,project_id,kind,topic,topic_key,version,state) select gen_random_uuid(),$1,'memory','旧记忆'||n,'old-'||n,1,'withdrawn' from generate_series(1,201) n",[f.a.id])
 await pool.query("insert into teloa_project_context_revisions(entry_id,version,markdown,hash,request_id,created_at) select id,1,'旧正文',repeat('a',64),gen_random_uuid(),now() from teloa_project_context_entries where project_id=$1",[f.a.id])
 await f.service.mutate(f.owner,{requestId:randomUUID(),projectId:f.a.id,expectedVersion:0,change:entry()})
 const original=(await f.service.get(f.owner,{projectId:f.a.id})).entries.find(e=>e.state==='active')!
 assert.ok(original);assert.ok((await f.service.get(f.owner,{projectId:f.a.id})).entries.length<=200)
 await f.service.mutate(f.owner,{requestId:randomUUID(),projectId:f.a.id,expectedVersion:1,change:{kind:'share',entryId:original.id,entryVersion:1,targetProjectId:f.b.id}})
 await f.service.mutate(f.owner,{requestId:randomUUID(),projectId:f.a.id,expectedVersion:2,change:{...entry('第二版'),entryId:original.id}})
 const target=await f.service.get(f.owner,{projectId:f.b.id}),share=target.shares[0]!
 assert.equal(share.markdown,'第一版');assert.equal(share.currentVersion,2)
 await f.service.mutate(f.owner,{requestId:randomUUID(),projectId:f.b.id,expectedVersion:target.version,change:{kind:'update-share',shareId:share.id,entryVersion:2}})
 const updated=await f.service.get(f.owner,{projectId:f.b.id})
 assert.equal(updated.shares.find(s=>s.id===share.id)!.status,'revoked');assert.equal(updated.shares.find(s=>s.status==='active')!.markdown,'第二版')
})
test('真实 PG：项目私有正文、服务重建、跨本人隔离、重复主题与并发版本',async()=>{
 const f=await fixture(),input={requestId:randomUUID(),projectId:f.a.id,expectedVersion:0,change:entry()}
 const [one,two]=await Promise.all([f.service.mutate(f.owner,input),f.service.mutate(f.owner,input)])
 assert.deepEqual(one,two)
 const saved=await new ProjectContextService(pool,identity).get(f.owner,{projectId:f.a.id})
 assert.equal(saved.entries.length,1);assert.equal(saved.entries[0]!.markdown,'第一版')
 assert.deepEqual((await f.service.get(f.owner,{projectId:f.b.id})).entries,[])
 await assert.rejects(f.service.get(randomUUID(),{projectId:f.a.id}),{code:'teloa/not-found'})
 await assert.rejects(f.service.mutate(f.owner,{...input,change:entry('篡改重试')}),{code:'teloa/conflict'})
 await assert.rejects(f.service.mutate(f.owner,{...input,requestId:randomUUID(),expectedVersion:1}),{code:'teloa/conflict'})
 const writes=await Promise.allSettled(['甲','乙'].map(brief=>f.service.mutate(f.owner,{requestId:randomUUID(),projectId:f.a.id,expectedVersion:1,change:{kind:'save-brief',brief}})))
 assert.equal(writes.filter(v=>v.status==='fulfilled').length,1)
 assert.equal((await pool.query("select to_regclass('knowledge_items') as table_name")).rows[0].table_name,null,'私有正文不依赖公共知识目录')
})
test('真实 PG：分享固定修订，更新不漂移，源头撤回使全部视图即时隐藏正文',async()=>{
 const f=await fixture()
 await f.service.mutate(f.owner,{requestId:randomUUID(),projectId:f.a.id,expectedVersion:0,change:entry()})
 const original=(await f.service.get(f.owner,{projectId:f.a.id})).entries[0]!
 await f.service.mutate(f.owner,{requestId:randomUUID(),projectId:f.a.id,expectedVersion:1,change:{kind:'share',entryId:original.id,entryVersion:1,targetProjectId:f.b.id}})
 await f.service.mutate(f.owner,{requestId:randomUUID(),projectId:f.a.id,expectedVersion:2,change:{...entry('第二版'),entryId:original.id}})
 assert.equal((await f.service.get(f.owner,{projectId:f.b.id})).shares[0]!.markdown,'第一版')
 const withdraw={requestId:randomUUID(),projectId:f.a.id,expectedVersion:3,change:{kind:'withdraw-entry' as const,entryId:original.id}}
 await f.service.mutate(f.owner,withdraw)
 const target=await f.service.get(f.owner,{projectId:f.b.id})
 assert.equal(target.shares[0]!.status,'withdrawn');assert.equal(target.shares[0]!.markdown,null);assert.equal(target.shares[0]!.hash,null)
 assert.equal(target.version,2,'接收方因分享加入及来源撤回提升版本')
 assert.equal((await f.service.get(f.owner,{projectId:f.a.id})).entries[0]!.markdown,null)
 assert.deepEqual(await f.service.mutate(f.owner,withdraw),{requestId:withdraw.requestId,projectId:f.a.id,version:4},'重试只返回无正文回执')
 assert.equal((await pool.query('select count(*)::int n from teloa_project_context_revisions where entry_id=$1',[original.id])).rows[0].n,2)
})
test('真实 PG：接收方可以撤销分享，不能修改来源；归档仍可撤回',async()=>{
 const f=await fixture()
 await f.service.mutate(f.owner,{requestId:randomUUID(),projectId:f.a.id,expectedVersion:0,change:entry()})
 const e=(await f.service.get(f.owner,{projectId:f.a.id})).entries[0]!
 await f.service.mutate(f.owner,{requestId:randomUUID(),projectId:f.a.id,expectedVersion:1,change:{kind:'share',entryId:e.id,entryVersion:1,targetProjectId:f.b.id}})
 const shared=(await f.service.get(f.owner,{projectId:f.b.id})).shares[0]!
 await assert.rejects(f.service.mutate(f.owner,{requestId:randomUUID(),projectId:f.b.id,expectedVersion:1,change:{...entry('不应修改'),entryId:e.id}}),{code:'teloa/not-found'})
 await f.service.mutate(f.owner,{requestId:randomUUID(),projectId:f.b.id,expectedVersion:1,change:{kind:'revoke-share',shareId:shared.id}})
 assert.equal((await f.service.get(f.owner,{projectId:f.a.id})).shares[0]!.markdown,null)
 const {id,ownerId,version,createdAt,updatedAt,...fields}=f.a
 await f.projects.edit(f.owner,{projectId:id,expectedVersion:version,fields:{...fields,state:'archived'}})
 await assert.rejects(f.service.mutate(f.owner,{requestId:randomUUID(),projectId:id,expectedVersion:3,change:{kind:'save-brief',brief:'归档不应修改'}}),{code:'teloa/conflict'})
 await f.service.mutate(f.owner,{requestId:randomUUID(),projectId:id,expectedVersion:3,change:{kind:'withdraw-entry',entryId:e.id}})
})
test('真实 PG：取消和跨本人分享不写入；规则不能冒充共享经验',async()=>{
 const f=await fixture(),other=await fixture(),abort=new AbortController();abort.abort()
 await assert.rejects(f.service.mutate(f.owner,{requestId:randomUUID(),projectId:f.a.id,expectedVersion:0,change:entry()},abort.signal),{name:'AbortError'})
 assert.equal((await f.service.get(f.owner,{projectId:f.a.id})).version,0)
 await f.service.mutate(f.owner,{requestId:randomUUID(),projectId:f.a.id,expectedVersion:0,change:{...entry(),entryKind:'rule'}})
 const e=(await f.service.get(f.owner,{projectId:f.a.id})).entries[0]!
 await assert.rejects(f.service.mutate(f.owner,{requestId:randomUUID(),projectId:f.a.id,expectedVersion:1,change:{kind:'share',entryId:e.id,entryVersion:1,targetProjectId:other.b.id}}),{code:'teloa/not-found'})
 await assert.rejects(f.service.mutate(f.owner,{requestId:randomUUID(),projectId:f.a.id,expectedVersion:1,change:{kind:'share',entryId:e.id,entryVersion:1,targetProjectId:f.b.id}}),{code:'teloa/conflict'})
})
test('真实 PG：旧约束升级后可显式新建同主题，撤回条目和旧分享不会复活',async()=>{
 // 模拟已安装 B1 的全历史主题唯一约束，升级必须保留原记录并可重复执行。
 const legacy='teloa_project_context_entries_project_id_kind_topic_key_key'
 if(!(await pool.query('select 1 from pg_constraint where conrelid=$1::regclass and conname=$2',['teloa_project_context_entries',legacy])).rowCount)
  await pool.query('alter table teloa_project_context_entries add constraint teloa_project_context_entries_project_id_kind_topic_key_key unique(project_id,kind,topic_key)')
 await initializeProjectContext(pool);await initializeProjectContext(pool)
 const f=await fixture()
 await f.service.mutate(f.owner,{requestId:randomUUID(),projectId:f.a.id,expectedVersion:0,change:entry()})
 const old=(await f.service.get(f.owner,{projectId:f.a.id})).entries[0]!
 await f.service.mutate(f.owner,{requestId:randomUUID(),projectId:f.a.id,expectedVersion:1,change:{kind:'share',entryId:old.id,entryVersion:1,targetProjectId:f.b.id}})
 await f.service.mutate(f.owner,{requestId:randomUUID(),projectId:f.a.id,expectedVersion:2,change:{kind:'withdraw-entry',entryId:old.id}})
 await f.service.mutate(f.owner,{requestId:randomUUID(),projectId:f.a.id,expectedVersion:3,change:entry('本人重新保存的内容')})
 const next=await f.service.get(f.owner,{projectId:f.a.id}),active=next.entries.find(e=>e.state==='active')!
 assert.notEqual(active.id,old.id);assert.equal(active.version,1);assert.equal(active.markdown,'本人重新保存的内容')
 assert.equal(next.entries.find(e=>e.id===old.id)!.markdown,null)
 const target=await f.service.get(f.owner,{projectId:f.b.id})
 assert.equal(target.shares[0]!.status,'withdrawn');assert.equal(target.shares[0]!.markdown,null);assert.equal(target.version,2)
 await assert.rejects(f.service.mutate(f.owner,{requestId:randomUUID(),projectId:f.a.id,expectedVersion:4,change:entry('重复活动主题')}),{code:'teloa/conflict'})
 await assert.rejects(f.service.mutate(f.owner,{requestId:randomUUID(),projectId:f.a.id,expectedVersion:4,change:{...entry(),entryId:old.id}}),{code:'teloa/conflict'})
})
test('真实 PG：既有主题的显示文字变化明确拒绝，不静默吞掉字段',async()=>{
 const f=await fixture()
 await f.service.mutate(f.owner,{requestId:randomUUID(),projectId:f.a.id,expectedVersion:0,change:{...entry(),topic:'Mac Only'}})
 const saved=(await f.service.get(f.owner,{projectId:f.a.id})).entries[0]!
 await assert.rejects(f.service.mutate(f.owner,{requestId:randomUUID(),projectId:f.a.id,expectedVersion:1,change:{...entry('新正文'),entryId:saved.id,topic:'Ｍａｃ Only'}}),{code:'teloa/conflict'})
 const next=await f.service.get(f.owner,{projectId:f.a.id})
 assert.equal(next.version,1);assert.equal(next.entries[0]!.version,1);assert.equal(next.entries[0]!.topic,'Mac Only')
})
