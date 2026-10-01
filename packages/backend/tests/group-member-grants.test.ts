import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {CollaborationService,initializeCollaboration} from '../src/work/collaboration.ts'
import {GroupAgentGrantService,initializeGroupAgentGrants} from '../src/work/group-agent-grants.ts'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {initializeRoleLifecycle,RoleLifecycleService} from '../src/work/role-lifecycle.ts'
import {initializeTasks} from '../src/work/tasks.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
const openGroupRules={historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true}

let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date('2026-09-21T09:00:00.000Z').toISOString()}

before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeRoles(pool);await initializeTasks(pool);await initializeRoleLifecycle(pool);await initializeCollaboration(pool);await initializeGroupAgentGrants(pool)
})
after(async()=>{await pool?.end();await container?.stop()})

/** 与 `collaboration.ts` 的 `defaultGrantRequestId` 同式重算：派生公式一变，这里立刻红。 */
const defaultGrantRequestId=(owner:string,groupId:string,roleId:string):string=>{
 const value=createHash('sha256').update(['teloa/group-member-default-grant/v1',owner,groupId,roleId].join('\0')).digest('hex')
 return `${value.slice(0,8)}-${value.slice(8,12)}-5${value.slice(13,16)}-a${value.slice(17,20)}-${value.slice(20,32)}`
}

/** 与 `collaboration.ts` 的 `renewedGrantRequestId` 同式重算：多一个群版本分量，每个群版本只续得出一行。 */
const renewedGrantRequestId=(owner:string,groupId:string,roleId:string,groupVersion:number):string=>{
 const value=createHash('sha256').update(['teloa/group-member-grant-renewal/v1',owner,groupId,roleId,String(groupVersion)].join('\0')).digest('hex')
 return `${value.slice(0,8)}-${value.slice(8,12)}-5${value.slice(13,16)}-a${value.slice(17,20)}-${value.slice(20,32)}`
}

const roleFields={name:'调查岗',kind:'employee' as const,scopes:['SOC'],duty:'调查',dataScope:'固定证据',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility}

/** 与 `collaboration.ts` 的 `roleRenewedGrantRequestId` 同式重算：分量是岗位版本，每个岗位版本只续得出一行。 */
const roleRenewedGrantRequestId=(owner:string,groupId:string,roleId:string,roleVersion:number):string=>{
 const value=createHash('sha256').update(['teloa/group-role-grant-renewal/v1',owner,groupId,roleId,String(roleVersion)].join('\0')).digest('hex')
 return `${value.slice(0,8)}-${value.slice(8,12)}-5${value.slice(13,16)}-a${value.slice(17,20)}-${value.slice(20,32)}`
}

/**
 * 一位同事同时在两个群里，两个群都已有默认授权。改使命的完整动线是「暂停 → 改定义 → 恢复在岗」，
 * 三步各把岗位版本 +1，所以续签必须在改定义与恢复两笔里各跑一次。
 */
async function roleInTwoGroups(){
 const owner=randomUUID(),roles=new RoleService(pool,identity),groups=new CollaborationService(pool,identity),lifecycle=new RoleLifecycleService(pool,identity)
 const role=await roles.create(owner,{requestId:randomUUID(),fields:roleFields})
 const make=(name:string)=>groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name,scope:'SOC',announcement:'固定范围。',rules:openGroupRules,memberRoleIds:[role.id]}})
 const first=await make('一号群'),second=await make('二号群')
 const rows=async(groupId:string)=>(await pool.query('select * from teloa_group_agent_grants where group_id=$1 and role_id=$2 order by grant_version',[groupId,role.id])).rows
 /** 暂停 → 改使命 → 恢复在岗，返回恢复之后的岗位。 */
 const changeDuty=async(duty:string)=>{
  const paused=await lifecycle.change(owner,{roleId:role.id,expectedVersion:role.version,action:'pause',reason:'改使命前暂停。'})
  const edited=await roles.edit(owner,{roleId:role.id,expectedVersion:paused.appliedVersion,fields:{...roleFields,duty}})
  const resumed=await lifecycle.change(owner,{roleId:role.id,expectedVersion:edited.version,action:'resume',reason:'改完恢复在岗。'})
  return resumed.role
 }
 return {owner,role,first,second,roles,groups,lifecycle,rows,changeDuty,grants:new GroupAgentGrantService(pool,identity.now)}
}

