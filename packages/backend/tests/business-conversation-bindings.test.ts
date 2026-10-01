import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir,tmpdir} from 'node:os'
import {join} from 'node:path'
import {mkdtemp,rm} from 'node:fs/promises'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import * as api from '../src/index.ts'
import {BusinessConfigurationDraftService} from '../src/work/business-configuration-drafts.ts'
import {initializeBusinessConfigurations} from '../src/work/business-configuration-store.ts'
import {ConversationService,FileConversationRepository} from '../src/work/conversations.ts'
import {ConversationWorkService,initializeConversationWork} from '../src/work/conversation-work.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
let pool:Pool,container:StartedPostgreSqlContainer
const paths:string[]=[]
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri(),max:1,connectionTimeoutMillis:3000})
 await api.initializeBusinessSpaces(pool);await api.initializeBusinessScopes(pool);await api.initializeBusinessDefinitions(pool);await initializeBusinessConfigurations(pool);await initializeConversationWork(pool);await api.initializeRoles(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop();for(const p of paths)await rm(p,{recursive:true,force:true})})
const identity={id:randomUUID,now:()=>new Date().toISOString()}
async function fixture(){
 assert.equal(typeof api.BusinessConversationBindingService,'function')
 await api.initializeBusinessConversationBindings(pool)
 const a={ownerId:'binding:'+randomUUID(),scopeIds:[] as string[]},path=await mkdtemp(join(tmpdir(),'teloa-business-bindings-'));paths.push(path)
 const sessions=new Set<string>()
 const repository=new FileConversationRepository(join(path,'conversations.json'))
 const conversations=new ConversationService(repository,{create:async id=>{sessions.add(id);return id},inspect:async id=>{assert.ok(sessions.has(id))}},identity)
 const drafts=new BusinessConfigurationDraftService(pool,identity)
 const contexts=new ConversationWorkService(pool,identity.now,async(owner,sessionId)=>({...await conversations.bySession(owner,sessionId),submitted:false}))
 const make=(ports:ConstructorParameters<typeof api.BusinessConversationBindingService>[2]={drafts,conversations,contexts})=>new api.BusinessConversationBindingService(pool,identity,ports)
 return {a,repository,conversations,drafts,contexts,make}
}
test('reservation_recovers_each_gap_without_new_draft',async()=>{
 const f=await fixture(),input={requestId:randomUUID(),kind:'builder',title:'搭建',workspaceId:'workspace-a'}
 await assert.rejects(f.make({drafts:{...f.drafts,begin:async()=>{throw Error('预约后中断')},get:f.drafts.get.bind(f.drafts)},conversations:f.conversations,contexts:f.contexts}).reserve(f.a,input),/预约后中断/)
 assert.equal((await f.make().byRequest(f.a,{requestId:input.requestId}))?.draftId,undefined)
 await assert.rejects(f.make({drafts:{begin:async(a,i)=>{await f.drafts.begin(a,i);throw Error('begin后中断')},get:f.drafts.get.bind(f.drafts)},conversations:f.conversations,contexts:f.contexts}).reserve(f.a,input),/begin后中断/)
 const [one,two]=await Promise.all([f.make().reserve(f.a,input),f.make().reserve(f.a,input)])
 assert.equal(one.draftId,two.draftId)
 const native=await f.conversations.create(f.a.ownerId,{requestId:input.requestId,title:input.title,workspaceId:input.workspaceId})
 assert.equal(await f.make().isBuilder(f.a.ownerId,native.sessionId),true)
 assert.equal((await f.make().bySession(f.a,{sessionId:native.sessionId}))?.requestId,input.requestId)
 const bound=await f.make().bind(f.a,{requestId:input.requestId,sessionId:native.sessionId})
 assert.deepEqual(await f.make().bind(f.a,{requestId:input.requestId,sessionId:native.sessionId}),bound)
 assert.equal((await pool.query('select count(*)::int n from teloa_business_configuration_drafts where owner_id=$1',[f.a.ownerId])).rows[0].n,1)
 assert.equal((await f.repository.read()).length,1)
 for(const change of [{title:'另一标题'},{workspaceId:'other'},{kind:'daily',scope:'SOC'}])await assert.rejects(f.make().reserve(f.a,{...input,...change}),{code:'teloa/conflict'})
 await assert.rejects(f.make().reserve(f.a,{...input,ownerId:'other'}),{code:'teloa/invalid-input'})
})
test('daily_requires_current_context 与跨本人、撤权、未登记范围',async()=>{
 const f=await fixture();await new api.BusinessSpaceService(pool,identity).ensurePersonal(f.a.ownerId);f.a.scopeIds=['SOC']
 await assert.rejects(f.make().reserve({...f.a,scopeIds:['missing']},{requestId:randomUUID(),kind:'daily',title:'工作',scope:'missing'}),{code:'teloa/forbidden'})
 const input={requestId:randomUUID(),kind:'daily',title:'工作',scope:'SOC'},r=await f.make().reserve(f.a,input)
 assert.equal(r.draftId,undefined)
 const n=await f.conversations.create(f.a.ownerId,{requestId:input.requestId,title:input.title})
 await assert.rejects(f.make().bind(f.a,{requestId:input.requestId,sessionId:n.sessionId}),{code:'teloa/conflict'})
 await f.contexts.setContext(f.a.ownerId,{requestId:randomUUID(),sessionId:n.sessionId,scopeId:'SOC',roleId:null,expectedVersion:0})
 await f.make().bind(f.a,{requestId:input.requestId,sessionId:n.sessionId})
 await assert.rejects(f.make().byRequest({...f.a,scopeIds:[]},{requestId:input.requestId}),{code:'teloa/forbidden'})
 assert.equal(await f.make().byRequest({ownerId:'other',scopeIds:['SOC']},{requestId:input.requestId}),undefined)
 await assert.rejects(f.make().bySession({ownerId:'other',scopeIds:['SOC']},{sessionId:n.sessionId}),{code:'teloa/forbidden'})
 await f.contexts.setContext(f.a.ownerId,{requestId:randomUUID(),sessionId:n.sessionId,scopeId:'general',roleId:null,expectedVersion:1})
 await assert.rejects(f.make().byRequest(f.a,{requestId:input.requestId}),{code:'teloa/conflict'})
})
test('builder_pending_bind_is_not_ordinary；固定会话不可换绑；判定失败显式抛出',async()=>{
 const f=await fixture(),input={requestId:randomUUID(),kind:'builder',title:'搭建'}
 await f.make().reserve(f.a,input)
 const n=await f.conversations.create(f.a.ownerId,{requestId:input.requestId,title:input.title})
 const independent=f.make({drafts:{begin:async()=>{throw Error('不得读取')},get:async()=>{throw Error('不得读取')}},conversations:f.conversations,contexts:{context:async()=>{throw Error('不得读取')}}})
 assert.equal(await independent.isBuilder(f.a.ownerId,n.sessionId),true)
 const plain=await f.conversations.create(f.a.ownerId,{requestId:randomUUID(),title:'普通'})
 assert.equal(await independent.isBuilder(f.a.ownerId,plain.sessionId),false)
 await assert.rejects(f.make().bind(f.a,{requestId:input.requestId,sessionId:plain.sessionId}),{code:'teloa/conflict'})
 await assert.rejects(independent.isBuilder('other',n.sessionId),{code:'teloa/forbidden'})
 await assert.rejects(independent.isBuilder(f.a.ownerId,'unknown'),{code:'teloa/not-bound'})
})
test('恢复列表稳定翻页，cursor绑定本人筛选，保留未ready预约',async()=>{
 const f=await fixture()
 for(let i=0;i<3;i++)await f.make().reserve(f.a,{requestId:randomUUID(),kind:'builder',title:'搭建'+i})
 const first=await f.make().list(f.a,{kind:'builder',limit:2})
 assert.equal(first.items.length,2);assert.ok(first.nextCursor)
 const next=await f.make().list(f.a,{kind:'builder',limit:2,cursor:first.nextCursor})
 assert.equal(next.items.length,1);assert.equal(next.nextCursor,undefined)
 assert.equal(new Set([...first.items,...next.items].map(r=>r.requestId)).size,3)
 await assert.rejects(f.make().list(f.a,{kind:'daily',cursor:first.nextCursor}),{code:'teloa/invalid-input'})
 await assert.rejects(f.make().list({ownerId:'other',scopeIds:[]},{kind:'builder',cursor:first.nextCursor}),{code:'teloa/invalid-input'})
})
test('两次bind竞争只固定原会话，TaskRun与标题工作区不匹配均拒绝',async()=>{
 const f=await fixture(),input={requestId:randomUUID(),kind:'builder',title:'搭建',workspaceId:'expected'}
 await f.make().reserve(f.a,input)
 const wrong=await f.conversations.create(f.a.ownerId,{requestId:input.requestId,title:input.title,workspaceId:'wrong'})
 await assert.rejects(f.make().bind(f.a,{requestId:input.requestId,sessionId:wrong.sessionId}),{code:'teloa/conflict'})
 const second={requestId:randomUUID(),kind:'builder',title:'正确'}
 await f.make().reserve(f.a,second)
 const n=await f.conversations.create(f.a.ownerId,{requestId:second.requestId,title:second.title})
 const results=await Promise.all([f.make().bind(f.a,{requestId:second.requestId,sessionId:n.sessionId}),f.make().bind(f.a,{requestId:second.requestId,sessionId:n.sessionId})])
 assert.deepEqual(results[0],results[1])
 const runInput={requestId:randomUUID(),kind:'builder',title:'任务运行'}
 await f.make().reserve(f.a,runInput)
 const run=await f.conversations.createRun(f.a.ownerId,{requestId:runInput.requestId,title:runInput.title},{sessionId:'task-run-'+randomUUID(),taskId:randomUUID(),taskVersion:1,roleId:randomUUID(),roleVersion:1,agentPresetId:'worker'})
 await assert.rejects(f.make().bind(f.a,{requestId:runInput.requestId,sessionId:run.sessionId}),{code:'teloa/conflict'})
 await assert.rejects(f.make().isBuilder(f.a.ownerId,run.sessionId),{code:'teloa/conflict'})
})
test('已采用新草案先刷新真实scopeIds；调整业务预约沿用正式配置',async()=>{
 const f=await fixture(),input={requestId:randomUUID(),kind:'builder',title:'新业务'},reserved=await f.make().reserve(f.a,input)
 const draft=await f.drafts.get(f.a,{draftId:reserved.draftId}),space=await new api.BusinessSpaceService(pool,identity).ensurePersonal(f.a.ownerId)
 const {businessConfigurationHash}=await import('../src/work/business-configuration-store.ts')
 const {insertBusinessDefinitionVersion}=await import('../src/work/business-definition-write.ts')
 const definition={format:'teloa.business-object-type/v1',id:'ticket',version:'1.0.0',domain:draft.scope,title:'工单',unit:'条',lead:'跟进事项',sourceId:draft.candidate.sources[0]!.sourceId,fields:[{name:'state',label:'状态',type:'text',required:true,from:'状态'}]}
 const page={id:'home',title:'记录',kind:'records',objectType:'ticket',fields:['state'],allowCreate:true,allowEdit:true,allowArchive:true}
 const db=await pool.connect()
 try{
  await db.query('begin')
  await api.BusinessScopeService.ensure(db,f.a.ownerId,{scope:draft.scope,title:'新业务',kind:'domain',spaceId:space.id})
  await db.query('update teloa_business_scopes set configuration_managed=true where owner_id=$1 and scope=$2',[f.a.ownerId,draft.scope])
  const leaf=await insertBusinessDefinitionVersion(db,{ownerId:f.a.ownerId,scope:draft.scope,kind:'object-type',definition,draftId:draft.id,now:identity.now()})
  await db.query("insert into teloa_business_local_definition_heads(owner_id,scope_id,kind,local_id,version,revision,updated_at) values($1,$2,'object-type','ticket',1,1,now())",[f.a.ownerId,draft.scope])
  const manifest={...draft.candidate,definitions:[{kind:'object-type',localId:'ticket',version:leaf.version,definitionHash:leaf.definitionHash}],pages:[page],homePageId:'home'}
  await db.query('insert into teloa_business_configuration_versions(owner_id,scope_id,version,manifest,hash,created_at) values($1,$2,1,$3,$4,now())',[f.a.ownerId,draft.scope,JSON.stringify(manifest),businessConfigurationHash(manifest)])
  await db.query('insert into teloa_business_configuration_heads(owner_id,scope_id,version,updated_at) values($1,$2,1,now())',[f.a.ownerId,draft.scope])
  await db.query("update teloa_business_configuration_drafts set status='applied' where owner_id=$1 and id=$2",[f.a.ownerId,draft.id])
  await db.query('commit')
 }finally{db.release()}
 await assert.rejects(f.make().byRequest(f.a,{requestId:input.requestId}),{code:'teloa/forbidden'})
 f.a.scopeIds=[draft.scope]
 assert.equal((await f.make().byRequest(f.a,{requestId:input.requestId}))?.draftId,draft.id)
 const adjust=await f.make().reserve(f.a,{requestId:randomUUID(),kind:'builder',title:'调整业务',scope:draft.scope})
 assert.equal((await f.drafts.get(f.a,{draftId:adjust.draftId})).baseVersion,1)
 await assert.rejects(f.make().byRequest({...f.a,scopeIds:[]},{requestId:adjust.requestId}),{code:'teloa/forbidden'})
})
test('native就绪但草案尚未写回仍识别builder；依赖错误不能回落false',async()=>{
 const f=await fixture(),input={requestId:randomUUID(),kind:'builder',title:'中断恢复'}
 await assert.rejects(f.make({drafts:{begin:async()=>{throw Error('中断')},get:f.drafts.get.bind(f.drafts)},conversations:f.conversations,contexts:f.contexts}).reserve(f.a,input),/中断/)
 const n=await f.conversations.create(f.a.ownerId,{requestId:input.requestId,title:input.title})
 assert.equal(await f.make().isBuilder(f.a.ownerId,n.sessionId),true)
 await assert.rejects(f.make().bind(f.a,{requestId:input.requestId,sessionId:n.sessionId}),{code:'teloa/conflict'})
 const failed=f.make({drafts:f.drafts,conversations:{bySession:async()=>{throw Error('文件读取故障')}},contexts:f.contexts})
 await assert.rejects(failed.isBuilder(f.a.ownerId,n.sessionId),/文件读取故障/)
})
test('已绑定session不能因原生请求身份丢失退回普通会话',async()=>{
 const f=await fixture(),input={requestId:randomUUID(),kind:'builder',title:'已绑定'}
 await f.make().reserve(f.a,input)
 const n=await f.conversations.create(f.a.ownerId,{requestId:input.requestId,title:input.title})
 await f.make().bind(f.a,{requestId:input.requestId,sessionId:n.sessionId})
 await f.repository.write((await f.repository.read()).map(({requestId,...row})=>row))
 await assert.rejects(f.make().isBuilder(f.a.ownerId,n.sessionId),{code:'teloa/conflict'})
 await assert.rejects(f.make().bySession(f.a,{sessionId:n.sessionId}),{code:'teloa/conflict'})
})

