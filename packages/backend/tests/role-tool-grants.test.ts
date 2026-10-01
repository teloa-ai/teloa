import {createHash} from 'node:crypto'
import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {RoleToolGrantService,initializeRoleToolGrants} from '../src/work/role-tool-grants.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import {initializeCollaboration} from '../src/work/collaboration.ts'
import {initializeGroupAgentGrants} from '../src/work/group-agent-grants.ts'
let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()}
before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeRoles(pool);await initializeCollaboration(pool);await initializeGroupAgentGrants(pool);await initializeRoleToolGrants(pool)})
after(async()=>{await pool?.end();await container?.stop()})

async function fixture(){
 const owner=randomUUID(),role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'资料岗',kind:'employee',scopes:['general'],duty:'资料读取',dataScope:'明确资料',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 // 工具授权只对暂停岗位开放；创建后直接在岗，夹具把状态摆回暂停且不动版本，保持版本断言语义。
 await pool.query("update teloa_roles set state='paused' where id=$1",[role.id])
 let checks=0
 const service=new RoleToolGrantService(pool,identity.now,async(_db,_owner,_role,rules)=>{checks++;if(rules.some(rule=>rule.name!=='read_reference'))throw Error('unsupported tool')})
 const command={roleId:role.id,expectedRoleVersion:1,action:'save',rules:[{name:'read_reference',allowed:[{id:'one',version:'v1'}]}]}
 return {owner,role,service,command,checks:()=>checks}
}
test('保存授权提升岗位版本，原请求恢复不重复校验或恢复被撤销授权',async()=>{
 const {owner,role,service,command,checks}=await fixture()
 assert.deepEqual(await service.get(owner,{roleId:role.id}),{roleVersion:1,grant:null})
 const saved=await service.change(owner,command);assert.equal(saved.roleVersion,2);assert.equal(checks(),1)
 const revoked=await service.change(owner,{roleId:role.id,expectedRoleVersion:2,action:'revoke',rules:[]});assert.equal(revoked.state,'revoked');assert.equal(revoked.roleVersion,3)
 assert.deepEqual(await service.get(owner,{roleId:role.id}),{roleVersion:3,grant:revoked})
 await assert.rejects(service.get('other',{roleId:role.id}),{code:'teloa/forbidden'})
 assert.deepEqual(await service.change(owner,command),saved);assert.equal(checks(),1)
 const rows=await pool.query('select * from teloa_role_tool_grants where role_id=$1 order by role_version desc',[role.id]);assert.equal(rows.rows[0].state,'revoked');assert.equal(rows.rowCount,2)
 assert.equal((await new RoleService(pool,identity).list(owner,{}))[0]?.version,3)
})
test('跨本人、活跃岗位、未支持工具拒绝；并发授权只能写入一个版本',async()=>{
 const {owner,role,service,command}=await fixture()
 await assert.rejects(service.change('other',command),{code:'teloa/forbidden'})
 await assert.rejects(service.change(owner,{...command,rules:[{name:'write',allowed:[{}]}]}),/unsupported tool/)
 assert.equal((await new RoleService(pool,identity).list(owner,{}))[0]?.version,1)
 await pool.query("update teloa_roles set state='active' where id=$1",[role.id]);await assert.rejects(service.change(owner,command),{code:'teloa/conflict'})
 await pool.query("update teloa_roles set state='paused' where id=$1",[role.id])
 const results=await Promise.allSettled([service.change(owner,command),service.change(owner,{...command,rules:[{name:'read_reference',allowed:[{id:'two',version:'v2'}]}]})])
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1)
})
test('持久规则与原请求不一致时恢复明确报错',async()=>{
 const {owner,role,service,command}=await fixture();await service.change(owner,command)
 await pool.query("update teloa_role_tool_grants set rules=$2 where role_id=$1",[role.id,JSON.stringify([{name:'read_reference',allowed:[{id:'different'}]}])])
 await assert.rejects(service.change(owner,command),{code:'teloa/storage-corrupt'})
})
