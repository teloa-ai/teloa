import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {RoleService,initializeRoles} from '../src/work/roles.ts'
import {initializeCollaboration} from '../src/work/collaboration.ts'
import {initializeGroupAgentGrants} from '../src/work/group-agent-grants.ts'
import {BusinessDataService,initializeBusinessData} from '../src/work/business-data.ts'
import {ensureNamedSeedRole,preserveSeedObjectNames,seedRoleNames} from '../../../scripts/种子同事姓名.mjs'

let container:StartedPostgreSqlContainer,pool:Pool
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeRoles(pool);await initializeCollaboration(pool);await initializeGroupAgentGrants(pool);await initializeBusinessData(pool)
})
after(async()=>{await pool?.end();await container?.stop()})
const identity={id:randomUUID,now:()=>new Date().toISOString()}
const fields={name:'Alex Morgan',kind:'employee',scopes:['SOC'],duty:'调查安全告警',dataScope:'已授权的资料',executionScope:'读取并提出建议',skills:[],knowledge:[],responsibility:{triggers:['收到调查任务'],autonomousActions:['整理证据'],confirmationPoints:['外部动作交回本人'],escalationRules:['缺资料时报告'],deliveryChecks:['结论附证据']},runtimeConfig:{agentPresetId:'teloa-standard'}}

test('新库用英文名创建；原请求重复执行只保留同一岗位',async()=>{
 const ownerId=randomUUID(),requestId=randomUUID(),service=new RoleService(pool,identity)
 const input={pool,service,ownerId,requestId,key:'lin-xi',fields}
 const first=await ensureNamedSeedRole(input),second=await ensureNamedSeedRole(input)
 assert.equal(first.name,'Alex Morgan');assert.equal(second.id,first.id)
 assert.equal((await service.list(ownerId,{})).length,1)
 assert.deepEqual(Object.values(seedRoleNames).map(value=>value.name),['Alex Morgan','Jordan Lee','Sam Taylor'])
})
test('旧中文请求可重放；保留用户后来改的姓名和原始请求指纹',async()=>{
 const ownerId=randomUUID(),requestId=randomUUID(),service=new RoleService(pool,identity)
 const legacy={...fields,name:'林析'}
 const first=await service.create(ownerId,{requestId,fields:legacy},{state:'paused'})
 const input={pool,service,ownerId,requestId,key:'lin-xi',fields}
 assert.equal((await ensureNamedSeedRole(input)).name,'林析')
 const edited=await service.edit(ownerId,{roleId:first.id,expectedVersion:first.version,fields:{...fields,name:'My researcher'}})
 assert.deepEqual(await ensureNamedSeedRole(input),edited)
 assert.equal((await pool.query('select request_spec->>\'name\' name from teloa_roles where id=$1',[first.id])).rows[0].name,'林析')
 await assert.rejects(ensureNamedSeedRole({...input,fields:{...fields,duty:'另一份职责'}}),{code:'teloa/conflict'})
})
const snapshot=(id:string,name:string)=>({scope:'SOC',type:'incident-ticket',id,version:1,title:'固定调查',source:'seed-source',observedAt:'2026-09-19T01:00:00.000Z',receivedAt:'2026-09-19T02:00:00.000Z',quality:'complete',summary:'固定展示快照',fields:[{label:'负责同事',value:name}]})
const persist=(ownerId:string,item:ReturnType<typeof snapshot>)=>new BusinessDataService(pool,{id:'seed-source',scopes:['SOC'],query:async()=>({schema:'teloa.data-source-page/v1',sourceId:'seed-source',scope:'SOC',capturedAt:'2026-09-19T03:00:00.000Z',items:[item]})}).query({ownerId,scopeIds:['SOC']},{scope:'SOC',limit:100})
test('新对象写英文；旧v1快照保持摘要与历史引用，其他变化仍拒绝',async()=>{
 const ownerId=randomUUID(),old=snapshot('old','林析'),first=await persist(ownerId,old)
 const [compatible]=await preserveSeedObjectNames(pool,ownerId,[snapshot('old','Alex Morgan')])
 assert.ok(compatible)
 const replay=await persist(ownerId,compatible)
 assert.equal(replay.items[0]?.snapshotHash,first.items[0]?.snapshotHash)
 assert.equal(replay.items[0]?.fields[0]?.value,'林析')
 const [fresh]=await preserveSeedObjectNames(pool,ownerId,[snapshot('new','Alex Morgan')])
 assert.ok(fresh)
 assert.equal((await persist(ownerId,fresh)).items[0]?.fields[0]?.value,'Alex Morgan')
 const [changed]=await preserveSeedObjectNames(pool,ownerId,[{...snapshot('old','Alex Morgan'),summary:'修改了不可变正文'}])
 assert.ok(changed)
 await assert.rejects(persist(ownerId,changed),{code:'teloa/source-conflict'})
})
