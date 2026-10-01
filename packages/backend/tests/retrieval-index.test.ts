import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {homedir,tmpdir} from 'node:os'
import {join} from 'node:path'
import {mkdtemp,rm} from 'node:fs/promises'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {ReferenceError} from '@teloa/mcp-reference/catalog'
import {readRetrievalSearchResult,retrievalLimits} from '@teloa/contract'
import {ResourceService,type ResourceActor} from '../src/capabilities/resources.ts'
import {initializeResources} from '../src/capabilities/schema.ts'
import {MarkdownKnowledgeService} from '../src/capabilities/markdown-knowledge.ts'
import {MarkdownKnowledgeCatalog,markdownKnowledgeReferenceId} from '../src/capabilities/markdown-knowledge-catalog.ts'
import {KnowledgeResourceService} from '../src/capabilities/knowledge-resources.ts'
import {chunkRetrievalText,retrievalChunker} from '../src/capabilities/retrieval-chunker.ts'
import {RetrievalIndexService,RetrievalVectorCache,retrievalCoverageNote,type Embedder} from '../src/capabilities/retrieval-index.ts'

let container:StartedPostgreSqlContainer,pool:Pool,root:string
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeResources(pool)
 root=await mkdtemp(join(tmpdir(),'teloa-retrieval-index-'))
},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop();if(root)await rm(root,{recursive:true,force:true})})

const profileA='a'.repeat(64),profileB='b'.repeat(64)
/** 确定性假嵌入：字符二元组散列进 1024 维后做 L2 归一化；记录每次调用的批内容。 */
function vectorOf(text:string):Float32Array{
 const vector=new Float32Array(1024),points=[...text]
 for(let index=0;index+1<points.length;index++)vector[createHash('sha256').update(points[index]!+points[index+1]!).digest().readUInt16LE(0)%1024]!+=1
 if(points.length<2)vector[0]=1
 const norm=Math.hypot(...vector)
 return vector.map(value=>value/norm)
}
function fakeEmbedder(profileHash=profileA,hooks:{onCall?:(kind:string,texts:string[])=>void;dimensions?:number}={}){
 const calls:{kind:string;texts:string[]}[]=[]
 const embedder:Embedder={profileHash,async embed(kind,texts){
  calls.push({kind,texts:[...texts]});hooks.onCall?.(kind,texts)
  return texts.map(text=>hooks.dimensions?new Float32Array(hooks.dimensions).fill(0.01):vectorOf(text))
 }}
 return {embedder,calls,passages:()=>calls.filter(call=>call.kind==='passage').flatMap(call=>call.texts)}
}
const signal=()=>new AbortController().signal

function memoryCatalog(){
 const texts=new Map<string,string>(),broken=new Set<string>()
 return {
  broken,
  add(id:string,text:string){const version=createHash('sha256').update(text).digest('hex');texts.set(id+'@'+version,text);return version},
  async list(){return {schema:'teloa.reference-list/v1' as const,references:[]}},
  async read(id:string,version:string){
   if(broken.has(id))throw new Error('磁盘暂不可读')
   const text=texts.get(id+'@'+version)
   if(text===undefined)throw new ReferenceError('reference/version-conflict','资料版本已变化。')
   return {schema:'teloa.reference/v1' as const,id,title:'资料',source:id,version,bytes:Buffer.byteLength(text),text}
  },
 }
}
function world(){
 const catalog=memoryCatalog(),identity={id:randomUUID,now:()=>new Date().toISOString()}
 const resources=new ResourceService(pool,catalog,identity),retrieval=new RetrievalIndexService(pool,resources,identity)
 const human:ResourceActor={ownerId:randomUUID(),kind:'human',scopeIds:['general','design']}
 const add=async(title:string,text:string,scopeIds=['general'])=>{
  const sourceId='src_'+randomUUID().replaceAll('-',''),sourceVersion=catalog.add(sourceId,text)
  const draft=await resources.create(human,{requestId:randomUUID(),title,sourceId,sourceVersion,scopeIds})
  return resources.apply(human,{draftId:draft.id,expectedVersion:draft.version})
 }
 return {catalog,resources,retrieval,human,agent:{...human,kind:'agent' as const},add}
}
const policy='# 差旅报销制度\n\n员工出差返回后三十日内提交报销单，附完整发票与行程单。\n\n## 审批流程\n\n报销单先由部门负责人审批，再交财务复核，金额超过五千元需分管副总签字。\n'
const handbook='# 产品手册\n\n设备开机前请确认电源电压为二百二十伏，首次使用需完成网络配对。\n'
const count=async(sql:string,params:unknown[])=>(await pool.query(sql,params)).rows[0].count as number

