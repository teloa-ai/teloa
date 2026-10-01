import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {RoleService,initializeRoles} from '../src/work/roles.ts'
import {ConversationWorkService,initializeConversationWork,workRequestChildId} from '../src/work/conversation-work.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import {WorkError} from '@teloa/contract'

let container:StartedPostgreSqlContainer,pool:Pool,dispatchLocks:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()}
before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});dispatchLocks=new Pool({connectionString:container.getConnectionUri(),max:2,connectionTimeoutMillis:1000,statement_timeout:3000});await initializeRoles(pool);await initializeConversationWork(pool)})
after(async()=>{await dispatchLocks?.end();await pool?.end();await container?.stop()})
async function fixture(){
 const owner=randomUUID(),sessionId='work-'+randomUUID(),submitted=new Set<string>()
 const service=new ConversationWorkService(pool,identity.now,async(actor,id)=>{if(actor!==owner||!id.startsWith('work-'))throw Error('private');return {ownerId:owner,sessionId:id,status:'ready',submitted:submitted.has(id)}},undefined,async()=>['general','SOC','AppSec'],dispatchLocks)
 const role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'调查同事',kind:'employee',scopes:['SOC'],duty:'调查',dataScope:'资料',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 return {owner,sessionId,service,role,submitted}
}
test('上下文在首次发送前按版本保存；原请求可核对，发送后拒绝改业务或负责人',async()=>{
 const {owner,sessionId,service,role,submitted}=await fixture(),input={requestId:randomUUID(),sessionId,scopeId:'SOC',roleId:role.id,expectedVersion:0}
 assert.equal(await service.context(owner,{sessionId}),null)
 const [a,b]=await Promise.all([service.setContext(owner,input),service.setContext(owner,input)])
 assert.deepEqual(a,b);assert.equal(a.version,1);assert.equal(a.roleId,role.id)
 submitted.add(sessionId)
 assert.equal((await service.context(owner,{sessionId}))?.locked,true)
 assert.deepEqual(await service.setContext(owner,input),{...a,locked:true})
 await assert.rejects(service.setContext(owner,{...input,requestId:randomUUID(),expectedVersion:1,scopeId:'general',roleId:null}),{code:'teloa/conflict'})
 await assert.rejects(service.setContext(owner,{...input,scopeId:'general'}),{code:'teloa/conflict'})
 await assert.rejects(service.context('other',{sessionId}),{code:'teloa/host-unavailable'})
})
test('同一消息交办固定输入；目录快照保留暂停同事，停止持久化且不改变原目标',async()=>{
 const {owner,sessionId,service,role}=await fixture(),input={requestId:randomUUID(),sessionId,messageId:'message-a',messageSeq:2,kind:'report' as const,scope:'SOC',title:'重新汇报',goal:'汇报进展',expectedReportTargets:[{roleId:role.id,roleVersion:role.version,name:role.name,scope:'SOC',unavailable:'paused' as const}]}
 await pool.query("update teloa_roles set state='paused' where id=$1",[role.id])
 const [a,b]=await Promise.all([service.reserve(owner,input),service.reserve(owner,input)])
 assert.deepEqual(a,b);assert.equal(a.targets.length,1);assert.equal(a.targets[0]?.unavailable,'paused')
 await pool.query("update teloa_roles set state='active',version=2 where id=$1",[role.id])
 assert.deepEqual(await service.reserve(owner,input),a)
 await assert.rejects(service.reserve(owner,{...input,goal:'另一个要求'}),{code:'teloa/conflict'})
 const stopped=await service.stop(owner,{sessionId,requestId:input.requestId})
 assert.ok(stopped.stoppedAt)
 assert.deepEqual((await service.reserve(owner,input)).targets,a.targets)
 assert.equal((await service.get(owner,{sessionId,requestId:input.requestId}))?.stoppedAt,stopped.stoppedAt)
 assert.equal((await service.list(owner,{sessionId})).length,1)
 await assert.rejects(service.get(owner,{sessionId:'work-other',requestId:input.requestId}),{code:'teloa/forbidden'})
 assert.equal(workRequestChildId(input.requestId,'task',role.id),workRequestChildId(input.requestId,'task',role.id))
 assert.notEqual(workRequestChildId(input.requestId,'task',role.id),workRequestChildId(input.requestId,'run',role.id))
})
test('明确选择负责人是服务端约束；暂停与范围不匹配在预约前失败',async()=>{
 const {owner,sessionId,service,role}=await fixture()
 await service.setContext(owner,{requestId:randomUUID(),sessionId,scopeId:'SOC',roleId:role.id,expectedVersion:0})
 const input={requestId:randomUUID(),sessionId,messageId:'message-b',messageSeq:2,kind:'task' as const,scope:'SOC',title:'调查',goal:'调查已确定事件',roleId:role.id,expectedRoleVersion:1}
 await assert.rejects(service.reserve(owner,{...input,scope:'general'}),{code:'teloa/conflict'})
 await pool.query("update teloa_roles set state='paused' where id=$1",[role.id])
 await assert.rejects(service.reserve(owner,input),{code:'teloa/conflict'})
 assert.equal(await service.get(owner,{sessionId,requestId:input.requestId}),null)
 await pool.query("update teloa_roles set state='active' where id=$1",[role.id])
 const reserved=await service.reserve(owner,input)
 assert.equal(reserved.targets[0]?.roleId,role.id)
 assert.equal((await service.context(owner,{sessionId}))?.locked,true)
})
test('通用工作不等于全部业务；SOC会话内明确跨业务仅改变协调请求，不改原上下文',async()=>{
 const {owner,sessionId,service,role}=await fixture()
 const general=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'通用同事',kind:'employee',scopes:['general'],duty:'通用',dataScope:'资料',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 const plain=await service.reserve(owner,{requestId:randomUUID(),sessionId:'work-general',messageId:'general',messageSeq:1,kind:'report',scope:'general',title:'通用汇报',goal:'重新汇报',expectedReportTargets:[{roleId:general.id,roleVersion:general.version,name:general.name,scope:'general',unavailable:null}]})
 assert.deepEqual(plain.targets.map(t=>t.roleId),[general.id])
 await service.setContext(owner,{requestId:randomUUID(),sessionId,scopeId:'SOC',roleId:null,expectedVersion:0})
 await service.freeze(owner,{sessionId})
 const all=await service.reserve(owner,{requestId:randomUUID(),sessionId,messageId:'all',messageSeq:1,kind:'report',scope:'general',allBusinesses:true,title:'全部业务汇报',goal:'请全部业务同事汇报',expectedReportTargets:[role,general].map(r=>({roleId:r.id,roleVersion:r.version,name:r.name,scope:r.scopes[0],unavailable:null}))})
 assert.deepEqual(new Set(all.targets.map(t=>t.roleId)),new Set([role.id,general.id]))
 assert.equal(all.targets.find(t=>t.roleId===role.id)?.scope,'SOC')
 assert.equal((await service.context(owner,{sessionId}))?.scopeId,'SOC')
})
test('真实请求锁让停止落盘后下一成员看见停止；待通知目录不被前100项截断',async()=>{
 const {owner,sessionId,service,role}=await fixture(),input={requestId:randomUUID(),sessionId,messageId:'stop',messageSeq:1,kind:'report',scope:'SOC',title:'汇报',goal:'汇报',expectedReportTargets:[{roleId:role.id,roleVersion:role.version,name:role.name,scope:'SOC',unavailable:null}]}
 await service.reserve(owner,input)
 let release!:()=>void,entered!:()=>void
 const held=new Promise<void>(resolve=>{entered=resolve}),gate=new Promise<void>(resolve=>{release=resolve})
 const dispatch=service.withDispatchLock(owner,input.requestId,async()=>{entered();await gate})
 await held
 const stopping=service.stop(owner,{sessionId,requestId:input.requestId})
 const deadline=Date.now()+3000
 while(!(await pool.query("select 1 from pg_stat_activity where wait_event_type='Lock' and query like 'select pg_advisory_lock%'" )).rowCount){assert.ok(Date.now()<deadline);await new Promise(r=>setTimeout(r,10))}
 release();await dispatch;await stopping
 await service.withDispatchLock(owner,input.requestId,async()=>assert.ok((await service.get(owner,{sessionId,requestId:input.requestId}))?.stoppedAt))
 for(let n=0;n<101;n++)await service.reserve(owner,{...input,requestId:randomUUID(),messageId:'new-'+n})
 assert.equal((await service.pendingNotifications(owner)).length,102)
})

