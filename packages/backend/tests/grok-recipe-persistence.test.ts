import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {PostgreSqlContainer} from '@testcontainers/postgresql'
import {parseMarketManifest,itemFromManifest,reprepareGrokRecipeItem} from '../../client/ui-workbench/src/client/market-preview.ts'
import {createMarketContentApi} from '../../client/ui-workbench/src/client/market-content-api.ts'
import {createMarketContentHandler} from '../../harness-dsh/src/market-content.ts'
import {MarketContentStore,initializeMarketContents} from '../src/market/content-store.ts'
import {IndustryLoadService,initializeIndustryLoads} from '../src/work/industry-loads.ts'
import {createIndustryLoadSource} from '../src/work/industry-load-source.ts'
import {IndustryRoleSource} from '../src/work/industry-role-source.ts'
import {IndustryRoleService,initializeIndustryRoles} from '../src/work/industry-roles.ts'
import {RoleService,initializeRoles} from '../src/work/roles.ts'
import {IndustryReferenceCatalog,combineReferenceCatalogs} from '../src/capabilities/industry-reference-catalog.ts'
import {createPublicReferenceCatalog} from '@teloa/mcp-reference/local'
import {ResourceService} from '../src/capabilities/resources.ts'
import {initializeResources} from '../src/capabilities/schema.ts'
import {IndustryKnowledgeService,initializeIndustryKnowledge} from '../src/work/industry-knowledge.ts'
import {initializeTasks} from '../src/work/tasks.ts'
import {initializeRoleLifecycle} from '../src/work/role-lifecycle.ts'
import {initializeCollaboration} from '../src/work/collaboration.ts'
import {initializeGroupAgentGrants} from '../src/work/group-agent-grants.ts'
import {BusinessSpaceService} from '../src/work/business-spaces.ts'
import {useLocalContainerRuntime} from './testcontainers-env.ts'