test('加入后建索引，状态为 ready，检索带原文位置引用与覆盖范围',async()=>{
 const {retrieval,human,agent,add}=world(),{embedder,passages,calls}=fakeEmbedder()
 const doc=await add('差旅报销制度',policy.replaceAll('\n','\r\n')),other=await add('产品手册',handbook)
 await retrieval.enroll(human,{sourceIds:[doc.sourceId]})
 assert.deepEqual((await retrieval.status(human,profileA)).items.map(item=>[item.resourceId,item.state]),[[doc.id,'stale']])
 assert.deepEqual(await retrieval.buildPending(human,embedder,signal()),{ready:1,failed:0})
 const expected=chunkRetrievalText(policy)
 assert.equal(passages().length,expected.length)
 const status=await retrieval.status(human,profileA)
 assert.deepEqual(status.items,[{sourceId:doc.sourceId,resourceId:doc.id,title:'差旅报销制度',version:1,state:'ready',chunkCount:expected.length}])
 assert.equal(status.enrolled,1);assert.equal(status.chunks,expected.length)
 const result=await retrieval.search(agent,['general'],{query:'报销单需要谁审批签字'},embedder,signal())
 assert.deepEqual(calls.filter(call=>call.kind==='query').map(call=>call.texts),[['报销单需要谁审批签字']],'范围内有就绪索引时恰好推理一次查询')
 assert.deepEqual(readRetrievalSearchResult(result),result)
 assert.deepEqual(result.coverage,{searched:[{resourceId:doc.id,title:'差旅报销制度',version:1}],pending:[],note:retrievalCoverageNote})
 assert.ok(result.results.length>=1&&result.results.length<=5)
 const top=result.results[0]!,chunk=expected.find(item=>item.start===top.chars[0])!
 assert.equal(top.excerpt,policy.slice(top.chars[0],top.chars[1]))
 assert.deepEqual(top.lines,[chunk.startLine,chunk.endLine])
 assert.equal(top.heading,'差旅报销制度 > 审批流程')
 assert.equal(top.sourceId,doc.sourceId);assert.equal(top.sourceVersion,doc.sourceVersion);assert.equal(top.resourceVersion,1)
 assert.ok(result.results.every(hit=>hit.resourceId!==other.id),'未加入的资料不参与检索')
 assert.equal((await retrieval.search(human,['general'],{query:'报销',limit:1},embedder,signal())).results.length,1)
 assert.equal(await count('select count(*)::int as count from teloa_retrieval_chunks c join teloa_retrieval_indexes i on i.id=c.index_id where i.owner_id=$1',[human.ownerId]),expected.length)
 assert.equal((await pool.query("select column_name from information_schema.columns where table_name='teloa_retrieval_chunks' and column_name in ('text','content','excerpt')")).rowCount,0,'索引表不存分块正文')
})