test('recentDaily按可信原生顺序跨过100条绑定；冷读取零context与零存储写入',{timeout:30000},async()=>{
 const f=await fixture();await new api.BusinessSpaceService(pool,identity).ensurePersonal(f.a.ownerId);f.a.scopeIds=['SOC']
 const natives=[]
 for(let i=0;i<102;i++){
  const input={requestId:randomUUID(),kind:'daily',title:'日常'+i,scope:'SOC'}
  await f.make().reserve(f.a,input)
  const n=await f.conversations.create(f.a.ownerId,{requestId:input.requestId,title:input.title});natives.push(n)
  await f.contexts.setContext(f.a.ownerId,{requestId:randomUUID(),sessionId:n.sessionId,scopeId:'SOC',roleId:null,expectedVersion:0})
  await f.make().bind(f.a,{requestId:input.requestId,sessionId:n.sessionId})
 }
 let visible=[natives[0]!,natives[101]!].map(n=>({sessionId:n.sessionId})),lists=0
 const cold=f.make({drafts:f.drafts,conversations:f.conversations,contexts:{context:async()=>{throw Error('冷查询不得激活context')}},visibleSessions:async()=>{lists++;return visible}})
 const before=await pool.query('select * from teloa_business_conversation_bindings where owner_id=$1 order by request_id',[f.a.ownerId]),file=await f.repository.read()
 assert.equal((await cold.recentDaily(f.a,{scope:'SOC'}))?.sessionId,natives[0]!.sessionId)
 visible.reverse();assert.equal((await cold.recentDaily(f.a,{scope:'SOC'}))?.sessionId,natives[101]!.sessionId)
 assert.equal(lists,2);assert.deepEqual((await pool.query('select * from teloa_business_conversation_bindings where owner_id=$1 order by request_id',[f.a.ownerId])).rows,before.rows);assert.deepEqual(await f.repository.read(),file)
 visible=[];assert.equal(await cold.recentDaily(f.a,{scope:'SOC'}),null)
 await assert.rejects(cold.recentDaily({...f.a,scopeIds:[]},{scope:'SOC'}),{code:'teloa/forbidden'})
 await assert.rejects(cold.recentDaily({...f.a,scopeIds:['missing']},{scope:'missing'}),{code:'teloa/forbidden'})
})

