import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {mkdtemp,mkdir,readFile,writeFile,rm,realpath} from 'node:fs/promises'
import {homedir,tmpdir} from 'node:os'
import {join} from 'node:path'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {Pool,stopTestContainer} from './postgres-test-lifecycle.ts'
import * as backend from '../src/index.ts'
import {initializeResources} from '../src/capabilities/schema.ts'
import {AuthorizedLocalMaterialCatalog,initializeAuthorizedLocalMaterials} from '../src/capabilities/authorized-local-material-catalog.ts'
import {ResourceService} from '../src/capabilities/resources.ts'
import {MarkdownKnowledgeService} from '../src/capabilities/markdown-knowledge.ts'
import {isPasteKnowledge,isKnowledgeCopyOrigin} from '@teloa/contract'

let pool:Pool,container:StartedPostgreSqlContainer,root:string
const identity={id:randomUUID,now:()=>new Date().toISOString()},hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex')
async function record(stage:string){if(process.env.TELOA_LOCAL_COPY_TEST_RECORD)await writeFile(process.env.TELOA_LOCAL_COPY_TEST_RECORD,JSON.stringify({stage,containerId:container?.getId(),root,models:0,ownedOnly:true,at:new Date().toISOString()}))}
async function evidence(name:string,value:unknown){const directory=process.env.TELOA_LOCAL_COPY_TEST_EVIDENCE_DIR;if(directory){await mkdir(directory,{recursive:true});await writeFile(join(directory,name+'.json'),JSON.stringify(value,null,2)+'\n')}}
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 // 必须复用已经存在的测试镜像，不让此定向验收触发下载。
 execFileSync('docker',['image','inspect','postgres:17-alpine','--format','{{.Id}}'],{stdio:'pipe'})
 container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()})
 root=await realpath(await mkdtemp(join(tmpdir(),'teloa-local-knowledge-copy-')));await record('created');await initializeResources(pool);await initializeAuthorizedLocalMaterials(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await stopTestContainer(container);if(root)await rm(root,{recursive:true,force:true});await record('cleaned')})
