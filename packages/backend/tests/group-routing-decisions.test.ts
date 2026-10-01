import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {type GroupRoutingDecision} from '@teloa/contract'
import {CollaborationService,initializeCollaboration} from '../src/work/collaboration.ts'
import {initializeGroupAgentGrants} from '../src/work/group-agent-grants.ts'
import {GroupRoutingDecisionService,initializeGroupRoutingDecisions} from '../src/work/group-routing-decisions.ts'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'

const openGroupRules={historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true}
/** 跳数与停下闸都按消息先后判定，测试时钟必须逐次前进。 */
let tick=0
const identity={id:randomUUID,now:()=>new Date(Date.parse('2026-09-21T09:00:00.000Z')+(tick++)*1000).toISOString()}

let container:StartedPostgreSqlContainer,pool:Pool,decisions:GroupRoutingDecisionService

before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeRoles(pool);await initializeCollaboration(pool);await initializeGroupAgentGrants(pool);await initializeGroupRoutingDecisions(pool)
 decisions=new GroupRoutingDecisionService(pool,identity)
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})

async function fixture(){
 const owner=randomUUID(),roles=new RoleService(pool,identity),groups=new CollaborationService(pool,identity)
 const role=await roles.create(owner,{requestId:randomUUID(),fields:{name:'SOC 研判员',kind:'employee',scopes:['SOC'],duty:'研判固定告警资料',dataScope:'固定资料',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'路由群',scope:'SOC',announcement:'固定范围。',rules:openGroupRules,memberRoleIds:[role.id]}})
 const root=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'话题根。'})
 const self=(text:string)=>groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,rootId:root.id,text})
 return {owner,groups,role,group,root,self}
}

/**
 * 数字员工回帖的真链路要走一整条运行（先例见 `group-tasks.test.ts` 的 `employeeReply`），跳数只关心 author_id 序列，
 * 因此这里按建表约束直接落行：author_id 为岗位 id 时 task_id/run_id 必须非空，这两列没有外键。
 */
async function colleagueMessage(owner:string,groupId:string,rootId:string,roleId:string,text:string):Promise<string>{
 const id=randomUUID()
 await pool.query('insert into teloa_group_messages(id,owner_id,group_id,request_id,request_spec,root_id,author_id,text,reference_snapshot,created_at,task_id,run_id) values($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb,$10,$11,$12)',
  [id,owner,groupId,randomUUID(),'{}',rootId,roleId,text,'[]',identity.now(),randomUUID(),randomUUID()])
 return id
}

const routed=(roleId:string,hops:number):GroupRoutingDecision=>({kind:'routed',respond:[roleId],reactions:[],hops,candidateIds:[roleId],truncatedCandidates:false,stopMessageId:null,at:identity.now()})
const stopped=(stopMessageId:string):GroupRoutingDecision=>({kind:'relay-stopped',respond:[],reactions:[],hops:6,candidateIds:[],truncatedCandidates:false,stopMessageId,at:identity.now()})

test('同一条消息只能有一条决策行',async()=>{
 const f=await fixture(),M=await colleagueMessage(f.owner,f.group.id,f.root.id,f.role.id,'同事回帖。')
 const a=await decisions.withTopicLock(f.owner,f.group.id,f.root.id,db=>decisions.record(db,f.owner,{groupId:f.group.id,messageId:M,decision:routed(f.role.id,1)}))
 assert.notEqual(a,undefined)
 const b=await decisions.withTopicLock(f.owner,f.group.id,f.root.id,db=>decisions.record(db,f.owner,{groupId:f.group.id,messageId:M,decision:routed(f.role.id,1)}))
 assert.equal(b,undefined)
 assert.equal((await pool.query('select count(*)::int c from teloa_group_routing_decisions where owner_id=$1',[f.owner])).rows[0].c,1)
 const client=await pool.connect()
 try{
  assert.equal(await decisions.claimed(client,f.owner,M),true)
  assert.equal(await decisions.claimed(client,f.owner,f.root.id),false)
 }finally{client.release()}
})

