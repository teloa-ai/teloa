import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {setupRoleWork,identity,loadRoleWorkModule} from './role-work-test-fixture.ts'
import {RoleService} from '../src/work/roles.ts'
import {CollaborationService} from '../src/work/collaboration.ts'
import {initializeRoleMemory,RoleMemoryService} from '../src/work/role-memory.ts'
import {Pool} from './postgres-test-lifecycle.ts'

let env:Awaited<ReturnType<typeof setupRoleWork>>,api:Record<string,any>
before(async()=>{api=await loadRoleWorkModule('twin-drafts');if(!api.TwinDraftService)return;env=await setupRoleWork();await initializeRoleMemory(env.pool);await api.initializeTwinDrafts(env.pool)})
after(async()=>{await env?.close()})
test('持久多稿、修订与本人群采用同事务幂等，丢回包复用原回执',async()=>{
 assert.equal(typeof api.TwinDraftService,'function','需要真实持久分身稿服务')
 await env.pool.query('create table if not exists test_twin_wakes(owner_id text,message_id uuid primary key)')
 const owner=randomUUID(),role=await new RoleService(env.pool,identity).ensurePersonalTwin(owner),groups=new CollaborationService(env.pool,identity,{recordWake:async(db,owner,input)=>{await db.query('insert into test_twin_wakes values($1,$2) on conflict do nothing',[owner,input.messageId])}})
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'研发同步',scope:'general',announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},memberRoleIds:[]}})
 const source=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'今天能合并吗？'})
 const service=new api.TwinDraftService(env.pool,identity,{groups,admitText:()=>{}})
 const create={requestId:randomUUID(),roleId:role.id,expectedRoleVersion:role.version,title:'回复进度',body:'回归后合并。',basis:[],source:{kind:'group',groupId:group.id,messageId:source.id}}
 const draft=await service.create(owner,create),other=await service.create(owner,{...create,requestId:randomUUID(),title:'另一份稿'})
 assert.deepEqual(await service.create(owner,create),draft)
 assert.notEqual(draft.id,other.id)
 assert.equal((await new api.TwinDraftService(env.pool,identity,{groups}).list(owner,{roleId:role.id})).drafts.length,2)
 const revised=await service.revise(owner,{requestId:randomUUID(),draftId:draft.id,expectedRevision:1,expectedRoleVersion:role.version,expectedBodyHash:draft.bodyHash,body:'18 点前回归后合并。'})
 assert.equal(revised.revision,2)
 await assert.rejects(service.revise(owner,{requestId:randomUUID(),draftId:draft.id,expectedRevision:1,expectedRoleVersion:role.version,expectedBodyHash:draft.bodyHash,body:'覆盖'}),{code:'teloa/version-conflict'})
 const command={requestId:randomUUID(),draftId:draft.id,expectedRevision:revised.revision,expectedRoleVersion:role.version,expectedBodyHash:revised.bodyHash}
 const [a,b]=await Promise.all([service.adopt(owner,command),service.adopt(owner,command)])
 assert.deepEqual(a,b);assert.equal(a.receipt.result.kind,'group-message')
 assert.equal(a.draft.state,'sent');assert.equal(a.receipt.result.authorId,'self')
 assert.deepEqual(await service.receipt(owner,{requestId:command.requestId}),a)
 assert.equal((await env.pool.query('select count(*) from teloa_group_messages where owner_id=$1 and text=$2',[owner,revised.body])).rows[0].count,'1')
 assert.equal((await env.pool.query('select count(*) from test_twin_wakes where message_id=$1',[a.receipt.result.messageId])).rows[0].count,'1')
 await assert.rejects(service.adopt(owner,{...command,requestId:randomUUID()}),{code:'teloa/version-conflict'})
 await assert.rejects(service.get(randomUUID(),{draftId:draft.id}),{code:'teloa/forbidden'})
 await assert.rejects(service.adopt(owner,{...command,expectedBodyHash:'a'.repeat(64)}),{code:'teloa/conflict'})
 const returned=await service.return(owner,{requestId:randomUUID(),draftId:other.id,expectedRevision:1,expectedRoleVersion:role.version,expectedBodyHash:other.bodyHash,reason:'请补依据'})
 assert.equal(returned.state,'returned');assert.equal(returned.body,other.body)
 const pending=await service.create(owner,{...create,requestId:randomUUID(),body:'事务失败不能外发'})
 const attempt={requestId:randomUUID(),draftId:pending.id,expectedRevision:1,expectedRoleVersion:role.version,expectedBodyHash:pending.bodyHash}
 await assert.rejects(new api.TwinDraftService(env.pool,identity,{groups}).adopt(owner,attempt),{code:'teloa/source-unavailable'},'未接正文安全核验必须拒发')
 const failing=new api.TwinDraftService(env.pool,identity,{groups:{sendInTransaction:async(...args:any[])=>{await (groups.sendInTransaction as any)(...args);throw Error('fault after message')}},admitText:()=>{}})
 await assert.rejects(failing.adopt(owner,attempt),/fault after message/)
 assert.equal((await env.pool.query('select count(*) from teloa_group_messages where owner_id=$1 and text=$2',[owner,pending.body])).rows[0].count,'0')
 assert.equal((await service.get(owner,{draftId:pending.id})).state,'draft')
 assert.equal(await service.receipt(owner,{requestId:attempt.requestId}),null)
 const memories=new RoleMemoryService(env.pool,identity),actor={ownerId:owner,kind:'human' as const}
 const memory=await memories.create(actor,{requestId:randomUUID(),roleId:role.id,expectedRoleVersion:role.version,title:'先说结论',markdown:'先给结论再给时间。',source:{kind:'self-feedback',id:randomUUID(),version:1},visibility:{kind:'private',scopeIds:[]}})
 const confirmed=await memories.confirm(actor,{requestId:randomUUID(),memoryId:memory.id,expectedStateVersion:memory.stateVersion})
 const based=await service.create(owner,{...create,requestId:randomUUID(),basis:[{id:confirmed.id,version:confirmed.content.version,contentHash:confirmed.content.contentHash}]})
 await memories.withdraw(actor,{requestId:randomUUID(),memoryId:confirmed.id,expectedStateVersion:confirmed.stateVersion})
 await assert.rejects(service.adopt(owner,{requestId:randomUUID(),draftId:based.id,expectedRevision:based.revision,expectedRoleVersion:role.version,expectedBodyHash:based.bodyHash}),{code:'teloa/version-conflict'})
 const concurrent=await Promise.all(['并发采用 A','并发采用 B'].map(body=>service.create(owner,{...create,requestId:randomUUID(),body})))
 const delayed=new api.TwinDraftService(env.pool,identity,{groups:{sendInTransaction:async(db:any,...args:any[])=>{await db.query('select pg_sleep(0.05)');return (groups.sendInTransaction as any)(db,...args)}},admitText:()=>{}})
 const sent=await Promise.all(concurrent.map(draft=>delayed.adopt(owner,{requestId:randomUUID(),draftId:draft.id,expectedRevision:1,expectedRoleVersion:role.version,expectedBodyHash:draft.bodyHash})))
 assert.equal(sent.length,2,'同一群的不同稿件并发采用均成功')
})

