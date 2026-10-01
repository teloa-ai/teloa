import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { PostgreSqlContainer,type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { RoleService,initializeRoles } from '../src/work/roles.ts'
import {initializeCollaboration} from '../src/work/collaboration.ts'
import {initializeGroupAgentGrants} from '../src/work/group-agent-grants.ts'
let container:StartedPostgreSqlContainer,pool:Pool
// 改岗位定义与恢复在岗都会在同一笔事务里按新岗位版本续签群授权（`collaboration.ts` 的 `renewRoleGrants`），
// 所以这套用例也要把群协作与群授权两张表建起来——否则岗位写口会因为表不存在整笔回滚。
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()});await initializeRoles(pool);await initializeCollaboration(pool);await initializeGroupAgentGrants(pool)
})
after(async()=>{await pool?.end();await container?.stop()})
const responsibility={triggers:['收到需要核对的线索'],autonomousActions:['整理证据并给出建议'],confirmationPoints:['采取外部动作前交回本人'],escalationRules:['证据冲突时说明阻塞'],deliveryChecks:['结论包含来源和置信度']}
const legacyFields={name:'调查岗',kind:'employee',scopes:['SOC'],duty:'查证据',dataScope:'已提供资料',executionScope:'只读调查',skills:['证据核验'],knowledge:['调查手册']}
const fields={...legacyFields,responsibility}
const configuredFields={...fields,responsibility,runtimeConfig:{agentPresetId:'security-analyst'}}
const fixture=()=>({owner:randomUUID(),service:new RoleService(pool,{id:randomUUID,now:()=>new Date().toISOString()})})
async function insertLegacyRole(owner:string){
 const id=randomUUID(),requestId=randomUUID(),now=new Date()
 await pool.query("insert into teloa_roles(id,owner_id,request_id,request_spec,definition,version,state,created_at,updated_at) values($1,$2,$3,$4,$4,1,'paused',$5,$5)",[id,owner,requestId,JSON.stringify(legacyFields),now])
 return {id,requestId}
}
/** 编辑只对暂停岗位开放；创建后直接在岗，需要编辑的用例先把状态摆回暂停，不动版本以保持版本断言语义。 */
async function createPausedRole(service:RoleService,owner:string,input:{requestId:string;fields:unknown}){
 const role=await service.create(owner,input);await pool.query("update teloa_roles set state='paused' where id=$1",[role.id])
 return {...role,state:'paused' as const}
}
test('同请求并发创建只保留一个岗位；重新构造服务恢复数据',async()=>{
 const {owner,service}=fixture(),input={requestId:randomUUID(),fields}
 const [a,b]=await Promise.all([service.create(owner,input),service.create(owner,input)])
 assert.equal(a.id,b.id);assert.equal(a.state,'active');assert.equal(a.version,1)
 const restored=await new RoleService(pool,{id:randomUUID,now:()=>new Date().toISOString()}).list(owner,{})
 assert.deepEqual(restored,[a]);assert.equal((await service.list('other',{})).length,0)
 await assert.rejects(service.create(owner,{...input,fields:{...fields,name:'另一个岗位'}}),{code:'teloa/conflict'})
})
test('个人空间默认分身首次创建后稳定复用，不经招聘请求重复产生',async()=>{
 const {owner,service}=fixture()
 const [first,second]=await Promise.all([service.ensurePersonalTwin(owner),service.ensurePersonalTwin(owner)])
 assert.equal(first.id,second.id)
 assert.equal(first.kind,'twin')
 assert.equal(first.state,'active')
 assert.equal(first.name,'我的分身')
 assert.deepEqual(first.knowledge,[],'默认分身不能用说明文字伪装成已授权资料')
 assert.deepEqual((await service.list(owner,{})).map(role=>role.id),[first.id])
})
test('旧数据已有分身时默认分身复用旧记录，不新增第二个身份',async()=>{
 const {owner,service}=fixture(),legacy=await service.create(owner,{requestId:randomUUID(),fields:{...fields,name:'旧分身',kind:'twin'}})
 assert.equal((await service.ensurePersonalTwin(owner)).id,legacy.id)
 assert.equal((await service.list(owner,{})).length,1)
})
test('结构化职责与运行配置经过规范化后随岗位持久化',async()=>{
 const {owner,service}=fixture(),role=await service.create(owner,{requestId:randomUUID(),fields:{...configuredFields,responsibility:{...responsibility,triggers:['  收到需要核对的线索  ']}}})
 assert.deepEqual(role.responsibility,{...responsibility,triggers:['收到需要核对的线索']})
 assert.deepEqual(role.runtimeConfig,{agentPresetId:'security-analyst'})
 assert.deepEqual((await service.list(owner,{}))[0],role)
})
test('新建岗位必须提交完整职责，但运行配置可以保持未固定',async()=>{
 const {owner,service}=fixture()
 await assert.rejects(service.create(owner,{requestId:randomUUID(),fields:legacyFields}),{code:'teloa/invalid-input'})
 const role=await service.create(owner,{requestId:randomUUID(),fields})
 assert.deepEqual(role.responsibility,responsibility)
 assert.equal(Object.hasOwn(role,'runtimeConfig'),false)
})
test('旧岗位缺少结构化职责与运行配置时保持可读且不伪造默认值',async()=>{
 const {owner,service}=fixture();await insertLegacyRole(owner);const [role]=await service.list(owner,{})
 assert.ok(role)
 assert.equal(Object.hasOwn(role,'responsibility'),false)
 assert.equal(Object.hasOwn(role,'runtimeConfig'),false)
})
test('只读恢复接口可以按历史定义找回旧岗位',async()=>{
 const {owner,service}=fixture(),legacy=await insertLegacyRole(owner)
 const role=await service.findByRequest(owner,{requestId:legacy.requestId,expectedFields:legacyFields})
 assert.equal(role?.id,legacy.id)
 assert.equal(Object.hasOwn(role!,'responsibility'),false)
})
test('旧创建请求可按原内容找回；不存在的旧请求仍拒绝新写入，且同身份改内容冲突',async()=>{
 const {owner,service}=fixture(),legacy=await insertLegacyRole(owner)
 const recovered=await service.create(owner,{requestId:legacy.requestId,fields:legacyFields})
 assert.equal(recovered.id,legacy.id)
 await assert.rejects(service.create(owner,{requestId:legacy.requestId,fields:{...legacyFields,name:'不同岗位'}}),{code:'teloa/conflict'})
 const missingRequest=randomUUID()
 await assert.rejects(service.create(owner,{requestId:missingRequest,fields:legacyFields}),{code:'teloa/invalid-input'})
 assert.equal((await pool.query('select count(*)::int n from teloa_roles where owner_id=$1 and request_id=$2',[owner,missingRequest])).rows[0].n,0)
})
test('旧岗位再次编辑可保存完整结构且重试读取固定编辑回执',async()=>{
 const {owner,service}=fixture(),legacy=await insertLegacyRole(owner),input={roleId:legacy.id,expectedVersion:1,fields:configuredFields},edited=await service.edit(owner,input)
 assert.equal(edited.version,2)
 assert.deepEqual(edited.responsibility,responsibility)
 assert.deepEqual(edited.runtimeConfig,{agentPresetId:'security-analyst'})
 assert.deepEqual(await service.edit(owner,input),edited)
})
test('再次编辑必须提交完整职责，不能把岗位改回旧结构',async()=>{
 const {owner,service}=fixture(),role=await service.create(owner,{requestId:randomUUID(),fields:configuredFields})
 await assert.rejects(service.edit(owner,{roleId:role.id,expectedVersion:role.version,fields:legacyFields}),{code:'teloa/invalid-input'})
 assert.deepEqual((await service.list(owner,{}))[0],role)
})
test('职责与运行配置严格拒绝未知键、空白项、过长文本和非法 preset id',async()=>{
 const {owner,service}=fixture(),invalidFields=[
  {...configuredFields,responsibility:{...responsibility,other:[]}},
  {...configuredFields,responsibility:{...responsibility,triggers:['   ']}},
  {...configuredFields,responsibility:{...responsibility,triggers:['x'.repeat(1001)]}},
  {...configuredFields,runtimeConfig:{agentPresetId:'../escape'}},
  {...configuredFields,runtimeConfig:{agentPresetId:'Uppercase'}},
  {...configuredFields,runtimeConfig:{agentPresetId:'a'.repeat(121)}},
  {...configuredFields,runtimeConfig:{agentPresetId:'security-analyst',credentials:'secret'}},
 ]
 for(const candidate of invalidFields)await assert.rejects(service.create(owner,{requestId:randomUUID(),fields:candidate}),{code:'teloa/invalid-input'})
 assert.deepEqual(await service.list(owner,{}),[])
})
test('同一创建请求不能借结构化职责或运行配置变化取得旧结果',async()=>{
 const {owner,service}=fixture(),requestId=randomUUID()
 await service.create(owner,{requestId,fields:configuredFields})
 await assert.rejects(service.create(owner,{requestId,fields:{...configuredFields,responsibility:{...responsibility,deliveryChecks:['不同验收要求']}}}),{code:'teloa/conflict'})
 await assert.rejects(service.create(owner,{requestId,fields:{...configuredFields,runtimeConfig:{agentPresetId:'another-preset'}}}),{code:'teloa/conflict'})
})
test('并发编辑只有一个旧版本可以成功；创建重试不覆盖新版本',async()=>{
 const {owner,service}=fixture(),input={requestId:randomUUID(),fields},a=await createPausedRole(service,owner,input)
 const outcomes=await Promise.allSettled(['甲','乙'].map(name=>service.edit(owner,{roleId:a.id,expectedVersion:1,fields:{...fields,name}})))
 assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1)
 assert.equal((outcomes.find(r=>r.status==='rejected') as PromiseRejectedResult).reason.code,'teloa/version-conflict')
 const retry=await service.create(owner,input);assert.equal(retry.id,a.id);assert.equal(retry.version,2)
 await assert.rejects(service.edit('other',{roleId:a.id,expectedVersion:2,fields}),{code:'teloa/forbidden'})
})
test('输入白名单阻止伪造身份、状态、版本及非法字段；错误不产生岗位',async()=>{
 const {owner,service}=fixture()
 for(const input of [{requestId:randomUUID(),fields,ownerId:'other'},{requestId:randomUUID(),fields:{...fields,state:'active'}},{requestId:randomUUID(),fields:{...fields,kind:'admin'}},{requestId:randomUUID(),fields:{...fields,scopes:[]}},{requestId:randomUUID(),fields:{...fields,skills:[{}]}}])await assert.rejects(service.create(owner,input),{code:'teloa/invalid-input'})
 assert.deepEqual(await service.list(owner,{}),[])
})
test('损坏存储显式拒绝，不隐藏岗位',async()=>{
 const {owner,service}=fixture(),role=await service.create(owner,{requestId:randomUUID(),fields})
 await pool.query("update teloa_roles set definition=jsonb_set(definition,'{kind}','\"unknown\"') where id=$1",[role.id])
 await assert.rejects(service.list(owner,{}),{code:'teloa/storage-corrupt'})
})
test('损坏的结构化职责或运行配置数据库行显式拒绝',async()=>{
 for(const broken of [{runtimeConfig:{agentPresetId:'../escape'}},{responsibility:{...responsibility,triggers:['']}}]){
  const {owner,service}=fixture(),role=await service.create(owner,{requestId:randomUUID(),fields:configuredFields})
  await pool.query('update teloa_roles set definition=definition || $2::jsonb where id=$1',[role.id,JSON.stringify(broken)])
  await assert.rejects(service.list(owner,{}),{code:'teloa/storage-corrupt'})
 }
})
test('写入失败回滚，不留下可被重试误认为成功的岗位',async()=>{
 const {owner,service}=fixture(),input={requestId:randomUUID(),fields}
 const broken=new RoleService(pool,{id:randomUUID,now:()=> 'invalid-time'})
 await assert.rejects(broken.create(owner,input))
 assert.deepEqual(await service.list(owner,{}),[])
 const recovered=await service.create(owner,input);assert.equal(recovered.version,1)
})
test('已退役岗位及身份类型不能借编辑复活；初始化不清空已有岗位',async()=>{
 const {owner,service}=fixture(),role=await createPausedRole(service,owner,{requestId:randomUUID(),fields})
 await assert.rejects(service.edit(owner,{roleId:role.id,expectedVersion:1,fields:{...fields,kind:'twin'}}),{code:'teloa/conflict'})
 await pool.query("update teloa_roles set state='retired' where id=$1",[role.id])
 await assert.rejects(service.edit(owner,{roleId:role.id,expectedVersion:1,fields}),{code:'teloa/conflict'})
 await initializeRoles(pool);assert.equal((await service.list(owner,{}))[0]?.state,'retired')
})
test('同版本相同编辑并发或回包丢失重试返回固定回执，不重复递增',async()=>{
 const {owner,service}=fixture(),role=await createPausedRole(service,owner,{requestId:randomUUID(),fields}),input={roleId:role.id,expectedVersion:1,fields:{...fields,name:'修改一'}}
 const [a,b]=await Promise.all([service.edit(owner,input),service.edit(owner,input)]);assert.deepEqual(a,b);assert.equal(a.version,2)
 await service.edit(owner,{roleId:role.id,expectedVersion:2,fields:{...fields,name:'修改二'}})
 assert.deepEqual(await service.edit(owner,input),a);assert.equal((await service.list(owner,{}))[0]?.version,3)
 await assert.rejects(service.edit(owner,{...input,fields:{...fields,name:'换内容'}}),{code:'teloa/version-conflict'})
 await assert.rejects(service.edit('other',input),{code:'teloa/forbidden'})
})
test('编辑回执保存失败必须回滚岗位，回执内容损坏不能成功返回',async()=>{
 const {owner,service}=fixture(),role=await createPausedRole(service,owner,{requestId:randomUUID(),fields}),input={roleId:role.id,expectedVersion:1,fields:{...fields,name:'修改'}}
 await pool.query(`create function reject_test_role_receipt() returns trigger language plpgsql as $$ begin if new.role_id='${role.id}'::uuid then raise exception 'receipt unavailable'; end if; return new; end $$; create trigger reject_test_role_receipt before insert on teloa_role_edits for each row execute function reject_test_role_receipt()`)
 try{await assert.rejects(service.edit(owner,input),/receipt unavailable/);assert.equal((await service.list(owner,{}))[0]?.version,1)}finally{await pool.query('drop trigger reject_test_role_receipt on teloa_role_edits; drop function reject_test_role_receipt()')}
 await service.edit(owner,input)
 await pool.query("update teloa_role_edits set result=jsonb_set(result,'{version}','99') where role_id=$1",[role.id])
 await assert.rejects(service.edit(owner,input),{code:'teloa/storage-corrupt'})
})