/** 建一个空成员的群与两位在岗数字员工；成员一律靠 `groups.change` 拉进来，差集判据才有观察面。 */
async function emptyGroup(){
 const owner=randomUUID(),roles=new RoleService(pool,identity),groups=new CollaborationService(pool,identity)
 const first=await roles.create(owner,{requestId:randomUUID(),fields:roleFields})
 const second=await roles.create(owner,{requestId:randomUUID(),fields:{...roleFields,name:'复核岗'}})
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'默认授权测试群',scope:'SOC',announcement:'固定范围。',rules:openGroupRules,memberRoleIds:[]}})
 let version=group.version
 const members=async(roleIds:string[],archived=false,name=group.name)=>{
  const saved=await groups.change(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:version,fields:{name,announcement:group.announcement,rules:openGroupRules,memberRoleIds:roleIds,pinned:false,archived}})
  version=saved.version
  return saved
 }
 const rows=async(roleId?:string)=>(await pool.query(
  roleId?'select * from teloa_group_agent_grants where group_id=$1 and role_id=$2 order by grant_version':'select * from teloa_group_agent_grants where group_id=$1 order by role_id,grant_version',
  roleId?[group.id,roleId]:[group.id])).rows
 return {owner,group,first,second,roles,groups,members,rows,grants:new GroupAgentGrantService(pool,identity.now),version:()=>version}
}

test('建群时就选同事：默认授权在建群那一笔里当场成立',async()=>{
 const owner=randomUUID(),roles=new RoleService(pool,identity),groups=new CollaborationService(pool,identity)
 const role=await roles.create(owner,{requestId:randomUUID(),fields:roleFields})
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'建群带成员',scope:'SOC',announcement:'固定范围。',rules:openGroupRules,memberRoleIds:[role.id]}})
 const read=await new GroupAgentGrantService(pool,identity.now).get(owner,{groupId:group.id,roleId:role.id})
 assert.equal(read.status,'active')
 assert.equal(read.grant?.canAutoRun,true)
 assert.equal(read.grant?.canPost,true)
 assert.equal(read.grant?.grantVersion,1)
})

test('首次拉进群：默认签发 canAutoRun 与 canPost 都为真',async()=>{
 const f=await emptyGroup()
 await f.members([f.first.id])
 const read=await f.grants.get(f.owner,{groupId:f.group.id,roleId:f.first.id})
 assert.equal(read.status,'active')
 assert.equal(read.grant?.canAutoRun,true)
 assert.equal(read.grant?.canPost,true)
 assert.deepEqual(read.grant?.resources,[])
 assert.equal(read.grant?.state,'active')
 assert.equal(read.grant?.grantVersion,1)
 // 请求身份确定性派生：同群同人只可能有这一条默认行，重放不签第二版。
 assert.equal((await f.rows(f.first.id))[0].request_id,defaultGrantRequestId(f.owner,f.group.id,f.first.id))
})

test('业务群里范围不一致的同事：不签发',async()=>{
 const f=await emptyGroup()
 const outsider=await f.roles.create(f.owner,{requestId:randomUUID(),fields:{...roleFields,name:'应用安全岗',scopes:['AppSec']}})
 await f.members([outsider.id])
 assert.deepEqual(await f.rows(outsider.id),[])
})

test('通用工作群对任何范围的同事开放：SOC 岗位照样拿到默认授权',async()=>{
 const owner=randomUUID(),roles=new RoleService(pool,identity),groups=new CollaborationService(pool,identity)
 const role=await roles.create(owner,{requestId:randomUUID(),fields:roleFields})
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'通用工作群',scope:'general',announcement:'不绑业务数据。',rules:openGroupRules,memberRoleIds:[role.id]}})
 const read=await new GroupAgentGrantService(pool,identity.now).get(owner,{groupId:group.id,roleId:role.id})
 assert.equal(read.status,'active')
 assert.equal(read.grant?.canAutoRun,true)
 assert.equal(read.grant?.canPost,true)
})

test('补签既有群：第一次把没有授权行的成员补齐，第二次返回 0',async()=>{
 const f=await emptyGroup()
 await f.members([f.first.id,f.second.id])
 // 造一个默认签发上线前建的群：成员在、一行授权都没有。
 await pool.query('delete from teloa_group_agent_grants where group_id=$1',[f.group.id])
 assert.equal(await f.groups.backfillDefaultGrants(f.owner),2)
 for(const roleId of [f.first.id,f.second.id])assert.equal((await f.grants.get(f.owner,{groupId:f.group.id,roleId})).status,'active')
 assert.equal(await f.groups.backfillDefaultGrants(f.owner),0)
})

