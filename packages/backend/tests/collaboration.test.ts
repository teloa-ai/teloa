import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {isMessageReference,type MessageReference} from '@teloa/contract'
import {initializeArtifactSnapshots} from '../src/work/artifact-snapshots.ts'
import {initializeArtifacts} from '../src/work/artifacts.ts'
import {CollaborationService,initializeCollaboration} from '../src/work/collaboration.ts'
import {GroupAttachmentService,initializeGroupAttachments} from '../src/work/group-attachments.ts'
import {artifactVersion as artifactVersionRow,attachmentPorts,uploadFile} from './group-attachment-test-fixture.ts'
import {GroupTaskService,initializeGroupTasks} from '../src/work/group-tasks.ts'
import {TaskService,initializeTasks} from '../src/work/tasks.ts'
import {GroupAgentGrantService,initializeGroupAgentGrants} from '../src/work/group-agent-grants.ts'
import {RoleService,initializeRoles} from '../src/work/roles.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import {initializeRoleDelegations} from '../src/work/role-delegations.ts'
const openGroupRules={historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true}

let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date('2026-09-12T09:00:00.000Z').toISOString()}

before(async()=>{
  process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
  process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
  container=await new PostgreSqlContainer('postgres:17-alpine').start()
  pool=new Pool({connectionString:container.getConnectionUri()})
  await initializeRoles(pool)
  await initializeRoleDelegations(pool)
  await initializeTasks(pool)
  await initializeCollaboration(pool)
  await initializeGroupTasks(pool)
  await initializeGroupAgentGrants(pool)
  await initializeArtifactSnapshots(pool)
  await initializeArtifacts(pool)
  await initializeGroupAttachments(pool)
})
after(async()=>{await pool?.end();await container?.stop()})

const fields=(memberRoleIds:string[]=[])=>(
  {name:'SOC 调查协作',scope:'SOC',announcement:'围绕固定证据协作。',rules:openGroupRules,memberRoleIds}
)
const roleFields={name:'调查岗',kind:'employee' as const,scopes:['SOC'],duty:'调查',dataScope:'固定证据',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility}
const setup=()=>{const tasks=new TaskService(pool,identity);return {owner:randomUUID(),groups:new CollaborationService(pool,identity),roles:new RoleService(pool,identity),grants:new GroupAgentGrantService(pool,identity.now),groupTasks:new GroupTaskService(pool,identity,tasks)}}

/** 本文件里 `artifactVersion` 固定用同一个测试时钟；夹具本体在 `group-attachment-test-fixture.ts`。 */
const artifactVersion=(owner:string)=>artifactVersionRow(pool,owner,identity.now())

test('创建群固定本人为成员，创建请求并发重试不重复写入',async()=>{
  const {owner,groups}=setup(),input={requestId:randomUUID(),expectedVersion:0 as const,fields:fields()}
  const [left,right]=await Promise.all([groups.create(owner,input),groups.create(owner,input)])
  assert.deepEqual(left,right)
  assert.equal(left.ownerId,owner)
  assert.equal(left.version,1)
  assert.equal((await pool.query('select count(*)::int as n from teloa_group_members where group_id=$1 and role_id is null',[left.id])).rows[0].n,1)
  assert.deepEqual(await groups.list(owner,{}),[left])
  assert.deepEqual(await groups.get(owner,{groupId:left.id}),{group:left,members:[{groupId:left.id,roleId:null,createdAt:left.createdAt}]})
  await assert.rejects(groups.get(owner,{groupId:left.id,rootId:randomUUID()}),{code:'teloa/invalid-input'})
  await assert.rejects(groups.get(randomUUID(),{groupId:left.id}),{code:'teloa/forbidden'})
  await assert.rejects(groups.create(owner,{...input,fields:{...fields(),name:'不同群'}}),{code:'teloa/conflict'})
})

test('群目录按置顶和最近更新时间稳定排序，供刷新后的客户端目录直接读取',async()=>{
 let tick=0
 const orderedIdentity={id:randomUUID,now:()=>new Date(Date.parse('2026-09-12T09:00:00.000Z')+tick++).toISOString()}
 const owner=randomUUID(),groups=new CollaborationService(pool,orderedIdentity)
 const first=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{...fields(),name:'较早的群'}})
 const second=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{...fields(),name:'较新的群'}})
 const pinned=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{...fields(),name:'置顶群'}})
 await groups.change(owner,{requestId:randomUUID(),groupId:pinned.id,expectedVersion:pinned.version,fields:{name:pinned.name,announcement:pinned.announcement,rules:pinned.rules,memberRoleIds:[],pinned:true,archived:false}})
 assert.deepEqual((await groups.list(owner,{})).map(group=>group.id),[pinned.id,second.id,first.id])
})

