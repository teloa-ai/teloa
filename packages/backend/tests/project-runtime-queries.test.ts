import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {WorkError} from '@teloa/contract'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {Pool,stopTestContainer} from './postgres-test-lifecycle.ts'
import {initializeBusinessSpaces} from '../src/work/business-spaces.ts'
import {initializeProjects,ProjectService} from '../src/work/projects.ts'
import {initializeProjectContext,ProjectContextService} from '../src/work/project-context.ts'
import {initializeProjectRuntime,ProjectRuntimeService,type ProjectRuntimeActor} from '../src/work/project-runtime.ts'

let container:StartedPostgreSqlContainer|undefined,pool:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()}
before(async()=>{
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeBusinessSpaces(pool);await initializeProjects(pool);await initializeProjectContext(pool);await initializeProjectRuntime(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await stopTestContainer(container)})

async function project(owner:string,title:string){
 return new ProjectService(pool,identity).create(owner,{requestId:randomUUID(),fields:{scope:'general',title,goal:'核对项目目录与历史的实际可见边界',dueDate:null,state:'planning',links:[],references:[]}})
}
function ordinary(sessionId:string,changes:Partial<ProjectRuntimeActor>={}):ProjectRuntimeActor{
 return {sessionId,title:`当前标题 ${sessionId}`,scope:'general',submitted:false,running:false,kind:'ordinary',...changes}
}
const digest=(text:string)=>createHash('sha256').update(text).digest('hex')
async function change(owner:string,projectId:string,change:unknown){
 const service=new ProjectContextService(pool,identity),current=await service.get(owner,{projectId})
 return service.mutate(owner,{requestId:randomUUID(),projectId,expectedVersion:current.version,change})
}
async function save(owner:string,projectId:string,topic:string,markdown:string,entryKind:'memory'|'rule'='memory'){
 await change(owner,projectId,{kind:'save-entry',entryId:null,entryKind,topic,markdown})
 const entry=(await new ProjectContextService(pool,identity).get(owner,{projectId})).entries.find(item=>item.topic===topic&&item.state==='active')
 assert.ok(entry);return entry
}
async function share(owner:string,sourceProjectId:string,targetProjectId:string,entry:{id:string;version:number}){
 await change(owner,sourceProjectId,{kind:'share',entryId:entry.id,entryVersion:entry.version,targetProjectId})
 const row=(await new ProjectContextService(pool,identity).get(owner,{projectId:targetProjectId})).shares.find(item=>item.entryId===entry.id&&item.status==='active')
 assert.ok(row);return row
}

test('真实 PG：项目目录过滤不可绑定会话，已归属其他项目的候选只在明确绑定后迁移',async t=>{
 const owner=randomUUID(),current=await project(owner,'当前项目'),other=await project(owner,'另一项目')
 // 会话归属和正文使用真实服务；仅宿主的会话目录/运行状态由端口提供。
 const actors=new Map<string,ProjectRuntimeActor>([
  ['new',ordinary('new')],['submitted',ordinary('submitted',{submitted:true})],
  ['other-project',ordinary('other-project')],['already-here',ordinary('already-here')],
  ['running',ordinary('running',{running:true})],['pending',ordinary('pending',{pending:true})],
  ['assistant',ordinary('assistant',{bindable:false})],['builder',ordinary('builder',{bindable:false})],
  ['employee',ordinary('employee',{kind:'employee'})],['task',ordinary('task',{kind:'task'})],
  ['subagent',ordinary('subagent',{kind:'subagent'})],['other-scope',ordinary('other-scope',{scope:'SOC'})],
 ])
 const runtime=new ProjectRuntimeService(pool,identity,{
  sessions:async actor=>{assert.equal(actor,owner);return [...actors.keys(),'inaccessible','deleted'].map(sessionId=>({sessionId,title:'旧目录标题'}))},
  inspect:async(actor,sessionId)=>{
   assert.equal(actor,owner)
   if(sessionId==='inaccessible')throw new WorkError('teloa/forbidden','没有此会话的权限')
   const row=actors.get(sessionId);if(!row)throw new WorkError('teloa/not-found','会话已删除')
   return row
  },
 });t.after(()=>runtime.dispose())
 await runtime.bind(owner,{requestId:randomUUID(),sessionId:'other-project',projectId:other.id,expectedVersion:0,memoryMode:'enabled'})
 actors.get('other-project')!.submitted=true
 await runtime.bind(owner,{requestId:randomUUID(),sessionId:'already-here',projectId:current.id,expectedVersion:0,memoryMode:'enabled'})
 const before=await runtime.getBinding(owner,'other-project')
 const candidates=await runtime.conversations(owner,{projectId:current.id})
 assert.deepEqual(candidates.rows.sort((a,b)=>a.sessionId.localeCompare(b.sessionId)),[
  {sessionId:'new',title:'当前标题 new',bindingVersion:0},
  {sessionId:'other-project',title:'当前标题 other-project',bindingVersion:1},
  {sessionId:'submitted',title:'当前标题 submitted',bindingVersion:0},
 ])
 assert.deepEqual(await runtime.getBinding(owner,'other-project'),before,'列出候选不改变原归属或版本')
 assert.equal(await runtime.getBinding(owner,'new'),null,'列出候选不提前创建归属')
 const moved=await runtime.bind(owner,{requestId:randomUUID(),sessionId:'other-project',projectId:current.id,expectedVersion:1,memoryMode:'enabled'})
 assert.equal(moved.projectId,current.id);assert.equal(moved.version,2)
 assert.deepEqual((await runtime.conversations(owner,{projectId:current.id})).rows.map(row=>row.sessionId).sort(),['new','submitted'])
 actors.get('new')!.running=true
 await assert.rejects(runtime.bind(owner,{requestId:randomUUID(),sessionId:'new',projectId:current.id,expectedVersion:0,memoryMode:'enabled'}),{code:'teloa/conflict'})
 assert.equal(await runtime.getBinding(owner,'new'),null,'旧候选不是稍后执行的授权凭据')
})

test('真实 PG：项目查询按本人隔离，重名会话不继承另一人的绑定版本',async t=>{
 const owner=randomUUID(),foreignOwner=randomUUID(),own=await project(owner,'本人项目'),foreign=await project(foreignOwner,'他人私有项目')
 const calls:string[]=[]
 const runtime=new ProjectRuntimeService(pool,identity,{
  sessions:async actor=>{calls.push(actor);return [{sessionId:'same-session',title:'同名目录项'}]},
  inspect:async(actor,sessionId)=>{assert.ok(actor===owner||actor===foreignOwner);return ordinary(sessionId,{title:actor===owner?'本人会话':'他人私有会话'})},
 });t.after(()=>runtime.dispose())
 await runtime.bind(foreignOwner,{requestId:randomUUID(),sessionId:'same-session',projectId:foreign.id,expectedVersion:0,memoryMode:'enabled'})
 const secret=await save(foreignOwner,foreign.id,'他人私有主题','他人历史正文不应离开归属')
 await change(foreignOwner,foreign.id,{kind:'withdraw-entry',entryId:secret.id})
 assert.deepEqual(await runtime.conversations(owner,{projectId:own.id}),{rows:[{sessionId:'same-session',title:'本人会话',bindingVersion:0}]})
 assert.deepEqual(calls,[owner])
 assert.equal(await runtime.getBinding(owner,'same-session'),null)
 assert.equal((await runtime.getBinding(foreignOwner,'same-session'))?.projectId,foreign.id)
 await assert.rejects(runtime.conversations(owner,{projectId:foreign.id}),{code:'teloa/not-found'})
 await assert.rejects(runtime.history(owner,{projectId:foreign.id}),{code:'teloa/not-found'})
 await assert.rejects(runtime.history(foreignOwner,{projectId:own.id}),{code:'teloa/not-found'})
 assert.deepEqual(calls,[owner],'项目权限失败时不读取宿主会话目录')
 assert.deepEqual(await runtime.history(owner,{projectId:own.id}),{entries:[],shares:[],nextCursor:null})
 assert.equal((await runtime.history(foreignOwner,{projectId:foreign.id})).entries[0]?.id,secret.id)
})

test('真实 PG：撤回条目与双向分享混合分页无重漏，历史仅返回状态不返回正文或哈希',async t=>{
 const owner=randomUUID(),a=await project(owner,'目录项目'),b=await project(owner,'接收项目'),c=await project(owner,'来源项目')
 const runtime=new ProjectRuntimeService(pool,identity,{inspect:async(_owner,sessionId)=>ordinary(sessionId)});t.after(()=>runtime.dispose())
 const secrets=['历史正文甲-不应输出','历史正文乙-不应输出','已撤销分享正文-不应输出','接收分享正文-不应输出']
 const withdrawn=await save(owner,a.id,'已撤回经验',secrets[0]!),rule=await save(owner,a.id,'已撤回规则',secrets[1]!,'rule')
 const withdrawnShare=await share(owner,a.id,b.id,withdrawn)
 await change(owner,a.id,{kind:'withdraw-entry',entryId:withdrawn.id});await change(owner,a.id,{kind:'withdraw-entry',entryId:rule.id})
 const active=await save(owner,a.id,'仍有效的经验',secrets[2]!),revoked=await share(owner,a.id,b.id,active)
 await change(owner,b.id,{kind:'revoke-share',shareId:revoked.id})
 const incoming=await save(owner,c.id,'来源经验',secrets[3]!),incomingRevoked=await share(owner,c.id,a.id,incoming)
 await change(owner,a.id,{kind:'revoke-share',shareId:incomingRevoked.id})
 const activeShare=await share(owner,a.id,c.id,active)
 const unrelated=await save(owner,b.id,'其他项目撤回','其他项目撤回正文');await change(owner,b.id,{kind:'withdraw-entry',entryId:unrelated.id})
 const page1=await runtime.history(owner,{projectId:a.id,limit:3})
 assert.equal(page1.entries.length,2);assert.equal(page1.shares.length,1,'同页跨过条目与分享的边界')
 assert.ok(page1.nextCursor)
 const page2=await runtime.history(owner,{projectId:a.id,limit:3,cursor:page1.nextCursor})
 assert.equal(page2.entries.length,0);assert.equal(page2.shares.length,2);assert.equal(page2.nextCursor,null)
 const entries=[...page1.entries,...page2.entries],shares=[...page1.shares,...page2.shares]
 assert.deepEqual(entries.map(row=>row.id).sort(),[withdrawn.id,rule.id].sort())
 assert.deepEqual(shares.map(row=>row.id).sort(),[withdrawnShare.id,revoked.id,incomingRevoked.id].sort())
 assert.ok(!entries.some(row=>row.id===unrelated.id||row.id===active.id))
 assert.ok(!shares.some(row=>row.id===activeShare.id),'有效分享不混入撤回历史')
 for(const row of entries){assert.equal(row.state,'withdrawn');assert.equal(row.markdown,null);assert.equal(row.hash,null)}
 for(const row of shares){assert.equal(row.topic,null);assert.equal(row.markdown,null);assert.equal(row.hash,null)}
 assert.equal(shares.find(row=>row.id===withdrawnShare.id)?.status,'withdrawn')
 assert.equal(shares.find(row=>row.id===revoked.id)?.status,'revoked')
 assert.equal(shares.find(row=>row.id===incomingRevoked.id)?.sourceTitle,'来源项目')
 assert.equal(shares.find(row=>row.id===incomingRevoked.id)?.targetTitle,'目录项目')
 const serialized=JSON.stringify([page1,page2])
 for(const secret of secrets){assert.ok(!serialized.includes(secret));assert.ok(!serialized.includes(digest(secret)))}
 const stored=await pool.query('select markdown,hash from teloa_project_context_revisions where entry_id=any($1::uuid[])',[[withdrawn.id,rule.id,active.id,incoming.id]])
 assert.deepEqual(stored.rows.map(row=>row.markdown).sort(),[...secrets].sort(),'查询脱敏不破坏保留的历史修订')
 for(const row of stored.rows)assert.equal(row.hash,digest(row.markdown))
})

test('真实 PG：历史逐项游标可重读和安全结束，分页参数不能扩展项目权限',async t=>{
 const owner=randomUUID(),own=await project(owner,'逐项分页项目'),foreign=await project(randomUUID(),'不属于本人的项目')
 const runtime=new ProjectRuntimeService(pool,identity,{inspect:async(_owner,sessionId)=>ordinary(sessionId)});t.after(()=>runtime.dispose())
 const entry=await save(owner,own.id,'第一项历史','只用于核对分页'),other=await save(owner,own.id,'第二项历史','第二项分页正文')
 await change(owner,own.id,{kind:'withdraw-entry',entryId:entry.id});await change(owner,own.id,{kind:'withdraw-entry',entryId:other.id})
 const first=await runtime.history(owner,{projectId:own.id,limit:1})
 assert.equal(first.entries.length,1);assert.ok(first.nextCursor)
 assert.deepEqual(first,await runtime.history(owner,{projectId:own.id,limit:1,cursor:null}))
 const second=await runtime.history(owner,{projectId:own.id,limit:1,cursor:first.nextCursor})
 assert.equal(second.entries.length,1);assert.equal(second.nextCursor,null)
 assert.deepEqual([first.entries[0]!.id,second.entries[0]!.id].sort(),[entry.id,other.id].sort())
 assert.deepEqual(second,await runtime.history(owner,{projectId:own.id,limit:1,cursor:first.nextCursor}),'重读同一游标不消耗下一页')
 assert.deepEqual(await runtime.history(owner,{projectId:own.id,limit:1,cursor:`e:${second.entries[0]!.id}`}),{entries:[],shares:[],nextCursor:null})
 const exact=await runtime.history(owner,{projectId:own.id,limit:2})
 assert.equal(exact.entries.length,2);assert.equal(exact.nextCursor,null,'恰好到达页大小不制造下一页')
 for(const input of [
  {projectId:own.id,limit:0},{projectId:own.id,limit:101},{projectId:own.id,limit:1.5},{projectId:own.id,limit:'1'},
  {projectId:own.id,cursor:'invalid'},{projectId:own.id,cursor:1},{projectId:own.id,cursor:`x:${entry.id}`},
  {projectId:own.id,ownerId:'override'},{projectId:'invalid'},
 ])await assert.rejects(runtime.history(owner,input),{code:'teloa/invalid-input'})
 await assert.rejects(runtime.conversations(owner,{projectId:own.id,ownerId:'override'}),{code:'teloa/invalid-input'})
 await assert.rejects(runtime.history(owner,{projectId:foreign.id,cursor:first.nextCursor,limit:100}),{code:'teloa/not-found'})
 assert.deepEqual(await runtime.history(owner,{projectId:own.id,limit:1}),first)
})