test('知识修订后旧索引不再命中，新版本为 stale 并可重建，未变分块复用向量',async()=>{
 const identity={id:randomUUID,now:()=>new Date().toISOString()},knowledge=new MarkdownKnowledgeService(pool,root,'default',identity)
 const resources=new ResourceService(pool,new MarkdownKnowledgeCatalog(knowledge),identity),revisions=new KnowledgeResourceService(pool,knowledge,resources),retrieval=new RetrievalIndexService(pool,resources,identity)
 const human:ResourceActor={ownerId:randomUUID(),kind:'human',scopeIds:['general']},{embedder,passages}=fakeEmbedder()
 const first='# 第一章\n\n年假按工龄计算，满一年五天。\n\n# 第二章\n\n病假需提供医院证明。\n\n# 第三章\n\n加班申请须提前一天提交。\n'
 const saved=await knowledge.createPaste(human,{requestId:randomUUID(),title:'假期制度',category:'sop',topics:['假期'],scopeIds:['general'],markdown:first})
 const draft=await resources.create(human,{requestId:randomUUID(),title:saved.item.title,sourceId:markdownKnowledgeReferenceId(saved.item.id),sourceVersion:saved.version.contentHash,scopeIds:saved.item.scopeIds})
 const v1=await resources.apply(human,{draftId:draft.id,expectedVersion:draft.version})
 await retrieval.enroll(human,{sourceIds:[v1.sourceId]})
 await retrieval.buildPending(human,embedder,signal())
 assert.equal(passages().length,3)
 const revised=await revisions.revise(human,{requestId:randomUUID(),knowledgeId:saved.item.id,expectedKnowledgeVersion:1,resourceId:v1.id,expectedResourceVersion:1,markdown:first.replace('加班申请须提前一天提交。','加班申请改为提前三天在系统中提交。')}) as {resource:{id:string}}
 const v2=revised.resource.id
 const stale=await retrieval.search(human,['general'],{query:'加班申请提前几天'},embedder,signal())
 assert.deepEqual(stale.results,[],'旧版本索引不再命中')
 assert.deepEqual(stale.coverage.searched,[])
 assert.deepEqual(stale.coverage.pending,[{resourceId:v2,title:'假期制度',reason:'stale'}])
 assert.equal((await retrieval.status(human,profileA)).items[0]!.state,'stale')
 await retrieval.buildPending(human,embedder,signal())
 assert.equal(passages().length,4,'只为变更的分块做推理')
 const fresh=await retrieval.search(human,['general'],{query:'加班申请提前几天'},embedder,signal())
 assert.equal(fresh.results[0]!.resourceId,v2)
 assert.match(fresh.results[0]!.excerpt,/提前三天/)
 assert.equal(await count('select count(*)::int as count from teloa_retrieval_indexes where resource_id=$1',[v1.id]),0,'建索引结束后清理失效索引')
})

test('撤回提交后的第一次检索就不再命中，覆盖范围也不再列出',async()=>{
 const {retrieval,resources,human,add}=world(),{embedder}=fakeEmbedder()
 const doc=await add('差旅报销制度',policy)
 await retrieval.enroll(human,{sourceIds:[doc.sourceId]})
 await retrieval.buildPending(human,embedder,signal())
 assert.ok((await retrieval.search(human,['general'],{query:'报销审批'},embedder,signal())).results.length>0)
 await resources.withdraw(human,{resourceId:doc.id,expectedVersion:1})
 const result=await retrieval.search(human,['general'],{query:'报销审批'},embedder,signal())
 assert.deepEqual(result,{coverage:{searched:[],pending:[],note:retrievalCoverageNote},results:[]})
 assert.deepEqual((await retrieval.status(human,profileA)).items,[{sourceId:doc.sourceId,resourceId:null,title:null,version:null,state:'unavailable',chunkCount:null}])
})

