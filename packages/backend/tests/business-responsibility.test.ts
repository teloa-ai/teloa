import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Pool,type PoolClient} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import * as api from '../src/index.ts'
import {BusinessDefinitionSourceReader} from '../src/work/business-definition-source.ts'
import {lockBusinessConfiguration} from '../src/work/business-configuration-lock.ts'
let pool:Pool,container:StartedPostgreSqlContainer
const identity={id:randomUUID,now:()=>new Date().toISOString()}
const unavailable=async():Promise<never>=>{throw Error('不得访问远端')}
before(async()=>{
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri(),statement_timeout:5000,connectionTimeoutMillis:2000})
 await api.initializeRoles(pool);await api.initializeBusinessSpaces(pool);await api.initializeBusinessDefinitions(pool);await api.initializeBusinessConfigurations(pool);await api.initializeBusinessRuntime(pool);await api.initializeBusinessData(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})
async function fixture(){
 assert.equal(typeof api.BusinessResponsibilityService,'function','须提供真实负责人服务')
 await api.initializeBusinessResponsibilities(pool)
 const drafts=new api.BusinessConfigurationDraftService(pool,identity),store=new api.BusinessConfigurationStore(pool)
 const definitions=new BusinessDefinitionSourceReader({get:unavailable,getInTransaction:unavailable},{get:unavailable,getInTransaction:unavailable,listInTransaction:async()=>({items:[],hasMore:false})},{activeSourceIds:unavailable},undefined,store)
 const runtime=new api.BusinessRuntimeService(pool,identity),spaces=new api.BusinessSpaceService(pool,identity)
 const apply=new api.BusinessConfigurationService(pool,identity,{drafts,store,definitions,runtime,spaces}),preview=new api.BusinessConfigurationPreviewService(pool,drafts,definitions,identity)
 const actor={ownerId:randomUUID(),scopeIds:[] as string[]}
 let draft=await drafts.begin(actor,{requestId:randomUUID(),title:'负责人业务'})
 draft=await drafts.revise(actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:1,patch:{upsertDefinitions:[{kind:'object-type',definition:{format:'teloa.business-object-type/v1',id:'customer',version:'1.0.0',domain:draft.scope,title:'客户',unit:'条',lead:'客户',sourceId:draft.candidate.sources[0]!.sourceId,fields:[{name:'name',label:'名称',from:'名称',type:'text',required:true}]}}],upsertPages:[{id:'home',title:'客户',kind:'records',objectType:'customer',fields:['name'],allowCreate:true,allowEdit:true,allowArchive:true}],homePageId:'home'}})
 await apply.apply(actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:draft.revision,expectedBaseVersion:0,previewReceipt:(await preview.preview(actor,{draftId:draft.id,expectedRevision:draft.revision})).receipt})
 const scope=draft.scope;actor.scopeIds=[scope]
 const roles=new api.RoleService(pool,identity),fields={name:'负责人',kind:'employee' as const,scopes:[scope],duty:'处理本业务',dataScope:'授权数据',executionScope:'批准动作',skills:[],knowledge:[],responsibility:{triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]}}
 const role=await roles.create(actor.ownerId,{requestId:randomUUID(),fields})
 const service=new api.BusinessResponsibilityService(pool),input={requestId:randomUUID(),scope,expectedVersion:0,role:{id:role.id,expectedVersion:role.version}}
 return {actor,scope,service,input,role,roles,fields,drafts,apply,preview}
}
const noSelection=(scope:string)=>({scope,version:0,roleId:null,selectedRoleVersion:null,availability:'none',currentRoleVersion:null})
async function counts(owner:string){return (await pool.query('select (select count(*)::int from teloa_business_responsibilities where owner_id=$1) heads,(select count(*)::int from teloa_business_responsibility_requests where owner_id=$1) receipts',[owner])).rows[0]}
async function blockedBy(client:PoolClient){
 const pid=(await client.query('select pg_backend_pid() pid')).rows[0].pid,deadline=Date.now()+4000
 while(Date.now()<deadline){if((await pool.query('select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))',[pid])).rowCount)return;await new Promise<void>(resolve=>setImmediate(resolve))}
 throw Error('未观察到真实PG锁等待')
}
test('可选负责人从零设置/清空，固定回执跨实例恢复且不更改岗位或配置',{timeout:20000},async()=>{
 const f=await fixture();assert.deepEqual(await f.service.read(f.actor,{scope:f.scope}),noSelection(f.scope))
 const first=await f.service.set(f.actor,f.input)
 assert.deepEqual(first,{scope:f.scope,version:1,roleId:f.role.id,selectedRoleVersion:1,availability:'ready',currentRoleVersion:1})
 const clear={...f.input,requestId:randomUUID(),expectedVersion:1,role:null},second=await f.service.set(f.actor,clear)
 assert.deepEqual(second,{...noSelection(f.scope),version:2})
 assert.deepEqual(await new api.BusinessResponsibilityService(pool).set(f.actor,f.input),first)
 assert.deepEqual(await f.service.read(f.actor,{scope:f.scope}),second)
 await assert.rejects(f.service.set(f.actor,{...f.input,role:null}),{code:'teloa/conflict'})
 assert.deepEqual(await counts(f.actor.ownerId),{heads:1,receipts:2})
 assert.equal((await f.roles.list(f.actor.ownerId,{}))[0]!.version,1)
 assert.equal((await f.apply.current(f.actor,{scope:f.scope}))!.version,1)
 const other=await fixture();assert.deepEqual(await other.service.set(other.actor,{...other.input,role:null}),{...noSelection(other.scope),version:1})
})
test('同请求并发只存一次，两个不同请求CAS竞争恰一个成功',{timeout:20000},async()=>{
 const f=await fixture(),same=await Promise.all([f.service.set(f.actor,f.input),f.service.set(f.actor,f.input)])
 assert.deepEqual(same[0],same[1]);assert.deepEqual(await counts(f.actor.ownerId),{heads:1,receipts:1})
 const db=await pool.connect();await db.query('begin');await db.query('select * from teloa_business_responsibilities where owner_id=$1 and scope_id=$2 for update',[f.actor.ownerId,f.scope])
 const pending=Promise.allSettled([1,2].map(()=>f.service.set(f.actor,{...f.input,requestId:randomUUID(),expectedVersion:1,role:null})))
 try{await blockedBy(db)}finally{await db.query('commit');db.release()}
 const results=await pending;assert.equal(results.filter(v=>v.status==='fulfilled').length,1);assert.equal(results.filter(v=>v.status==='rejected'&&v.reason.code==='teloa/version-conflict').length,1)
 assert.deepEqual(await counts(f.actor.ownerId),{heads:1,receipts:2})
})
test('未采用、跨本人、撤销scope、twin和无权岗位不写入，旧回执也先查当前授权',{timeout:20000},async()=>{
 const f=await fixture()
 for(const actor of [{...f.actor,scopeIds:[]},{...f.actor,ownerId:randomUUID()},{...f.actor,scopeIds:[f.scope,f.scope]}])await assert.rejects(f.service.set(actor,f.input),{code:'teloa/forbidden'})
 for(const fields of [{...f.fields,kind:'twin' as const},{...f.fields,scopes:['general']}]){
  const r=await f.roles.create(f.actor.ownerId,{requestId:randomUUID(),fields})
  await assert.rejects(f.service.set(f.actor,{...f.input,role:{id:r.id,expectedVersion:1}}),{code:'teloa/forbidden'})
 }
 await assert.rejects(f.service.set(f.actor,{...f.input,role:{id:f.role.id,expectedVersion:2}}),{code:'teloa/version-conflict'})
 const draft=await f.drafts.begin(f.actor,{requestId:randomUUID(),title:'未采用'})
 await assert.rejects(f.service.set({...f.actor,scopeIds:[draft.scope]},{...f.input,scope:draft.scope}))
 assert.deepEqual(await counts(f.actor.ownerId),{heads:0,receipts:0})
 await f.service.set(f.actor,f.input)
 await assert.rejects(f.service.set({...f.actor,scopeIds:[]},f.input),{code:'teloa/forbidden'})
 await assert.rejects(f.service.read({...f.actor,scopeIds:[]},{scope:f.scope}),{code:'teloa/forbidden'})
})
test('暂停退役撤权或移除仍保留负责人身份，旧回执固定且新请求不可选择失效角色',{timeout:20000},async()=>{
 const f=await fixture(),first=await f.service.set(f.actor,f.input)
 for(const state of ['paused','retired']){
  await pool.query('update teloa_roles set state=$2,version=version+1 where id=$1',[f.role.id,state])
  const value=await f.service.read(f.actor,{scope:f.scope});assert.equal(value.roleId,f.role.id);assert.equal(value.selectedRoleVersion,1);assert.equal(value.availability,state)
  await assert.rejects(f.service.set(f.actor,{...f.input,requestId:randomUUID(),expectedVersion:1,role:{id:f.role.id,expectedVersion:value.currentRoleVersion!}}),{code:'teloa/conflict'})
 }
 await pool.query("update teloa_roles set state='active',definition=$2::jsonb,version=version+1 where id=$1",[f.role.id,JSON.stringify({...f.fields,scopes:['general']})])
 assert.equal((await f.service.read(f.actor,{scope:f.scope})).availability,'forbidden')
 await pool.query('delete from teloa_role_edits where role_id=$1',[f.role.id]);await pool.query('delete from teloa_roles where id=$1',[f.role.id])
 assert.deepEqual(await f.service.read(f.actor,{scope:f.scope}),{...first,availability:'missing',currentRoleVersion:null})
 assert.deepEqual(await f.service.set(f.actor,f.input),first)
})
test('等待岗位行锁后重验撤权，事务失败不留负责人或回执',{timeout:20000},async()=>{
 const f=await fixture(),db=await pool.connect();await db.query('begin')
 await db.query('update teloa_roles set definition=$2::jsonb,version=version+1 where id=$1',[f.role.id,JSON.stringify({...f.fields,scopes:['general']})])
 const pending=Promise.allSettled([f.service.set(f.actor,f.input)])
 try{await blockedBy(db)}finally{await db.query('commit');db.release()}
 const [result]=await pending;assert.equal(result!.status,'rejected');assert.ok(result!.status==='rejected'&&['teloa/forbidden','teloa/version-conflict'].includes(result!.reason.code))
 assert.deepEqual(await counts(f.actor.ownerId),{heads:0,receipts:0})
})
test('配置锁串行重验且重新采用旧布局不会回退负责人',{timeout:20000},async()=>{
 const f=await fixture(),db=await pool.connect();await db.query('begin');await lockBusinessConfiguration(db,f.actor.ownerId,f.scope)
 const pending=f.service.set(f.actor,f.input)
 try{await blockedBy(db)}finally{await db.query('commit');db.release()}
 await pending
 for(const title of ['新布局','负责人业务']){
  let draft=await f.drafts.begin(f.actor,{requestId:randomUUID(),scope:f.scope,title})
  draft=await f.drafts.revise(f.actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:draft.revision,patch:{title}})
  await f.apply.apply(f.actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:draft.revision,expectedBaseVersion:draft.baseVersion,previewReceipt:(await f.preview.preview(f.actor,{draftId:draft.id,expectedRevision:draft.revision})).receipt})
 }
 assert.equal((await f.apply.current(f.actor,{scope:f.scope}))!.version,3)
 assert.equal((await f.service.read(f.actor,{scope:f.scope})).roleId,f.role.id)
})
test('max=1读写与同PoolClient读取不自等，池耗尽按deadline失败后恢复且无半写',{timeout:20000},async()=>{
 const f=await fixture(),single=new Pool({connectionString:container.getConnectionUri(),max:1,connectionTimeoutMillis:150,statement_timeout:2000})
 try{
  const service=new api.BusinessResponsibilityService(single)
  const first=await service.set(f.actor,f.input);assert.deepEqual(await service.read(f.actor,{scope:f.scope}),first)
  const db=await single.connect()
  try{
   await db.query('begin');assert.deepEqual(await service.readInTransaction(db,f.actor,{scope:f.scope}),first)
   const started=Date.now();await assert.rejects(service.set(f.actor,{...f.input,requestId:randomUUID(),expectedVersion:1,role:null}),/timeout/);assert.ok(Date.now()-started<1500)
   await db.query('rollback')
  }finally{db.release()}
  assert.deepEqual(await counts(f.actor.ownerId),{heads:1,receipts:1})
  assert.equal((await service.set(f.actor,{...f.input,requestId:randomUUID(),expectedVersion:1,role:null})).version,2)
 }finally{await single.end()}
})
test('存储负责人/回执不一致显式拒绝，不能把损坏解释为未设置',{timeout:20000},async()=>{
 const f=await fixture();await f.service.set(f.actor,f.input)
 await pool.query("update teloa_business_responsibility_requests set result=jsonb_set(result,'{scope}','\"other\"') where owner_id=$1",[f.actor.ownerId])
 await assert.rejects(f.service.set(f.actor,f.input),{code:'teloa/storage-corrupt'})
 await pool.query('update teloa_business_responsibilities set selected_role_version=99 where owner_id=$1',[f.actor.ownerId])
 await assert.rejects(f.service.read(f.actor,{scope:f.scope}),{code:'teloa/storage-corrupt'})
})

