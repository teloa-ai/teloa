import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from './postgres-test-lifecycle.ts'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {WorkError,type WorkResource} from '@teloa/contract'
import {initializeResources} from '../src/capabilities/schema.ts'
import {ResourceService,type ResourceActor,type ResourceSourceCatalog} from '../src/capabilities/resources.ts'
import {ResourceAdoptionCatalog} from '../src/capabilities/resource-adoption-catalog.ts'
import {combineReferenceCatalogs} from '../src/capabilities/industry-reference-catalog.ts'
import {initializeBusinessSpaces,BusinessSpaceService} from '../src/work/business-spaces.ts'
import {BusinessScopeService} from '../src/work/business-scopes.ts'
import {RetrievalIndexService,type Embedder} from '../src/capabilities/retrieval-index.ts'
let container:StartedPostgreSqlContainer,pool:Pool
before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeResources(pool);await initializeBusinessSpaces(pool)},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})
const identity={id:randomUUID,now:()=>new Date().toISOString()},signal=()=>new AbortController().signal
async function world(){
 const ownerId=randomUUID(),human:ResourceActor={ownerId,kind:'human',scopeIds:['general','soc','business-new']},texts=new Map<string,string>(),unavailable=new Set<string>()
 const space=await new BusinessSpaceService(pool,identity).ensurePersonal(ownerId)
 for(const scope of ['soc','business-new'])await BusinessScopeService.ensure(pool,ownerId,{scope,title:scope,kind:'domain',spaceId:space.id})
 const original:ResourceSourceCatalog={list:async()=>({schema:'teloa.reference-list/v1',references:[]}),read:async(id,version,context)=>{if(context?.actor.ownerId!==ownerId||!context.actor.scopeIds.includes('soc')||!context.scopeIds?.includes('soc'))throw new WorkError('teloa/forbidden','原来源仅限soc');const text=texts.get(id);if(text===undefined||unavailable.has(id))throw new WorkError('teloa/source-unavailable','原来源不可用');return {schema:'teloa.reference/v1',id,title:id,source:'market:fixed-soc/'+id,version,bytes:Buffer.byteLength(text),text}}}
 const empty:ResourceSourceCatalog={list:async()=>({schema:'teloa.reference-list/v1',references:[]}),read:async()=>{throw Error('unexpected public source')}}
 const adopted=new ResourceAdoptionCatalog(pool),catalog=combineReferenceCatalogs(empty,original,undefined,undefined,adopted),service=new ResourceService(pool,catalog,identity),retrieval=new RetrievalIndexService(pool,service,identity)
 const add=async(n:number,text='# 固定依据 '+n+'\n\n告警先核对资产与误报，再记录结论。')=>{const sourceId='industry_fixture_'+randomUUID();texts.set(sourceId,text);const sourceVersion=createHash('sha256').update(text).digest('hex'),draft=await service.create(human,{requestId:randomUUID(),title:'SOC依据'+n,sourceId,sourceVersion,scopeIds:['soc']});return service.apply(human,{draftId:draft.id,expectedVersion:draft.version})}
 const refs=(resources:WorkResource[])=>resources.map(({id,version,sourceVersion})=>({id,version,sourceVersion}))
 return {human,service,retrieval,adopted,add,refs,unavailable,texts}
}
test('16项旧业务资料经本人显式准备/采用后可在新业务使用，固定原来源、版本、历史与索引独立',async()=>{
 const w=await world(),old=await Promise.all(Array.from({length:16},(_,n)=>w.add(n))),input={requestId:randomUUID(),targetScope:'business-new',resources:w.refs(old)}
 const embedder:Embedder={profileHash:'b'.repeat(64),embed:async(_kind,texts)=>texts.map(()=>{const vector=new Float32Array(1024);vector[0]=1;return vector})}
 await w.retrieval.enroll(w.human,{sourceIds:[old[0]!.sourceId]});await w.retrieval.buildPending(w.human,embedder,signal())
 await assert.rejects(w.service.executionKnowledge({...w.human,kind:'agent',scopeIds:['business-new']},['business-new'],[old[0]!.id]),{code:'teloa/forbidden'})
 const [drafts,replay]=await Promise.all([w.service.prepareAdoption(w.human,input),w.service.prepareAdoption(w.human,{...input,resources:[...input.resources].reverse()})])
 assert.deepEqual(drafts.map(row=>row.id),replay.map(row=>row.id));assert.equal(drafts.length,16);assert.equal((await w.service.list(w.human)).resources.length,16,'准备不自动加入')
 assert.ok(drafts.every(row=>row.scopeIds.length===1&&row.scopeIds[0]==='business-new'&&row.sourceId.startsWith('adopted_')))
 const resources=await Promise.all(drafts.map(draft=>w.service.apply(w.human,{draftId:draft.id,expectedVersion:draft.version})))
 const newActor={...w.human,kind:'agent' as const,scopeIds:['business-new']},contents=await w.service.executionKnowledge(newActor,['business-new'],resources.map(row=>row.id))
 assert.equal(contents.length,16);assert.ok(contents.every(row=>row.text.includes('告警先核对')))
 assert.deepEqual((await w.retrieval.status(w.human,embedder.profileHash)).items.map(row=>row.resourceId),[old[0]!.id],'不复用或改写原索引')
 const fixed=await w.adopted.read(resources[0]!.sourceId,resources[0]!.sourceVersion,{actor:newActor,scopeIds:['business-new']});assert.match(fixed.source,/resource:.*@1 ← market:fixed-soc/)
 await w.service.withdraw(w.human,{resourceId:old[0]!.id,expectedVersion:old[0]!.version});w.unavailable.add(old[0]!.sourceId)
 assert.equal((await w.service.executionKnowledge(newActor,['business-new'],resources.map(row=>row.id))).length,16,'采用固定版本不跟随原资料撤回或来源变化')
 await w.retrieval.enroll(w.human,{sourceIds:[resources[0]!.sourceId]});await w.retrieval.buildPending(w.human,embedder,signal())
 const found=await w.retrieval.search(newActor,['business-new'],{query:'告警核对'},embedder,signal());assert.ok(found.results.length);assert.ok(found.results.every(row=>resources.some(resource=>resource.id===row.resourceId)))
 await assert.rejects(w.adopted.read(resources[0]!.sourceId,resources[0]!.sourceVersion,{actor:w.human,scopeIds:['soc']}),{code:'teloa/forbidden'})
 await assert.rejects(w.adopted.read(resources[0]!.sourceId,resources[0]!.sourceVersion,{actor:{...newActor,ownerId:'other'},scopeIds:['business-new']}),{code:'teloa/source-unavailable'})
 assert.equal((await w.adopted.list({actor:{...w.human,scopeIds:['soc']}})).references.length,0)
 await assert.rejects(pool.query('update teloa_resource_adoptions set content=$1 where owner_id=$2',['tamper',w.human.ownerId]),/immutable/)
})
test('采用拒绝代理、跨本人、缺原范围、未登记目标、过期版本与伪造正文，批量失败完整回滚；请求身份不能换意图',async()=>{
 const w=await world(),a=await w.add(1),b=await w.add(2),input={requestId:randomUUID(),targetScope:'business-new',resources:w.refs([a,b])}
 await assert.rejects(w.service.prepareAdoption({...w.human,kind:'agent'},input),{code:'teloa/forbidden'})
 await assert.rejects(w.service.prepareAdoption({...w.human,ownerId:'other'},input),{code:'teloa/forbidden'})
 await assert.rejects(w.service.prepareAdoption({...w.human,scopeIds:['business-new']},input),{code:'teloa/forbidden'})
 await assert.rejects(w.service.prepareAdoption({...w.human,scopeIds:[...w.human.scopeIds,'not-registered']},{...input,targetScope:'not-registered'}),{code:'teloa/forbidden'})
 await assert.rejects(w.service.prepareAdoption(w.human,{...input,resources:[{...input.resources[0],version:2}]}),{code:'teloa/version-conflict'})
 await assert.rejects(w.service.prepareAdoption(w.human,{...input,ownerId:'forged'}),{code:'teloa/invalid-input'})
 w.unavailable.add(b.sourceId);await assert.rejects(w.service.prepareAdoption(w.human,input),{code:'teloa/source-unavailable'})
 assert.equal((await pool.query('select count(*)::int n from teloa_resource_adoptions where owner_id=$1',[w.human.ownerId])).rows[0].n,0)
 assert.equal((await w.service.list(w.human)).drafts.filter(row=>row.status==='draft').length,0)
 w.unavailable.clear();const drafts=await w.service.prepareAdoption(w.human,input)
 await assert.rejects(w.service.prepareAdoption(w.human,{...input,resources:w.refs([a])}),{code:'teloa/conflict'})
 assert.deepEqual((await w.service.prepareAdoption(w.human,input)).map(row=>row.id),drafts.map(row=>row.id))
 w.texts.set(a.sourceId,'被改写正文');await assert.rejects(w.service.prepareAdoption(w.human,{...input,requestId:randomUUID()}),{code:'teloa/source-unavailable'})
})
test('独立采用来源仍登记真实字节数，超大资料继续受现有整段正文上限限制',async()=>{
 const w=await world(),original=await w.add(1,'# 大型手册\n\n'+'固定资料。'.repeat(20000)),drafts=await w.service.prepareAdoption(w.human,{requestId:randomUUID(),targetScope:'business-new',resources:w.refs([original])}),draft=drafts[0]!,resource=await w.service.apply(w.human,{draftId:draft.id,expectedVersion:draft.version})
 assert.ok((await w.service.fullTextBytes(w.human,[resource])).get(resource.id)!>256*1024)
 await assert.rejects(w.service.checkFullTextBudget(w.human,[resource.id],'role'),{code:'teloa/invalid-input'})
 await assert.rejects(w.service.executionKnowledge({...w.human,kind:'agent',scopeIds:['business-new']},['business-new'],[resource.id]),{code:'teloa/invalid-input'})
 assert.ok((await w.service.readContent(w.human,{resourceId:resource.id,expectedVersion:resource.version,sourceVersion:resource.sourceVersion})).text.startsWith('# 大型手册'))
})
