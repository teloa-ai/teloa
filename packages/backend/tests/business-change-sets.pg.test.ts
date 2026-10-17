import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool,type PoolClient} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import * as api from '../src/index.ts'
import {BusinessDefinitionSourceReader} from '../src/work/business-definition-source.ts'
let pool:Pool,container:StartedPostgreSqlContainer
const identity={id:randomUUID,now:()=>new Date().toISOString()}
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()})
 for(const init of [api.initializeBusinessSpaces,api.initializeBusinessDefinitions,api.initializeBusinessConfigurations,api.initializeBusinessRuntime,api.initializeBusinessData,api.initializeBusinessWarehouse,api.initializeBusinessSnapshotReferences,api.initializeBusinessRecords,api.initializeBusinessSync])await init(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})
async function fixture(extraType=false){
 assert.equal(typeof api.BusinessChangeSetService,'function','须提供持久业务修改草稿')
 await api.initializeBusinessChangeSets(pool)
 const unavailable=async():Promise<never>=>{throw Error('不能访问外部来源')},drafts=new api.BusinessConfigurationDraftService(pool,identity),store=new api.BusinessConfigurationStore(pool)
 const definitions=new BusinessDefinitionSourceReader({get:unavailable,getInTransaction:unavailable},{get:unavailable,getInTransaction:unavailable,listInTransaction:async()=>({items:[],hasMore:false})},{activeSourceIds:unavailable},undefined,store)
 const runtime=new api.BusinessRuntimeService(pool,identity),spaces=new api.BusinessSpaceService(pool,identity),configuration=new api.BusinessConfigurationService(pool,identity,{drafts,store,definitions,runtime,spaces}),preview=new api.BusinessConfigurationPreviewService(pool,drafts,definitions,identity)
 const actor={ownerId:randomUUID(),scopeIds:[] as string[]};let draft=await drafts.begin(actor,{requestId:randomUUID(),title:'合成客户业务'})
 const definition={format:'teloa.business-object-type/v1',id:'customer',version:'1.0.0',domain:draft.scope,title:'客户',unit:'条',lead:'客户',sourceId:draft.candidate.sources[0]!.sourceId,fields:[{name:'state',label:'状态',from:'状态',type:'text',required:true}]}
 draft=await drafts.revise(actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:1,patch:{upsertDefinitions:[{kind:'object-type',definition},...(extraType?[{kind:'object-type',definition:{...definition,id:'contact',title:'联系人'}}]:[])],upsertPages:[{id:'home',title:'客户',kind:'records',objectType:'customer',fields:['state'],allowCreate:true,allowEdit:true,allowArchive:true}],homePageId:'home'}})
 await configuration.apply(actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:draft.revision,expectedBaseVersion:0,previewReceipt:(await preview.preview(actor,{draftId:draft.id,expectedRevision:draft.revision})).receipt});actor.scopeIds=[draft.scope]
 const dependencies={definitions,warehouse:new api.BusinessWarehouseService(pool,identity),references:new api.BusinessSnapshotReferenceService(pool,identity)},records=new api.BusinessRecordService(pool,identity,dependencies)
 const origin={sessionId:'session-'+randomUUID(),messageId:'message-'+randomUUID(),seq:1,fingerprint:'fixed-context-'+randomUUID()}
 const changes=new api.BusinessChangeSetService(pool,identity,records)
 const input={requestId:randomUUID(),scope:draft.scope,operations:[{operation:'create',type:'customer',title:'客户甲',summary:'',fields:[{name:'state',value:'待联系'}]}]}
 return {actor,records,changes,input,origin,dependencies,drafts,configuration,preview,definition}
}
test('准备零正式写入，重建服务后可读；批准采用与回执同事务，丢回包后原ID重放',async()=>{
 const f=await fixture(),draft=await f.changes.prepare(f.actor,f.input,f.origin)
 assert.equal(draft.state,'draft');assert.equal((await f.records.list(f.actor,{scope:f.input.scope,type:'customer',limit:10})).items.length,0)
 assert.deepEqual(await f.changes.prepare(f.actor,f.input,f.origin),draft)
 const rebuilt=new api.BusinessChangeSetService(pool,identity,f.records),apply={changeSetId:draft.id,expectedRevision:1,expectedDigest:draft.digest}
 assert.deepEqual(await rebuilt.get(f.actor,{changeSetId:draft.id}),draft)
 await assert.rejects(rebuilt.apply(f.actor,apply,async()=>{throw Object.assign(Error('没有原生批准'),{code:'teloa/forbidden'})}),{code:'teloa/forbidden'})
 const result=await rebuilt.apply(f.actor,apply,async()=>f.origin.fingerprint);assert.equal(result.state,'applied');assert.ok(result.receipt);assert.equal(result.receipt.items.length,1)
 assert.deepEqual(await rebuilt.apply(f.actor,apply,async()=>f.origin.fingerprint),result)
 assert.equal((await f.records.list(f.actor,{scope:f.input.scope,type:'customer',limit:10})).items.length,1)
})
test('多类型冻结预览覆盖全部定义，采用末端失败回滚记录和回执；定义变化拒绝旧批准',async()=>{
 const f=await fixture(true),operations=[f.input.operations[0]!,{...f.input.operations[0]!,type:'contact',title:'联系人甲'}],draft=await f.changes.prepare(f.actor,{...f.input,operations},f.origin)
 assert.deepEqual(draft.preview.definitions.map(row=>row.type).sort(),['contact','customer'])
 const input={changeSetId:draft.id,expectedRevision:1,expectedDigest:draft.digest}
 const failAfterRecords=new Proxy(f.records,{get(target,key){if(key==='batchInTransaction')return async(...args:Parameters<typeof target.batchInTransaction>)=>{await target.batchInTransaction(...args);throw Error('采用末端故障')};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})
 await assert.rejects(new api.BusinessChangeSetService(pool,identity,failAfterRecords).apply(f.actor,input,async()=>f.origin.fingerprint),/采用末端故障/)
 for(const type of ['customer','contact'])assert.equal((await f.records.list(f.actor,{scope:f.input.scope,type,limit:10})).items.length,0)
 assert.equal((await f.changes.get(f.actor,{changeSetId:draft.id})).state,'draft')
 let authorizations=0
 await assert.rejects(f.changes.apply(f.actor,input,async()=>{if(++authorizations===2)throw Error('本人已停止采用');return f.origin.fingerprint}),/本人已停止采用/)
 for(const type of ['customer','contact'])assert.equal((await f.records.list(f.actor,{scope:f.input.scope,type,limit:10})).items.length,0)
 const applied=await f.changes.apply(f.actor,input,async()=>f.origin.fingerprint);assert.equal(applied.receipt!.items.length,2)
 const fresh=await f.changes.prepare(f.actor,{...f.input,requestId:randomUUID(),operations},f.origin)
 const edit=await f.drafts.begin(f.actor,{requestId:randomUUID(),scope:f.input.scope,title:'调整联系人字段'})
 const revised=await f.drafts.revise(f.actor,{requestId:randomUUID(),draftId:edit.id,expectedRevision:1,patch:{upsertDefinitions:[{kind:'object-type',definition:{...f.definition,id:'contact',title:'联系人',fields:[{...f.definition.fields[0]!,label:'跟进状态'}]}}]}})
 await f.configuration.apply(f.actor,{requestId:randomUUID(),draftId:edit.id,expectedRevision:revised.revision,expectedBaseVersion:1,previewReceipt:(await f.preview.preview(f.actor,{draftId:edit.id,expectedRevision:revised.revision})).receipt})
 await assert.rejects(f.changes.apply(f.actor,{changeSetId:fresh.id,expectedRevision:1,expectedDigest:fresh.digest},async()=>f.origin.fingerprint),{code:'teloa/version-conflict'})
 for(const type of ['customer','contact'])assert.equal((await f.records.list(f.actor,{scope:f.input.scope,type,limit:10})).items.length,1)
})
test('同请求异内容、过期摘要、跨本人和范围均拒绝；拒绝不改变记录',async()=>{
 const f=await fixture(),draft=await f.changes.prepare(f.actor,f.input,f.origin)
 await assert.rejects(f.changes.prepare(f.actor,{...f.input,operations:[{...f.input.operations[0],title:'另一内容'}]},f.origin),{code:'teloa/conflict'})
 await assert.rejects(f.changes.get({...f.actor,ownerId:randomUUID()},{changeSetId:draft.id}),{code:'teloa/not-found'})
 await assert.rejects(f.changes.get({...f.actor,scopeIds:[]},{changeSetId:draft.id}),{code:'teloa/forbidden'})
 await assert.rejects(f.changes.apply(f.actor,{changeSetId:draft.id,expectedRevision:1,expectedDigest:'a'.repeat(64)},async()=>f.origin.fingerprint),{code:'teloa/version-conflict'})
 const rejected=await f.changes.reject(f.actor,{changeSetId:draft.id,expectedRevision:1});assert.equal(rejected.state,'rejected')
 await assert.rejects(f.changes.apply(f.actor,{changeSetId:draft.id,expectedRevision:1,expectedDigest:draft.digest},async()=>f.origin.fingerprint),{code:'teloa/conflict'})
 assert.equal((await f.records.list(f.actor,{scope:f.input.scope,type:'customer',limit:10})).items.length,0)
})
test('审批期间记录变化使草稿过期；整批并发采用只保存一次，授权变化零写',async()=>{
 const f=await fixture(),first=await f.records.batch(f.actor,f.input)
 const operations=[{operation:'edit',type:'customer',id:first.items[0]!.id,expectedVersion:1,fields:[{name:'state',value:'已联系'}]}]
 const draft=await f.changes.prepare(f.actor,{...f.input,requestId:randomUUID(),operations},f.origin)
 await f.records.edit(f.actor,{scope:f.input.scope,type:'customer',id:first.items[0]!.id,expectedVersion:1,requestId:randomUUID(),fields:[{name:'state',value:'人工更新'}]})
 assert.equal((await f.changes.get(f.actor,{changeSetId:draft.id})).state,'stale')
 await assert.rejects(f.changes.apply(f.actor,{changeSetId:draft.id,expectedRevision:1,expectedDigest:draft.digest},async()=>f.origin.fingerprint),{code:'teloa/version-conflict'})
 const fresh=await f.changes.prepare(f.actor,{...f.input,requestId:randomUUID()},f.origin),apply={changeSetId:fresh.id,expectedRevision:1,expectedDigest:fresh.digest}
 await assert.rejects(f.changes.apply(f.actor,apply,async()=>'changed-context'),{code:'teloa/forbidden'})
 const replies=await Promise.all([f.changes.apply(f.actor,apply,async()=>f.origin.fingerprint),f.changes.apply(f.actor,apply,async()=>f.origin.fingerprint)])
 assert.deepEqual(replies[0],replies[1]);assert.equal((await f.records.list(f.actor,{scope:f.input.scope,type:'customer',limit:10})).items.length,2)
})
test('同对象可关联多个原生工作，普通结果版本固定，重启可读且请求重放不重复',async()=>{
 const f=await fixture();assert.equal(typeof api.BusinessObjectWorkLinkService,'function')
 await api.initializeBusinessObjectWork(pool)
 const first=(await f.records.batch(f.actor,f.input)).items[0]!,reference={scope:first.scope,type:first.type,id:first.id,version:first.version,snapshotHash:first.snapshotHash}
 const authorize=async(_db:PoolClient,_actor:{ownerId:string;scopeIds:string[]},scope:string,sessionId:string)=>{assert.equal(scope,first.scope);assert.ok(sessionId.startsWith('session-'))}
 const work=new api.BusinessObjectWorkLinkService(pool,identity,{authorizeSession:authorize})
 const input={requestId:randomUUID(),reference,sessionId:f.origin.sessionId,title:'客户研究'}
 const link=await work.link(f.actor,input);assert.deepEqual(await work.link(f.actor,input),link)
 const second=await work.link(f.actor,{...input,requestId:randomUUID(),sessionId:'session-'+randomUUID(),title:'联系准备'})
 assert.notEqual(link.id,second.id);assert.equal((await work.list(f.actor,{scope:first.scope,type:first.type,id:first.id})).length,2)
 const publish={requestId:randomUUID(),workLinkId:link.id,slot:'summary',expectedRevision:0,summary:'依据原记录的分析',state:'completed'}
 const result=await work.publish(f.actor,publish,f.origin);assert.equal(result.revision,1);assert.deepEqual(await work.publish(f.actor,publish,f.origin),result)
 await assert.rejects(work.publish(f.actor,{...publish,summary:'改正文'},f.origin),{code:'teloa/conflict'})
 await assert.rejects(work.publish(f.actor,{...publish,requestId:randomUUID(),summary:'旧轮次'},f.origin),{code:'teloa/version-conflict'})
 await assert.rejects(work.results({...f.actor,ownerId:randomUUID()},{workLinkId:link.id}),{code:'teloa/not-found'})
 const rebuilt=new api.BusinessObjectWorkLinkService(pool,identity,{authorizeSession:authorize})
 assert.deepEqual(await rebuilt.results(f.actor,{workLinkId:link.id}),[result]);assert.equal((await f.records.get(f.actor,{scope:first.scope,type:first.type,id:first.id})).version,1)
})
test('待办不被终态挤出；工作和结果有固定游标，可读超过原100项上限',async()=>{
 const f=await fixture(),draft=await f.changes.prepare(f.actor,f.input,f.origin)
 assert.equal(typeof f.changes.listPage,'function')
 for(let n=0;n<101;n++){const terminal={...draft,id:randomUUID(),state:'rejected',updatedAt:new Date(Date.parse(draft.updatedAt)+n+1).toISOString()};await pool.query('insert into teloa_business_change_sets values($1,$2,$3,$4,$5)',[f.actor.ownerId,terminal.id,draft.scope,JSON.stringify(terminal),JSON.stringify(f.origin)])}
 const pending=await f.changes.listPage(f.actor,{scope:draft.scope});assert.deepEqual(pending.items.map(row=>row.id),[draft.id])
 let cursor,history=0;do{const page=await f.changes.listPage(f.actor,{scope:draft.scope,history:true,cursor});history+=page.items.length;cursor=page.nextCursor}while(cursor);assert.equal(history,101)
 await pool.query('update teloa_business_change_sets set document=jsonb_set(document,\'{state}\',\'"awaiting-approval"\') where owner_id=$1 and id=$2',[f.actor.ownerId,draft.id]);assert.equal((await f.changes.get(f.actor,{changeSetId:draft.id})).state,'draft')
 await api.initializeBusinessObjectWork(pool);const record=(await f.records.batch(f.actor,f.input)).items[0]!,reference={scope:record.scope,type:record.type,id:record.id,version:record.version,snapshotHash:record.snapshotHash}
 const work=new api.BusinessObjectWorkLinkService(pool,identity,{authorizeSession:async()=>{}}),link=await work.link(f.actor,{requestId:randomUUID(),reference,sessionId:f.origin.sessionId,title:'原工作'})
 let newest=link;for(let n=0;n<101;n++){newest={...link,id:randomUUID(),title:'工作'+n,createdAt:new Date(Date.parse(link.createdAt)+n+1).toISOString()};await pool.query('insert into teloa_business_object_work_links values($1,$2,$3,$4,$5,$6,$7)',[f.actor.ownerId,newest.id,reference.scope,reference.type,reference.id,reference.version,JSON.stringify(newest)])}
 const first=await work.listPage(f.actor,reference);assert.equal(first.items[0]!.id,newest.id)
 let count=0;cursor=undefined;do{const page=await work.listPage(f.actor,{...reference,cursor});count+=page.items.length;cursor=page.nextCursor}while(cursor);assert.equal(count,102)
 for(let n=1;n<=101;n++)await pool.query('insert into teloa_business_work_results values($1,$2,$3,$4,$5)',[f.actor.ownerId,link.id,'aaa',n,JSON.stringify({workLinkId:link.id,slot:'aaa',revision:n})])
 await pool.query('insert into teloa_business_work_results values($1,$2,$3,$4,$5)',[f.actor.ownerId,link.id,'summary',1,JSON.stringify({workLinkId:link.id,slot:'summary',revision:1})])
 let resultCursor,found=false;do{const page=await work.resultsPage(f.actor,{workLinkId:link.id,cursor:resultCursor});found ||=page.items.some(row=>row.slot==='summary');resultCursor=page.nextCursor}while(resultCursor);assert.equal(found,true)
 await assert.rejects(work.listPage(f.actor,{...reference,cursor:{at:'bad',id:randomUUID()}}),{code:'teloa/invalid-input'})
})