test('大写 UUID 停止与原派发共用同一 D 锁并返回规范化身份',async()=>{
 const {owner,sessionId,service:reserved,role}=await fixture(),requestId=randomUUID(),input={requestId,sessionId,messageId:'case-stop',messageSeq:1,kind:'task' as const,scope:'SOC',title:'核对',goal:'核对',roleId:role.id,expectedRoleVersion:role.version},tag='case-stop-'+randomUUID(),locks=new Pool({connectionString:container.getConnectionUri(),max:2,application_name:tag,connectionTimeoutMillis:1000,statement_timeout:3000})
 await reserved.reserve(owner,input)
 const service=new ConversationWorkService(pool,identity.now,async(_owner,id)=>({ownerId:owner,sessionId:id,status:'ready',submitted:false}),undefined,undefined,locks)
 let entered!:()=>void,release!:()=>void
 const held=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve)
 const dispatch=service.withDispatchLock(owner,requestId,async()=>{entered();await gate})
 await held
 const uppercase=requestId.toUpperCase(),stopping=service.stop(owner,{sessionId,requestId:uppercase})
 try{
  const deadline=Date.now()+1000
  while(!(await pool.query("select 1 from pg_stat_activity where application_name=$1 and wait_event_type='Lock' and query like 'select pg_advisory_lock%'",[tag])).rowCount){assert.ok(Date.now()<deadline,'大写身份必须等待同一派发锁');await new Promise(resolve=>setTimeout(resolve,10))}
  assert.equal((await service.get(owner,{sessionId,requestId}))?.stoppedAt,null)
 }finally{release();await dispatch;try{await stopping}finally{await locks.end()}}
 const stopped=await stopping
 assert.equal(stopped.requestId,requestId)
 assert.ok(stopped.stoppedAt)
})