test('完整原请求只读回执：无行显式null、旧选择跨变化恢复、spec漂移与当前撤权拒绝',{timeout:20000},async()=>{
 const f=await fixture()
 const state=async()=>{const result=await pool.query("select md5(coalesce(jsonb_agg(to_jsonb(t) order by request_id)::text,'')) digest from teloa_business_responsibility_requests t where owner_id=$1",[f.actor.ownerId]);return {counts:await counts(f.actor.ownerId),digest:result.rows[0].digest,current:await f.service.read(f.actor,{scope:f.scope})}}
 const before=await state();assert.equal(await f.service.receipt(f.actor,f.input),null);assert.deepEqual(await state(),before)
 const first=await f.service.set(f.actor,f.input)
 await f.service.set(f.actor,{...f.input,requestId:randomUUID(),expectedVersion:1,role:null})
 await pool.query("update teloa_roles set state='paused',version=version+1 where id=$1",[f.role.id])
 const changed=await state()
 assert.deepEqual(await new api.BusinessResponsibilityService(pool).receipt(f.actor,f.input),first)
 assert.deepEqual(await state(),changed,'旧回执不恢复负责人或岗位、也不改回执正文')
 for(const input of [{...f.input,role:null},{...f.input,expectedVersion:1},{...f.input,role:{id:f.role.id,expectedVersion:2}}])await assert.rejects(f.service.receipt(f.actor,input),{code:'teloa/conflict'})
 await assert.rejects(f.service.receipt({...f.actor,scopeIds:[]},f.input),{code:'teloa/forbidden'})
 await assert.rejects(f.service.receipt({...f.actor,ownerId:randomUUID()},f.input),{code:'teloa/forbidden'})
 await assert.rejects(f.service.receipt(f.actor,{requestId:f.input.requestId} as never),{code:'teloa/invalid-input'})
 assert.deepEqual(await state(),changed)
 await pool.query("update teloa_business_responsibility_requests set result=jsonb_set(result,'{version}','999') where owner_id=$1 and request_id=$2",[f.actor.ownerId,f.input.requestId])
 await assert.rejects(f.service.receipt(f.actor,f.input),{code:'teloa/storage-corrupt'})
})
test('只读回执使用max1并等待原事务，受理未知后核对原结果恰一选择/回执',{timeout:20000},async()=>{
 const f=await fixture(),single=new Pool({connectionString:container.getConnectionUri(),max:1,connectionTimeoutMillis:150,statement_timeout:2000})
 try{
  const service=new api.BusinessResponsibilityService(single),before=await counts(f.actor.ownerId)
  assert.equal(await service.receipt(f.actor,f.input),null);assert.deepEqual(await counts(f.actor.ownerId),before)
  const result=await service.set(f.actor,f.input);assert.deepEqual(await service.receipt(f.actor,f.input),result)
  assert.deepEqual(await counts(f.actor.ownerId),{heads:1,receipts:1})
  const db=await single.connect();try{const started=Date.now();await assert.rejects(service.receipt(f.actor,f.input),/timeout/);assert.ok(Date.now()-started<1500)}finally{db.release()}
  assert.deepEqual(await service.receipt(f.actor,f.input),result)
 }finally{await single.end()}
 const db=await pool.connect();await db.query('begin')
 await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa.business-responsibility-request',f.actor.ownerId,f.input.requestId])])
 const pending=f.service.receipt(f.actor,f.input)
 try{await blockedBy(db)}finally{await db.query('commit');db.release()}
 assert.equal((await pending)?.roleId,f.role.id)
})