test('默认签发上线之后建的群不补签：补签只修更早的群',async()=>{
 const owner=randomUUID(),late={id:randomUUID,now:()=>'2026-09-21T13:00:00.000Z'}
 const role=await new RoleService(pool,late).create(owner,{requestId:randomUUID(),fields:roleFields})
 const groups=new CollaborationService(pool,late)
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'上线之后建的群',scope:'SOC',announcement:'固定范围。',rules:openGroupRules,memberRoleIds:[role.id]}})
 // 建群那一笔已经签过；把它删掉模拟「没有授权行」，补签仍应当认出这是界之后的群而不去补。
 await pool.query('delete from teloa_group_agent_grants where group_id=$1',[group.id])
 assert.equal(await groups.backfillDefaultGrants(owner),0)
 assert.deepEqual((await pool.query('select * from teloa_group_agent_grants where group_id=$1',[group.id])).rows,[])
})

test('一群补不上不影响其余群：坏群只记一行告警，好群照常签出',async()=>{
 const broken=await emptyGroup()
 await broken.members([broken.first.id])
 const healthy=await new CollaborationService(pool,identity).create(broken.owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'同一本人的另一个群',scope:'SOC',announcement:'固定范围。',rules:openGroupRules,memberRoleIds:[broken.second.id]}})
 await pool.query('delete from teloa_group_agent_grants where owner_id=$1',[broken.owner])
 // 群定义损坏：这一群的事务必须自己回滚，不能把另一群的签发一起带走。
 await pool.query("update teloa_groups set definition='{}'::jsonb where id=$1",[broken.group.id])
 const reported:[string,string][]=[]
 assert.equal(await broken.groups.backfillDefaultGrants(broken.owner,(groupId,code)=>{reported.push([groupId,code])}),1)
 assert.deepEqual(reported,[[broken.group.id,'teloa/storage-corrupt']])
 assert.deepEqual(await broken.rows(),[])
 assert.equal((await pool.query('select count(*)::int c from teloa_group_agent_grants where group_id=$1',[healthy.id])).rows[0].c,1)
})

test('补签不复活已撤销的授权',async()=>{
 const f=await emptyGroup()
 await f.members([f.first.id])
 await f.grants.change(f.owner,{requestId:randomUUID(),groupId:f.group.id,roleId:f.first.id,expectedGroupVersion:f.version(),expectedRoleVersion:f.first.version,action:'revoke',resources:[],canPost:false,canAutoRun:false})
 const before=await f.rows(f.first.id)
 assert.equal(await f.groups.backfillDefaultGrants(f.owner),0)
 assert.deepEqual(await f.rows(f.first.id),before)
 assert.equal((await f.grants.get(f.owner,{groupId:f.group.id,roleId:f.first.id})).status,'revoked')
})

test('归档群不补签',async()=>{
 const f=await emptyGroup()
 await f.members([f.first.id],true)
 assert.deepEqual(await f.rows(),[])
 assert.equal(await f.groups.backfillDefaultGrants(f.owner),0)
 assert.deepEqual(await f.rows(),[])
})

test('分身成员：不签发',async()=>{
 const f=await emptyGroup()
 const twin=await f.roles.create(f.owner,{requestId:randomUUID(),fields:{...roleFields,name:'我的分身',kind:'twin' as const}})
 await f.members([twin.id])
 assert.deepEqual(await f.rows(twin.id),[])
})

test('已归档群加成员：群编辑照常成功但不签发；取消归档时把全体成员补签一遍',async()=>{
 const f=await emptyGroup()
 const archived=await f.members([f.first.id],true)
 assert.equal(archived.archived,true)
 assert.deepEqual(await f.rows(),[])
 const restored=await f.members([f.first.id])
 assert.equal(restored.archived,false)
 const read=await f.grants.get(f.owner,{groupId:f.group.id,roleId:f.first.id})
 assert.equal(read.status,'active')
 assert.equal(read.grant?.canAutoRun,true)
 assert.equal(read.grant?.canPost,true)
 assert.equal(read.grant?.grantVersion,1)
})