async function managedFixture(){
 const api=await import('../src/index.ts')
 await api.initializeBusinessSpaces(pool);await api.initializeBusinessDefinitions(pool);await api.initializeBusinessConfigurations(pool);await api.initializeBusinessRuntime(pool);await api.initializeBusinessData(pool);await api.initializeBusinessResponsibilities(pool)
 const {BusinessDefinitionSourceReader}=await import('../src/work/business-definition-source.ts'),unavailable=async():Promise<never>=>{throw Error('不得访问远端')}
 const actor={ownerId:randomUUID(),scopeIds:[] as string[]},drafts=new api.BusinessConfigurationDraftService(pool,identity),store=new api.BusinessConfigurationStore(pool)
 const definitions=new BusinessDefinitionSourceReader({get:unavailable,getInTransaction:unavailable},{get:unavailable,getInTransaction:unavailable,listInTransaction:async()=>({items:[],hasMore:false})},{activeSourceIds:unavailable},undefined,store)
 const runtime=new api.BusinessRuntimeService(pool,identity),spaces=new api.BusinessSpaceService(pool,identity),apply=new api.BusinessConfigurationService(pool,identity,{drafts,store,definitions,runtime,spaces}),preview=new api.BusinessConfigurationPreviewService(pool,drafts,definitions,identity)
 let draft=await drafts.begin(actor,{requestId:randomUUID(),title:'日常业务'})
 draft=await drafts.revise(actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:1,patch:{upsertDefinitions:[{kind:'object-type',definition:{format:'teloa.business-object-type/v1',id:'customer',version:'1.0.0',domain:draft.scope,title:'客户',unit:'条',lead:'客户',sourceId:draft.candidate.sources[0]!.sourceId,fields:[{name:'name',label:'名称',from:'名称',type:'text',required:true}]}}],upsertPages:[{id:'home',title:'客户',kind:'records',objectType:'customer',fields:['name'],allowCreate:true,allowEdit:true,allowArchive:true}],homePageId:'home'}})
 await apply.apply(actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:draft.revision,expectedBaseVersion:0,previewReceipt:(await preview.preview(actor,{draftId:draft.id,expectedRevision:draft.revision})).receipt})
 const scope=draft.scope;actor.scopeIds=[scope]
 const roles=new api.RoleService(pool,identity),fields={name:'业务同事',kind:'employee' as const,scopes:[scope],duty:'跟进',dataScope:'资料',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility}
 const first=await roles.create(actor.ownerId,{requestId:randomUUID(),fields}),other=await roles.create(actor.ownerId,{requestId:randomUUID(),fields:{...fields,name:'明确另选'}})
 const sessionId='work-'+randomUUID(),inspect=async(owner:string,id:string)=>({ownerId:owner,sessionId:id,status:'ready',submitted:true})
 let allowed=true
 const guard=async()=>async()=>{if(!allowed)throw new WorkError('teloa/forbidden','已撤权')}
 const service=new ConversationWorkService(pool,identity.now,inspect,guard),responsibilities=new api.BusinessResponsibilityService(pool)
 const selected=await responsibilities.set(actor,{requestId:randomUUID(),scope,expectedVersion:0,role:{id:first.id,expectedVersion:1}})
 const input={requestId:randomUUID(),sessionId,messageId:'本人消息',messageSeq:2,kind:'task' as const,scope,title:'跟进客户',goal:'整理跟进建议',roleId:first.id,expectedRoleVersion:1,responsibility:{version:selected.version,roleId:selected.roleId}}
 return {actor,scope,service,responsibilities,selected,first,other,input,inspect,guard,revoke:()=>{allowed=false}}
}
test('已采用业务首次reserve必须固定当前负责人，显式另选不改变持久负责人',{timeout:20000},async()=>{
 const f=await managedFixture(),{responsibility:_,...missing}=f.input
 await assert.rejects(f.service.reserve(f.actor.ownerId,missing),{code:'teloa/conflict'})
 await assert.rejects(f.service.reserve(f.actor.ownerId,{...f.input,responsibility:{version:0,roleId:null}}),{code:'teloa/version-conflict'})
 const result=await f.service.reserve(f.actor.ownerId,{...f.input,roleId:f.other.id})
 assert.equal(result.targets[0]!.roleId,f.other.id);assert.deepEqual(result.responsibility,f.input.responsibility)
 assert.equal((await f.responsibilities.read(f.actor,{scope:f.scope})).roleId,f.first.id)
 await assert.rejects(f.service.reserve(f.actor.ownerId,{...f.input,roleId:f.other.id,supersedesRequestId:randomUUID()}),{code:'teloa/invalid-input'})
})
test('原reserve回执优先于后续负责人变化但不绕过当前授权或同session规则',{timeout:20000},async()=>{
 const f=await managedFixture(),[first,duplicate]=await Promise.all([f.service.reserve(f.actor.ownerId,f.input),f.service.reserve(f.actor.ownerId,f.input)])
 assert.deepEqual(first,duplicate)
 await f.responsibilities.set(f.actor,{requestId:randomUUID(),scope:f.scope,expectedVersion:1,role:null})
 assert.deepEqual(await f.service.reserve(f.actor.ownerId,f.input),first)
 await assert.rejects(f.service.reserve(f.actor.ownerId,{...f.input,responsibility:{version:2,roleId:null}}),{code:'teloa/conflict'})
 await assert.rejects(f.service.reserve(f.actor.ownerId,{...f.input,messageId:'替换消息'}),{code:'teloa/conflict'})
 await assert.rejects(f.service.get(f.actor.ownerId,{sessionId:'work-other',requestId:f.input.requestId}),{code:'teloa/forbidden'})
 const fresh={...f.input,requestId:randomUUID(),messageId:'未设负责人也可派发',responsibility:{version:2,roleId:null}}
 assert.equal((await f.service.reserve(f.actor.ownerId,fresh)).targets[0]!.roleId,f.first.id)
 f.revoke();await assert.rejects(f.service.reserve(f.actor.ownerId,f.input),{code:'teloa/forbidden'})
})
test('负责人scope锁竞争后核对新版本；岗位撤权后reserve无半条请求',{timeout:20000},async()=>{
 const f=await managedFixture(),db=await pool.connect();await db.query('begin')
 await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa.business-responsibility',f.actor.ownerId,f.scope])])
 const pending=Promise.allSettled([f.service.reserve(f.actor.ownerId,f.input)])
 try{
  const pid=(await db.query('select pg_backend_pid() pid')).rows[0].pid,deadline=Date.now()+4000
  while(!(await pool.query('select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))',[pid])).rowCount){assert.ok(Date.now()<deadline);await new Promise<void>(resolve=>setImmediate(resolve))}
  await db.query('update teloa_business_responsibilities set version=version+1,role_id=null,selected_role_version=null where owner_id=$1 and scope_id=$2',[f.actor.ownerId,f.scope])
 }finally{await db.query('commit');db.release()}
 const [result]=await pending;assert.equal(result!.status,'rejected');assert.ok(result!.status==='rejected'&&result!.reason.code==='teloa/version-conflict')
 assert.equal(await f.service.get(f.actor.ownerId,{sessionId:f.input.sessionId,requestId:f.input.requestId}),null)
 await pool.query("update teloa_roles set state='paused',version=version+1 where id=$1",[f.first.id])
 await assert.rejects(f.service.reserve(f.actor.ownerId,{...f.input,expectedRoleVersion:2,responsibility:{version:2,roleId:null}}),{code:'teloa/conflict'})
})
test('负责人reserve在max=1用同连接完成，耗尽失败后原请求仅保留一条',{timeout:10000},async()=>{
 const f=await managedFixture(),single=new Pool({connectionString:container.getConnectionUri(),max:1,connectionTimeoutMillis:150,statement_timeout:2000})
 try{
  const service=new ConversationWorkService(single,identity.now,f.inspect,f.guard)
  const first=await service.reserve(f.actor.ownerId,f.input);assert.deepEqual(first.responsibility,f.input.responsibility)
  const held=await single.connect()
  try{await assert.rejects(service.reserve(f.actor.ownerId,f.input),/timeout/)}finally{held.release()}
  assert.deepEqual(await service.reserve(f.actor.ownerId,f.input),first)
  assert.equal((await service.list(f.actor.ownerId,{sessionId:f.input.sessionId})).length,1)
 }finally{await single.end()}
})

