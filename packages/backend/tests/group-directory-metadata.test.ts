import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {CollaborationService,initializeCollaboration} from '../src/work/collaboration.ts'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {initializeTasks} from '../src/work/tasks.ts'
import {initializeGroupAgentGrants} from '../src/work/group-agent-grants.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'

let container:StartedPostgreSqlContainer,pool:Pool
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeRoles(pool);await initializeTasks(pool);await initializeCollaboration(pool);await initializeGroupAgentGrants(pool)
})
after(async()=>{await pool?.end();await container?.stop()})
const rules={historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true}
async function fixture(){
 let at='2026-10-13T01:00:00.000Z'
 const owner=randomUUID(),identity={id:randomUUID,now:()=>at},groups=new CollaborationService(pool,identity),roles=new RoleService(pool,identity)
 const employee=await roles.create(owner,{requestId:randomUUID(),fields:{name:'采购核查员',kind:'employee',scopes:['general'],duty:'核查采购资料',dataScope:'本人提供的资料',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 const fields={name:'采购协作',scope:'general',purpose:'持续核对采购和付款资料',announcement:'周五前提供发票',rules,memberRoleIds:[employee.id]}
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields})
 return {owner,groups,employee,group,fields,time:(value:string)=>{at=value}}
}

test('群说明和真实成员人数一致呈现，所有者隔离且旧编辑不清空说明',async()=>{
 const f=await fixture(),other=await fixture()
 const detail=await f.groups.get(f.owner,{groupId:f.group.id}),directory=await f.groups.list(f.owner,{})
 assert.equal(detail.group.memberCount,detail.members.length);assert.equal(detail.group.memberCount,2)
 assert.equal(directory.length,1);assert.equal(directory[0]!.id,f.group.id);assert.equal(directory[0]!.memberCount,2)
 assert.equal(detail.group.purpose,f.fields.purpose);assert.equal(directory[0]!.purpose,f.fields.purpose)
 await assert.rejects(f.groups.get(other.owner,{groupId:f.group.id}),{code:'teloa/forbidden'})
 const legacy=await f.groups.change(f.owner,{requestId:randomUUID(),groupId:f.group.id,expectedVersion:1,fields:{name:f.fields.name,announcement:'更新公告',rules,memberRoleIds:[],pinned:false,archived:false}})
 assert.equal(legacy.purpose,f.fields.purpose)
 const after=await f.groups.get(f.owner,{groupId:f.group.id})
 assert.equal(after.group.memberCount,1);assert.equal((await f.groups.list(f.owner,{}))[0]!.memberCount,1)
 const cleared=await f.groups.change(f.owner,{requestId:randomUUID(),groupId:f.group.id,expectedVersion:legacy.version,fields:{name:f.fields.name,purpose:'',announcement:'更新公告',rules,memberRoleIds:[],pinned:false,archived:false}})
 assert.equal(cleared.purpose,'');assert.equal((await f.groups.get(f.owner,{groupId:f.group.id})).group.purpose,'')
})

test('编辑、置顶和归档不伪造最近消息时间；详情与目录采用同一真实活动来源',async()=>{
 const f=await fixture(),created=f.group.createdAt
 const {scope:_,...fields}=f.fields
 f.time('2026-10-13T02:00:00.000Z')
 let saved=await f.groups.change(f.owner,{requestId:randomUUID(),groupId:f.group.id,expectedVersion:1,fields:{...fields,pinned:true,archived:false}})
 assert.equal((await f.groups.list(f.owner,{}))[0]!.updatedAt,created)
 assert.equal((await f.groups.get(f.owner,{groupId:f.group.id})).group.updatedAt,created)
 f.time('2026-10-13T03:00:00.000Z')
 const message=await f.groups.send(f.owner,{requestId:randomUUID(),groupId:f.group.id,expectedVersion:saved.version,text:'只核对所提供的合成资料。',references:[],mentions:[]})
 f.time('2026-10-13T04:00:00.000Z')
 saved=await f.groups.change(f.owner,{requestId:randomUUID(),groupId:f.group.id,expectedVersion:saved.version,fields:{...fields,name:'采购与付款协作',pinned:false,archived:true}})
 const detail=await f.groups.get(f.owner,{groupId:f.group.id}),directory=await f.groups.list(f.owner,{})
 assert.equal(detail.group.archived,true);assert.equal(directory[0]!.archived,true)
 assert.equal(detail.group.updatedAt,message.createdAt);assert.equal(directory[0]!.updatedAt,message.createdAt)
 assert.equal(detail.group.version,saved.version,'真实活动时间不改写群设置版本')
})
