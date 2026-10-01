import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {CollaborationService,initializeCollaboration} from '../src/work/collaboration.ts'
import {initializeGroupAgentGrants} from '../src/work/group-agent-grants.ts'
import {GroupReactionService,initializeGroupReactions} from '../src/work/group-reactions.ts'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'

const openGroupRules={historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true}
/** 消息要按发送先后排出稳定次序，测试时钟必须逐次前进，不能固定在同一毫秒。 */
let tick=0
const identity={id:randomUUID,now:()=>new Date(Date.parse('2026-09-21T09:00:00.000Z')+(tick++)*1000).toISOString()}

let container:StartedPostgreSqlContainer,pool:Pool,reactions:GroupReactionService

before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeRoles(pool);await initializeCollaboration(pool);await initializeGroupAgentGrants(pool);await initializeGroupReactions(pool)
 reactions=new GroupReactionService(pool,identity)
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})

async function fixture(){
 const owner=randomUUID(),roles=new RoleService(pool,identity),groups=new CollaborationService(pool,identity)
 const role=await roles.create(owner,{requestId:randomUUID(),fields:{name:'SOC 研判员',kind:'employee',scopes:['SOC'],duty:'研判固定告警资料',dataScope:'固定资料',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'表情群',scope:'SOC',announcement:'固定范围。',rules:openGroupRules,memberRoleIds:[role.id]}})
 const root=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'话题根。'})
 const reply=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,rootId:root.id,text:'同话题回复。'})
 const otherTopic=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'另一个话题。'})
 return {owner,groups,role,group,root,reply,otherTopic}
}

test('加表情、取消、再加：往返幂等且行永不删',async()=>{
 const f=await fixture(),M=f.root.id
 const first=await reactions.toggle(f.owner,{requestId:randomUUID(),groupId:f.group.id,messageId:M,emoji:'👍'})
 assert.equal(first.items.find(i=>i.emoji==='👍')?.count,1)
 assert.equal(first.items.find(i=>i.emoji==='👍')?.mine,true)
 const second=await reactions.toggle(f.owner,{requestId:randomUUID(),groupId:f.group.id,messageId:M,emoji:'👍'})
 assert.equal(second.items.find(i=>i.emoji==='👍'),undefined)
 const rows=await pool.query('select withdrawn_at from teloa_group_reactions where owner_id=$1 and message_id=$2',[f.owner,M])
 assert.equal(rows.rowCount,1)
 assert.notEqual(rows.rows[0].withdrawn_at,null)
 const third=await reactions.toggle(f.owner,{requestId:randomUUID(),groupId:f.group.id,messageId:M,emoji:'👍'})
 assert.equal(third.items.find(i=>i.emoji==='👍')?.count,1)
 assert.equal((await pool.query('select count(*)::int as n from teloa_group_reactions where owner_id=$1 and message_id=$2',[f.owner,M])).rows[0].n,1)
})

test('同 requestId 重放回原回执，不改变状态',async()=>{
 const f=await fixture(),requestId=randomUUID()
 const a=await reactions.toggle(f.owner,{requestId,groupId:f.group.id,messageId:f.root.id,emoji:'✅'})
 const b=await reactions.toggle(f.owner,{requestId,groupId:f.group.id,messageId:f.root.id,emoji:'✅'})
 assert.deepEqual(a,b)
 assert.equal(a.items.find(i=>i.emoji==='✅')?.count,1)
 await assert.rejects(reactions.toggle(f.owner,{requestId,groupId:f.group.id,messageId:f.root.id,emoji:'❌'}),{code:'teloa/conflict'})
})

test('非本群消息判 forbidden，归档群判 conflict，非法 emoji 判 invalid-input',async()=>{
 const f=await fixture(),other=await fixture()
 await assert.rejects(reactions.toggle(f.owner,{requestId:randomUUID(),groupId:other.group.id,messageId:f.root.id,emoji:'👍'}),{code:'teloa/forbidden'})
 await assert.rejects(reactions.toggle(other.owner,{requestId:randomUUID(),groupId:f.group.id,messageId:f.root.id,emoji:'👍'}),{code:'teloa/forbidden'})
 // 归档只改群状态，消息照旧存在：归档后不能再加表情。
 await pool.query('update teloa_groups set archived=true where id=$1 and owner_id=$2',[other.group.id,other.owner])
 await assert.rejects(reactions.toggle(other.owner,{requestId:randomUUID(),groupId:other.group.id,messageId:other.root.id,emoji:'👍'}),{code:'teloa/conflict'})
 await assert.rejects(reactions.toggle(f.owner,{requestId:randomUUID(),groupId:f.group.id,messageId:f.root.id,emoji:'🐛'}),{code:'teloa/invalid-input'})
})

test('同事身份加表情：actor_kind=role、run_id 可空、check 约束挡住混写',async()=>{
 const f=await fixture(),M=f.root.id,R=f.role.id,client=await pool.connect()
 try{
  await reactions.applyRole(client,f.owner,{groupId:f.group.id,messageId:M,roleId:R,emoji:'👀',runId:null,requestId:randomUUID()})
 }finally{client.release()}
 const eye=(await reactions.list(f.owner,{groupId:f.group.id,messageIds:[M]})).items.find(i=>i.emoji==='👀')
 assert.equal(eye?.count,1)
 assert.equal(eye?.mine,false)
 assert.deepEqual(eye?.actors,[{actorKind:'role',actorId:R}])
 await assert.rejects(pool.query(
  "insert into teloa_group_reactions(owner_id,group_id,message_id,actor_kind,actor_id,emoji,run_id,request_id,created_at,updated_at) values($1,$2,$3,'self',$4,'👍',null,$5,now(),now())",
  [f.owner,f.group.id,M,R,randomUUID()]))
})

test('inTopic：同话题为真、跨话题为假、根消息为真',async()=>{
 const f=await fixture(),client=await pool.connect()
 try{
  assert.equal(await reactions.inTopic(client,f.owner,f.group.id,f.root.id,f.root.id),true)
  assert.equal(await reactions.inTopic(client,f.owner,f.group.id,f.root.id,f.reply.id),true)
  assert.equal(await reactions.inTopic(client,f.owner,f.group.id,f.root.id,f.otherTopic.id),false)
 }finally{client.release()}
})

test('并发双击（两个 requestId、同一人同一表情）：都成功、末态归零、行仍只有一条',async()=>{
 const f=await fixture(),M=f.reply.id
 const results=await Promise.allSettled([
  reactions.toggle(f.owner,{requestId:randomUUID(),groupId:f.group.id,messageId:M,emoji:'🎉'}),
  reactions.toggle(f.owner,{requestId:randomUUID(),groupId:f.group.id,messageId:M,emoji:'🎉'}),
 ])
 assert.equal(results.filter(r=>r.status==='fulfilled').length,2)
 assert.equal((await reactions.list(f.owner,{groupId:f.group.id,messageIds:[M]})).items.find(i=>i.emoji==='🎉'),undefined)
 const rows=await pool.query('select withdrawn_at from teloa_group_reactions where owner_id=$1 and message_id=$2',[f.owner,M])
 assert.equal(rows.rowCount,1)
 assert.notEqual(rows.rows[0].withdrawn_at,null)
})

test('list 的 messageIds 超两百即 invalid-input',async()=>{
 const f=await fixture()
 await assert.rejects(reactions.list(f.owner,{groupId:f.group.id,messageIds:new Array(201).fill(f.root.id)}),{code:'teloa/invalid-input'})
})
