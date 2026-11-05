import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {Pool,stopTestContainer} from './postgres-test-lifecycle.ts'
import {useLocalContainerRuntime} from './testcontainers-env.ts'
import {initializeTeloaDatabase} from '../src/work/initialize-database.ts'
import {CollaborationService} from '../src/work/collaboration.ts'
import {RoleService} from '../src/work/roles.ts'
import {GroupAgentGrantService} from '../src/work/group-agent-grants.ts'
import {GroupRoutingDecisionService} from '../src/work/group-routing-decisions.ts'
import {GroupRoutingOutboxService} from '../src/work/group-routing-outbox.ts'
import {GroupReplyExecutionService,groupReplyContentHash} from '../src/work/group-reply-executions.ts'
import {GroupMentionService} from '../src/work/group-mentions.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import type {GroupMessage,GroupRoutingDecision} from '@teloa/contract'

let container:StartedPostgreSqlContainer,pool:Pool,tick=0
const identity={id:randomUUID,now:()=>new Date(Date.parse('2026-11-05T00:00:00Z')+tick++).toISOString()}
before(async()=>{useLocalContainerRuntime();container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeTeloaDatabase(pool)},{timeout:120000})
after(async()=>{await pool?.end();await stopTestContainer(container)})

test('真实PG：独立reply按固定main/thread归属出现在分页、搜索、话题计数、提及和已读水位',async()=>{
 const owner=randomUUID(),groups=new CollaborationService(pool,identity),role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'群回复回归员',kind:'employee',scopes:['general'],duty:'解释合成问题',dataScope:'本群',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'独立reply显示归属',scope:'general',announcement:'合成PG回归',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},memberRoleIds:[role.id]}})
 await new GroupAgentGrantService(pool,identity.now).change(owner,{requestId:randomUUID(),groupId:group.id,roleId:role.id,expectedGroupVersion:group.version,expectedRoleVersion:role.version,action:'save',canPost:true,canAutoRun:true,resources:[]})
 const root=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'主群合成问题'})
 const thread=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,rootId:root.id,text:'话题合成补充'})
 const decisions=new GroupRoutingDecisionService(pool,identity),outbox=new GroupRoutingOutboxService(pool,identity),replies=new GroupReplyExecutionService(pool,identity)
 // 原生完成证据是本用例的显式合成输入；本测试验证真实PG发布及SQL投影，不宣称模型质量。
 const publish=async(source:GroupMessage,text:string)=>{
  const decision:GroupRoutingDecision={kind:'direct',respond:[role.id],reactions:[],hops:0,candidateIds:[role.id],truncatedCandidates:false,stopMessageId:null,at:identity.now(),intent:'reply',assignments:[],workTarget:null}
  const items=await decisions.withTopicLock(owner,group.id,source.rootId??source.id,async db=>{const saved=await decisions.record(db,owner,{groupId:group.id,messageId:source.id,decision});assert.ok(saved);return outbox.recordRecipients(db,owner,{groupId:group.id,messageId:source.id,decision:saved,decisionVersion:1})})
  const item=await outbox.claim(owner,{itemId:items[0]!.id,expectedLeaseGeneration:0});assert.ok(item)
  const execution=await replies.prepare(owner,item.id),sha=groupReplyContentHash([{type:'text',text:source.text}])
  assert.equal(await replies.submitting(owner,item.id,item.leaseGeneration,{nativeInputSha256:sha}),true)
  await replies.admitNativeInput(owner,item.id,randomUUID(),sha)
  await replies.observe(owner,item.id,{state:'ended',evidence:{turn:0,messageSeq:1,endSeq:3,reason:'completed'},text})
  const message=await replies.publish(owner,item.id);assert.ok('replyExecutionId' in message);return {message,execution}
 }
 const main=await publish(root,'共同回归关键词：主群答复'),topic=await publish(thread,'共同回归关键词：话题答复')
 // 本人提及是隔离测试的显式持久夹具，不从正文姓名推导。
 await pool.query('update teloa_group_messages set mention_self=true where owner_id=$1 and id=any($2::uuid[])',[owner,[main.message.id,topic.message.id]])
 const page=await groups.messagePage(owner,{groupId:group.id,limit:10})
 assert.deepEqual(page.items.map(message=>message.id),[root.id,main.message.id])
 assert.equal(page.items.at(-1)?.contextMode,'main')
 assert.equal(page.topics.find(item=>item.rootId===root.id)?.count,2)
 const topicPage=await groups.messagePage(owner,{groupId:group.id,rootId:root.id,limit:10})
 assert.deepEqual(topicPage.items.map(message=>message.id),[root.id,thread.id,topic.message.id])
 const search=await groups.messageSearch(owner,{groupId:group.id,query:'共同回归关键词'})
 assert.equal(search.items.find(item=>item.message.id===main.message.id)?.rootId,null)
 assert.equal(search.items.find(item=>item.message.id===topic.message.id)?.rootId,root.id)
 assert.deepEqual((await groups.messageSearch(owner,{groupId:group.id,rootId:root.id,query:'共同回归关键词'})).items.map(item=>item.message.id),[topic.message.id])
 const mentionService=new GroupMentionService(pool),mentions=await mentionService.list(owner,{groupId:group.id,unreadOnly:true})
 assert.equal(mentions.items.find(item=>item.message.id===main.message.id)?.rootId,null)
 assert.equal(mentions.items.find(item=>item.message.id===topic.message.id)?.rootId,root.id)
 assert.equal((await groups.reading(owner,{groupId:group.id})).unreadCount,1)
 assert.equal((await groups.reading(owner,{groupId:group.id,rootId:root.id})).unreadCount,1)
 await groups.markRead(owner,{groupId:group.id,messageId:main.message.id})
 assert.equal((await mentionService.list(owner,{groupId:group.id,unreadOnly:true})).items.some(item=>item.message.id===main.message.id),false)
 assert.equal((await groups.reading(owner,{groupId:group.id,rootId:root.id})).unreadCount,1)
 for(const table of ['teloa_tasks','teloa_task_runs'])assert.equal(Number((await pool.query(`select count(*) n from ${table} where owner_id=$1`,[owner])).rows[0].n),0)
 await pool.query('update teloa_group_messages set text=$3 where owner_id=$1 and id=$2',[owner,main.message.id,'篡改的普通回复'])
 await assert.rejects(()=>groups.messagePage(owner,{groupId:group.id,limit:10}),{code:'teloa/storage-corrupt'})
})