test('取消归档不复活已撤销的授权，也不给已有行加版本',async()=>{
 const f=await emptyGroup()
 await f.members([f.first.id])
 await f.grants.change(f.owner,{requestId:randomUUID(),groupId:f.group.id,roleId:f.first.id,expectedGroupVersion:f.version(),expectedRoleVersion:f.first.version,action:'revoke',resources:[],canPost:false,canAutoRun:false})
 await f.members([f.first.id],true)
 const before=await f.rows(f.first.id)
 await f.members([f.first.id])
 assert.deepEqual(await f.rows(f.first.id),before)
 assert.equal(before.length,2)
})

test('已有授权的成员：再拉一位同事时既有行一字不动（只按新群版本续签一行），新同事照常拿默认授权',async()=>{
 const f=await emptyGroup()
 await f.members([f.first.id])
 await f.grants.change(f.owner,{requestId:randomUUID(),groupId:f.group.id,roleId:f.first.id,expectedGroupVersion:f.version(),expectedRoleVersion:f.first.version,action:'save',resources:[],canPost:false,canAutoRun:true})
 const before=await f.rows(f.first.id)
 await f.members([f.first.id,f.second.id])
 // T5b：群版本 +1 会让既有行整体 `invalidated`，所以这一笔按新版本续签一行；**旧行逐字不动**。
 const after=await f.rows(f.first.id)
 assert.deepEqual(after.slice(0,before.length),before)
 assert.equal(after.length,before.length+1)
 assert.equal(after[after.length-1].can_post,false)
 assert.equal(after[after.length-1].can_auto_run,true)
 const second=await f.grants.get(f.owner,{groupId:f.group.id,roleId:f.second.id})
 assert.equal(second.grant?.canAutoRun,true)
 assert.equal(second.grant?.canPost,true)
})

test('已撤销的成员：移出再拉回来也不复活',async()=>{
 const f=await emptyGroup()
 await f.members([f.first.id])
 await f.grants.change(f.owner,{requestId:randomUUID(),groupId:f.group.id,roleId:f.first.id,expectedGroupVersion:f.version(),expectedRoleVersion:f.first.version,action:'revoke',resources:[],canPost:false,canAutoRun:false})
 await f.members([])
 await f.members([f.first.id])
 const read=await f.grants.get(f.owner,{groupId:f.group.id,roleId:f.first.id})
 assert.equal(read.grant?.state,'revoked')
 assert.equal(read.grant?.canAutoRun,false)
 assert.equal(read.grant?.canPost,false)
 assert.equal((await f.rows(f.first.id)).length,2)
})

test('移除成员不动它的授权行',async()=>{
 const f=await emptyGroup()
 await f.members([f.first.id,f.second.id])
 const before=await f.rows(f.first.id)
 await f.members([f.second.id])
 assert.deepEqual(await f.rows(f.first.id),before)
})

test('本人那一行（role_id 为 null）不被当成新增成员',async()=>{
 const f=await emptyGroup()
 await f.members([f.first.id])
 const rows=await f.rows()
 assert.equal(rows.length,1)
 assert.equal(rows[0].role_id,f.first.id)
})

test('差集为空时不再默认签发（新增的那一行是续签，不是默认签发）',async()=>{
 const f=await emptyGroup()
 await f.members([f.first.id])
 const before=await f.rows()
 const renamed=await f.members([f.first.id])
 const after=await f.rows()
 assert.deepEqual(after.slice(0,before.length),before)
 assert.equal(after.length,before.length+1)
 assert.equal(after[after.length-1].request_id,renewedGrantRequestId(f.owner,f.group.id,f.first.id,renamed.version))
 assert.notEqual(after[after.length-1].request_id,defaultGrantRequestId(f.owner,f.group.id,f.first.id))
})

test('改群名后既有 active 授权按新群版本续签：三项逐字沿用，本人不必逐位重新保存',async()=>{
 const f=await emptyGroup()
 await f.members([f.first.id])
 const resource=await f.groups.saveResource(f.owner,{requestId:randomUUID(),groupId:f.group.id,resourceId:randomUUID(),expectedVersion:0,title:'已核验资料',markdown:'# 证据\n\n固定版本。'})
 const resources=[{kind:'group-resource' as const,id:resource.id,version:resource.version}]
 await f.grants.change(f.owner,{requestId:randomUUID(),groupId:f.group.id,roleId:f.first.id,expectedGroupVersion:f.version(),expectedRoleVersion:f.first.version,action:'save',resources,canPost:true,canAutoRun:true})
 const before=await f.rows(f.first.id)
 const renamed=await f.members([f.first.id],false,'改过名的群')
 const read=await f.grants.get(f.owner,{groupId:f.group.id,roleId:f.first.id})
 assert.equal(read.status,'active')
 assert.equal(read.grant?.groupVersion,renamed.version)
 assert.equal(read.grant?.roleVersion,f.first.version)
 assert.equal(read.grant?.canPost,true)
 assert.equal(read.grant?.canAutoRun,true)
 assert.deepEqual(read.grant?.resources,resources)
 assert.equal(read.grant?.grantVersion,before.length+1)
 const after=await f.rows(f.first.id)
 assert.deepEqual(after.slice(0,before.length),before)
 assert.equal(after[after.length-1].request_id,renewedGrantRequestId(f.owner,f.group.id,f.first.id,renamed.version))
})

