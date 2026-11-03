import {BusinessSpaceService} from '../src/work/business-spaces.ts'
import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises'
import {homedir,tmpdir} from 'node:os'
import {join} from 'node:path'
import {Pool} from './postgres-test-lifecycle.ts'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import * as backend from '../src/index.ts'
import {initializeMarketContents,MarketContentStore} from '../src/market/content-store.ts'
import {createIndustryLoadSource} from '../src/work/industry-load-source.ts'
import {initializeIndustryLoads,IndustryLoadService} from '../src/work/industry-loads.ts'
import {IndustryReferenceCatalog,industryReferenceId,combineReferenceCatalogs} from '../src/capabilities/industry-reference-catalog.ts'
import {MarkdownKnowledgeService} from '../src/capabilities/markdown-knowledge.ts'
import {MarkdownKnowledgeCatalog} from '../src/capabilities/markdown-knowledge-catalog.ts'
import {initializeResources} from '../src/capabilities/schema.ts'
import {ResourceService} from '../src/capabilities/resources.ts'
let container:StartedPostgreSqlContainer,pool:Pool,root:string
async function recordResources(stage:'created'|'cleaned'){if(process.env.TELOA_KNOWLEDGE_COPY_RESOURCE_RECORD)await writeFile(process.env.TELOA_KNOWLEDGE_COPY_RESOURCE_RECORD,JSON.stringify({stage,containerId:container.getId(),root,scope:'isolated knowledge-copy tests only',modelCalls:0,credentialValuesRecorded:false,recordedAt:new Date().toISOString()},null,2))}
const identity={id:randomUUID,now:()=>new Date().toISOString()},file=(path:string,text:string)=>({path,bytes:new TextEncoder().encode(text)})
before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeMarketContents(pool);await initializeIndustryLoads(pool);await initializeResources(pool);root=await mkdtemp(join(tmpdir(),'teloa-knowledge-copy-'));await recordResources('created')},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop();if(root)await rm(root,{recursive:true,force:true});await recordResources('cleaned')})
async function fixture(license=true){
 const ownerId=randomUUID(),actor={ownerId,kind:'human' as const,scopeIds:['general']},market=new MarketContentStore(pool,identity)
 const manifest={format:'teloa.business-package/v2',id:'copy-sop',title:'分享SOP',version:'1.0.0',domain:'general',scope:'general',description:'副本验收',resources:[{id:'guide',kind:'knowledge',title:'原SOP',version:'1.0.0',required:true,source:{kind:'local',path:'knowledge/guide.md'}}],relations:[],entrypoints:[]}
 const imported=await market.import({ownerId,kind:'human'},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'副本测试'},trust:{publisher:'合成作者',repository:null,license:license?{status:'declared',value:'MIT'}:{status:'missing'},signature:{status:'unverified',signer:null},compatibility:{teloa:'0.2.10',dsh:'0.2.1'},plugins:[],externalCapabilities:[],permissions:[],review:{conclusion:'needs-review',summary:'合成来源'}},manifestPath:'teloa.json',files:[file('teloa.json',JSON.stringify(manifest)),file('knowledge/guide.md','# 固定原文\n'),...(license?[file('LICENSE','MIT\n')]:[])],references:[]})
 const space=await new BusinessSpaceService(pool,identity).ensurePersonal(ownerId),loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market)),loadInput={requestId:randomUUID(),contentId:imported.content.id,contentHash:imported.content.hash,target:{kind:'existing' as const,spaceId:space.id,expectedVersion:space.version}}
 assert.equal(space.kind,'personal')
 await assert.rejects(loads.create(ownerId,{...loadInput,requestId:randomUUID(),target:{kind:'new',spaceId:randomUUID(),name:'不应创建'}}),{code:'teloa/forbidden'})
 const other=await new BusinessSpaceService(pool,identity).ensurePersonal(randomUUID())
 await assert.rejects(loads.create(ownerId,{...loadInput,requestId:randomUUID(),target:{kind:'existing',spaceId:other.id,expectedVersion:other.version}}),{code:'teloa/forbidden'})
 const load=await loads.create(ownerId,loadInput),sourceId=industryReferenceId(load.id,load.items[0]!.instanceId)
 assert.equal(load.space.id,space.id);assert.equal(load.space.scope,'general')
 const registered=(await pool.query('select space_id from teloa_business_scopes where owner_id=$1 and scope=$2',[ownerId,'general'])).rows
 assert.deepEqual(registered,[{space_id:space.id}])
 const industry=new IndustryReferenceCatalog(pool,market,loads),knowledge=new MarkdownKnowledgeService(pool,root,'default',identity),resources=new ResourceService(pool,combineReferenceCatalogs({list:async()=>({schema:'teloa.reference-list/v1',references:[]}),read:async()=>{throw Error('unexpected public source')}},industry,new MarkdownKnowledgeCatalog(knowledge)),identity)
 const source=(await resources.sourceDirectory(actor)).find(row=>row.id===sourceId)!,draft=await resources.create(actor,{requestId:randomUUID(),title:'原SOP',sourceId,sourceVersion:source.version,scopeIds:['general']}),resource=await resources.apply(actor,{draftId:draft.id,expectedVersion:draft.version})
 const Constructor=Reflect.get(backend,'KnowledgeCopyService');assert.equal(typeof Constructor,'function','必须提供真实、持久的知识副本服务，不能只有剪贴板复制')
 const copies=new Constructor(pool,knowledge,resources,industry),ref={resourceId:resource.id,expectedResourceVersion:resource.version,sourceVersion:resource.sourceVersion}
 return {actor,market,loads,imported,load,knowledge,resources,resource,copies,ref}
}
test('固定SOP派生为可编辑本人资料并持久保留服务端来源、摘要与许可；原件和绑定不变',async()=>{
 const f=await fixture(),preview=await f.copies.preview(f.actor,f.ref)
 assert.equal(preview.markdown,'# 固定原文\n');assert.equal(preview.origin.contentHash,f.imported.content.hash);assert.equal(preview.origin.sourceVersion,f.resource.sourceVersion);assert.equal(preview.origin.license.status,'declared');assert.equal(preview.origin.sourceTitle,'原SOP')
 const command={...f.ref,requestId:randomUUID(),title:'我的校正版',markdown:'# 接收方独立修订\n'},copy=await f.copies.create(f.actor,command)
 assert.notEqual(copy.knowledge.item.id,f.resource.id);assert.equal(copy.knowledge.item.currentVersion,1);assert.equal(copy.knowledge.version.markdown,command.markdown);assert.deepEqual(copy.origin,preview.origin)
 assert.equal(copy.resource.sourceId,'knowledge_'+copy.knowledge.item.id);assert.deepEqual(copy.resource.scopeIds,f.resource.scopeIds)
 assert.deepEqual(await f.copies.origin(f.actor,{knowledgeId:copy.knowledge.item.id}),copy.origin)
 const revised=await new backend.KnowledgeResourceService(pool,f.knowledge,f.resources).revise(f.actor,{requestId:randomUUID(),knowledgeId:copy.knowledge.item.id,expectedKnowledgeVersion:1,resourceId:copy.resource.id,expectedResourceVersion:1,markdown:'# 后续独立版本\n'});assert.equal(revised.knowledge.item.currentVersion,2);assert.equal(revised.resource.status,'active')
 await f.resources.withdraw(f.actor,{resourceId:f.resource.id,expectedVersion:1})
 assert.deepEqual(await f.copies.create(f.actor,command),copy,'未知回执恢复返回原创建事实，不依赖原件仍active，也不创建第二副本')
 assert.deepEqual(await f.copies.origin(f.actor,{knowledgeId:copy.knowledge.item.id}),preview.origin)
 const fixed=await f.market.get({ownerId:f.actor.ownerId,kind:'human'},{contentId:f.imported.content.id});assert.equal(fixed.hash,f.imported.content.hash);assert.deepEqual(fixed.files,f.imported.content.files)
 assert.equal((await f.knowledge.list(f.actor,{})).length,1)
 await assert.rejects(f.copies.create(f.actor,{...command,markdown:'# 改变原请求'}),{code:'teloa/conflict'})
 await assert.rejects(f.copies.create(f.actor,{...command,requestId:randomUUID()}),{code:'teloa/resource-withdrawn'})
})
test('来源owner/CAS/范围由服务端重验，失败无残留，missing许可如实保留',async()=>{
 const f=await fixture(),command={...f.ref,requestId:randomUUID(),title:'不应创建',markdown:'# 不应创建'}
 for(const [actor,input,code] of [[{...f.actor,ownerId:randomUUID()},command,'teloa/forbidden'],[{...f.actor,kind:'agent'},command,'teloa/forbidden'],[f.actor,{...command,expectedResourceVersion:2},'teloa/version-conflict'],[f.actor,{...command,sourceVersion:'0'.repeat(64)},'teloa/version-conflict'],[f.actor,{...command,scopeIds:['other']},'teloa/invalid-input'],[f.actor,{...command,license:{status:'declared',value:'MIT'}},'teloa/invalid-input']] as const)await assert.rejects(f.copies.create(actor,input),{code})
 assert.equal((await f.knowledge.list(f.actor,{})).length,0);assert.equal((await f.resources.list(f.actor)).resources.length,1)
 const missing=await fixture(false),copy=await missing.copies.create(missing.actor,{...missing.ref,requestId:randomUUID(),title:'本人私有校正版',markdown:'# 本人私有副本'});assert.deepEqual(copy.origin.license,{status:'missing'});assert.equal((await missing.knowledge.list(missing.actor,{})).length,1)
})
test('投影失败整笔回滚，已提交后丢回包只恢复原两个身份',async()=>{
 const f=await fixture(),before=await f.resources.list(f.actor),allocated:string[]=[],knowledge=new MarkdownKnowledgeService(pool,root,'default',{id:()=>{const id=randomUUID();allocated.push(id);return id},now:identity.now})
 const broken=new Proxy(f.resources,{get(target,key){if(key==='createKnowledgeProjectionInTransaction')return async()=>{throw Error('test projection failure')};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value}})
 const industry=new IndustryReferenceCatalog(pool,f.market,f.loads),Constructor=Reflect.get(backend,'KnowledgeCopyService'),copies=new Constructor(pool,knowledge,broken,industry),input={...f.ref,requestId:randomUUID(),title:'原子副本',markdown:'# 原子正文'}
 await assert.rejects(copies.create(f.actor,input),{code:'teloa/storage-unavailable'})
 assert.equal((await knowledge.list(f.actor,{})).length,0);assert.deepEqual(await f.resources.list(f.actor),before)
 await assert.rejects(readFile(join(root,'workspaces','default','knowledge',allocated[0]!,'versions',createHash('sha256').update(input.markdown).digest('hex')+'.md')),{code:'ENOENT'})
 assert.equal((await pool.query('select count(*)::int n from teloa_knowledge_copies where owner_id=$1',[f.actor.ownerId])).rows[0].n,0)
 let lost=false
 const lossy={query:pool.query.bind(pool),connect:async()=>{const client=await pool.connect();let wrote=false;return new Proxy(client,{get(target,key){if(key==='query')return async(sql:unknown,...args:unknown[])=>{const result=await (target.query as (...values:unknown[])=>Promise<unknown>).call(target,sql,...args);if(typeof sql==='string'&&sql.startsWith('insert into teloa_knowledge_copies'))wrote=true;if(wrote&&!lost&&sql==='commit'){lost=true;throw Error('lost copy commit receipt')}return result};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value}})}} as unknown as Pool
 const retry=new Constructor(lossy,new MarkdownKnowledgeService(lossy,root,'default',identity),f.resources,industry)
 await assert.rejects(retry.create(f.actor,input),{code:'teloa/storage-unavailable'});assert.equal(lost,true)
 const recovered=await retry.create(f.actor,input);assert.deepEqual(await retry.create(f.actor,input),recovered)
 assert.equal((await knowledge.list(f.actor,{})).length,1);assert.equal((await f.resources.list(f.actor)).resources.length,2)
 assert.equal((await pool.query('select count(*)::int n from teloa_knowledge_copies where owner_id=$1',[f.actor.ownerId])).rows[0].n,1)
 await assert.rejects(pool.query('update teloa_knowledge_copies set result=result where owner_id=$1',[f.actor.ownerId]),/immutable/)
 await assert.rejects(retry.create({...f.actor,scopeIds:['unrelated']},input),{code:'teloa/forbidden'})
})