test('pending daily优先：原生创建前/context前/context后都保留原预约；全局识别不读context',{timeout:15000},async()=>{
 const f=await fixture();await new api.BusinessSpaceService(pool,identity).ensurePersonal(f.a.ownerId);f.a.scopeIds=['SOC']
 const visible:{sessionId:string;origin?:'subagent'}[]=[],cold=f.make({drafts:f.drafts,conversations:f.conversations,contexts:{context:async()=>{throw Error('pending不可读取context')}},visibleSessions:async()=>visible})
 const input={requestId:randomUUID(),kind:'daily',title:'恢复原预约',scope:'SOC',workspaceId:'work'},r=await cold.reserve(f.a,input)
 assert.deepEqual(await cold.recentDaily(f.a,{scope:'SOC'}),r)
 await cold.reserve(f.a,{...input,requestId:randomUUID(),title:'第二预约'})
 const n=await f.conversations.create(f.a.ownerId,{requestId:input.requestId,title:input.title,workspaceId:input.workspaceId})
 await assert.rejects(cold.recentDaily(f.a,{scope:'SOC'}),{code:'teloa/conflict',details:{reason:'daily-session-unavailable'}})
 visible.push({sessionId:n.sessionId})
 assert.deepEqual(await cold.bySession(f.a,{sessionId:n.sessionId}),r)
 assert.deepEqual(await cold.recentDaily(f.a,{scope:'SOC'}),r)
 await f.contexts.setContext(f.a.ownerId,{requestId:input.requestId,sessionId:n.sessionId,scopeId:'SOC',roleId:null,expectedVersion:0})
 assert.deepEqual(await cold.recentDaily(f.a,{scope:'SOC'}),r)
 visible[0]!.origin='subagent';await assert.rejects(cold.recentDaily(f.a,{scope:'SOC'}),{code:'teloa/conflict'})
})