test('已撤销的授权不因改群名复活',async()=>{
 const f=await emptyGroup()
 await f.members([f.first.id])
 await f.grants.change(f.owner,{requestId:randomUUID(),groupId:f.group.id,roleId:f.first.id,expectedGroupVersion:f.version(),expectedRoleVersion:f.first.version,action:'revoke',resources:[],canPost:false,canAutoRun:false})
 const before=await f.rows(f.first.id)
 await f.members([f.first.id],false,'改名也不复活')
 assert.deepEqual(await f.rows(f.first.id),before)
 assert.equal((await f.grants.get(f.owner,{groupId:f.group.id,roleId:f.first.id})).status,'revoked')
})

test('新群版本上已经有行时不重复续签',async()=>{
 const f=await emptyGroup()
 await f.members([f.first.id])
 // 直写一版「已经落在下一个群版本上」的行（本人在同事务前后手动保存过）：续签必须认出它并整段跳过。
 await pool.query(`insert into teloa_group_agent_grants(group_id,owner_id,role_id,grant_version,group_version,role_version,state,resources,can_post,can_auto_run,request_id,request_spec,created_at)
  values($1,$2,$3,2,$4,$5,'active','[]'::jsonb,true,false,$6,'{}'::jsonb,$7)`,[f.group.id,f.owner,f.first.id,f.version()+1,f.first.version,randomUUID(),identity.now()])
 const before=await f.rows(f.first.id)
 await f.members([f.first.id],false,'改名不产生第三版')
 assert.deepEqual(await f.rows(f.first.id),before)
})

test('同一次编辑里既有成员续签、新成员默认签发，两条路互不重复',async()=>{
 const f=await emptyGroup()
 await f.members([f.first.id])
 const renamed=await f.members([f.first.id,f.second.id],false,'扩员并改名')
 const firstRows=await f.rows(f.first.id),secondRows=await f.rows(f.second.id)
 assert.equal(firstRows.length,2)
 assert.equal(secondRows.length,1)
 assert.equal(firstRows[1].group_version,renamed.version)
 assert.equal(firstRows[1].request_id,renewedGrantRequestId(f.owner,f.group.id,f.first.id,renamed.version))
 assert.equal(secondRows[0].group_version,renamed.version)
 assert.equal(secondRows[0].request_id,defaultGrantRequestId(f.owner,f.group.id,f.second.id))
 for(const roleId of [f.first.id,f.second.id])assert.equal((await f.grants.get(f.owner,{groupId:f.group.id,roleId})).status,'active')
})

test('续签之后 groups/agent-grants/get 回读与表里最新一行逐字一致',async()=>{
 const f=await emptyGroup()
 await f.members([f.first.id])
 const renamed=await f.members([f.first.id],false,'口径一致')
 const read=await f.grants.get(f.owner,{groupId:f.group.id,roleId:f.first.id})
 const rows=await f.rows(f.first.id),latest=rows[rows.length-1]
 assert.deepEqual(read.grant,{groupId:latest.group_id,roleId:latest.role_id,groupVersion:latest.group_version,roleVersion:latest.role_version,grantVersion:latest.grant_version,state:latest.state,resources:latest.resources,canPost:latest.can_post,canAutoRun:latest.can_auto_run,createdAt:latest.created_at.toISOString()})
 assert.equal(read.groupVersion,renamed.version)
 assert.equal(read.status,'active')
})

