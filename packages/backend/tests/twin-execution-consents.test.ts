import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {setupRoleWork,loadRoleWorkModule,roleFixture,identity,ownerAuthority} from './role-work-test-fixture.ts'
let env:Awaited<ReturnType<typeof setupRoleWork>>,api:Record<string,any>
before(async()=>{env=await setupRoleWork();api=await loadRoleWorkModule('twin-execution-consents');if(api.initializeTwinExecutionConsents)await api.initializeTwinExecutionConsents(env.pool)})
after(async()=>{await env?.close()})
const service=(authority:any=ownerAuthority)=>{assert.equal(typeof api.TwinExecutionConsentService,'function','需要持久的分身本人执行授权服务');return new api.TwinExecutionConsentService(env.pool,identity,authority)}
test('本人确认固定内容版本，状态记账不失效；并发重放不重复，撤销后旧确认不复活',async()=>{
 const {owner,role,taskId,authorization}=await roleFixture(env.pool),consents=service(),command={requestId:randomUUID(),roleId:role.id,expectedRoleVersion:1,authorization}
 const [a,b]=await Promise.all([consents.confirm(owner,command),consents.confirm(owner,command)])
 assert.deepEqual(a,b);assert.equal(a.version,1);assert.equal(a.state,'active')
 await env.pool.query("update teloa_tasks set state='running',version=version+1 where id=$1",[taskId])
 assert.equal((await consents.confirm(owner,{...command,requestId:randomUUID()})).id,a.id)
 const revoke={requestId:randomUUID(),consentId:a.id,expectedVersion:1}
 assert.equal((await consents.revoke(owner,revoke)).state,'revoked')
 assert.deepEqual(await consents.revoke(owner,revoke),await consents.confirm(owner,command))
 await assert.rejects(consents.confirm(owner,{...command,authorization:{...authorization,taskContentVersion:2}}),{code:'teloa/conflict'})
 assert.equal(Number((await env.pool.query('select count(*) from teloa_twin_execution_consents where role_id=$1',[role.id])).rows[0].count),1)
})
test('本人端口缺失、跨归属、旧角色/内容版本和未知字段不能确认；读取撤销仍可用',async()=>{
 const {owner,role,taskId,authorization}=await roleFixture(env.pool),command={requestId:randomUUID(),roleId:role.id,expectedRoleVersion:1,authorization}
 await assert.rejects(service(null).confirm(owner,command),{code:'teloa/forbidden'})
 await assert.rejects(service().confirm('other',command),{code:'teloa/forbidden'})
 await assert.rejects(service().confirm(owner,{...command,authorId:'self'}),{code:'teloa/invalid-input'})
 await assert.rejects(service().confirm(owner,{...command,authorization:{...authorization,taskVersion:1}}),{code:'teloa/invalid-input'})
 await env.pool.query('update teloa_tasks set content_version=2 where id=$1',[taskId])
 await assert.rejects(service().confirm(owner,command),{code:'teloa/version-conflict'})
 await env.pool.query('update teloa_tasks set content_version=1 where id=$1',[taskId])
 const receipt=await service().confirm(owner,command)
 await env.pool.query('update teloa_roles set version=2 where id=$1',[role.id])
 await assert.rejects(service().confirm(owner,{...command,requestId:randomUUID()}),{code:'teloa/version-conflict'})
 assert.equal((await service(null).get(owner,{roleId:role.id})).length,1)
 assert.equal((await service(null).revoke(owner,{requestId:randomUUID(),consentId:receipt.id,expectedVersion:1})).state,'revoked')
})
test('Task 与确认在同一事务回滚；漏事务和迟到本人授权租约不能写入',async()=>{
 const {owner,role,taskId,authorization}=await roleFixture(env.pool),consents=service(),db=await env.pool.connect(),atomicTaskId=randomUUID()
 try{
  await assert.rejects(consents.confirmInTransaction(db,owner,{requestId:randomUUID(),roleId:role.id,expectedRoleVersion:1,authorization}),{code:'teloa/conflict'})
  await db.query('begin');await db.query('select id from teloa_roles where owner_id=$1 and id=$2 for update',[owner,role.id])
  await db.query(`insert into teloa_tasks(id,owner_id,request_id,request_spec,definition,version,content_version,state,assignee_role_id,assignee_role_version,created_at,updated_at)
   select $1,owner_id,$2,'{}',definition,1,1,'ready',assignee_role_id,assignee_role_version,now(),now() from teloa_tasks where id=$3`,[atomicTaskId,randomUUID(),taskId])
  const receipt=await consents.confirmInTransaction(db,owner,{requestId:randomUUID(),roleId:role.id,expectedRoleVersion:1,authorization:{...authorization,taskId:atomicTaskId}});assert.equal(receipt.state,'active');await db.query('rollback')
 }
 finally{db.release()}
 assert.equal((await env.pool.query('select id from teloa_tasks where id=$1',[atomicTaskId])).rowCount,0)
 assert.deepEqual(await consents.get(owner,{roleId:role.id}),[])
 let current=true
 const guarded=service({authorize:async()=>({assertCurrent(){if(!current)throw Error('本人确认失效')}})})
 current=false
 await assert.rejects(guarded.confirm(owner,{requestId:randomUUID(),roleId:role.id,expectedRoleVersion:1,authorization}))
 assert.deepEqual(await consents.get(owner,{roleId:role.id}),[])
})
