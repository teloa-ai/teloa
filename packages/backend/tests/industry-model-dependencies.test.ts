import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import type {IndustryModelDependency,IndustryModelPhase} from '@teloa/contract'
import {MarketContentStore,initializeMarketContents} from '../src/market/content-store.ts'
import {IndustryLoadService,initializeIndustryLoads} from '../src/work/industry-loads.ts'
import {BusinessSpaceService} from '../src/work/business-spaces.ts'
import {createIndustryLoadSource} from '../src/work/industry-load-source.ts'
import {IndustryWorkSource} from '../src/work/industry-work-source.ts'
import {IndustryTaskService,initializeIndustryTasks} from '../src/work/industry-tasks.ts'
import {TaskService,initializeTasks} from '../src/work/tasks.ts'
import {initializeRoles} from '../src/work/roles.ts'
import {initializeCollaboration} from '../src/work/collaboration.ts'
import {initializeGroupAgentGrants} from '../src/work/group-agent-grants.ts'
import {createIndustryLoadApi} from '../../client/ui-workbench/src/client/industry-load-api.ts'
import {SkillInstallSource} from '../src/market/skill-install-source.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()},enc=new TextEncoder()
const dependency:IndustryModelDependency={catalogId:'teloa.model.sensevoice',version:'1.0.0',usage:'speech-to-text',required:true}
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeMarketContents(pool);await initializeRoles(pool);await initializeCollaboration(pool);await initializeGroupAgentGrants(pool)
 await initializeTasks(pool);await initializeIndustryLoads(pool);await initializeIndustryTasks(pool)
},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop()})

async function fixture(){
 const owner=randomUUID(),market=new MarketContentStore(pool,identity),loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market))
 const spaces=new BusinessSpaceService(pool,identity)
 await spaces.ensurePersonal(owner)
 let phase:IndustryModelPhase='disabled',probes=0
 const works=new IndustryWorkSource(market,loads,async dep=>{probes++;return dep.catalogId===dependency.catalogId&&dep.version===dependency.version?phase:'unsupported'})
 const tasks=new IndustryTaskService(pool,identity,works,new TaskService(pool,identity))
 const install=async(id:string,deps:IndustryModelDependency[]=[dependency],version='1.0.0')=>{
  const resources=['voice','plain'].map(localId=>({id:localId,kind:'work-template',title:localId,version:'1.0.0',required:true,source:{kind:'local',path:localId+'.json'},...(localId==='voice'?{modelDependencies:deps}:{})}))
  const manifest={format:'teloa.business-package/v3',id,title:id,version,domain:'general',description:'本地语音与普通任务',resources,relations:[],entrypoints:['voice','plain']}
  const files=[{path:'teloa.json',bytes:enc.encode(JSON.stringify(manifest))},...resources.map(row=>({path:row.id+'.json',bytes:enc.encode(JSON.stringify({format:'teloa.work-template/v1',id:row.id,title:row.title,version:'1.0.0',domain:'general',description:'整理已输入的文字',requirements:['输入'],output:'摘要',skills:[]}))}))]
  const saved=await market.import({ownerId:owner,kind:'human'},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:id},manifestPath:'teloa.json',files,references:[]})
  return saved.content
 }
 const load=async(content:Awaited<ReturnType<typeof install>>)=>{const personal=await spaces.ensurePersonal(owner);return loads.create(owner,{requestId:randomUUID(),contentId:content.id,contentHash:content.hash,target:{kind:'existing',spaceId:personal.id,expectedVersion:personal.version}})}
 return {owner,market,loads,tasks,works,install,load,setPhase:(value:IndustryModelPhase)=>{phase=value},probes:()=>probes}
}

