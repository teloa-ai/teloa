import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {CollaborationService,initializeCollaboration} from '../src/work/collaboration.ts'
import {initializeRoles} from '../src/work/roles.ts'
import {initializeRoleDelegations} from '../src/work/role-delegations.ts'
import {TaskService,initializeTasks} from '../src/work/tasks.ts'
import {GroupTaskService,initializeGroupTasks} from '../src/work/group-tasks.ts'

let pool:Pool,container:StartedPostgreSqlContainer,tick=0
const identity={id:randomUUID,now:()=>new Date(Date.parse('2026-10-15T00:00:00.000Z')+tick++*1000).toISOString()}
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeRoles(pool);await initializeRoleDelegations(pool);await initializeTasks(pool);await initializeCollaboration(pool);await initializeGroupTasks(pool)
})
after(async()=>{await pool?.end();await container?.stop()})
async function fixture(){
 const owner=randomUUID(),groups=new CollaborationService(pool,identity)
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'阅读位置群',scope:'general',announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},memberRoleIds:[]}})
 const send=(text:string,rootId?:string)=>groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text,...(rootId?{rootId}:{})})
 const employee=async(rootId:string|null,taskId:string=randomUUID(),id:string=randomUUID(),createdAt:string=identity.now())=>{
  await pool.query("insert into teloa_group_messages(id,owner_id,group_id,request_id,request_spec,root_id,author_id,task_id,run_id,text,reference_snapshot,mention_snapshot,created_at) values($1,$2,$3,$4,'{}',$5,$6,$7,$8,'员工正文','[]','[]',$9)",[id,owner,group.id,randomUUID(),rootId,randomUUID(),taskId,randomUUID(),createdAt])
  return {id,createdAt}
 }
 return {owner,groups,group,send,employee}
}
test('本人已读水位持久且单调；主群与话题隔离，读取不写入，旧消息没有虚构已读',async()=>{
 const f=await fixture()
 assert.equal(typeof f.groups.reading,'function','原群服务须提供真实阅读状态')
 const root=await f.send('本人话题根'),main=await f.employee(null),reply=await f.employee(root.id)
 const query={groupId:f.group.id}
 const before=await f.groups.reading(f.owner,query)
 assert.equal(before.cursor,null);assert.equal(before.unreadCount,1);assert.deepEqual(before.latest,{messageId:main.id,createdAt:main.createdAt})
 assert.equal((await pool.query('select count(*)::int n from teloa_group_read_cursors where owner_id=$1',[f.owner])).rows[0].n,0)
 const read=await f.groups.markRead(f.owner,{...query,messageId:main.id})
 assert.equal(read.unreadCount,0);assert.deepEqual(read.cursor,{messageId:main.id,createdAt:main.createdAt})
 const topic=await f.groups.reading(f.owner,{...query,rootId:root.id})
 assert.equal(topic.unreadCount,1);assert.equal(topic.cursor,null);assert.deepEqual(topic.latest,{messageId:reply.id,createdAt:reply.createdAt})
 await f.groups.markRead(f.owner,{...query,rootId:root.id,messageId:reply.id})
 assert.equal((await f.groups.reading(f.owner,{...query,rootId:root.id})).unreadCount,0)
 assert.deepEqual(await new CollaborationService(pool,identity).markRead(f.owner,{...query,messageId:main.id}),read)
 const later=await f.employee(null)
 await f.groups.markRead(f.owner,{...query,messageId:later.id})
 assert.deepEqual((await f.groups.markRead(f.owner,{...query,messageId:root.id})).cursor,{messageId:later.id,createdAt:later.createdAt},'迟到旧水位不得回退')
 assert.deepEqual((await f.groups.reading(f.owner,{...query,rootId:root.id})).cursor,{messageId:reply.id,createdAt:reply.createdAt})
 await assert.rejects(f.groups.reading(randomUUID(),query),{code:'teloa/forbidden'})
 await assert.rejects(f.groups.markRead(f.owner,{...query,messageId:reply.id}),{code:'teloa/forbidden'})
 await assert.rejects(f.groups.markRead(f.owner,{...query,rootId:root.id,messageId:later.id}),{code:'teloa/forbidden'})
 const other=await fixture(),foreign=await other.employee(null)
 await assert.rejects(f.groups.markRead(f.owner,{...query,messageId:foreign.id}),{code:'teloa/forbidden'})
 await assert.rejects(f.groups.reading(f.owner,{...query,rootId:reply.id}),{code:'teloa/forbidden'})
})
test('主群读取沿原v2上下文显示归属；同一时间戳以真实消息身份排序',async()=>{
 const f=await fixture()
 assert.equal(typeof f.groups.reading,'function')
 const root=await f.send('主群问题')
 const source=await new GroupTaskService(pool,identity,new TaskService(pool,identity)).create(f.owner,{requestId:randomUUID(),groupId:f.group.id,expectedGroupVersion:1,messageId:root.id,goal:'只回答',trigger:'routed',executionMode:'reply',routingAttemptVersion:1})
 const mainReply=await f.employee(root.id,source.task.id)
 assert.equal((await f.groups.reading(f.owner,{groupId:f.group.id})).unreadCount,1,'main上下文员工回帖仍属主群')
 await f.groups.markRead(f.owner,{groupId:f.group.id,messageId:mainReply.id})
 const at=identity.now(),low=await f.employee(null,randomUUID(),'11111111-1111-4111-8111-111111111111',at),high=await f.employee(null,randomUUID(),'ffffffff-ffff-4fff-8fff-ffffffffffff',at)
 assert.equal((await f.groups.reading(f.owner,{groupId:f.group.id})).unreadCount,2)
 await f.groups.markRead(f.owner,{groupId:f.group.id,messageId:high.id})
 const older=await f.groups.markRead(f.owner,{groupId:f.group.id,messageId:low.id})
 assert.deepEqual(older.cursor,{messageId:high.id,createdAt:high.createdAt});assert.equal(older.unreadCount,0)
})