test('移出检索在事务内删除索引与向量',async()=>{
 const {retrieval,human,add}=world(),{embedder}=fakeEmbedder()
 const doc=await add('差旅报销制度',policy),keep=await add('产品手册',handbook)
 await retrieval.enroll(human,{sourceIds:[doc.sourceId,keep.sourceId]})
 await retrieval.buildPending(human,embedder,signal())
 await retrieval.remove(human,{sourceIds:[doc.sourceId]})
 assert.equal(await count('select count(*)::int as count from teloa_retrieval_indexes where resource_id=$1',[doc.id]),0)
 assert.equal(await count('select count(*)::int as count from teloa_retrieval_enrollments where owner_id=$1',[human.ownerId]),1)
 assert.equal(await count('select count(*)::int as count from teloa_retrieval_chunks c join teloa_retrieval_indexes i on i.id=c.index_id where i.resource_id=$1',[keep.id]),chunkRetrievalText(handbook).length)
 const result=await retrieval.search(human,['general'],{query:'报销审批'},embedder,signal())
 assert.deepEqual(result.coverage.searched.map(item=>item.resourceId),[keep.id])
 assert.ok(result.results.every(hit=>hit.resourceId===keep.id))
 await retrieval.remove(human,{sourceIds:[doc.sourceId]})
})

test('范围外资料不出现在 searched 与 pending，也不计数',async()=>{
 const {retrieval,human,agent,add}=world(),{embedder}=fakeEmbedder()
 const general=await add('差旅报销制度',policy),secret=await add('设计评审纪要',policy.replace('差旅','设计'),['design']),later=await add('产品手册',handbook)
 await retrieval.enroll(human,{sourceIds:[general.sourceId,secret.sourceId]})
 await retrieval.buildPending(human,embedder,signal())
 await retrieval.enroll(human,{sourceIds:[later.sourceId]})
 const result=await retrieval.search(human,['general'],{query:'报销审批'},embedder,signal())
 assert.deepEqual(result.coverage.searched.map(item=>item.resourceId),[general.id])
 assert.deepEqual(result.coverage.pending,[{resourceId:later.id,title:'产品手册',reason:'stale'}])
 assert.ok(result.results.every(hit=>hit.resourceId===general.id))
 const narrowed=await retrieval.search({...agent,scopeIds:['general']},['general','design'],{query:'评审报销'},embedder,signal())
 assert.deepEqual(narrowed.coverage.searched.map(item=>item.resourceId),[general.id],'主体范围同样收窄')
 const agentStatus=await retrieval.status({...agent,scopeIds:['general']},profileA)
 assert.deepEqual(agentStatus.items.map(item=>item.resourceId).sort(),[general.id,later.id].sort())
 assert.equal(agentStatus.enrolled,undefined);assert.equal(agentStatus.chunks,undefined)
})

test('profileHash 变化后旧索引不可用，按新配置重建后清理旧配置',async()=>{
 const {retrieval,human,add}=world(),a=fakeEmbedder(profileA),b=fakeEmbedder(profileB)
 const doc=await add('差旅报销制度',policy)
 await retrieval.enroll(human,{sourceIds:[doc.sourceId]})
 await retrieval.buildPending(human,a.embedder,signal())
 const other=await retrieval.search(human,['general'],{query:'报销'},b.embedder,signal())
 assert.deepEqual(other.results,[])
 assert.deepEqual(other.coverage.pending,[{resourceId:doc.id,title:'差旅报销制度',reason:'stale'}])
 assert.equal((await retrieval.status(human,profileB)).items[0]!.state,'stale')
 assert.equal((await retrieval.status(human,null)).items[0]!.state,'stale')
 await retrieval.buildPending(human,b.embedder,signal())
 assert.ok((await retrieval.search(human,['general'],{query:'报销'},b.embedder,signal())).results.length>0)
 assert.deepEqual((await pool.query('select profile_hash from teloa_retrieval_indexes where owner_id=$1',[human.ownerId])).rows.map(row=>row.profile_hash),[profileB])
 await assert.rejects(retrieval.search(human,['general'],{query:'报销'},{...b.embedder,profileHash:'not-a-hash'},signal()),{code:'teloa/invalid-input'})
})