test('成员只接受本人当前在岗的数字岗位；群业务范围不限制成员来源（2026-09-21 用户裁定 B）',async()=>{
  const {owner,groups,roles}=setup(),role=await roles.create(owner,{requestId:randomUUID(),fields:roleFields})
  await pool.query("update teloa_roles set state='paused' where id=$1",[role.id]) // 创建后直接在岗，本用例要的是暂停岗位
  await assert.rejects(groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:fields([role.id])}),{code:'teloa/conflict'})
  await pool.query("update teloa_roles set state='active' where id=$1",[role.id])
  // 岗位只支持 SOC，群业务范围是 AppSec：成员不限业务范围，可正常加入。
  const crossScope=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{...fields([role.id]),scope:'AppSec'}})
  assert.deepEqual((await groups.get(owner,{groupId:crossScope.id})).members.map(member=>member.roleId).sort(),[null,role.id].sort())
  await assert.rejects(groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:fields([randomUUID()])}),{code:'teloa/forbidden'})
  const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:fields([role.id])})
  assert.equal((await pool.query('select count(*)::int as n from teloa_group_members where group_id=$1',[group.id])).rows[0].n,2)
  assert.deepEqual((await groups.get(owner,{groupId:group.id})).members.map(member=>member.roleId).sort(),[null,role.id].sort())
})

test('群业务范围与成员岗位范围不同时，成员仍能被提及、群内仍能正常发消息（2026-09-21 用户裁定 B）',async()=>{
  const {owner,groups,roles}=setup(),member=await roles.create(owner,{requestId:randomUUID(),fields:roleFields})
  const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{...fields([member.id]),scope:'AppSec'}})
  assert.equal(group.scope,'AppSec')
  const mention={roleId:member.id,expectedVersion:member.version}
  const message=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'请核对并请 @调查岗 处理。',mentions:[mention]})
  if(!('mentions' in message))throw Error('unreachable')
  assert.deepEqual(message.mentions,[mention])
})

test('群编辑以版本比较更新成员，旧版本和不同重试均不覆盖当前记录',async()=>{
  const {owner,groups,roles}=setup(),role=await roles.create(owner,{requestId:randomUUID(),fields:roleFields})
  await pool.query("update teloa_roles set state='active' where id=$1",[role.id])
  const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:fields()})
  const input={requestId:randomUUID(),groupId:group.id,expectedVersion:1,fields:{name:'SOC 核查群',announcement:'固定范围。',rules:openGroupRules,memberRoleIds:[role.id],pinned:true,archived:false}}
  const [left,right]=await Promise.all([groups.change(owner,input),groups.change(owner,input)])
  assert.deepEqual(left,right)
  assert.equal(left.version,2)
  assert.equal(left.pinned,true)
  await assert.rejects(groups.change(owner,{...input,requestId:randomUUID()}),{code:'teloa/version-conflict'})
  await assert.rejects(groups.change(owner,{...input,fields:{...input.fields,name:'不同内容'}}),{code:'teloa/conflict'})
})

test('消息固定本人作者、引用身份与同群根消息；跨群根消息不被接受',async()=>{
  const {owner,groups}=setup(),first=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:fields()}),second=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{...fields(),name:'另一群'}})
  const resource=await groups.saveResource(owner,{requestId:randomUUID(),groupId:first.id,resourceId:randomUUID(),expectedVersion:0,title:'prod-03 证据',markdown:'# prod-03\n\n固定线索。'})
  const rootInput={requestId:randomUUID(),groupId:first.id,expectedVersion:1,text:'请核验 prod-03。',references:[{kind:'group-resource',id:resource.id,version:resource.version}]}
  const root=await groups.send(owner,rootInput)
  assert.equal(root.authorId,'self')
  assert.equal(root.rootId,null)
  assert.deepEqual((await pool.query('select reference_snapshot from teloa_group_messages where id=$1',[root.id])).rows[0].reference_snapshot,root.references)
  assert.deepEqual(await groups.send(owner,rootInput),root)
  const reply=await groups.send(owner,{requestId:randomUUID(),groupId:first.id,expectedVersion:1,text:'已开始核验。',rootId:root.id})
  assert.equal(reply.rootId,root.id)
  await assert.rejects(groups.send(owner,{requestId:randomUUID(),groupId:second.id,expectedVersion:1,text:'错误线程。',rootId:root.id}),{code:'teloa/forbidden'})
  assert.deepEqual((await groups.messages(owner,{groupId:first.id,rootId:root.id})).map(item=>item.id),[root.id,reply.id])
})

