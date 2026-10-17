import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeTeloaDatabase} from '../src/work/initialize-database.ts'
import {CollaborationService} from '../src/work/collaboration.ts'
import {GroupAgentGrantService} from '../src/work/group-agent-grants.ts'
import {GroupTaskService} from '../src/work/group-tasks.ts'
import {TaskService} from '../src/work/tasks.ts'
import {RoleService} from '../src/work/roles.ts'
import {groupConversationNotice,readGroupConversationTopic,readRunGroupTopic} from '../src/work/group-topic.ts'
import {readGroupTaskExecutionMode} from '../src/work/group-execution-policy.ts'
import type {RunGroupContext} from '../src/work/task-run-group-context.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'

let container:StartedPostgreSqlContainer,pool:Pool,tick=0
const identity={id:randomUUID,now:()=>new Date(Date.parse('2026-10-14T09:00:00.000Z')+(tick++)*1000).toISOString()}
const rules={historyVisibleToNewMembers:false,draftsVisibleInGroup:true,mentionAllAllowed:true}
before(async()=>{container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeTeloaDatabase(pool)},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})

async function employeeReply(owner:string,groupId:string,rootId:string,roleId:string,text:string){
 const id=randomUUID()
 await pool.query('insert into teloa_group_messages(id,owner_id,group_id,request_id,request_spec,root_id,author_id,text,reference_snapshot,created_at,task_id,run_id) values($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb,$10,$11,$12)',[id,owner,groupId,randomUUID(),'{}',rootId,roleId,text,'[]',identity.now(),randomUUID(),randomUUID()])
 return id
}

test('真实连续上下文：主群追问读到上一根话题的回答，排除水位之后与其他群；新成员看不到入群前历史；回复来源 v2 固定空工具策略',async()=>{
 const owner='conversation-test:'+randomUUID(),roles=new RoleService(pool,identity),groups=new CollaborationService(pool,identity),grants=new GroupAgentGrantService(pool,identity.now),groupTasks=new GroupTaskService(pool,identity,new TaskService(pool,identity))
 const role=(name:string)=>roles.create(owner,{requestId:randomUUID(),fields:{name,kind:'employee',scopes:['SOC'],duty:'核对预算',dataScope:'群内资料',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 const a=await role('预算员'),b=await role('后加入的核对员')
 let group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'预算群',scope:'general',announcement:'',rules,memberRoleIds:[a.id]}})
 const other=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'别的群',scope:'general',announcement:'',rules,memberRoleIds:[a.id]}})
 await groups.send(owner,{requestId:randomUUID(),groupId:other.id,expectedVersion:other.version,text:'别群的机密数字 999。'})
 const send=(text:string)=>groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text})
 const asked=await send('这个项目预算多少？')
 await employeeReply(owner,group.id,asked.id,a.id,'预算还剩 680 元。')
 const follow=await send('还剩多少？不要修改任何记录。')
 await send('触发之后才到的消息。')
 await grants.change(owner,{requestId:randomUUID(),groupId:group.id,roleId:a.id,expectedGroupVersion:group.version,expectedRoleVersion:a.version,action:'save',resources:[],canPost:true,canAutoRun:true})
 const created=await groupTasks.create(owner,{requestId:randomUUID(),groupId:group.id,messageId:follow.id,expectedGroupVersion:group.version,goal:'回应',assignee:{roleId:a.id,expectedVersion:a.version},trigger:'routed',executionMode:'reply',routingAttemptVersion:1})
 assert.equal(created.source.schema,'teloa.group-task-source/v2')
 assert.deepEqual(created.source.schema==='teloa.group-task-source/v2'&&[created.source.contextMode,created.source.executionMode,created.source.routingAttemptVersion,created.source.messageText],['main','reply',1,'还剩多少？不要修改任何记录。'])
 assert.equal(await readGroupTaskExecutionMode(pool,owner,created.task.id),'reply')
 const db=await pool.connect()
 try{
  const topic=await readRunGroupTopic(db,owner,{taskId:created.task.id,groupId:group.id,roleId:a.id,source:{messageId:follow.id,rootId:follow.id,createdAt:follow.createdAt,text:follow.text}} as RunGroupContext)
  assert.equal(topic?.notice,groupConversationNotice)
  const texts=topic?.messages.map(message=>message.text)??[]
  assert.ok(texts.includes('预算还剩 680 元。'),'上一主群根话题里的回答进入当前追问的上下文')
  assert.ok(!texts.includes('触发之后才到的消息。'),'触发水位之后的消息不进入')
  assert.ok(!texts.some(text=>text.includes('999')),'不读其他群')
  group=await groups.change(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,fields:{name:group.name,announcement:'',rules,memberRoleIds:[a.id,b.id],pinned:false,archived:false}})
  const later=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'新同事也看一下。',replyToMessageId:asked.id})
  const forNewMember=await readGroupConversationTopic(db,owner,{groupId:group.id,messageId:later.id,replyToMessageId:asked.id,mode:'main',roleId:b.id})
  assert.deepEqual(forNewMember?.messages.map(message=>message.text),['新同事也看一下。'],'入群前历史与被引用的旧消息都不注入新成员')
  const forOwner=await readGroupConversationTopic(db,owner,{groupId:group.id,messageId:later.id,replyToMessageId:asked.id,mode:'main',roleId:null})
  assert.ok(forOwner?.messages.some(message=>message.text==='这个项目预算多少？'),'本人路由可见面保留引用锚点')
 }finally{db.release()}
})
