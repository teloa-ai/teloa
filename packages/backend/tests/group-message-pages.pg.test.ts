import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeTeloaDatabase} from '../src/work/initialize-database.ts'
import {CollaborationService} from '../src/work/collaboration.ts'
import {groupMessageBodySnapshot} from '../src/work/group-message-body.ts'
import type {GroupMessage} from '@teloa/contract'
import {RoleService} from '../src/work/roles.ts'
import {GroupTaskService} from '../src/work/group-tasks.ts'
import {TaskService} from '../src/work/tasks.ts'
import {GroupAgentGrantService} from '../src/work/group-agent-grants.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
let container:StartedPostgreSqlContainer,pool:Pool,tick=0
const identity={id:randomUUID,now:()=>new Date(Date.parse('2026-10-15T00:00:00.000Z')+tick++).toISOString()}
before(async()=>{container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeTeloaDatabase(pool)},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})
async function fixture(){
 const owner=randomUUID(),service=new CollaborationService(pool,identity),group=await service.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'历史群',scope:'general',announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},memberRoleIds:[]}})
 const send=(text:string,rootId?:string)=>service.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:1,text,...(rootId?{rootId}:{})})
 return {owner,service,group,send,api:service as unknown as {messagePage:(owner:string,input:unknown)=>Promise<any>;messageSearch:(owner:string,input:unknown)=>Promise<any>}}
}
test('真实分页按消息ID查回稳定时间顺序，主群/话题隔离且旧list兼容',async()=>{
 const f=await fixture(),root=await f.send('原话题'),replies:GroupMessage[]=[]
 for(let n=0;n<5;n++)replies.push(await f.send('话题回复'+n,root.id))
 const mains=[];for(let n=0;n<5;n++)mains.push(await f.send('主群消息'+n))
 const tail=await f.api.messagePage(f.owner,{groupId:f.group.id,limit:2});assert.deepEqual(tail.items.map((m:any)=>m.id),mains.slice(-2).map(m=>m.id));assert.equal(tail.older,mains[3]!.id)
 const previous=await f.api.messagePage(f.owner,{groupId:f.group.id,before:tail.older,limit:2});assert.deepEqual(previous.items.map((m:any)=>m.id),mains.slice(1,3).map(m=>m.id))
 const incremental=await f.api.messagePage(f.owner,{groupId:f.group.id,after:mains[1]!.id,limit:2});assert.deepEqual(incremental.items.map((m:any)=>m.id),mains.slice(2,4).map(m=>m.id));assert.equal(incremental.newer,mains[3]!.id)
 const topic=await f.api.messagePage(f.owner,{groupId:f.group.id,rootId:root.id,limit:2});assert.deepEqual(topic.items.map((m:any)=>m.id),[root.id,...replies.slice(-2).map(m=>m.id)])
 const around=await f.api.messagePage(f.owner,{groupId:f.group.id,rootId:root.id,around:replies[1]!.id,limit:3});assert.ok(around.items.some((m:any)=>m.id===replies[1]!.id));assert.equal(around.items[0].id,root.id)
 const summary=await f.api.messagePage(f.owner,{groupId:f.group.id,after:mains.at(-1)!.id,topicRoots:[root.id]});assert.equal(summary.items.length,0);assert.equal(summary.topics[0].count,5);assert.equal(summary.topics[0].replies.length,1)
 await f.send('新话题回复',root.id);const refreshed=await f.api.messagePage(f.owner,{groupId:f.group.id,after:mains.at(-1)!.id,topicRoots:[root.id]});assert.equal(refreshed.items.length,0);assert.equal(refreshed.topics[0].count,6)
 assert.equal((await f.api.messagePage(f.owner,{groupId:f.group.id,rootId:root.id,limit:2})).topics[0].count,6)
 assert.equal((await f.service.messages(f.owner,{groupId:f.group.id})).length,12)
 await assert.rejects(f.api.messagePage(f.owner,{groupId:f.group.id,before:replies[0]!.id}),{code:'teloa/forbidden'})
 const other=await fixture(),foreign=await other.send('另一群');await assert.rejects(f.api.messagePage(f.owner,{groupId:f.group.id,before:foreign.id}),{code:'teloa/forbidden'})
 await assert.rejects(f.api.messagePage(other.owner,{groupId:f.group.id}),{code:'teloa/forbidden'})
})
test('全文检索命中未载入的长正文尾部，保留原话题/主群目标且游标不跨群',async()=>{
 const f=await fixture(),root=await f.send('讨论根'),reply=await f.send('原话题独有线索',root.id),text='原始正文'.repeat(2300)+'尾部唯一关键词',body=groupMessageBodySnapshot(text),messageId=randomUUID()
 await pool.query('insert into teloa_group_messages(id,owner_id,group_id,request_id,request_spec,root_id,author_id,task_id,run_id,text,reference_snapshot,created_at,full_text,full_text_meta) values($1,$2,$3,$4,\'{}\',null,$5,$6,$7,$8,\'[]\',$9,$10,$11)',[messageId,f.owner,f.group.id,randomUUID(),randomUUID(),randomUUID(),randomUUID(),body.preview,identity.now(),body.body,JSON.stringify(body.summary)])
 const result=await f.api.messageSearch(f.owner,{groupId:f.group.id,query:'尾部唯一关键词'});assert.equal(result.items.length,1);assert.equal(result.items[0].message.id,messageId);assert.equal(result.items[0].rootId,null);assert.equal(result.items[0].message.fullText.chars,text.length)
 const topic=await f.api.messageSearch(f.owner,{groupId:f.group.id,query:'独有线索'});assert.equal(topic.items[0].message.id,reply.id);assert.equal(topic.items[0].rootId,root.id)
 assert.deepEqual((await f.api.messageSearch(f.owner,{groupId:f.group.id,query:'不存在'})).items,[])
 const other=await fixture(),foreign=await other.send('另一群');await assert.rejects(f.api.messageSearch(f.owner,{groupId:f.group.id,query:'线索',before:foreign.id}),{code:'teloa/forbidden'})
 assert.match(result.items[0].excerpt,/尾部唯一关键词/)
})
test('v2主群员工回包按原main归属分页与定位，同刻消息稳定排序，归档可读而撤成员即拒绝',async()=>{
 const f=await fixture(),root=await f.send('原交办'),reply=await f.send('真实话题回复',root.id),role=await new RoleService(pool,identity).create(f.owner,{requestId:randomUUID(),fields:{name:'原员工',kind:'employee',scopes:['general'],duty:'核对',dataScope:'本群',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 const group=await f.service.change(f.owner,{requestId:randomUUID(),groupId:f.group.id,expectedVersion:1,fields:{name:f.group.name,announcement:'',rules:f.group.rules,memberRoleIds:[role.id],pinned:false,archived:false}})
 await new GroupAgentGrantService(pool,identity.now).change(f.owner,{requestId:randomUUID(),groupId:group.id,roleId:role.id,expectedGroupVersion:group.version,expectedRoleVersion:role.version,action:'save',canPost:true,canAutoRun:true,resources:[]})
 const {task}=await new GroupTaskService(pool,identity,new TaskService(pool,identity)).create(f.owner,{requestId:randomUUID(),groupId:group.id,messageId:root.id,expectedGroupVersion:group.version,goal:'原主群答复',assignee:{roleId:role.id,expectedVersion:role.version},trigger:'routed',executionMode:'reply',routingAttemptVersion:1}),messageId=randomUUID()
 await pool.query('insert into teloa_group_messages(id,owner_id,group_id,request_id,request_spec,root_id,author_id,task_id,run_id,text,reference_snapshot,created_at) values($1,$2,$3,$4,\'{}\',$5,$6,$7,$8,\'main原答案\',\'[]\',$9)',[messageId,f.owner,group.id,randomUUID(),root.id,role.id,task.id,randomUUID(),root.createdAt])
 const page=await f.api.messagePage(f.owner,{groupId:group.id,limit:1}),expected=[root.id,messageId].sort();assert.equal(page.items[0].id,expected[1])
 const all=await f.api.messagePage(f.owner,{groupId:group.id,limit:10});assert.deepEqual(all.items.map((row:any)=>row.id),expected);assert.equal(all.items.find((row:any)=>row.id===messageId).contextMode,'main')
 const summary=all.topics.find((topic:any)=>topic.rootId===root.id),topic=await f.api.messagePage(f.owner,{groupId:group.id,rootId:root.id}),topicSearch=await f.api.messageSearch(f.owner,{groupId:group.id,rootId:root.id,query:'main原答案'})
 assert.deepEqual({count:summary.count,participants:summary.participants,summaryReplyIds:summary.replies.map((row:any)=>row.id),topicIds:topic.items.map((row:any)=>row.id),topicCount:topic.topics[0].count,topicSearchIds:topicSearch.items.map((row:any)=>row.message.id)},{count:1,participants:1,summaryReplyIds:[reply.id],topicIds:[root.id,reply.id],topicCount:1,topicSearchIds:[]},'显式main回包不计入话题回复、成员、分页或限定话题搜索')
 const search=await f.api.messageSearch(f.owner,{groupId:group.id,query:'main原答案'});assert.equal(search.items[0].rootId,null)
 await pool.query('update teloa_groups set archived=true where id=$1',[group.id]);assert.equal((await f.api.messageSearch(f.owner,{groupId:group.id,query:'main原答案'})).items.length,1,'归档历史仍可读')
 await pool.query("delete from teloa_group_members where owner_id=$1 and group_id=$2 and member_key='self'",[f.owner,group.id]);await assert.rejects(f.api.messagePage(f.owner,{groupId:group.id}),{code:'teloa/forbidden'});await assert.rejects(f.api.messageSearch(f.owner,{groupId:group.id,query:'原答案'}),{code:'teloa/forbidden'})
})