test('群资料按不可变版本保存，跨群、旧版本和撤回后的新引用均被拒绝',async()=>{
  const {owner,groups}=setup(),first=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:fields()}),second=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{...fields(),name:'另一群'}})
  const create={requestId:randomUUID(),groupId:first.id,resourceId:randomUUID(),expectedVersion:0,title:'初版依据',markdown:'# 初版\n\n固定线索。'}
  const firstVersion=await groups.saveResource(owner,create)
  assert.equal(firstVersion.version,1)
  assert.deepEqual(await groups.saveResource(owner,create),firstVersion)
  const revised=await groups.saveResource(owner,{requestId:randomUUID(),groupId:first.id,resourceId:firstVersion.id,expectedVersion:1,title:'修订依据',markdown:'# 修订\n\n更正后的固定线索。'})
  assert.equal(revised.version,2)
  assert.deepEqual(await groups.resource(owner,{groupId:first.id,resourceId:revised.id,resourceVersion:1}),{resourceId:revised.id,groupId:first.id,version:1,title:'初版依据',markdown:'# 初版\n\n固定线索。',createdAt:firstVersion.createdAt})
  assert.deepEqual((await groups.resources(owner,{groupId:first.id})).map(item=>item.id),[revised.id])
  await assert.rejects(groups.send(owner,{requestId:randomUUID(),groupId:first.id,expectedVersion:1,text:'错误版本。',references:[{kind:'group-resource',id:revised.id,version:3}]}),{code:'teloa/forbidden'})
  await assert.rejects(groups.send(owner,{requestId:randomUUID(),groupId:second.id,expectedVersion:1,text:'跨群引用。',references:[{kind:'group-resource',id:revised.id,version:2}]}),{code:'teloa/forbidden'})
  const message=await groups.send(owner,{requestId:randomUUID(),groupId:first.id,expectedVersion:1,text:'引用修订依据。',references:[{kind:'group-resource',id:revised.id,version:2}]})
  const withdrawn=await groups.withdrawResource(owner,{requestId:randomUUID(),groupId:first.id,resourceId:revised.id,expectedVersion:2})
  assert.notEqual(withdrawn.withdrawnAt,null)
  assert.deepEqual((await groups.messages(owner,{groupId:first.id})).map(item=>item.id),[message.id])
  await assert.rejects(groups.send(owner,{requestId:randomUUID(),groupId:first.id,expectedVersion:1,text:'撤回后引用。',references:[{kind:'group-resource',id:revised.id,version:2}]}),{code:'teloa/forbidden'})
  await assert.rejects(groups.saveResource(owner,{requestId:randomUUID(),groupId:first.id,resourceId:revised.id,expectedVersion:2,title:'不应修订',markdown:'正文'}),{code:'teloa/conflict'})
})