test('改岗位使命：该岗位在两个群的授权都按新岗位版本续上，最新一版仍是 active',async()=>{
 const f=await roleInTwoGroups()
 const before=await Promise.all([f.rows(f.first.id),f.rows(f.second.id)])
 assert.deepEqual(before.map(rows=>rows.length),[1,1])
 const updated=await f.changeDuty('改过的使命。')
 for(const group of [f.first,f.second]){
  const rows=await f.rows(group.id)
  // 改定义与恢复在岗各续一版：岗位版本 +1 两次，授权也跟着走两版。
  assert.equal(rows.length,3)
  assert.deepEqual(rows.slice(0,1),(group.id===f.first.id?before[0]:before[1]))
  const latest=rows[rows.length-1]
  assert.equal(latest.state,'active')
  assert.equal(latest.role_version,updated.version)
  assert.equal(latest.group_version,group.version)
  assert.equal(latest.can_post,true)
  assert.equal(latest.can_auto_run,true)
  assert.equal(latest.request_id,roleRenewedGrantRequestId(f.owner,group.id,f.role.id,updated.version))
  assert.equal((await f.grants.get(f.owner,{groupId:group.id,roleId:f.role.id})).status,'active')
 }
})

test('已撤销的授权不因改岗位使命复活',async()=>{
 const f=await roleInTwoGroups()
 await f.grants.change(f.owner,{requestId:randomUUID(),groupId:f.first.id,roleId:f.role.id,expectedGroupVersion:f.first.version,expectedRoleVersion:f.role.version,action:'revoke',resources:[],canPost:false,canAutoRun:false})
 const before=await f.rows(f.first.id)
 await f.changeDuty('撤销之后再改使命。')
 assert.deepEqual(await f.rows(f.first.id),before)
 assert.equal((await f.grants.get(f.owner,{groupId:f.first.id,roleId:f.role.id})).status,'revoked')
})

test('已归档群不因改岗位使命续签',async()=>{
 const f=await roleInTwoGroups()
 await f.groups.change(f.owner,{requestId:randomUUID(),groupId:f.second.id,expectedVersion:f.second.version,fields:{name:f.second.name,announcement:f.second.announcement,rules:openGroupRules,memberRoleIds:[f.role.id],pinned:false,archived:true}})
 const archived=await f.rows(f.second.id)
 const updated=await f.changeDuty('归档群不该被续签。')
 assert.deepEqual(await f.rows(f.second.id),archived)
 // 未归档的那个群照常续上：归档只挡自己这一个群，不影响同一位同事的其余群。
 const live=await f.rows(f.first.id)
 assert.equal(live[live.length-1].role_version,updated.version)
})

test('同一岗位版本的续签行已经在库里：撞唯一键按「已被并发续签」跳过该群，不抛也不多一版',async()=>{
 const f=await roleInTwoGroups()
 // 直写一版「已经按将来那个岗位版本续过」的行：它落在别的 grant_version 上，但 request_id 与续签要用的派生值相同。
 // 群行不加锁，所以群编辑的 renewMemberGrants 抢先落一行是真会发生的；这里用唯一键把那种交错固定下来。
 // role_version 故意留旧值，免得被「已经落在新岗位版本上」那一条提前跳过——要走到的是 insert 撞唯一键那一步。
 const editedVersion=f.role.version+2 // 暂停 +1、改定义 +1
 await pool.query(`insert into teloa_group_agent_grants(group_id,owner_id,role_id,grant_version,group_version,role_version,state,resources,can_post,can_auto_run,request_id,request_spec,created_at)
  values($1,$2,$3,3,$4,$5,'active','[]'::jsonb,true,true,$6,'{}'::jsonb,$7)`,[f.first.id,f.owner,f.role.id,f.first.version,f.role.version,roleRenewedGrantRequestId(f.owner,f.first.id,f.role.id,editedVersion),identity.now()])
 const before=await f.rows(f.first.id)
 assert.equal(before.length,2)
 const paused=await f.lifecycle.change(f.owner,{roleId:f.role.id,expectedVersion:f.role.version,action:'pause',reason:'改使命前暂停。'})
 const edited=await f.roles.edit(f.owner,{roleId:f.role.id,expectedVersion:paused.appliedVersion,fields:{...roleFields,duty:'撞唯一键也要改得成。'}})
 // 岗位那一笔本身必须照常成功：续签撞唯一键只跳过这一个群，不回滚岗位编辑。
 assert.equal(edited.version,editedVersion)
 assert.deepEqual(await f.rows(f.first.id),before)
 // 没被并发抢到的那个群照常续上：跳过是按群算的，不是整段放弃。
 const second=await f.rows(f.second.id)
 assert.equal(second.length,2)
 assert.equal(second[1].role_version,editedVersion)
})