test('recentDaily的目录失败、取消和当前context冲突都不能返回空或写入',{timeout:15000},async()=>{
 const f=await fixture();await new api.BusinessSpaceService(pool,identity).ensurePersonal(f.a.ownerId);f.a.scopeIds=['SOC']
 const cold=f.make({drafts:f.drafts,conversations:f.conversations,contexts:f.contexts,visibleSessions:async signal=>{signal?.throwIfAborted();throw Error('目录失败')}})
 await assert.rejects(cold.recentDaily(f.a,{scope:'SOC'}),/目录失败/)
 const abort=new AbortController();abort.abort(Error('取消'));await assert.rejects(cold.recentDaily(f.a,{scope:'SOC'},abort.signal),/取消/)
 const input={requestId:randomUUID(),kind:'daily',title:'失效上下文',scope:'SOC'};await f.make().reserve(f.a,input)
 const n=await f.conversations.create(f.a.ownerId,{requestId:input.requestId,title:input.title});await f.contexts.setContext(f.a.ownerId,{requestId:randomUUID(),sessionId:n.sessionId,scopeId:'SOC',roleId:null,expectedVersion:0});await f.make().bind(f.a,{requestId:input.requestId,sessionId:n.sessionId})
 await pool.query('update teloa_conversation_work_contexts set scope_id=$3,locked=true where owner_id=$1 and session_id=$2',[f.a.ownerId,n.sessionId,'general'])
 const service=f.make({drafts:f.drafts,conversations:f.conversations,contexts:{context:async()=>{throw Error('不得激活')}},visibleSessions:async()=>[{sessionId:n.sessionId}]})
 await assert.rejects(service.recentDaily(f.a,{scope:'SOC'}),{code:'teloa/conflict'})
 assert.equal((await pool.query('select scope_id from teloa_conversation_work_contexts where owner_id=$1 and session_id=$2',[f.a.ownerId,n.sessionId])).rows[0].scope_id,'general')
})