test('群数字员工授权固定群、岗位和资料版本，撤回、岗位变化和撤销都会失效',async()=>{
 const {owner,groups,roles,grants}=setup(),role=await roles.create(owner,{requestId:randomUUID(),fields:roleFields})
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:fields([role.id])})
 const resource=await groups.saveResource(owner,{requestId:randomUUID(),groupId:group.id,resourceId:randomUUID(),expectedVersion:0,title:'已核验资料',markdown:'# 证据\n\n固定版本。'})
 const input={requestId:randomUUID(),groupId:group.id,roleId:role.id,expectedGroupVersion:group.version,expectedRoleVersion:role.version,action:'save' as const,resources:[{kind:'group-resource',id:resource.id,version:resource.version}],canPost:true,canAutoRun:false}
 // 拉同事进群时 C1 已默认签过一版，本人自己保存的这版按实际值往后排一位。
 const defaulted=(await grants.get(owner,{groupId:group.id,roleId:role.id})).grant
 const [left,right]=await Promise.all([grants.change(owner,input),grants.change(owner,input)])
 assert.deepEqual(left,right)
 assert.equal(left.state,'active')
 assert.equal(left.grantVersion,(defaulted?.grantVersion??0)+1)
 assert.deepEqual(await grants.get(owner,{groupId:group.id,roleId:role.id}),{groupVersion:group.version,roleVersion:role.version,grant:left,status:'active'})
 await assert.rejects(grants.change(owner,{...input,requestId:randomUUID(),resources:[{kind:'group-resource',id:randomUUID(),version:1}]}),{code:'teloa/forbidden'})
 const withdrawn=await groups.withdrawResource(owner,{requestId:randomUUID(),groupId:group.id,resourceId:resource.id,expectedVersion:resource.version})
 assert.notEqual(withdrawn.withdrawnAt,null)
 assert.equal((await grants.get(owner,{groupId:group.id,roleId:role.id})).status,'invalidated')
 // 授权记录保留，但撤回后不允许新的授权写入。
 await assert.rejects(grants.change(owner,{...input,requestId:randomUUID()}),{code:'teloa/forbidden'})
 await pool.query("update teloa_roles set state='paused',version=version+1 where id=$1",[role.id])
 assert.equal((await grants.get(owner,{groupId:group.id,roleId:role.id})).status,'invalidated')
 await pool.query("update teloa_roles set state='active',version=version+1 where id=$1",[role.id])
 assert.equal((await grants.get(owner,{groupId:group.id,roleId:role.id})).status,'invalidated')
 const current=await groups.get(owner,{groupId:group.id})
 const revoked=await grants.change(owner,{requestId:randomUUID(),groupId:group.id,roleId:role.id,expectedGroupVersion:current.group.version,expectedRoleVersion:role.version+2,action:'revoke',resources:[],canPost:false,canAutoRun:false})
 assert.equal(revoked.state,'revoked')
 assert.equal((await grants.get(owner,{groupId:group.id,roleId:role.id})).status,'revoked')
})


test('群消息转任务固定消息、话题根和群版本，重试不重复创建且成员边界不被绕过',async()=>{
 const {owner,groups,roles,groupTasks}=setup(),role=await roles.create(owner,{requestId:randomUUID(),fields:roleFields})
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:fields([role.id])})
 const root=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'请研判此告警的影响和处置优先级。'})
 const reply=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'补充：关联到生产资产。',rootId:root.id})
 const input={requestId:randomUUID(),groupId:group.id,messageId:reply.id,expectedGroupVersion:group.version,goal:'形成可审计的研判结论。',assignee:{roleId:role.id,expectedVersion:role.version}}
 const [left,right]=await Promise.all([groupTasks.create(owner,input),groupTasks.create(owner,input)])
 assert.deepEqual(left,right)
 assert.equal(left.task.scope,'SOC')
 assert.equal(left.task.assigneeRoleId,role.id)
 assert.equal(left.source.messageId,reply.id)
 assert.equal(left.source.rootId,root.id)
 assert.equal(left.source.messageText,reply.text)
 assert.equal(left.source.groupVersion,group.version)
 assert.deepEqual(await groupTasks.source(owner,{taskId:left.task.id}),left.source)
 await assert.rejects(groupTasks.create(owner,{...input,requestId:randomUUID(),expectedGroupVersion:group.version+1}),{code:'teloa/version-conflict'})
 const unrelated=await roles.create(owner,{requestId:randomUUID(),fields:roleFields})
 await assert.rejects(groupTasks.create(owner,{...input,requestId:randomUUID(),assignee:{roleId:unrelated.id,expectedVersion:unrelated.version}}),{code:'teloa/forbidden'})
 await assert.rejects(groupTasks.create(owner,{...input,requestId:randomUUID(),messageId:randomUUID()}),{code:'teloa/forbidden'})
})