test('reserve等待负责人锁期间撤销会话授权，取得锁后仍须拒绝且零请求',{timeout:15000},async()=>{
 const f=await managedFixture(),db=await pool.connect();await db.query('begin')
 await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa.business-responsibility',f.actor.ownerId,f.scope])])
 const pending=Promise.allSettled([f.service.reserve(f.actor.ownerId,f.input)])
 try{
  const pid=(await db.query('select pg_backend_pid() pid')).rows[0].pid,deadline=Date.now()+4000
  while(!(await pool.query('select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))',[pid])).rowCount){assert.ok(Date.now()<deadline);await new Promise<void>(resolve=>setImmediate(resolve))}
  f.revoke()
 }finally{await db.query('commit');db.release()}
 const [result]=await pending;assert.ok(result!.status==='rejected'&&result!.reason.code==='teloa/forbidden')
 assert.equal((await pool.query('select count(*)::int n from teloa_conversation_work_requests where owner_id=$1',[f.actor.ownerId])).rows[0].n,0)
})

test('报告批准名单与事务真实目录逐项比对；新增同事前后不得扩大已确认targets',{timeout:20000},async()=>{
 const f=await fixture(),expected=[{roleId:f.role.id,roleVersion:f.role.version,name:f.role.name,scope:'SOC',unavailable:null}]
 const input={requestId:randomUUID(),sessionId:f.sessionId,messageId:'approved-roster',messageSeq:2,kind:'report',scope:'SOC',title:'汇报',goal:'真实进度',expectedReportTargets:expected}
 const first=await f.service.reserve(f.owner,input)
 await new RoleService(pool,identity).create(f.owner,{requestId:randomUUID(),fields:{name:'后来同事',kind:'employee',scopes:['SOC'],duty:'调查',dataScope:'资料',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 assert.deepEqual((await f.service.reserve(f.owner,input)).targets,first.targets)
 const changed={...input,requestId:randomUUID(),messageId:'new-approved-old-roster'}
 await assert.rejects(f.service.reserve(f.owner,changed),{code:'teloa/version-conflict'})
 assert.equal(await f.service.get(f.owner,{sessionId:f.sessionId,requestId:changed.requestId}),null)
 assert.equal((await pool.query('select count(*)::int n from teloa_conversation_work_requests where owner_id=$1',[f.owner])).rows[0].n,1)
})
test('新报告不能缺固定名单；旧无字段回执仍优先重放且不重选名单',{timeout:20000},async()=>{
 const f=await fixture(),input={requestId:randomUUID(),sessionId:f.sessionId,messageId:'legacy',messageSeq:2,kind:'report',scope:'SOC',title:'汇报',goal:'进展'}
 await assert.rejects(f.service.reserve(f.owner,input),{code:'teloa/invalid-input'})
 const targets=[{roleId:f.role.id,roleVersion:1,name:f.role.name,scope:'SOC',unavailable:null}]
 await pool.query('insert into teloa_conversation_work_requests(owner_id,request_id,session_id,request_spec,targets,created_at) values($1,$2,$3,$4,$5,now())',[f.owner,input.requestId,f.sessionId,JSON.stringify(input),JSON.stringify(targets)])
 await pool.query("update teloa_roles set version=2,definition=jsonb_set(definition,'{name}','\"新名称\"'::jsonb) where id=$1",[f.role.id])
 assert.deepEqual((await f.service.reserve(f.owner,input)).targets,targets)
})
test('全部业务报告按事务授权scope固定执行范围，max1拒绝名单删改及授权变化',{timeout:20000},async t=>{
 const f=await fixture(),inspect=async(owner:string,id:string)=>({ownerId:owner,sessionId:id,status:'ready',submitted:true})
 await pool.query("update teloa_roles set definition=jsonb_set(definition,'{scopes}','[\"AppSec\",\"SOC\"]'::jsonb) where id=$1",[f.role.id])
 let allowed=['general','SOC'],reads=0
 const single=new Pool({connectionString:container.getConnectionUri(),max:1,connectionTimeoutMillis:1000});t.after(()=>single.end())
 const service=new ConversationWorkService(single,identity.now,inspect,undefined,async db=>{assert.notEqual(db,single);await db.query('select 1');reads++;return allowed})
 const target={roleId:f.role.id,roleVersion:1,name:f.role.name,scope:'SOC',unavailable:null}
 const input={requestId:randomUUID(),sessionId:f.sessionId,messageId:'all-authorized',messageSeq:2,kind:'report',scope:'general',allBusinesses:true,title:'汇报',goal:'真实进度',expectedReportTargets:[target]}
 assert.deepEqual((await service.reserve(f.owner,input)).targets,[target]);assert.ok(reads>=1)
 for(const targets of [[],[{...target,scope:'AppSec'}],[{...target,name:'伪名字'}],[{...target,roleVersion:2}],[{...target,unavailable:'paused'}]]){
  const value={...input,requestId:randomUUID(),expectedReportTargets:targets};await assert.rejects(service.reserve(f.owner,value),{code:'teloa/version-conflict'});assert.equal(await service.get(f.owner,{sessionId:f.sessionId,requestId:value.requestId}),null)
 }
 allowed=['general']
 const revoked={...input,requestId:randomUUID()};await assert.rejects(service.reserve(f.owner,revoked),{code:'teloa/version-conflict'});assert.equal(await service.get(f.owner,{sessionId:f.sessionId,requestId:revoked.requestId}),null)
 const malformed={...input,requestId:randomUUID(),expectedReportTargets:[target,target]};await assert.rejects(service.reserve(f.owner,malformed),{code:'teloa/invalid-input'})
 await assert.rejects(service.reserve(f.owner,{...input,requestId:randomUUID(),expectedReportTargets:Array(1001).fill(target)}),{code:'teloa/invalid-input'})
})

test('dispatch独立锁域使max1主池内get/stop/回流写入可完成，未装配显式失败',{timeout:10000},async()=>{
 const f=await fixture(),input={requestId:randomUUID(),sessionId:f.sessionId,messageId:'lock-single',messageSeq:1,kind:'task' as const,scope:'SOC',title:'核对',goal:'核对真实资料',roleId:f.role.id,expectedRoleVersion:f.role.version}
 await f.service.reserve(f.owner,input)
 const single=new Pool({connectionString:container.getConnectionUri(),max:1,connectionTimeoutMillis:200,statement_timeout:2000}),locks=new Pool({connectionString:container.getConnectionUri(),max:2,connectionTimeoutMillis:200,statement_timeout:2000})
 const inspect=async(owner:string,sessionId:string)=>({ownerId:owner,sessionId,status:'ready',submitted:true})
 try{
  const service=new ConversationWorkService(single,identity.now,inspect,undefined,undefined,locks)
  await service.withDispatchLock(f.owner,input.requestId,async()=>{assert.equal((await service.get(f.owner,{sessionId:f.sessionId,requestId:input.requestId}))?.requestId,input.requestId);await service.notified(f.owner,input.requestId)})
  const stopped=await service.stop(f.owner,{sessionId:f.sessionId,requestId:input.requestId});assert.ok(stopped.stoppedAt)
  assert.equal((await service.stop(f.owner,{sessionId:f.sessionId,requestId:input.requestId})).stoppedAt,stopped.stoppedAt)
  await assert.rejects(new ConversationWorkService(single,identity.now,inspect).withDispatchLock(f.owner,input.requestId,async()=>{}),{code:'teloa/dependency-unavailable'})
 }finally{await locks.end();await single.end()}
})

test('两个实例同key等待不会占满max2主池；不同key按专用池容量进展',{timeout:10000},async()=>{
 const tag='dispatch-'+randomUUID(),main=new Pool({connectionString:container.getConnectionUri(),max:2,connectionTimeoutMillis:250,statement_timeout:2000,application_name:tag}),locks=new Pool({connectionString:container.getConnectionUri(),max:2,connectionTimeoutMillis:250,statement_timeout:2000,application_name:tag}),owner=randomUUID(),requestId=randomUUID()
 const inspect=async(owner:string,sessionId:string)=>({ownerId:owner,sessionId,status:'ready',submitted:true}),a=new ConversationWorkService(main,identity.now,inspect,undefined,undefined,locks),b=new ConversationWorkService(main,identity.now,inspect,undefined,undefined,locks)
 let release!:()=>void,enter!:()=>void,active=0,maximum=0
 const entered=new Promise<void>(resolve=>enter=resolve),gate=new Promise<void>(resolve=>release=resolve)
 const first=a.withDispatchLock(owner,requestId,async()=>{active++;maximum=Math.max(maximum,active);enter();await gate;try{await main.query('select 1')}finally{active--}})
 await entered
 const second=b.withDispatchLock(owner,requestId,async()=>{active++;maximum=Math.max(maximum,active);try{await main.query('select 1')}finally{active--}}),settled=Promise.allSettled([first,second])
 try{
  const deadline=Date.now()+1500
  while(!(await pool.query("select 1 from pg_stat_activity where application_name=$1 and wait_event_type='Lock' and query like 'select pg_advisory_lock%'",[tag])).rowCount){assert.ok(Date.now()<deadline,'第二实例应真实等待原PG锁');await new Promise<void>(resolve=>setImmediate(resolve))}
  release();const results=await settled;assert.deepEqual(results.map(result=>result.status),['fulfilled','fulfilled']);assert.equal(maximum,1)
  let open!:()=>void,both!:()=>void,count=0;const holding=new Promise<void>(resolve=>open=resolve),reached=new Promise<void>(resolve=>both=resolve)
  const parallel=[a,b].map(service=>service.withDispatchLock(owner,randomUUID(),async()=>{await main.query('select 1');if(++count===2)both();await holding})),done=Promise.allSettled(parallel)
  try{await Promise.race([reached,new Promise((_,reject)=>setTimeout(()=>reject(Error('不同key未按池容量并行')),1000))])}finally{open();await done}
  assert.equal(count,2)
 }finally{release();await settled;await locks.end();await main.end()}
})

test('专用锁连接失效立即中止lockSignal且不能返回成功，回调异常不残留锁',{timeout:10000},async()=>{
 const main=new Pool({connectionString:container.getConnectionUri(),max:1,connectionTimeoutMillis:200,statement_timeout:2000}),locks=new Pool({connectionString:container.getConnectionUri(),max:1,connectionTimeoutMillis:200,statement_timeout:2000}),owner=randomUUID(),requestId=randomUUID()
 let lockPid=0
 const lockPort={connect:async()=>{const db=await locks.connect();lockPid=(await db.query('select pg_backend_pid() pid')).rows[0].pid;return db}}
 const service=new ConversationWorkService(main,identity.now,async(owner,sessionId)=>({ownerId:owner,sessionId,status:'ready',submitted:true}),undefined,undefined,lockPort)
 try{
  await assert.rejects(service.withDispatchLock(owner,requestId,async()=>{throw Error('callback failure')}),/callback failure/)
  await service.withDispatchLock(owner,requestId,async()=>{await main.query('select 1')})
  let successful=false
  await assert.rejects(service.withDispatchLock(owner,requestId,async signal=>{
   assert.ok(signal instanceof AbortSignal)
   const aborted=new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}))
   await pool.query('select pg_terminate_backend($1)',[lockPid]);await aborted
   assert.equal(signal.aborted,true)
   // 即使旧callback忽略abort而返回普通值，服务也不能将失锁的操作当成成功。
   return 'ignored abort'
  }).then(()=>{successful=true}),{code:'teloa/storage-unavailable'})
  assert.equal(successful,false)
  await service.withDispatchLock(owner,requestId,async signal=>{signal.throwIfAborted();await main.query('select 1')})
 }finally{await locks.end();await main.end()}
})