test('max1事务守卫：builder拒绝、pending可设置原scope但不能freeze/交办、bound仍固定scope',{timeout:20000},async()=>{
 const f=await fixture();await new api.BusinessSpaceService(pool,identity).ensurePersonal(f.a.ownerId);f.a.scopeIds=['SOC']
 const service=new ConversationWorkService(pool,identity.now,async(owner,sessionId)=>{
  // 原生 inspection 的既有 role/task 查询确实会使用 pool；必须在 checkout 前完成。
  await pool.query('select 1');return {...await f.conversations.bySession(owner,sessionId),submitted:false}
 },(owner,sessionId)=>f.make().prepareWorkGuard(owner,sessionId))
 const create=async(kind:'builder'|'daily')=>{const requestId=randomUUID(),title=kind;await f.make().reserve(f.a,{requestId,kind,title,...(kind==='daily'?{scope:'SOC'}:{})});return f.conversations.create(f.a.ownerId,{requestId,title})}
 const builder=await create('builder'),daily=await create('daily')
 const context=(sessionId:string,scopeId='SOC',roleId:string|null=null,expectedVersion=0)=>({requestId:randomUUID(),sessionId,scopeId,roleId,expectedVersion})
 const work=(sessionId:string)=>({requestId:randomUUID(),sessionId,messageId:'本人',messageSeq:1,kind:'report',scope:'SOC',title:'汇报',goal:'汇报',expectedReportTargets:[]})
 await assert.rejects(service.setContext(f.a.ownerId,context(builder.sessionId)),{code:'teloa/forbidden'})
 await assert.rejects(service.freeze(f.a.ownerId,{sessionId:builder.sessionId}),{code:'teloa/forbidden'})
 await assert.rejects(service.reserve(f.a.ownerId,work(builder.sessionId)),{code:'teloa/forbidden'})
 await assert.rejects(service.setContext(f.a.ownerId,context(daily.sessionId,'general')),{code:'teloa/conflict'})
 await assert.rejects(service.setContext(f.a.ownerId,context(daily.sessionId,'SOC',randomUUID())),{code:'teloa/conflict'})
 assert.equal(await service.context(f.a.ownerId,{sessionId:daily.sessionId}),null)
 const fixed=context(daily.sessionId);assert.equal((await service.setContext(f.a.ownerId,fixed)).scopeId,'SOC')
 await assert.rejects(service.freeze(f.a.ownerId,{sessionId:daily.sessionId}),{code:'teloa/binding-pending'})
 assert.equal((await pool.query('select count(*)::int n from teloa_conversation_work_frozen_sessions where owner_id=$1 and session_id=$2',[f.a.ownerId,daily.sessionId])).rows[0].n,0,'pending拒绝不写冻结事实')
 await assert.rejects(service.reserve(f.a.ownerId,work(daily.sessionId)),{code:'teloa/binding-pending'})
 await f.make().bind(f.a,{requestId:daily.requestId,sessionId:daily.sessionId})
 await assert.rejects(service.setContext(f.a.ownerId,context(daily.sessionId,'general',null,1)),{code:'teloa/conflict'})
 assert.deepEqual(await service.setContext(f.a.ownerId,fixed),{sessionId:daily.sessionId,scopeId:'SOC',roleId:null,version:1,locked:false})
 assert.equal((await service.freeze(f.a.ownerId,{sessionId:daily.sessionId}))?.locked,true)
 assert.equal((await service.setContext(f.a.ownerId,fixed)).locked,true,'已成功请求仍优先恢复冻结后的原回执')
 assert.equal((await pool.query('select count(*)::int n from teloa_conversation_work_frozen_sessions where owner_id=$1 and session_id=$2',[f.a.ownerId,daily.sessionId])).rows[0].n,0,'已有context使用原locked字段')
 assert.equal((await service.reserve(f.a.ownerId,work(daily.sessionId))).scope,'SOC')
 assert.equal((await service.context(f.a.ownerId,{sessionId:daily.sessionId}))?.scopeId,'SOC')
 assert.equal((await pool.query('select count(*)::int n from teloa_conversation_work_contexts where owner_id=$1 and session_id=$2',[f.a.ownerId,builder.sessionId])).rows[0].n,0)
})