test('群消息任务运行上下文只读取来源引用的已授权固定资料版本',async()=>{
 const {owner,groups,roles,grants,groupTasks}=setup(),role=await roles.create(owner,{requestId:randomUUID(),fields:roleFields})
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:fields([role.id])})
 const resource=await groups.saveResource(owner,{requestId:randomUUID(),groupId:group.id,resourceId:randomUUID(),expectedVersion:0,title:'生产告警证据',markdown:'# prod-03\n\n固定上下文。'})
 const message=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'请给出研判结论。',references:[{kind:'group-resource',id:resource.id,version:resource.version}]})
 const created=await groupTasks.create(owner,{requestId:randomUUID(),groupId:group.id,messageId:message.id,expectedGroupVersion:group.version,goal:'形成结论。',assignee:{roleId:role.id,expectedVersion:role.version}})
 await grants.change(owner,{requestId:randomUUID(),groupId:group.id,roleId:role.id,expectedGroupVersion:group.version,expectedRoleVersion:role.version,action:'save',resources:[{kind:'group-resource',id:resource.id,version:resource.version}],canPost:false,canAutoRun:false})
 const {readRunGroupContext}=await import('../src/work/task-run-group-context.ts')
 const db=await pool.connect()
 try{
  await db.query('begin')
  const context=await readRunGroupContext(db,owner,created.task,role)
  assert.equal(context?.source.messageId,message.id)
  assert.deepEqual(context?.materials,[{resourceId:resource.id,resourceVersion:1,title:'生产告警证据',markdown:'# prod-03\n\n固定上下文。'}])
  await db.query('commit')
 }catch(error){await db.query('rollback');throw error}finally{db.release()}
})

test('损坏的群消息行以 teloa/storage-corrupt 停止读取，而不是抛出没有错误码的裸错误',async()=>{
 const {owner,groups}=setup()
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:fields()})
 const message=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'请核对这条证据。'})
 await pool.query('update teloa_group_messages set text=$2 where id=$1',[message.id,'   '])
 await assert.rejects(groups.messages(owner,{groupId:group.id}),{code:'teloa/storage-corrupt'})
})

test('群提及固定在岗数字员工成员且岗位版本匹配，非成员、分身与版本过期均被拒绝，不传时回包为空数组',async()=>{
 const {owner,groups,roles}=setup()
 const member=await roles.create(owner,{requestId:randomUUID(),fields:roleFields})
 const outsider=await roles.create(owner,{requestId:randomUUID(),fields:{...roleFields,name:'非本群岗'}})
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:fields([member.id])})
 const mention={roleId:member.id,expectedVersion:member.version}
 const withMentions=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'请核对并请 @调查岗 处理。',mentions:[mention]})
 if(!('mentions' in withMentions))throw Error('unreachable')
 assert.deepEqual(withMentions.mentions,[mention])
 const reread=(await groups.messages(owner,{groupId:group.id})).find(item=>item.id===withMentions.id)
 if(!reread||!('mentions' in reread))throw Error('unreachable')
 assert.deepEqual(reread.mentions,[mention])
 const withoutMentions=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'不提及任何人。'})
 if(!('mentions' in withoutMentions))throw Error('unreachable')
 assert.deepEqual(withoutMentions.mentions,[])
 await assert.rejects(groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'提及非成员。',mentions:[{roleId:outsider.id,expectedVersion:outsider.version}]}),{code:'teloa/forbidden'})
 await pool.query("update teloa_roles set definition=jsonb_set(definition,'{kind}','\"twin\"') where id=$1",[member.id])
 await assert.rejects(groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'提及分身。',mentions:[mention]}),{code:'teloa/forbidden'})
 await pool.query("update teloa_roles set definition=jsonb_set(definition,'{kind}','\"employee\"') where id=$1",[member.id])
 await assert.rejects(groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'岗位版本过期。',mentions:[{roleId:member.id,expectedVersion:member.version+1}]}),{code:'teloa/version-conflict'})
 await pool.query("update teloa_roles set state='paused' where id=$1",[member.id])
 await assert.rejects(groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'暂停后仍被提及。',mentions:[mention]}),{code:'teloa/forbidden'})
})

test('老消息行（mention_snapshot 取列缺省值）读出 mentions:[] 而不是损坏',async()=>{
 const {owner,groups}=setup()
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:fields()})
 const legacyId=randomUUID()
 await pool.query("insert into teloa_group_messages(id,owner_id,group_id,request_id,request_spec,root_id,author_id,text,reference_snapshot,created_at) values($1,$2,$3,$4,'{}'::jsonb,null,'self',$5,'[]'::jsonb,$6)",[legacyId,owner,group.id,randomUUID(),'本字段上线前的老消息行。',identity.now()])
 const legacy=(await groups.messages(owner,{groupId:group.id})).find(item=>item.id===legacyId)
 if(!legacy||!('mentions' in legacy))throw Error('unreachable')
 assert.deepEqual(legacy.mentions,[])
})