test('上限：500 份加入、5 万块、查询 500 字，向量长度不是 4096 字节时拒写',async()=>{
 const {retrieval,human,add}=world(),{embedder,calls}=fakeEmbedder()
 const doc=await add('差旅报销制度',policy),big=await add('产品手册',handbook)
 await assert.rejects(retrieval.enroll(human,{sourceIds:['src_missing']}),{code:'teloa/not-found'})
 await assert.rejects(retrieval.enroll(human,{sourceIds:[doc.sourceId,doc.sourceId]}),{code:'teloa/invalid-input'})
 await assert.rejects(retrieval.enroll(human,{sourceIds:[doc.sourceId],extra:true}),{code:'teloa/invalid-input'})
 await pool.query("insert into teloa_retrieval_enrollments(owner_id,source_id,created_at) select $1,'filler_'||n,now() from generate_series(1,500) n",[human.ownerId])
 await assert.rejects(retrieval.enroll(human,{sourceIds:[doc.sourceId]}),{code:'teloa/invalid-input'})
 await pool.query("delete from teloa_retrieval_enrollments where owner_id=$1 and source_id like 'filler_%'",[human.ownerId])

 await assert.rejects(retrieval.search(human,['general'],{query:'字'.repeat(501)},embedder,signal()),{code:'teloa/invalid-input'})
 await assert.rejects(retrieval.search(human,['general'],{query:'  '},embedder,signal()),{code:'teloa/invalid-input'})
 await assert.rejects(retrieval.search(human,['general'],{query:'报销',limit:9},embedder,signal()),{code:'teloa/invalid-input'})
 await assert.rejects(retrieval.search(human,['general'],{query:'报销',resourceIds:[doc.id]},embedder,signal()),{code:'teloa/invalid-input'})
 await assert.rejects(retrieval.search(human,['general'],{query:'报销',limit:null},embedder,signal()),{code:'teloa/invalid-input'},'limit 为 null 不是缺省')
 assert.deepEqual(await retrieval.search(human,['general'],{query:'字'.repeat(500)},embedder,signal()),{coverage:{searched:[],pending:[],note:retrievalCoverageNote},results:[]})
 assert.equal(calls.length,0,'没有已加入且就绪的资料时不推理查询')

 await retrieval.enroll(human,{sourceIds:[doc.sourceId]})
 await assert.rejects(retrieval.buildPending(human,fakeEmbedder(profileA,{dimensions:1023}).embedder,signal()),{code:'teloa/dependency-unavailable'})
 assert.equal(await count('select count(*)::int as count from teloa_retrieval_chunks c join teloa_retrieval_indexes i on i.id=c.index_id where i.owner_id=$1',[human.ownerId]),0)
 await retrieval.buildPending(human,embedder,signal())
 const index=(await pool.query('select id from teloa_retrieval_indexes where resource_id=$1',[doc.id])).rows[0].id as string
 await assert.rejects(pool.query("insert into teloa_retrieval_chunks(index_id,ordinal,start_char,end_char,start_line,end_line,heading,text_sha256,vector) values($1,999,0,1,0,0,null,$2,$3)",[index,'0'.repeat(64),Buffer.alloc(4095)]),/check/)

 // 5 万块上限：已有索引占满额度时，新资料建索引失败且不写任何向量。
 await retrieval.enroll(human,{sourceIds:[big.sourceId]})
 const bigChunks=chunkRetrievalText(handbook).length
 assert.ok(bigChunks>=1)
 await pool.query('update teloa_retrieval_indexes set chunk_count=$2 where id=$1',[index,retrievalLimits.maxChunks-bigChunks+1])
 assert.deepEqual(await retrieval.buildPending(human,embedder,signal()),{ready:0,failed:1})
 const failed=(await pool.query('select state,failure,chunk_count from teloa_retrieval_indexes where resource_id=$1',[big.id])).rows[0]
 assert.equal(failed.state,'failed');assert.equal(failed.failure.code,'teloa/invalid-input');assert.equal(failed.chunk_count,0)
 assert.equal((await retrieval.status(human,profileA)).items.find(item=>item.resourceId===big.id)!.state,'failed')
 assert.deepEqual(await retrieval.buildPending(human,embedder,signal()),{ready:0,failed:0},'失败的资料不在每次任务中反复重试')
})