test('连接池max2两份会话来源并发创建复用当前事务连接，不再向同池借连接',async t=>{
 const pool=new Pool({...env.pool.options,max:2,connectionTimeoutMillis:1000});t.after(()=>pool.end())
 const owner=randomUUID(),role=await new RoleService(pool,identity).ensurePersonalTwin(owner),groups=new CollaborationService(pool,identity)
 await pool.query('create table if not exists test_twin_conversations(owner_id text,session_id text primary key,text text)')
 const ids=[randomUUID(),randomUUID()]
 for(const id of ids)await pool.query('insert into test_twin_conversations values($1,$2,$3)',[owner,id,'本人原文 '+id])
 const service=new api.TwinDraftService(pool,identity,{groups,conversation:async(actor:string,source:any,db:any)=>{
  assert.ok(db,'会话核验必须拿到当前事务连接')
  const row=(await db.query('select text from test_twin_conversations where owner_id=$1 and session_id=$2',[actor,source.sessionId])).rows[0]
  if(!row)throw Object.assign(Error('not owned'),{code:'teloa/forbidden'})
  return {label:'本人会话',text:row.text}
 }})
 const results=await Promise.all(ids.map(sessionId=>service.create(owner,{requestId:randomUUID(),roleId:role.id,expectedRoleVersion:role.version,title:'会话回复',body:'待本人发送',basis:[],source:{kind:'conversation',sessionId,messageId:'message',messageSeq:1}})))
 assert.equal(results.length,2);assert.equal(new Set(results.map((d:any)=>d.id)).size,2)
 assert.equal(pool.waitingCount,0)
 for(const draft of results)assert.equal(draft.source.text,'本人原文 '+draft.source.sessionId)
})