test('群提及超过上限或重复在契约层被拦下，同一请求换提及内容判为冲突',async()=>{
 const {owner,groups,roles}=setup()
 const member=await roles.create(owner,{requestId:randomUUID(),fields:roleFields})
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:fields([member.id])})
 const nineMentions=Array.from({length:9},()=>({roleId:randomUUID(),expectedVersion:1}))
 await assert.rejects(groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'超过上限。',mentions:nineMentions}),{code:'teloa/invalid-input'})
 const duplicateMentions=[{roleId:member.id,expectedVersion:member.version},{roleId:member.id,expectedVersion:member.version}]
 await assert.rejects(groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'重复提及。',mentions:duplicateMentions}),{code:'teloa/invalid-input'})
 const requestId=randomUUID()
 await groups.send(owner,{requestId,groupId:group.id,expectedVersion:group.version,text:'相同请求。',mentions:[{roleId:member.id,expectedVersion:member.version}]})
 await assert.rejects(groups.send(owner,{requestId,groupId:group.id,expectedVersion:group.version,text:'相同请求。'}),{code:'teloa/conflict'})
})

test('群消息引用三类原件：群资料仍限本群，本人级附件与成果可跨群引用',async()=>{
  const {owner,groups}=setup(),attachments=new GroupAttachmentService(pool,identity,attachmentPorts())
  const first=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:fields()})
  const second=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{...fields(),name:'另一群'}})
  const resource=await groups.saveResource(owner,{requestId:randomUUID(),groupId:first.id,resourceId:randomUUID(),expectedVersion:0,title:'prod-03 证据',markdown:'# prod-03\n\n固定线索。'})
  const attachment=await uploadFile(attachments,owner,first.id,first.version,'A 群上传的原件。')
  const artifactId=await artifactVersion(owner)
  const references:MessageReference[]=[
    {kind:'group-resource',id:resource.id,version:resource.version},
    {kind:'attachment',id:attachment.attachmentId,version:1},
    {kind:'artifact',id:artifactId,version:1}
  ]
  const message=await groups.send(owner,{requestId:randomUUID(),groupId:first.id,expectedVersion:first.version,text:'请核对这三件原件。',references})
  assert.deepEqual(message.references,references)
  assert.ok(message.references.every(isMessageReference))
  const listed=(await groups.messages(owner,{groupId:first.id})).find(item=>item.id===message.id)
  assert.deepEqual(listed?.references,references)
  // 用户引用口径裁定第 3 条：附件与成果是本人级原件，B 群可以引用 A 群上传的那一件。
  const crossGroup=await groups.send(owner,{requestId:randomUUID(),groupId:second.id,expectedVersion:second.version,text:'跨群引用本人原件。',references:[references[1],references[2]]})
  assert.deepEqual(crossGroup.references,[references[1],references[2]])
  // 群资料的原件归属就是群，本群限制不变。
  await assert.rejects(groups.send(owner,{requestId:randomUUID(),groupId:second.id,expectedVersion:second.version,text:'跨群引用群资料。',references:[references[0]]}),{code:'teloa/forbidden'})
  const outsider=await artifactVersion(randomUUID())
  await assert.rejects(groups.send(owner,{requestId:randomUUID(),groupId:first.id,expectedVersion:first.version,text:'引用别人的成果。',references:[{kind:'artifact',id:outsider,version:1}]}),{code:'teloa/forbidden'})
  await assert.rejects(groups.send(owner,{requestId:randomUUID(),groupId:first.id,expectedVersion:first.version,text:'引用不存在的成果版本。',references:[{kind:'artifact',id:artifactId,version:2}]}),{code:'teloa/forbidden'})
})