test('reconcile 清理撤回、改版、旧分块器与旧配置的失效行',async()=>{
 const {retrieval,resources,human,add}=world(),{embedder}=fakeEmbedder()
 const withdrawn=await add('差旅报销制度',policy),kept=await add('产品手册',handbook)
 await retrieval.enroll(human,{sourceIds:[withdrawn.sourceId,kept.sourceId]})
 await retrieval.buildPending(human,embedder,signal())
 await resources.withdraw(human,{resourceId:withdrawn.id,expectedVersion:1})
 const keptIndex=(await pool.query('select * from teloa_retrieval_indexes where resource_id=$1',[kept.id])).rows[0]
 await pool.query("insert into teloa_retrieval_indexes(id,owner_id,resource_id,resource_version,source_id,source_version,scope_ids,profile_hash,chunker,state,chunk_count,failure,created_at) values($1,$2,$3,1,$4,$5,$6,$7,'teloa.chunk.zh/v0','ready',0,null,now())",[randomUUID(),human.ownerId,kept.id,kept.sourceId,kept.sourceVersion,JSON.stringify(kept.scopeIds),profileA])
 await pool.query("insert into teloa_retrieval_indexes(id,owner_id,resource_id,resource_version,source_id,source_version,scope_ids,profile_hash,chunker,state,chunk_count,failure,created_at) values($1,$2,$3,1,$4,$5,$6,$7,$8,'ready',0,null,now())",[randomUUID(),human.ownerId,kept.id,kept.sourceId,kept.sourceVersion,JSON.stringify(kept.scopeIds),profileB,retrievalChunker])
 const removed=await retrieval.reconcile(profileA)
 assert.ok(removed.removed>=3)
 assert.deepEqual((await pool.query('select id from teloa_retrieval_indexes where owner_id=$1',[human.ownerId])).rows.map(row=>row.id),[keptIndex.id])
 assert.equal(await count('select count(*)::int as count from teloa_retrieval_chunks c where not exists(select 1 from teloa_retrieval_indexes i where i.id=c.index_id)',[]),0)
 assert.equal((await retrieval.reconcile()).removed>=0,true)
})

test('Agent 主体不能加入、移出或建索引',async()=>{
 const {retrieval,agent,human,add}=world(),{embedder}=fakeEmbedder()
 const doc=await add('差旅报销制度',policy)
 await assert.rejects(retrieval.enroll(agent,{sourceIds:[doc.sourceId]}),{code:'teloa/forbidden'})
 await retrieval.enroll(human,{sourceIds:[doc.sourceId]})
 await assert.rejects(retrieval.remove(agent,{sourceIds:[doc.sourceId]}),{code:'teloa/forbidden'})
 await assert.rejects(retrieval.buildPending(agent,embedder,signal()),{code:'teloa/forbidden'})
 await assert.rejects(retrieval.enroll({...human,ownerId:''},{sourceIds:[doc.sourceId]}),{code:'teloa/forbidden'})
 assert.equal(await count('select count(*)::int as count from teloa_retrieval_enrollments where owner_id=$1',[human.ownerId]),1)
})

