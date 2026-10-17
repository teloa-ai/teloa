import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {MarketContentStore,initializeMarketContents} from '../src/market/content-store.ts'
import {IndustryLoadService,initializeIndustryLoads} from '../src/work/industry-loads.ts'
import {createIndustryLoadSource} from '../src/work/industry-load-source.ts'
import {IndustryRoleService,initializeIndustryRoles} from '../src/work/industry-roles.ts'
import {IndustryRoleSource} from '../src/work/industry-role-source.ts'
import {IndustryKnowledgeService,initializeIndustryKnowledge} from '../src/work/industry-knowledge.ts'
import {IndustryReferenceCatalog,combineReferenceCatalogs} from '../src/capabilities/industry-reference-catalog.ts'
import {ResourceService} from '../src/capabilities/resources.ts'
import {initializeResources} from '../src/capabilities/schema.ts'
import {createPublicReferenceCatalog} from '@teloa/mcp-reference/local'
import {CollaborationService,initializeCollaboration} from '../src/work/collaboration.ts'
import {GroupAgentGrantService,initializeGroupAgentGrants} from '../src/work/group-agent-grants.ts'
import {RoleService,initializeRoles} from '../src/work/roles.ts'
import {RoleLifecycleService,initializeRoleLifecycle} from '../src/work/role-lifecycle.ts'
import {initializeTasks} from '../src/work/tasks.ts'
import {useLocalContainerRuntime} from './testcontainers-env.ts'
import {BusinessSpaceService} from '../src/work/business-spaces.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()},rules={historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true}
before(async()=>{
 useLocalContainerRuntime();container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeMarketContents(pool);await initializeResources(pool);await initializeIndustryLoads(pool);await initializeIndustryKnowledge(pool);await initializeRoles(pool);await initializeCollaboration(pool);await initializeGroupAgentGrants(pool);await initializeTasks(pool);await initializeRoleLifecycle(pool);await initializeIndustryRoles(pool)
},{timeout:180000})
after(async()=>{await pool?.end();await container?.stop()})
async function fixture(){
 const owner=randomUUID(),market=new MarketContentStore(pool,identity),loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market)),roles=new RoleService(pool,identity)
 const manifest={format:'teloa.business-package/v2',id:'team',title:'固定团队',version:'1.0.0',domain:'general',description:'明确创建暂停团队，不自动工作。',resources:['lead','member'].map(id=>({id,kind:'role',title:id,version:'1.0.0',required:true,source:{kind:'local',path:id+'.json'}})),relations:[{kind:'role-coordination',from:'lead',to:'member'}],entrypoints:[]}
 const file=(path:string,value:unknown)=>({path,bytes:new TextEncoder().encode(JSON.stringify(value))})
 const content=(await market.import({ownerId:owner,kind:'human'},{requestId:randomUUID(),kind:'industry-template',source:{kind:'upload',name:'固定团队'},manifestPath:'teloa.json',files:[file('teloa.json',manifest),...['lead','member'].map(name=>file(name+'.json',{format:'teloa.role/v1',name,kind:'employee',duty:'核对本人给定资料',dataScope:'本人给定资料',executionScope:'只整理，不外发'}))],references:[]})).content
 const space=await new BusinessSpaceService(pool,identity).ensurePersonal(owner)
 const load=await loads.create(owner,{requestId:randomUUID(),contentId:content.id,contentHash:content.hash,target:{kind:'existing',spaceId:space.id,expectedVersion:space.version}})
 const sources=combineReferenceCatalogs(createPublicReferenceCatalog(),new IndustryReferenceCatalog(pool,market,loads)),resources=new ResourceService(pool,sources,identity),knowledge=new IndustryKnowledgeService(pool,identity,loads,sources,resources),service=new IndustryRoleService(pool,identity,loads,new IndustryRoleSource(market,loads),knowledge,roles)
 const instances=await Promise.all(load.items.filter(row=>row.kind==='role').map(item=>service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:item.instanceId})))
 const lead=instances.find(row=>row.itemLocalId==='lead')!.role!,member=instances.find(row=>row.itemLocalId==='member')!.role!
 const source={kind:'industry-load' as const,loadId:load.id,contentId:load.contentId,contentHash:load.contentHash,mappingHash:load.mappingHash}
 const fields={name:'固定团队',scope:load.scope,announcement:'',rules,memberRoleIds:[lead.id,member.id],coordinatorRoleId:lead.id,source}
 return {owner,load,source,fields,lead,member,groups:new CollaborationService(pool,identity),grants:new GroupAgentGrantService(pool,identity.now),lifecycle:new RoleLifecycleService(pool,identity)}
}
test('真实固定内容与加载岗位建立唯一暂停团队群；原请求恢复不重复且来源可回读',async()=>{
 const f=await fixture(),request={requestId:randomUUID(),expectedVersion:0 as const,fields:f.fields}
 const [a,b]=await Promise.all([f.groups.create(f.owner,request),f.groups.create(f.owner,request)])
 assert.deepEqual(a,b);assert.deepEqual(a.source,f.source);assert.equal(a.coordinatorRoleId,f.lead.id)
 assert.equal((await f.groups.list(f.owner,{})).filter(row=>row.id===a.id).length,1)
 assert.deepEqual((await f.groups.get(f.owner,{groupId:a.id})).members.map(row=>row.roleId).filter(Boolean).sort(),[f.lead.id,f.member.id].sort())
 const grant=await f.grants.get(f.owner,{groupId:a.id,roleId:f.lead.id});assert.equal(grant.status,'invalidated');assert.deepEqual(grant.grant?.resources,[]);assert.equal(grant.grant?.canAutoRun,true)
 assert.deepEqual((await pool.query('select state from teloa_roles where owner_id=$1',[f.owner])).rows.map(row=>row.state),['paused','paused'])
 assert.equal((await pool.query('select count(*)::int as n from teloa_tasks where owner_id=$1',[f.owner])).rows[0].n,0,'明确建群不创建或启动工作')
 await assert.rejects(f.groups.create(f.owner,{...request,fields:{...f.fields,source:{...f.source,contentHash:'f'.repeat(64)}}}),{code:'teloa/conflict'})
})
test('伪造来源、摘要、映射或成员不落群；群改名保原来源和协调者，移除lead须明确同次清空',async()=>{
 const f=await fixture(),other=await fixture()
 await assert.rejects(f.groups.create(f.owner,{requestId:randomUUID(),expectedVersion:0,fields:other.fields}),{code:'teloa/forbidden'})
 for(const [fields,code] of [[{...f.fields,source:{...f.source,loadId:randomUUID()}},'teloa/forbidden'],[{...f.fields,source:{...f.source,contentId:randomUUID()}},'teloa/conflict'],[{...f.fields,source:{...f.source,contentHash:'f'.repeat(64)}},'teloa/conflict'],[{...f.fields,source:{...f.source,mappingHash:'e'.repeat(64)}},'teloa/conflict'],[{...f.fields,memberRoleIds:[f.lead.id,randomUUID()]},'teloa/forbidden']] as const)await assert.rejects(f.groups.create(f.owner,{requestId:randomUUID(),expectedVersion:0,fields}),{code})
 assert.equal((await f.groups.list(f.owner,{})).length,0)
 const group=await f.groups.create(f.owner,{requestId:randomUUID(),expectedVersion:0,fields:f.fields})
 const change={name:'重命名',announcement:'',rules,memberRoleIds:f.fields.memberRoleIds,pinned:false,archived:false}
 const renamed=await f.groups.change(f.owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,fields:change})
 assert.deepEqual(renamed.source,f.source);assert.equal(renamed.coordinatorRoleId,f.lead.id)
 await assert.rejects(f.groups.change(f.owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:renamed.version,fields:{...change,memberRoleIds:[f.member.id]}}),{code:'teloa/conflict'})
 const cleared=await f.groups.change(f.owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:renamed.version,fields:{...change,memberRoleIds:[f.member.id],coordinatorRoleId:null}})
 assert.equal(cleared.coordinatorRoleId,undefined);assert.deepEqual(cleared.source,f.source)
})
test('暂停成员恢复后沿真实岗位续签，明确撤权者不因恢复复活',async()=>{
 const f=await fixture(),group=await f.groups.create(f.owner,{requestId:randomUUID(),expectedVersion:0,fields:f.fields})
 await f.grants.change(f.owner,{requestId:randomUUID(),groupId:group.id,roleId:f.member.id,expectedGroupVersion:group.version,expectedRoleVersion:f.member.version,action:'revoke',resources:[],canPost:false,canAutoRun:false})
 await f.lifecycle.change(f.owner,{roleId:f.lead.id,expectedVersion:f.lead.version,action:'resume',reason:'本人明确恢复'})
 await f.lifecycle.change(f.owner,{roleId:f.member.id,expectedVersion:f.member.version,action:'resume',reason:'本人明确恢复'})
 assert.equal((await f.grants.get(f.owner,{groupId:group.id,roleId:f.lead.id})).status,'active')
 assert.equal((await f.grants.get(f.owner,{groupId:group.id,roleId:f.member.id})).status,'revoked')
})