test('引用已撤回附件、已撤回群资料与不存在的成果版本回同一个错误码，不作存在性探测',async()=>{
  const {owner,groups}=setup(),attachments=new GroupAttachmentService(pool,identity,attachmentPorts())
  const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:fields()})
  const attachment=await uploadFile(attachments,owner,group.id,group.version,'待撤回的原件。')
  await attachments.withdraw(owner,{requestId:randomUUID(),attachmentId:attachment.attachmentId})
  const resource=await groups.saveResource(owner,{requestId:randomUUID(),groupId:group.id,resourceId:randomUUID(),expectedVersion:0,title:'待撤回资料',markdown:'# 待撤回\n\n固定线索。'})
  await groups.withdrawResource(owner,{requestId:randomUUID(),groupId:group.id,resourceId:resource.id,expectedVersion:resource.version})
  // 他人上传的附件：原件真实存在且在用，只是不属本人。
  const outsider=randomUUID()
  const outsiderGroup=await groups.create(outsider,{requestId:randomUUID(),expectedVersion:0,fields:{...fields(),name:'别人的群'}})
  const outsiderAttachment=await uploadFile(new GroupAttachmentService(pool,identity,attachmentPorts()),outsider,outsiderGroup.id,outsiderGroup.version,'别人上传的原件。')
  const probes:MessageReference[]=[
    {kind:'attachment',id:attachment.attachmentId,version:1},
    {kind:'group-resource',id:resource.id,version:resource.version},
    {kind:'artifact',id:randomUUID(),version:1},
    {kind:'attachment',id:outsiderAttachment.attachmentId,version:1},
    {kind:'attachment',id:'sha256:'+'0'.repeat(64),version:1}
  ]
  const errors=[]
  for(const reference of probes)errors.push(await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'引用不可见原件。',references:[reference]}).then(()=>null,(error:{code:string;message:string})=>error))
  assert.deepEqual(errors.map(error=>error?.code),Array(5).fill('teloa/forbidden'))
  // 两类本人级原件不区分「不属本人」「不存在」「已撤回」，同一句话。
  assert.deepEqual(errors.filter((_error,index)=>index!==1).map(error=>error?.message),Array(4).fill(errors[0]?.message))
})

test('旧二元组引用行读回归一化成群资料引用，消息与数字员工授权都不判损坏',async()=>{
  const {owner,groups,roles,grants}=setup(),role=await roles.create(owner,{requestId:randomUUID(),fields:roleFields})
  const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:fields([role.id])})
  const resource=await groups.saveResource(owner,{requestId:randomUUID(),groupId:group.id,resourceId:randomUUID(),expectedVersion:0,title:'历史资料',markdown:'# 历史\n\n固定线索。'})
  const normalized:MessageReference[]=[{kind:'group-resource',id:resource.id,version:resource.version}]
  const message=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'历史消息。',references:normalized})
  await grants.change(owner,{requestId:randomUUID(),groupId:group.id,roleId:role.id,expectedGroupVersion:group.version,expectedRoleVersion:role.version,action:'save',resources:normalized,canPost:false,canAutoRun:false})
  const legacy=JSON.stringify([{resourceId:resource.id,resourceVersion:resource.version}])
  await pool.query('update teloa_group_messages set reference_snapshot=$2::jsonb where id=$1',[message.id,legacy])
  await pool.query('update teloa_group_agent_grants set resources=$3::jsonb where group_id=$1 and role_id=$2',[group.id,role.id,legacy])
  assert.deepEqual((await groups.messages(owner,{groupId:group.id})).find(item=>item.id===message.id)?.references,normalized)
  assert.deepEqual((await grants.get(owner,{groupId:group.id,roleId:role.id})).grant?.resources,normalized)
})

test('同一发送请求换引用判冲突，两条并发消息可以同时引用同一件原件',async()=>{
  const {owner,groups}=setup(),attachments=new GroupAttachmentService(pool,identity,attachmentPorts())
  const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:fields()})
  const attachment=await uploadFile(attachments,owner,group.id,group.version,'并发引用的原件。')
  const reference:MessageReference={kind:'attachment',id:attachment.attachmentId,version:1}
  const input={requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'引用同一件原件。',references:[reference]}
  const message=await groups.send(owner,input)
  assert.deepEqual(message.references,[reference])
  await assert.rejects(groups.send(owner,{...input,references:[]}),{code:'teloa/conflict'})
  const [left,right]=await Promise.all([groups.send(owner,{...input,requestId:randomUUID()}),groups.send(owner,{...input,requestId:randomUUID()})])
  assert.notEqual(left.id,right.id)
  assert.deepEqual(left.references,[reference])
  assert.deepEqual(right.references,[reference])
})