test('真实导入→加载→严格客户端回读→两个方案共享就绪状态→停用阻断重试→卸载保留另一方案',async()=>{
 const f=await fixture(),a=await f.load(await f.install('voice-a')),b=await f.load(await f.install('voice-b'))
 const api=createIndustryLoadApi(async(endpoint,value)=>{assert.equal(endpoint,'industry-loads/get');return f.loads.get(f.owner,value)})
 const restored=await api.get(a.id)
 assert.deepEqual(restored.items.find(row=>row.localId==='voice')?.modelDependencies,[dependency])
 const input=(load:typeof a,id:string)=>({requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items.find(row=>row.localId===id)!.instanceId,goal:'整理',inputs:['测试输入']})
 const pending=input(a,'voice')
 await assert.rejects(f.tasks.create(f.owner,pending),{code:'teloa/dependency-unavailable'})
 assert.equal((await pool.query('select count(*)::int n from teloa_tasks where owner_id=$1',[f.owner])).rows[0].n,0)
 await f.tasks.create(f.owner,input(a,'plain'))
 f.setPhase('standby')
 const first=await f.tasks.create(f.owner,pending),second=await f.tasks.create(f.owner,input(b,'voice'))
 assert.equal((await f.tasks.create(f.owner,pending)).task.id,first.task.id)
 const db=await pool.connect()
 try{
  await db.query('begin')
  assert.ok(await f.tasks.executionContextInTransaction(db,f.owner,first.task.id))
  f.setPhase('disabled')
  await assert.rejects(f.tasks.executionContextInTransaction(db,f.owner,first.task.id),{code:'teloa/dependency-unavailable'})
  await db.query('rollback')
 }finally{db.release()}
 f.setPhase('ready')
 const before=f.probes()
 await f.loads.unload(f.owner,{requestId:randomUUID(),loadId:a.id,expectedMappingHash:a.mappingHash})
 assert.equal(f.probes(),before,'卸载不操作模型准备器')
 assert.equal((await f.loads.get(f.owner,{loadId:b.id})).status,'active')
 await f.works.read(f.owner,b.id,second.source.itemInstanceId)
 assert.equal((await pool.query('select count(*)::int n from teloa_tasks where owner_id=$1',[f.owner])).rows[0].n,3)
})

test('未知必需模型保留为待准备声明，只阻断依赖它的入口；可选模型不阻断',async()=>{
 const f=await fixture()
 for(const required of [true,false]){
  const load=await f.load(await f.install(required?'unknown-required':'unknown-optional',[{...dependency,catalogId:'vendor.model.unknown',required}]))
  const voice=load.items.find(row=>row.localId==='voice')!,plain=load.items.find(row=>row.localId==='plain')!
  await f.works.read(f.owner,load.id,plain.instanceId)
  if(required)await assert.rejects(f.works.read(f.owner,load.id,voice.instanceId),{code:'teloa/dependency-unavailable'})
  else await f.works.read(f.owner,load.id,voice.instanceId)
 }
})

test('升级必须明确接受模型依赖变化，拒绝伪称保留且不改动旧加载',async()=>{
 const f=await fixture(),a=await f.load(await f.install('upgrade')),candidate=await f.install('upgrade',[{...dependency,required:false}],'1.1.0')
 const choices={resources:{voice:'keep' as const},roles:{},relations:'keep' as const,entrypoints:'keep' as const,positioning:'keep' as const}
 const input={requestId:randomUUID(),loadId:a.id,candidateContentId:candidate.id,expectedMappingHash:a.mappingHash,choices}
 await assert.rejects(f.loads.upgrade(f.owner,input),{code:'teloa/invalid-input'})
 assert.equal((await f.loads.get(f.owner,{loadId:a.id})).status,'active')
 const next=await f.loads.upgrade(f.owner,{...input,choices:{...choices,resources:{voice:'candidate'}}})
 assert.equal(next.superseded.status,'superseded')
 assert.deepEqual(next.successor.items.find(row=>row.localId==='voice')?.modelDependencies,[{...dependency,required:false}])
})

test('已安装 Skill 的普通会话使用按固定清单重验；停用不删除安装正文，恢复无需重装',async()=>{
 const f=await fixture(),manifest={format:'teloa.business-package/v3',id:'voice-skill',title:'语音技能',version:'1.0.0',domain:'general',description:'语音整理',resources:[{id:'voice-notes',kind:'skill',title:'语音整理',version:'1.0.0',required:true,source:{kind:'local',path:'skills/voice-notes/SKILL.md'},modelDependencies:[dependency]}],relations:[],entrypoints:[]}
 const content=(await f.market.import({ownerId:f.owner,kind:'human'},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'voice-skill'},manifestPath:'teloa.json',files:[{path:'teloa.json',bytes:enc.encode(JSON.stringify(manifest))},{path:'skills/voice-notes/SKILL.md',bytes:enc.encode('---\nname: voice-notes\ndescription: 整理语音文字\n---\n保留来源，整理已转写的文字。')}],references:[]})).content
 const load=await f.load(content),input={kind:'industry',loadId:load.id,itemInstanceId:load.items[0]!.instanceId}
 let phase:IndustryModelPhase='disabled'
 const reader=new SkillInstallSource(f.market,f.loads,async()=>phase)
 const bundle=await reader.read(f.owner,input)
 await assert.rejects(reader.assertModelsReady(f.owner,bundle.source),{code:'teloa/dependency-unavailable'})
 phase='ready'
 await reader.assertModelsReady(f.owner,bundle.source)
 phase='disabled';await assert.rejects(reader.assertModelsReady(f.owner,bundle.source),{code:'teloa/dependency-unavailable'})
 phase='standby';await reader.assertModelsReady(f.owner,bundle.source)
 assert.deepEqual((await reader.read(f.owner,input)).files,bundle.files)
})