test('recipe经原客户端导入、真实宿主wire和PG固定加载；重试不复制内容、空间或原员工',{timeout:120000},async t=>{
 useLocalContainerRuntime();const container=await new PostgreSqlContainer('postgres:17-alpine').start(),pool=new Pool({connectionString:container.getConnectionUri()});t.after(async()=>{await pool.end();await container.stop()})
 await initializeMarketContents(pool);await initializeResources(pool);await initializeIndustryLoads(pool);await initializeIndustryKnowledge(pool);await initializeRoles(pool);await initializeCollaboration(pool);await initializeGroupAgentGrants(pool);await initializeTasks(pool);await initializeRoleLifecycle(pool);await initializeIndustryRoles(pool)
 const identity={id:randomUUID,now:()=>new Date().toISOString()},owner='recipe-test:'+randomUUID(),actor={ownerId:owner,kind:'human' as const},store=new MarketContentStore(pool,identity)
 const never=async()=>{throw Error('本用例不得访问外部市场或应用')},handle=createMarketContentHandler(owner,async()=>({import:(self,input)=>store.import(self,input),importGithub:never,importGithubSkill:never,get:(self,input)=>store.get(self,input),getImport:(self,input)=>store.getImport(self,input),list:(self,input)=>store.list(self,input)}))
 const raw=JSON.stringify({profile:{name:'原创核对员',title:'原创核对模板',description:'核对本人输入材料。'},memory:[{kind:'profile',content:'模板参考：标注不确定事实。'}],skills:[{name:'核对方法',description:'比较文本。',content:'# 完整核对方法\n只使用本人提供的文本。'}],routines:[{slug:'review',name:'例行核对',description:'按方法复核资料。',content:'保留完整例行步骤。'}],plugins:[{pluginId:'external',name:'未配置外部应用'}]})
 const item=itemFromManifest(await parseMarketManifest(raw),{kind:'upload',name:'recipe.json',size:new TextEncoder().encode(raw).length}),api=createMarketContentApi(handle,undefined,randomUUID)
 const saved=await api.importIndustry(item),again=await api.importIndustry(item);assert.equal(saved.contentStorage?.contentId,again.contentStorage?.contentId);assert.equal(saved.packageContent?.hash,item.packageContent?.hash);assert.deepEqual(saved.recipeImport,item.recipeImport)
 const fixed=await store.get(actor,{contentId:saved.contentStorage!.contentId}),loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(store)),space=await new BusinessSpaceService(pool,identity).ensurePersonal(owner),input={requestId:randomUUID(),contentId:fixed.id,contentHash:fixed.hash,target:{kind:'existing' as const,spaceId:space.id,expectedVersion:space.version}}
 const load=await loads.create(owner,input),repeat=await loads.create(owner,{...input,requestId:randomUUID(),target:{...input.target,expectedVersion:load.space.version}});assert.equal(repeat.id,load.id);assert.equal((await loads.create(owner,input)).id,load.id);assert.equal(load.items.find(row=>row.localId===saved.recipeImport?.plugins[0]?.resourceId)?.status,'skipped');assert.equal(load.items.some(row=>row.kind==='plan'),false)
 const catalog=combineReferenceCatalogs(createPublicReferenceCatalog(),new IndustryReferenceCatalog(pool,store,loads)),resources=new ResourceService(pool,catalog,identity),knowledge=new IndustryKnowledgeService(pool,identity,loads,catalog,resources)
 for(const row of load.items.filter(row=>row.kind==='knowledge')){const reference=await knowledge.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:row.instanceId});assert.equal(reference.state,'active')}
 const roles=new RoleService(pool,identity),service=new IndustryRoleService(pool,identity,loads,new IndustryRoleSource(store,loads),knowledge,roles),roleItem=load.items.find(row=>row.kind==='role')!
 const original=await service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:roleItem.instanceId}),restored=await service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:roleItem.instanceId})
 assert.equal(original.role?.id,restored.role?.id);assert.equal(original.role?.name,'原创核对员');assert.equal(original.state,'paused');assert.deepEqual(original.role?.skills,[],'实例化不冒充技能安装');assert.ok(original.role!.knowledge.length>0);assert.ok(original.declarations.some(row=>row.kind==='mcp'&&row.status==='skipped'))
 for(const [table,count]of [['teloa_market_contents',1],['teloa_industry_loads',1],['teloa_roles',1]] as const)assert.equal((await pool.query('select count(*)::int n from '+table+' where owner_id=$1',[owner])).rows[0].n,count)
 // 同一原件的不同显式应用声明是不同固定内容；导入不覆盖原加载、不自动创建第二位员工。
 const mapped=await reprepareGrokRecipeItem(item,{external:{kind:'mcp',definition:{format:'teloa.mcp-connection/v1',serverName:'reference',tools:['read_reference']}}}),mappedSaved=await api.importIndustry(mapped),mappedAgain=await api.importIndustry(mapped)
 assert.notEqual(mappedSaved.contentStorage?.contentId,fixed.id);assert.equal(mappedSaved.contentStorage?.contentId,mappedAgain.contentStorage?.contentId);assert.equal(mappedSaved.recipeImport?.sourceHash,saved.recipeImport?.sourceHash);assert.equal(mappedSaved.manifest?.id,saved.manifest?.id);assert.equal(mappedSaved.version,saved.version)
 const mappedFixed=await store.get(actor,{contentId:mappedSaved.contentStorage!.contentId});assert.notEqual(mappedFixed.hash,fixed.hash);assert.equal((await store.get(actor,{contentId:fixed.id})).hash,fixed.hash)
 await assert.rejects(loads.create(owner,{...input,requestId:randomUUID(),contentId:mappedFixed.id,contentHash:mappedFixed.hash}),{code:'teloa/version-conflict'},'新内容不能使用旧目标版本覆盖原加载')
 for(const [table,count]of [['teloa_market_contents',2],['teloa_industry_loads',1],['teloa_roles',1]] as const)assert.equal((await pool.query('select count(*)::int n from '+table+' where owner_id=$1',[owner])).rows[0].n,count)
 const otherRaw=JSON.stringify({...JSON.parse(raw),profile:{name:'另一位原创员工',title:'另一份原创模板',description:'核对另一份资料。'},memory:[{kind:'profile',content:'第二份模板独立参考。'}]}),otherSaved=await api.importIndustry(itemFromManifest(await parseMarketManifest(otherRaw),{kind:'upload',name:'recipe.json',size:new TextEncoder().encode(otherRaw).length})),current=await new BusinessSpaceService(pool,identity).current(owner),otherLoad=await loads.create(owner,{requestId:randomUUID(),contentId:otherSaved.contentStorage!.contentId,contentHash:otherSaved.packageContent!.hash,target:{kind:'existing',spaceId:current.id,expectedVersion:current.version}})
 assert.equal(load.scope,'general');assert.equal(otherLoad.scope,'general');assert.notEqual(load.id,otherLoad.id)
 for(const item of otherLoad.items.filter(row=>row.kind==='knowledge'))assert.equal((await knowledge.instantiate(owner,{requestId:randomUUID(),loadId:otherLoad.id,itemInstanceId:item.instanceId})).state,'active')
 const otherPrepared=await service.instantiate(owner,{requestId:randomUUID(),loadId:otherLoad.id,itemInstanceId:otherLoad.items.find(row=>row.kind==='role')!.instanceId})
 assert.notEqual(original.role?.id,otherPrepared.role?.id);assert.equal(otherPrepared.role?.name,'另一位原创员工');assert.equal(otherPrepared.role?.duty,'核对另一份资料。');assert.equal(otherPrepared.state,'paused')
 const originalRefs=new Set(original.role!.knowledge);assert.ok(otherPrepared.role!.knowledge.length>0);assert.ok(otherPrepared.role!.knowledge.every(id=>!originalRefs.has(id)),'同一业务下原员工引用只绑定各自固定加载，不混入另一模板')
 const labels=(await pool.query('select scope,kind from teloa_business_scopes where owner_id=$1 order by scope',[owner])).rows;assert.deepEqual(labels.map(row=>row.scope),['general']);assert.ok(labels.every(row=>row.kind==='builtin'),'导入员工模板不登记新的domain业务标签')
 await assert.rejects(store.get({ownerId:'other',kind:'human'},{contentId:fixed.id}))
})