test('决策表只追加：update 与 delete 都被触发器挡住',async()=>{
 const f=await fixture(),M=await colleagueMessage(f.owner,f.group.id,f.root.id,f.role.id,'同事回帖。')
 await decisions.withTopicLock(f.owner,f.group.id,f.root.id,db=>decisions.record(db,f.owner,{groupId:f.group.id,messageId:M,decision:routed(f.role.id,1)}))
 await assert.rejects(pool.query('update teloa_group_routing_decisions set created_at=now() where owner_id=$1',[f.owner]),/append-only/)
 await assert.rejects(pool.query('delete from teloa_group_routing_decisions where owner_id=$1',[f.owner]),/append-only/)
})

test('跳数：从触发消息往前数连续同事消息，遇本人归零',async()=>{
 const f=await fixture(),M0=f.root.id
 const A1=await colleagueMessage(f.owner,f.group.id,M0,f.role.id,'第一跳。')
 await colleagueMessage(f.owner,f.group.id,M0,f.role.id,'第二跳。')
 const A3=await colleagueMessage(f.owner,f.group.id,M0,f.role.id,'第三跳。')
 const M1=(await f.self('我来接一句。')).id
 const client=await pool.connect()
 try{
  assert.equal(await decisions.hops(client,f.owner,f.group.id,M0,M0),0)
  assert.equal(await decisions.hops(client,f.owner,f.group.id,M0,A1),1)
  assert.equal(await decisions.hops(client,f.owner,f.group.id,M0,A3),3)
  assert.equal(await decisions.hops(client,f.owner,f.group.id,M0,M1),0)
 }finally{client.release()}
})

test('relayGateOpen：没停过恒开；停过且本人未插话则关；本人插话后再开（H2）',async()=>{
 const f=await fixture(),client=await pool.connect()
 try{
  assert.equal(await decisions.relayGateOpen(client,f.owner,f.group.id,f.root.id,f.root.id),true)
  const trigger=await colleagueMessage(f.owner,f.group.id,f.root.id,f.role.id,'第六跳。')
  const stopMessage=await f.self('我先停一下，等你确认再继续。')
  await decisions.withTopicLock(f.owner,f.group.id,f.root.id,db=>decisions.record(db,f.owner,{groupId:f.group.id,messageId:trigger,decision:stopped(stopMessage.id)}))
  assert.equal(await decisions.relayGateOpen(client,f.owner,f.group.id,f.root.id,stopMessage.id),false)
  const resume=await f.self('继续吧。')
  assert.equal(await decisions.relayGateOpen(client,f.owner,f.group.id,f.root.id,resume.id),true)
 }finally{client.release()}
})

test('停下消息比决策还晚也不顶开闸门：排除只认 stopMessageId，不认先后',async()=>{
 const f=await fixture(),client=await pool.connect()
 try{
  const trigger=await colleagueMessage(f.owner,f.group.id,f.root.id,f.role.id,'第六跳。')
  const stopMessage=await f.self('我先停一下，等你确认再继续。')
  await decisions.withTopicLock(f.owner,f.group.id,f.root.id,db=>decisions.record(db,f.owner,{groupId:f.group.id,messageId:trigger,decision:stopped(stopMessage.id)}))
  // 停下消息的落库时刻推到决策之后：时间戳那道闸挡不住它，只剩 `not exists(stopMessageId)` 这一道。
  await pool.query("update teloa_group_messages set created_at=(select created_at from teloa_group_routing_decisions where owner_id=$1 and message_id=$2)+interval '1 second' where id=$3",[f.owner,trigger,stopMessage.id])
  assert.equal(await decisions.relayGateOpen(client,f.owner,f.group.id,f.root.id,stopMessage.id),false)
  const resume=await f.self('继续吧。')
  assert.equal(await decisions.relayGateOpen(client,f.owner,f.group.id,f.root.id,resume.id),true)
 }finally{client.release()}
})