test('建索引每批不超过 32 条，批间可取消，取消后已写向量被复用',async()=>{
 const {retrieval,human,add}=world()
 const text=Array.from({length:70},(_,index)=>`# 第${index}节\n\n第${index}节规定编号${index}的设备每周巡检一次并登记。\n`).join('\n')
 const doc=await add('巡检手册',text),total=chunkRetrievalText(text).length
 assert.equal(total,70)
 await retrieval.enroll(human,{sourceIds:[doc.sourceId]})
 const controller=new AbortController()
 const first=fakeEmbedder(profileA,{onCall:()=>controller.abort()})
 await assert.rejects(retrieval.buildPending(human,first.embedder,controller.signal),{code:'teloa/cancelled'})
 assert.deepEqual(first.calls.map(call=>call.texts.length),[32])
 assert.equal(await count('select count(*)::int as count from teloa_retrieval_chunks c join teloa_retrieval_indexes i on i.id=c.index_id where i.resource_id=$1',[doc.id]),32)
 assert.equal((await retrieval.status(human,profileA)).items[0]!.state,'building')
 assert.deepEqual((await retrieval.search(human,['general'],{query:'巡检'},first.embedder,signal())).coverage.pending,[{resourceId:doc.id,title:'巡检手册',reason:'building'}])
 const second=fakeEmbedder()
 assert.deepEqual(await retrieval.buildPending(human,second.embedder,signal()),{ready:1,failed:0})
 assert.ok(second.calls.every(call=>call.texts.length<=32))
 assert.equal(second.passages().length,total-32,'取消前已写的向量不再推理')
 assert.equal((await retrieval.status(human,profileA)).items[0]!.state,'ready')
 const hit=(await retrieval.search(human,['general'],{query:'编号69的设备每周巡检',limit:8},second.embedder,signal())).results[0]!
 assert.match(hit.excerpt,/编号69/)
 const aborted=new AbortController();aborted.abort()
 await assert.rejects(retrieval.search(human,['general'],{query:'巡检'},second.embedder,aborted.signal),{code:'teloa/cancelled'})
})

test('来源暂不可读只跳过不记 failed，下次建索引自动重试；超限才记 failed',async()=>{
 const {catalog,retrieval,human,add}=world(),{embedder}=fakeEmbedder()
 const doc=await add('差旅报销制度',policy)
 await retrieval.enroll(human,{sourceIds:[doc.sourceId]})
 catalog.broken.add(doc.sourceId)
 assert.deepEqual(await retrieval.buildPending(human,embedder,signal()),{ready:0,failed:0})
 assert.equal((await retrieval.status(human,profileA)).items[0]!.state,'stale','没有写 failed 行')
 assert.equal(await count('select count(*)::int as count from teloa_retrieval_indexes where owner_id=$1',[human.ownerId]),0)
 catalog.broken.delete(doc.sourceId)
 assert.deepEqual(await retrieval.buildPending(human,embedder,signal()),{ready:1,failed:0},'不需要 retryFailed 即自动重试')
 assert.equal((await retrieval.status(human,profileA)).items[0]!.state,'ready')
})

test('向量缓存按最近使用淘汰，总量不超过上限；字节估算计入标题路径',()=>{
 const cache=new RetrievalVectorCache(10_000)
 const entry=(n:number)=>({vectors:new Float32Array(n*1024),norms:new Float32Array(n),chunks:[]})
 const heading='标'.repeat(200)
 cache.set('h',{vectors:new Float32Array(1024),norms:new Float32Array(1),chunks:[{ordinal:0,start:0,end:1,startLine:0,endLine:0,heading}]})
 assert.equal(cache.bytes,4096+4+96+heading.length*2,'标题路径按 UTF-16 计入')
 cache.delete('h')
 cache.set('a',entry(1));cache.set('b',entry(1))
 assert.ok(cache.get('a'))
 cache.set('c',entry(1))
 assert.equal(cache.get('b'),undefined,'最久未用的条目先淘汰')
 assert.ok(cache.get('a')&&cache.get('c'))
 assert.ok(cache.bytes<=10_000)
 cache.set('huge',entry(10))
 assert.equal(cache.get('huge'),undefined,'单条超过上限时不缓存')
 cache.delete('a')
 assert.equal(cache.get('a'),undefined)
})