test('两个并发事务耗尽max2池时守卫不二次checkout，set与bind竞态保持预约scope',{timeout:20000},async()=>{
 const f=await fixture();await new api.BusinessSpaceService(pool,identity).ensurePersonal(f.a.ownerId);f.a.scopeIds=['SOC']
 const limited=new Pool({connectionString:container.getConnectionUri(),max:2,connectionTimeoutMillis:2000,statement_timeout:3000})
 try{
  const bindings=new api.BusinessConversationBindingService(limited,identity,{drafts:f.drafts,conversations:f.conversations,contexts:f.contexts})
  const guarded=new ConversationWorkService(limited,identity.now,async(owner,sessionId)=>{await limited.query('select 1');return {...await f.conversations.bySession(owner,sessionId),submitted:false}},(owner,sessionId)=>bindings.prepareWorkGuard(owner,sessionId))
  const requestId=randomUUID();await bindings.reserve(f.a,{requestId,kind:'daily',title:'竞态日常',scope:'SOC'})
  const native=await f.conversations.create(f.a.ownerId,{requestId,title:'竞态日常'}),sessionId=native.sessionId
  const fixed={requestId:randomUUID(),sessionId,scopeId:'SOC',roleId:null,expectedVersion:0}
  const two=await Promise.all([guarded.setContext(f.a.ownerId,fixed),guarded.setContext(f.a.ownerId,fixed)])
  assert.deepEqual(two[0],two[1])
  const raced=await Promise.allSettled([bindings.bind(f.a,{requestId,sessionId}),guarded.setContext(f.a.ownerId,{...fixed,requestId:randomUUID(),scopeId:'general',expectedVersion:1})])
  assert.equal(raced[0]!.status,'fulfilled');assert.equal(raced[1]!.status,'rejected')
  assert.equal((await guarded.context(f.a.ownerId,{sessionId}))?.scopeId,'SOC')
  await Promise.all([guarded.freeze(f.a.ownerId,{sessionId}),guarded.freeze(f.a.ownerId,{sessionId})])
 }finally{await limited.end()}
})