async function fixture(){
 const ownerId=randomUUID(),actor={ownerId,kind:'human' as const,scopeIds:['general']},path=ownerId+'.md',original=Buffer.from('\uFEFF# 本机原件\r\n完整固定正文\r\n')
 await writeFile(join(root,path),original);let permitted=true
 const catalog=new AuthorizedLocalMaterialCatalog(pool,identity,{authorize:async()=>({workspaceRoot:root,assertCurrent:()=>{assert.equal(permitted,true)},isProtectedPath:()=>false})})
 const source=await catalog.register(actor,{requestId:randomUUID(),title:'登记原名',path,scopeIds:['general']})
 const resources=new ResourceService(pool,catalog,identity),draft=await resources.create(actor,{requestId:randomUUID(),title:'本机资料',sourceId:source.id,sourceVersion:source.version,scopeIds:['general']})
 const resource=await resources.apply(actor,{draftId:draft.id,expectedVersion:draft.version}),knowledge=new MarkdownKnowledgeService(pool,root,'default',identity)
 const Constructor=Reflect.get(backend,'LocalKnowledgeCopyService');assert.equal(typeof Constructor,'function','本机保存副本必须有独立的真实事务服务，不能借用industry许可协议')
 const copies=new Constructor(pool,knowledge,resources,catalog),ref={resourceId:resource.id,expectedResourceVersion:resource.version,sourceVersion:resource.sourceVersion}
 return {actor,path,original,catalog,source,resource,resources,knowledge,copies,ref,Constructor,permit:(value:boolean)=>{permitted=value}}
}
test('本机原字节固定预览，明确保存为普通paste和独立投影，不伪造行业来源且原件不变',async()=>{
 const f=await fixture(),preview=await f.copies.preview(f.actor,f.ref)
 assert.equal(preview.markdown,f.original.toString('utf8'));assert.equal(preview.origin.sourceVersion,hash(f.original));assert.deepEqual(preview.scopeIds,['general'])
 assert.deepEqual(preview.origin,{kind:'local-material',resourceId:f.resource.id,resourceVersion:1,sourceId:f.source.id,sourceTitle:'登记原名',sourceVersion:f.source.version,sourcePath:f.path,bytes:f.original.length})
 assert.equal(isKnowledgeCopyOrigin(preview.origin),false,'独立local origin不能伪装旧industry来源')
 const input={...f.ref,requestId:randomUUID(),title:' 我的副本 ',markdown:'\uFEFF# 本人明确编辑\r\n'},copy=await f.copies.create(f.actor,input)
 assert.equal(isPasteKnowledge(copy.knowledge),true);assert.equal(copy.knowledge.item.sourceType,'paste');assert.equal(copy.knowledge.version.markdown,'# 本人明确编辑\n')
 assert.equal(copy.knowledge.item.title,'我的副本');assert.equal(copy.resource.sourceId,'knowledge_'+copy.knowledge.item.id);assert.deepEqual(copy.resource.scopeIds,f.resource.scopeIds)
 assert.deepEqual(await f.copies.origin(f.actor,{knowledgeId:copy.knowledge.item.id}),preview.origin)
 await assert.rejects(f.copies.origin({...f.actor,kind:'agent'},{knowledgeId:copy.knowledge.item.id}),{code:'teloa/forbidden'},'知识正文可读不能隐式披露本人本机路径元数据')
 const industry=new backend.KnowledgeCopyService(pool,f.knowledge,f.resources,{} as never)
 assert.equal(await industry.origin(f.actor,{knowledgeId:copy.knowledge.item.id}),null,'旧industry读取器不得将新local记录当损坏')
 assert.deepEqual(await readFile(join(root,f.path)),f.original);assert.deepEqual(await f.resources.getResource(f.actor,{resourceId:f.resource.id}),f.resource)
 assert.equal((await f.knowledge.list(f.actor,{})).length,1);assert.equal((await f.resources.list(f.actor)).resources.length,2)
 await evidence('created',{input,preview,copy,sourceBytesSha256:hash(await readFile(join(root,f.path))),receipt:(await pool.query('select command_hash,knowledge_id,result from teloa_local_knowledge_copies where owner_id=$1 and request_id=$2',[f.actor.ownerId,input.requestId])).rows[0]})
 await f.resources.withdraw(f.actor,{resourceId:f.resource.id,expectedVersion:1});await rm(join(root,f.path))
 assert.deepEqual(await f.copies.create(f.actor,input),copy,'未知回执重试恢复原身份，不重新读已撤回/丢失原件')
 await evidence('replayed-after-source-withdrawal',{input,result:await f.copies.create(f.actor,input),knowledgeCount:(await f.knowledge.list(f.actor,{})).length,resourceCount:(await f.resources.list(f.actor)).resources.length})
 await assert.rejects(f.copies.create(f.actor,{...input,markdown:'# 不同原请求'}),{code:'teloa/conflict'})
 await assert.rejects(f.copies.create(f.actor,{...input,requestId:randomUUID()}),{code:'teloa/resource-withdrawn'})
})
test('本人、固定版本、当前原件和业务范围在服务端重验，agent和额外参数不能写',async()=>{
 const f=await fixture(),input={...f.ref,requestId:randomUUID(),title:'不可越权',markdown:'# 待保存'}
 for(const [actor,command,code]of [[{...f.actor,ownerId:randomUUID()},input,'teloa/forbidden'],[{...f.actor,kind:'agent'},input,'teloa/forbidden'],[{...f.actor,scopeIds:['other']},input,'teloa/forbidden'],[f.actor,{...input,expectedResourceVersion:2},'teloa/version-conflict'],[f.actor,{...input,sourceVersion:'a'.repeat(64)},'teloa/version-conflict'],[f.actor,{...input,scopeIds:['other']},'teloa/invalid-input'],[f.actor,{...input,publisher:'伪造'},'teloa/invalid-input']]as const)await assert.rejects(f.copies.create({...actor,scopeIds:[...actor.scopeIds]},command),{code})
 f.permit(false);await assert.rejects(f.copies.create(f.actor,input),{code:'teloa/forbidden'});f.permit(true)
 await writeFile(join(root,f.path),'# 已变版');await assert.rejects(f.copies.create(f.actor,input),{code:'teloa/version-conflict'})
 assert.equal((await f.knowledge.list(f.actor,{})).length,0);assert.equal((await f.resources.list(f.actor)).resources.length,1)
})
test('准备后原件变版或撤权，保存事务必须回滚知识、投影和receipt',async()=>{
 for(const kind of ['version','permission']){
  const f=await fixture();let reads=0
  const sources={list:f.catalog.list.bind(f.catalog),read:async(...args:Parameters<typeof f.catalog.read>)=>{if(++reads===2){if(kind==='version')await writeFile(join(root,f.path),'# 保存中变版');else f.permit(false)}return f.catalog.read(...args)}}
  const copies=new f.Constructor(pool,f.knowledge,f.resources,sources)
  await assert.rejects(copies.create(f.actor,{...f.ref,requestId:randomUUID(),title:'不应残留',markdown:'# 副本'}),{code:kind==='version'?'teloa/version-conflict':'teloa/forbidden'})
  assert.equal((await f.knowledge.list(f.actor,{})).length,0);assert.equal((await f.resources.list(f.actor)).resources.length,1)
  assert.equal((await pool.query('select count(*)::int n from teloa_local_knowledge_copies where owner_id=$1',[f.actor.ownerId])).rows[0].n,0)
 }
})
test('投影失败原子回滚，发布正文不残留，nonce不能借旧paste请求换副本来源',async()=>{
 const f=await fixture(),allocated:string[]=[],knowledge=new MarkdownKnowledgeService(pool,root,'default',{id:()=>{const id=randomUUID();allocated.push(id);return id},now:identity.now})
 const broken=new Proxy(f.resources,{get(target,key){if(key==='createKnowledgeProjectionInTransaction')return async()=>{throw Error('synthetic projection failure')};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value}})
 const copies=new f.Constructor(pool,knowledge,broken,f.catalog),input={...f.ref,requestId:randomUUID(),title:'原子副本',markdown:'# 原子正文'}
 await assert.rejects(copies.create(f.actor,input),{code:'teloa/storage-unavailable'})
 assert.equal((await knowledge.list(f.actor,{})).length,0);assert.equal((await f.resources.list(f.actor)).resources.length,1)
 await assert.rejects(readFile(join(root,'workspaces','default','knowledge',allocated[0]!,'versions',hash(input.markdown)+'.md')),{code:'ENOENT'})
 assert.equal((await pool.query('select count(*)::int n from teloa_local_knowledge_copies where owner_id=$1',[f.actor.ownerId])).rows[0].n,0)
 await f.knowledge.createPaste(f.actor,{requestId:input.requestId,title:input.title,category:'reference',topics:[],scopeIds:['general'],markdown:input.markdown})
 await assert.rejects(f.copies.create(f.actor,input),{code:'teloa/conflict'})
 assert.equal((await f.resources.list(f.actor)).resources.length,1)
})
test('COMMIT成功但回包丢失仅恢复原知识/投影；并发精确重放和不可变回执',async()=>{
 const f=await fixture();let lost=false
 const lossy={query:pool.query.bind(pool),connect:async()=>{const client=await pool.connect();let wrote=false;return new Proxy(client,{get(target,key){if(key==='query')return async(sql:unknown,...args:unknown[])=>{const result=await (target.query as(...values:unknown[])=>Promise<unknown>).call(target,sql,...args);if(typeof sql==='string'&&sql.startsWith('insert into teloa_local_knowledge_copies'))wrote=true;if(wrote&&!lost&&sql==='commit'){lost=true;throw Error('lost committed local-copy response')}return result};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value}})}} as unknown as Pool
 const copies=new f.Constructor(lossy,new MarkdownKnowledgeService(lossy,root,'default',identity),f.resources,f.catalog),input={...f.ref,requestId:randomUUID(),title:'恢复原身份',markdown:'# 唯一副本'}
 await assert.rejects(copies.create(f.actor,input),{code:'teloa/storage-unavailable'});assert.equal(lost,true)
 const receiptBeforeRecovery=(await pool.query('select command_hash,knowledge_id,result from teloa_local_knowledge_copies where owner_id=$1 and request_id=$2',[f.actor.ownerId,input.requestId])).rows[0]
 const a=await copies.create(f.actor,input),b=await copies.create(f.actor,input);assert.deepEqual(a,b)
 await evidence('lost-commit-response',{input,lostAfterActualCommit:lost,receiptBeforeRecovery,recovered:a,secondRecovery:b})
 assert.equal((await f.knowledge.list(f.actor,{})).length,1);assert.equal((await f.resources.list(f.actor)).resources.length,2)
 await assert.rejects(copies.create({...f.actor,scopeIds:['other']},input),{code:'teloa/forbidden'})
 await assert.rejects(pool.query('update teloa_local_knowledge_copies set result=result where owner_id=$1',[f.actor.ownerId]),/immutable/)
 const next={...input,requestId:randomUUID(),title:'另一次明确保存'},[c,d]=await Promise.all([copies.create(f.actor,next),copies.create(f.actor,next)]);assert.deepEqual(c,d)
 assert.equal((await f.knowledge.list(f.actor,{})).length,2);assert.equal((await f.resources.list(f.actor)).resources.length,3)
})
