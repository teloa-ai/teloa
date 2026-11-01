import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {Pool,stopTestContainer} from './postgres-test-lifecycle.ts'
import {useLocalContainerRuntime} from './testcontainers-env.ts'
import {initializeTeloaDatabase} from '../src/work/initialize-database.ts'
import {CollaborationService} from '../src/work/collaboration.ts'
import {RoleService} from '../src/work/roles.ts'
import {TaskService} from '../src/work/tasks.ts'
import {GroupTaskService} from '../src/work/group-tasks.ts'
import {GroupRunMessageService} from '../src/work/group-run-messages.ts'
import {GroupRoutingOutboxService} from '../src/work/group-routing-outbox.ts'
import {ObjectConversationService} from '../src/work/object-conversations.ts'
import {TaskRunService} from '../src/work/task-runs.ts'
import {readRunGroupContext} from '../src/work/task-run-group-context.ts'
import {readRunGroupTopic} from '../src/work/group-topic.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import type {DigitalRole,GroupHumanMessage} from '@teloa/contract'

let container:StartedPostgreSqlContainer,pool:Pool,tick=0
const identity={id:randomUUID,now:()=>new Date(Date.parse('2026-10-20T00:00:00Z')+tick++).toISOString()},hash=(text:string)=>createHash('sha256').update(text).digest('hex')
before(async()=>{useLocalContainerRuntime();container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeTeloaDatabase(pool)},{timeout:120000})
after(async()=>{await pool?.end();await stopTestContainer(container)})
async function fixture(legacy=false,negativeReferences=false){
 const owner=randomUUID(),groups=new CollaborationService(pool,identity),roles=new RoleService(pool,identity),employees:DigitalRole[]=[]
 for(const name of ['核对员','复核员']){const role=await roles.create(owner,{requestId:randomUUID(),fields:{name,kind:'employee',scopes:['general'],duty:'核对合成金额',dataScope:'本群合成消息',executionScope:'分析与说明',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'test-analyst'}}});employees.push(role)}
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'来源核对群',scope:'general',announcement:'合成来源',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},memberRoleIds:employees.map(role=>role.id)}}),outbox=new GroupRoutingOutboxService(pool,identity)
 const send=async(text:string)=>await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text}) as GroupHumanMessage
 const work=async(role:DigitalRole,message:GroupHumanMessage,text:(input:{ids:string[]})=>string,ids:string[]=[])=>{
  const {task}=await new GroupTaskService(pool,identity,new TaskService(pool,identity)).create(owner,{requestId:randomUUID(),groupId:group.id,messageId:message.id,expectedGroupVersion:group.version,goal:message.text,assignee:{roleId:role.id,expectedVersion:role.version},trigger:'routed',executionMode:'reply',routingAttemptVersion:1})
  const sessionId=randomUUID(),conversationId=randomUUID(),inspect=async()=>({id:conversationId,sessionId,ownerId:owner,status:'ready'})
  await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:task.version,sessionId,expectedLinkVersion:0,action:'link'})
  const runs=new TaskRunService(pool,identity,inspect,{allowedTools:[],groupContext:(db,actor,task,role)=>readRunGroupContext(db,actor,task,role),groupTopic:(db,actor,context,continuation)=>readRunGroupTopic(db,actor,context,'',undefined,continuation)}),run=await runs.prepare(owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:task.version,roleId:role.id,expectedRoleVersion:role.version,sessionId,expectedLinkVersion:1})
  await runs.claim(owner,{runId:run.id});await runs.record(owner,{runId:run.id,sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'accepted'}});await runs.record(owner,{runId:run.id,sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:2,endSeq:4,reason:'completed'}})
  const publisher=new GroupRunMessageService(pool,identity,undefined,undefined,legacy?undefined:{recordRunMessage:(db,actor,input)=>outbox.recordRunMessage(db,actor,input),recordWake:(db,actor,input)=>outbox.recordWake(db,actor,input)}),delivery=await publisher.post(owner,{requestId:run.nativeRequestId,runId:run.id,text:text({ids})})
  return {run,delivery}
 }
 const first=await send('合成金额20元与30元'),a=await work(employees[0]!,first,()=>('完整原始依据。'.repeat(1200)+'\n原始证据末尾。')),second=await send('只分析，不执行工具'),a2=await work(employees[0]!,second,()=> '复核总额50元'),third=await send('请复核当前合成资料'),ids=[first.id,second.id,third.id,a.delivery.id,a2.delivery.id]
 const foreignGroup=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'另一来源群',scope:'general',announcement:'',rules:group.rules,memberRoleIds:[]}}),foreign=await groups.send(owner,{requestId:randomUUID(),groupId:foreignGroup.id,expectedVersion:foreignGroup.version,text:'仅另一群资料'}),missing=randomUUID()
 const final=await work(employees[1]!,third,({ids})=>`总额50元。\n消息编号 ${ids[0]}\n消息编号 ${ids[1]}\n消息编号 ${ids[2]}\n消息编号 ${ids[3]} 与 ${ids[4]}${negativeReferences?'\n消息编号 '+[foreign.id,missing,employees[0]!.id].join(' 与 '):''}`,ids)
 return {owner,groups,group,ids,first,a,final,send,work,employees,foreign,missing}
}
test('已完成 Run 的五个明确来源冷读后仍可定位，长正文保原摘要；读取不改变任何持久行',async()=>{
 const f=await fixture(),before=(await pool.query("select md5(string_agg(row_to_json(t)::text,'' order by id)) h from teloa_group_messages t where owner_id=$1",[f.owner])).rows[0].h
 const result=await new CollaborationService(pool,identity).messageSources(f.owner,{groupId:f.group.id,messageId:f.final.delivery.id})
 assert.equal(result.runId,f.final.run.id);assert.deepEqual(result.items.map(item=>item.message.id),f.ids);assert.equal(result.unavailableCount,0)
 const long=result.items.find(item=>item.message.id===f.a.delivery.id)!;assert.ok('runId'in long.message&&long.message.fullText);assert.equal(long.sha256,hash('完整原始依据。'.repeat(1200)+'\n原始证据末尾。'))
 assert.ok((await f.groups.messagePage(f.owner,{groupId:f.group.id,around:long.message.id})).items.some(item=>item.id===long.message.id))
 const actual=await f.groups.messageBody(f.owner,{groupId:f.group.id,messageId:long.message.id});assert.equal(actual.sha256,long.sha256);assert.match(actual.text,/原始证据末尾/)
 assert.equal((await pool.query("select md5(string_agg(row_to_json(t)::text,'' order by id)) h from teloa_group_messages t where owner_id=$1",[f.owner])).rows[0].h,before)
 const cold=await new CollaborationService(pool,identity).messageSources(f.owner,{groupId:f.group.id,messageId:f.final.delivery.id});assert.deepEqual(cold,result)
})
test('坏ID、跨群、未来/不存在来源不因 UUID 或伪话题快照变可点；跨本人/目标群直接拒绝',async()=>{
 const f=await fixture(false,true),other=await fixture(),missing=f.missing,raw=(await pool.query('select input_text from teloa_task_runs where owner_id=$1 and id=$2',[f.owner,f.final.run.id])).rows[0],input=JSON.parse(raw.input_text)
 input.groupTopic.messages.push({messageId:f.foreign.id,authorKind:'self',authorId:'self',authorName:'用户',text:f.foreign.text,createdAt:f.foreign.createdAt},{messageId:missing,authorKind:'self',authorId:'self',authorName:'用户',text:'不存在',createdAt:identity.now()})
 await pool.query('update teloa_task_runs set input_text=$3 where owner_id=$1 and id=$2',[f.owner,f.final.run.id,JSON.stringify(input)])
 const result=await f.groups.messageSources(f.owner,{groupId:f.group.id,messageId:f.final.delivery.id});assert.deepEqual(result.items.map(item=>item.message.id),f.ids);assert.equal(result.unavailableCount,3)
 await assert.rejects(f.groups.messageSources(other.owner,{groupId:f.group.id,messageId:f.final.delivery.id}),{code:'teloa/forbidden'})
 await assert.rejects(f.groups.messageSources(f.owner,{groupId:f.group.id,messageId:other.final.delivery.id}),{code:'teloa/forbidden'})
 await pool.query("delete from teloa_group_members where owner_id=$1 and group_id=$2 and member_key='self'",[f.owner,f.group.id]);await assert.rejects(f.groups.messageSources(f.owner,{groupId:f.group.id,messageId:f.final.delivery.id}),{code:'teloa/forbidden'})
})
test('旧消息没有可信 Run 来源时保持原文可读，不补造引用或写回历史',async()=>{
 const f=await fixture(true),before=(await pool.query('select row_to_json(t) row from teloa_group_messages t where id=$1',[f.final.delivery.id])).rows[0].row
 const result=await f.groups.messageSources(f.owner,{groupId:f.group.id,messageId:f.final.delivery.id});assert.equal(result.runId,null);assert.deepEqual(result.items,[]);assert.equal(result.unavailableCount,5)
 assert.deepEqual((await pool.query('select row_to_json(t) row from teloa_group_messages t where id=$1',[f.final.delivery.id])).rows[0].row,before)
 assert.equal((await pool.query('select count(*)::int n from teloa_group_run_sources where owner_id=$1',[f.owner])).rows[0].n,0)
})
test('错误 Run/Task/来源摘要和原回复正文不一致都拒绝；被引用正文变化不以同ID替代',async()=>{
 const f=await fixture(),input={groupId:f.group.id,messageId:f.final.delivery.id},read=()=>f.groups.messageSources(f.owner,input)
 for(const column of ['run_id','task_id'] as const){
  const old=(await pool.query('select '+column+' value from teloa_group_messages where id=$1',[f.final.delivery.id])).rows[0].value
  await pool.query('update teloa_group_messages set '+column+'=$2 where id=$1',[f.final.delivery.id,randomUUID()]);await assert.rejects(read(),{code:'teloa/storage-corrupt'});await pool.query('update teloa_group_messages set '+column+'=$2 where id=$1',[f.final.delivery.id,old])
 }
 // 源记录禁止 UPDATE；坏摘要用独立旧记录首次插入负夹具，不关闭不可变触发器。
 const bad=await fixture(true),run=bad.final.run;assert.ok(run.roleSnapshot&&run.lineage)
 const source={schema:'teloa.group-run-source/v2',ownerId:bad.owner,taskId:run.taskId,runId:run.id,roleId:run.roleId,roleVersion:run.roleVersion,roleKind:run.roleSnapshot.kind,roleName:run.roleSnapshot.name,lineage:run.lineage}
 await pool.query('insert into teloa_group_run_sources(owner_id,message_id,group_id,source,source_hash) values($1,$2,$3,$4,$5)',[bad.owner,bad.final.delivery.id,bad.group.id,JSON.stringify(source),'f'.repeat(64)])
 await assert.rejects(bad.groups.messageSources(bad.owner,{groupId:bad.group.id,messageId:bad.final.delivery.id}),{code:'teloa/storage-corrupt'})
 const original=f.final.delivery.text;await pool.query('update teloa_group_messages set text=$2 where id=$1',[f.final.delivery.id,original+'\n改动']);await assert.rejects(read(),{code:'teloa/source-unavailable'});await pool.query('update teloa_group_messages set text=$2 where id=$1',[f.final.delivery.id,original])
 await pool.query('update teloa_group_messages set text=$2 where id=$1',[f.first.id,'同ID被替换的原文']);const unavailable=await read();assert.equal(unavailable.items.some(item=>item.message.id===f.first.id),false);assert.equal(unavailable.unavailableCount,1)
})