test('R1 max1与耗尽max2时，事务和同事create串行队列交错均不靠checkout超时脱困',{timeout:30000},async()=>{
 for(const max of [1,2])for(const operation of ['freeze','bind'] as const){
  const f=await fixture();await new api.BusinessSpaceService(pool,identity).ensurePersonal(f.a.ownerId);f.a.scopeIds=['SOC']
  const role=await new api.RoleService(pool,identity).create(f.a.ownerId,{requestId:randomUUID(),fields:{name:'同事',kind:'employee',scopes:['SOC'],duty:'调查',dataScope:'资料',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
  const fixed={requestId:randomUUID(),kind:'daily',title:'串行交错',scope:'SOC'};await f.make().reserve(f.a,fixed)
  const native=await f.conversations.create(f.a.ownerId,{requestId:fixed.requestId,title:fixed.title})
  await f.contexts.setContext(f.a.ownerId,{requestId:randomUUID(),sessionId:native.sessionId,scopeId:'SOC',roleId:null,expectedVersion:0})
  const limited=new Pool({connectionString:container.getConnectionUri(),max,connectionTimeoutMillis:800,statement_timeout:3000}),admin=new Pool({connectionString:container.getConnectionUri(),max:2})
  const held=await admin.connect(),key=JSON.stringify(['teloa/conversation-work',f.a.ownerId,'context:'+native.sessionId]),fillers=[]
  let roleEntered!:()=>void;const atRole=new Promise<void>(resolve=>roleEntered=resolve)
  const conversations=new ConversationService(f.repository,{create:async id=>id,inspect:async()=>{}},identity,async(owner,roleId)=>{roleEntered();return (await new api.RoleService(limited,identity).list(owner,{})).find(role=>role.id===roleId)})
  const bindings=new api.BusinessConversationBindingService(limited,identity,{drafts:f.drafts,conversations,contexts:f.contexts})
  const work=new ConversationWorkService(limited,identity.now,async(owner,sessionId)=>({...await conversations.bySession(owner,sessionId),submitted:false}),(owner,sessionId)=>bindings.prepareWorkGuard(owner,sessionId))
  try{
   for(let i=1;i<max;i++)fillers.push(await limited.connect())
   await held.query('select pg_advisory_lock(hashtextextended($1,0))',[key])
   const action=(operation==='freeze'?work.freeze(f.a.ownerId,{sessionId:native.sessionId}):bindings.bind(f.a,{requestId:fixed.requestId,sessionId:native.sessionId})).then(value=>({value}),error=>({error}))
   const deadline=Date.now()+2000
   while(!(await admin.query("select 1 from pg_stat_activity where wait_event='advisory' and query like 'select pg_advisory_xact_lock%'")).rowCount){assert.ok(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,5))}
   const creating=conversations.create(f.a.ownerId,{requestId:randomUUID(),title:'并发同事',roleId:role.id}).then(value=>({value}),error=>({error}))
   await atRole;assert.equal(limited.waitingCount,1)
   await held.query('select pg_advisory_unlock(hashtextextended($1,0))',[key])
   const [result,created]=await Promise.all([action,creating])
   assert.ok('value' in created,JSON.stringify({max,operation,error:'error' in created?String(created.error):''}))
   if(operation==='freeze'){assert.ok('error' in result);assert.equal(result.error.code,'teloa/binding-pending')}
   else assert.ok('value' in result)
  }finally{await held.query('select pg_advisory_unlock_all()');held.release();for(const filler of fillers)filler.release();await limited.end();await admin.end()}
 }
})

test('R1 空context消费后保持null：等待checkout期间提交也不能首次设置scope或role',{timeout:15000},async()=>{
 const f=await fixture();await new api.BusinessSpaceService(pool,identity).ensurePersonal(f.a.ownerId)
 const n=await f.conversations.create(f.a.ownerId,{requestId:randomUUID(),title:'未选业务的普通会话'})
 const limited=new Pool({connectionString:container.getConnectionUri(),max:1,connectionTimeoutMillis:2000})
 let submitted=false,inspected!:()=>void
 const work=new ConversationWorkService(limited,identity.now,async(owner,sessionId)=>{const result={...await f.conversations.bySession(owner,sessionId),submitted};inspected?.();return result})
 try{
  assert.equal(await work.freeze(f.a.ownerId,{sessionId:n.sessionId}),null)
  const restarted=new ConversationWorkService(limited,identity.now,async(owner,sessionId)=>({...await f.conversations.bySession(owner,sessionId),submitted:false}))
  assert.equal(await restarted.context(f.a.ownerId,{sessionId:n.sessionId}),null)
  await assert.rejects(restarted.setContext(f.a.ownerId,{requestId:randomUUID(),sessionId:n.sessionId,scopeId:'general',roleId:null,expectedVersion:0}),{code:'teloa/conflict'})
  const held=await limited.connect()
  const snapshot=new Promise<void>(resolve=>inspected=resolve)
  const setting=work.setContext(f.a.ownerId,{requestId:randomUUID(),sessionId:n.sessionId,scopeId:'SOC',roleId:null,expectedVersion:0})
  await snapshot;submitted=true;held.release()
  await assert.rejects(setting,{code:'teloa/conflict'})
  assert.equal(await work.context(f.a.ownerId,{sessionId:n.sessionId}),null)
  await assert.rejects(work.setContext(f.a.ownerId,{requestId:randomUUID(),sessionId:n.sessionId,scopeId:'SOC',roleId:randomUUID(),expectedVersion:0}),{code:'teloa/conflict'})
 }finally{await limited.end()}
})

test('R1 checkout等待期间普通会话adopt为builder或pending daily，锁内拒绝过期身份',{timeout:15000},async()=>{
 for(const kind of ['builder','daily'] as const){
  const f=await fixture();await new api.BusinessSpaceService(pool,identity).ensurePersonal(f.a.ownerId);f.a.scopeIds=['SOC']
  const conversations=new ConversationService(f.repository,{create:async id=>id,inspect:async()=>{}},identity)
  const sessionId=randomUUID();await conversations.ensure(f.a.ownerId,{sessionId})
  const requestId=randomUUID(),title='从目录加入';await f.make().reserve(f.a,{requestId,kind,title,...(kind==='daily'?{scope:'SOC'}:{})})
  const limited=new Pool({connectionString:container.getConnectionUri(),max:1,connectionTimeoutMillis:2000})
  const bindings=new api.BusinessConversationBindingService(limited,identity,{drafts:f.drafts,conversations,contexts:f.contexts})
  let prepared!:()=>void;const ready=new Promise<void>(resolve=>prepared=resolve)
  const work=new ConversationWorkService(limited,identity.now,async(owner,id)=>({...await conversations.bySession(owner,id),submitted:false}),async(owner,id)=>{const guard=await bindings.prepareWorkGuard(owner,id);prepared();return guard})
  const held=await limited.connect();let released=false
  try{
   const setting=work.setContext(f.a.ownerId,{requestId:randomUUID(),sessionId,scopeId:'general',roleId:null,expectedVersion:0})
   await ready;await conversations.adopt(f.a.ownerId,{sessionId,requestId,title});held.release();released=true
   await assert.rejects(setting,{code:kind==='builder'?'teloa/forbidden':'teloa/conflict'})
   assert.equal((await pool.query('select count(*)::int n from teloa_conversation_work_contexts where owner_id=$1 and session_id=$2',[f.a.ownerId,sessionId])).rows[0].n,0)
   await assert.rejects(work.freeze(f.a.ownerId,{sessionId}),{code:kind==='builder'?'teloa/forbidden':'teloa/binding-pending'})
  }finally{if(!released)held.release();await limited.end()}
 }
})