test('闸门按触发消息所在位置判：停下之后、本人插话之前的同事消息，路由晚跑也不被后来的插话顶开',async()=>{
 const f=await fixture(),client=await pool.connect()
 try{
  const trigger=await colleagueMessage(f.owner,f.group.id,f.root.id,f.role.id,'第六跳。')
  const stopMessage=await f.self('我先停一下，等你确认再继续。')
  await decisions.withTopicLock(f.owner,f.group.id,f.root.id,db=>decisions.record(db,f.owner,{groupId:f.group.id,messageId:trigger,decision:stopped(stopMessage.id)}))
  const skipped=await colleagueMessage(f.owner,f.group.id,f.root.id,f.role.id,'停下之后又说了一句。')
  // 这一条的路由是 fire-and-forget，负载下可能拖到本人插话落库之后才跑：插话在它之后，不能替它开闸。
  const resume=await f.self('我来说一句，接着聊。')
  assert.equal(await decisions.relayGateOpen(client,f.owner,f.group.id,f.root.id,skipped),false)
  assert.equal(await decisions.relayGateOpen(client,f.owner,f.group.id,f.root.id,resume.id),true)
  const after=await colleagueMessage(f.owner,f.group.id,f.root.id,f.role.id,'插话之后的同事回帖。')
  assert.equal(await decisions.relayGateOpen(client,f.owner,f.group.id,f.root.id,after),true)
 }finally{client.release()}
})

test('relayStopRounds 随触顶次数递增（H2 的轮次分量来源）',async()=>{
 const f=await fixture(),client=await pool.connect()
 try{
  assert.equal(await decisions.relayStopRounds(client,f.owner,f.group.id,f.root.id),0)
  const first=await colleagueMessage(f.owner,f.group.id,f.root.id,f.role.id,'第六跳。')
  const firstStop=await f.self('我先停一下，等你确认再继续。')
  await decisions.withTopicLock(f.owner,f.group.id,f.root.id,db=>decisions.record(db,f.owner,{groupId:f.group.id,messageId:first,decision:stopped(firstStop.id)}))
  assert.equal(await decisions.relayStopRounds(client,f.owner,f.group.id,f.root.id),1)
  const second=await colleagueMessage(f.owner,f.group.id,f.root.id,f.role.id,'又一轮第六跳。')
  const secondStop=await f.self('我先停一下，等你确认再继续。')
  await decisions.withTopicLock(f.owner,f.group.id,f.root.id,db=>decisions.record(db,f.owner,{groupId:f.group.id,messageId:second,decision:stopped(secondStop.id)}))
  assert.equal(await decisions.relayStopRounds(client,f.owner,f.group.id,f.root.id),2)
 }finally{client.release()}
})

test('isStopMessage：停下消息为真，别的消息为假',async()=>{
 const f=await fixture(),client=await pool.connect()
 try{
  const trigger=await colleagueMessage(f.owner,f.group.id,f.root.id,f.role.id,'第六跳。')
  const stopMessage=await f.self('我先停一下，等你确认再继续。')
  await decisions.withTopicLock(f.owner,f.group.id,f.root.id,db=>decisions.record(db,f.owner,{groupId:f.group.id,messageId:trigger,decision:stopped(stopMessage.id)}))
  assert.equal(await decisions.isStopMessage(client,f.owner,f.group.id,stopMessage.id),true)
  assert.equal(await decisions.isStopMessage(client,f.owner,f.group.id,f.root.id),false)
 }finally{client.release()}
})

test('话题锁下并发两条同 messageId 的写入只成一条',async()=>{
 const f=await fixture(),MX=await colleagueMessage(f.owner,f.group.id,f.root.id,f.role.id,'并发触发。')
 const results=await Promise.allSettled([
  decisions.withTopicLock(f.owner,f.group.id,f.root.id,db=>decisions.record(db,f.owner,{groupId:f.group.id,messageId:MX,decision:routed(f.role.id,1)})),
  decisions.withTopicLock(f.owner,f.group.id,f.root.id,db=>decisions.record(db,f.owner,{groupId:f.group.id,messageId:MX,decision:routed(f.role.id,1)})),
 ])
 assert.equal(results.filter(r=>r.status==='fulfilled'&&r.value!==undefined).length,1)
})

test('list 只回四键投影，不下发 candidateIds 与 stopMessageId',async()=>{
 const f=await fixture(),M=await colleagueMessage(f.owner,f.group.id,f.root.id,f.role.id,'同事回帖。')
 await decisions.withTopicLock(f.owner,f.group.id,f.root.id,db=>decisions.record(db,f.owner,{groupId:f.group.id,messageId:M,decision:routed(f.role.id,2)}))
 const item=(await decisions.list(f.owner,{groupId:f.group.id,messageIds:[M]})).items[0]
 assert.deepEqual(Object.keys(item as object).sort(),['hops','kind','messageId','respond'])
 assert.deepEqual(item,{messageId:M,kind:'routed',respond:[f.role.id],hops:2})
})
