import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {writeFileSync,unlinkSync,symlinkSync} from 'node:fs'
import {mkdtemp,writeFile,rm,realpath,lstat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Client,Pool} from 'pg'
import {retrievalLimits,WorkError} from '@teloa/contract'
import type {Embedder} from '../src/capabilities/retrieval-index.ts'
import {AuthorizedLocalMaterialCatalog} from '../src/capabilities/authorized-local-material-catalog.ts'
import {ResourceService} from '../src/capabilities/resources.ts'
import {guardDecision,protectedRootsFor} from '../../harness-dsh/src/credential-guards.ts'

// 私有红例可加载原版同一模块；正常测试入口始终默认当前生产模块，不替代服务或排序实现。
const {RetrievalIndexService}=await import(process.env.TELOA_RETRIEVAL_TEST_MODULE??'../src/capabilities/retrieval-index.ts') as typeof import('../src/capabilities/retrieval-index.ts')
const digest=(text:string)=>createHash('sha256').update(text).digest('hex')
async function fixture(t:TestContext,count:number,materialized=count){
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-ranked-freshness-')))
 t.after(()=>rm(root,{recursive:true,force:true}))
 const state=await lstat(root,{bigint:true}),owner=randomUUID(),profile='a'.repeat(64),now=new Date(),rootKey=digest(root+'\0'+state.dev+'\0'+state.ino)
 const docs=Array.from({length:count},(_,i)=>{
  const id=(i+1).toString(16).padStart(8,'0')+'-0000-4000-8000-000000000000',materialId=randomUUID(),text='# 合成原件 '+i+'\n本轮固定正文。\n',version=digest(text),path=join(root,i+'.md')
  return {id,materialId,text,path,indexId:randomUUID(),owner,status:'active',enrolled:true,indexProfile:profile,ready:true,scopes:['general'],sourceScopes:['general'],spec:{title:'合成资料'+i,sourceId:'local_material_'+materialId,sourceVersion:version,scopeIds:['general']}}
 })
 for(const doc of docs.slice(0,materialized))await writeFile(doc.path,doc.text)
 const pool=new Pool(),client=Object.assign(new Client(),{release(){}}),actor={ownerId:owner,kind:'human' as const,scopeIds:['general']}
 t.after(()=>pool.end())
 t.mock.method(pool,'connect',async()=>client)
 const sourceReads=new Map<string,number>(),guardCalls=new Map<string,number>()
 const response=(rows:unknown[])=>({rows,command:'SELECT',rowCount:rows.length,oid:0,fields:[]})
 t.mock.method(client,'query',async(sql:unknown,values?:unknown[])=>{
  assert.equal(typeof sql,'string');const text=String(sql)
  if(['begin','commit','rollback'].includes(text))return response([])
  // 当前完整schema含员工知识表；本夹具只登记本机原件，没有员工版本或退役记录。
  if(text==="select to_regclass('teloa_employee_knowledge_versions') as relation")return response([{relation:'teloa_employee_knowledge_versions'}])
  if(text==="select to_regclass('teloa_employee_knowledge_source_retirements') as present")return response([{present:'teloa_employee_knowledge_source_retirements'}])
  if(text==='select 1 from teloa_employee_knowledge_source_retirements where owner_id=$1 and source_id=$2 and source_version=$3')return response([])
  if(text.includes('from teloa_retrieval_enrollments e'))return response(docs.filter(doc=>doc.enrolled&&doc.owner===values?.[0]&&doc.status==='active'&&(values?.[3]==null||Array.isArray(values[3])&&values[3].includes(doc.id))).map(doc=>({id:doc.id,revision:1,spec:{...doc.spec,scopeIds:doc.scopes},index_id:doc.indexProfile===values?.[1]?doc.indexId:null,state:doc.ready?'ready':'building',chunk_count:doc.ready?1:0})))
  if(text.startsWith('select index_id,ordinal,'))return response(docs.filter(doc=>Array.isArray(values?.[0])&&values[0].includes(doc.indexId)).map(doc=>{
   const score=(count-docs.indexOf(doc))/(count+1),vector=Buffer.alloc(retrievalLimits.vectorBytes);vector.writeFloatLE(score,0);vector.writeFloatLE(Math.sqrt(1-score*score),4)
   return {index_id:doc.indexId,ordinal:0,start_char:0,end_char:doc.text.length,start_line:0,end_line:1,heading:null,vector}
  }))
  if(text==='select * from teloa_resources where id=$1 for share')return response(docs.filter(doc=>doc.id===values?.[0]).map(doc=>({id:doc.id,owner_id:doc.owner,revision:1,spec:{...doc.spec,scopeIds:doc.scopes},status:doc.status,created_at:now,updated_at:now})))
  if(text==='select * from teloa_authorized_local_materials where owner_id=$1 and id=$2')return response(docs.filter(doc=>doc.owner===values?.[0]&&doc.materialId===values?.[1]).map(doc=>{
   sourceReads.set(doc.id,(sourceReads.get(doc.id)??0)+1)
   return {id:doc.materialId,owner_id:doc.owner,title:doc.spec.title,relative_path:doc.path.slice(root.length+1),scope_ids:doc.sourceScopes,workspace_root:root,workspace_key:rootKey}
  }))
  throw Error('测试只允许具名只读 SQL：'+text)
 })
 let permitted=true,protectFile:string|undefined,onGuard:((doc:typeof docs[number],count:number)=>void)|undefined,onEmbed:(()=>void)|undefined,embeddings=0
 const catalog=new AuthorizedLocalMaterialCatalog(pool,{id:randomUUID,now:()=>now.toISOString()},{authorize:async(principal,scopes)=>{
  assert.equal(principal.ownerId,owner);assert.ok(scopes.every(scope=>principal.scopeIds.includes(scope)))
  return {workspaceRoot:root,assertCurrent(){assert.ok(permitted)},isProtectedPath(path){
   const doc=docs.find(doc=>doc.path===path);assert.ok(doc)
   const calls=(guardCalls.get(doc.id)??0)+1;guardCalls.set(doc.id,calls);onGuard?.(doc,calls)
   return guardDecision({file_path:path},{toolName:'read',cwd:root,roots:protectedRootsFor({providerPaths:protectFile?[protectFile]:[],runtimeRoot:join(root,'runtime'),env:{}}),known:[],env:{},home:root})!==undefined
  }}
 }})
 const resources=new ResourceService(pool,catalog,{id:randomUUID,now:()=>now.toISOString()}),service=new RetrievalIndexService(pool,resources,{id:randomUUID,now:()=>now.toISOString()})
 const embedder:Embedder={profileHash:profile,async embed(kind,texts){assert.equal(kind,'query');assert.equal(texts.length,1);embeddings++;onEmbed?.();const vector=new Float32Array(retrievalLimits.dimensions);vector[0]=1;return [vector]}}
 return {docs,sourceReads,guardCalls,resources,service,actor,get embeddings(){return embeddings},onGuard(callback:typeof onGuard){onGuard=callback},onEmbed(callback:typeof onEmbed){onEmbed=callback},revoke(){permitted=false},protect(path:string){protectFile=path},search:()=>service.search(actor,['general'],{query:'本轮合成查询',limit:8},embedder,new AbortController().signal)}
}

test('1000个元数据候选只完整核验实际前8命中，未命中缺失原件不触发全库扫描',async t=>{
 const f=await fixture(t,1000,8),result=await f.search()
 assert.deepEqual(result.results.map(hit=>hit.resourceId),f.docs.slice(0,8).map(doc=>doc.id))
 assert.equal(f.embeddings,1);assert.equal(f.sourceReads.size,8)
 for(const count of f.sourceReads.values())assert.equal(count,2,'命中读取及返回前完整复核各一次')
 assert.equal(result.coverage.searchedCount,1000);assert.equal(result.coverage.truncated,true)
 assert.match(result.coverage.note,/未命中资料不代表已逐份回读/)
})

test('高排名24份变版原件全部排除并补齐后8份有效命中，只嵌入原查询一次',async t=>{
 const f=await fixture(t,32)
 for(const doc of f.docs.slice(0,24))await writeFile(doc.path,'# 已变版，不得返回旧索引正文\n')
 const result=await f.search()
 assert.deepEqual(result.results.map(hit=>hit.resourceId),f.docs.slice(24).map(doc=>doc.id));assert.equal(f.embeddings,1)
 assert.equal(result.coverage.pending.length,24);assert.ok(result.results.every(hit=>!hit.excerpt.includes('已变版')))
})

test('初始无授权、撤回、错scope/profile或未就绪均不嵌入也不读正文',async t=>{
 for(const mode of ['owner','withdrawn','scope','profile','building'])await t.test(mode,async t=>{
  const f=await fixture(t,1),doc=f.docs[0]!
  if(mode==='owner')doc.owner='00000000-0000-4000-8000-000000000099'
  if(mode==='withdrawn')doc.status='withdrawn'
  if(mode==='scope')doc.scopes=['other']
  if(mode==='profile')doc.indexProfile='b'.repeat(64)
  if(mode==='building')doc.ready=false
  assert.deepEqual((await f.search()).results,[]);assert.equal(f.embeddings,0);assert.equal(f.sourceReads.size,0)
 })
})

test('全失效或空结果不返回旧正文；SQL仍ready而文件全变版允许一次查询嵌入',async t=>{
 const f=await fixture(t,12)
 for(const doc of f.docs)await writeFile(doc.path,'# 全部变版\n')
 const result=await f.search();assert.deepEqual(result.results,[]);assert.deepEqual(result.coverage.searched,[]);assert.equal(result.coverage.pending.length,12);assert.equal(f.embeddings,1)
 const empty=await fixture(t,0);assert.deepEqual((await empty.search()).results,[]);assert.equal(empty.embeddings,0)
})

test('embedding期间撤回立即移出，末尾版本复核发现变版继续补取而不返回早先摘录',async t=>{
 const f=await fixture(t,10)
 f.onEmbed(()=>{f.docs[0]!.status='withdrawn'})
 f.onGuard((doc,count)=>{if(doc.id===f.docs[1]!.id&&count===4)writeFileSync(doc.path,'# 返回前变版\n')})
 const result=await f.search()
 assert.deepEqual(result.results.map(hit=>hit.resourceId),f.docs.slice(2).map(doc=>doc.id));assert.equal(f.embeddings,1)
 assert.ok(result.coverage.searched.every(row=>row.resourceId!==f.docs[0]!.id&&row.resourceId!==f.docs[1]!.id))
})

test('最终原件检查之后的移出、scope或profile绑定变化仍在具名元数据复核拒绝并补齐',async t=>{
 for(const mode of ['removed','scope','profile']){
  const f=await fixture(t,9),first=f.docs[0]!
  f.onGuard((doc,count)=>{if(doc!==first||count!==6)return;if(mode==='removed')doc.enrolled=false;else if(mode==='scope')doc.scopes=['other'];else doc.indexProfile='b'.repeat(64)})
  const result=await f.search()
  assert.deepEqual(result.results.map(hit=>hit.resourceId),f.docs.slice(1).map(doc=>doc.id),mode)
  assert.ok(result.coverage.searched.every(row=>row.resourceId!==first.id),mode);assert.equal(f.embeddings,1)
 }
})

test('第三安全边界发生撤权/新credential根/符号链接替换仍整体拒绝，不吞为可重试stale',async t=>{
 for(const mode of ['revoked','credential','symlink'])await t.test(mode,async t=>{
  const f=await fixture(t,2)
  f.onGuard((doc,count)=>{if(count!==3)return;if(mode==='revoked')f.revoke();else if(mode==='credential')f.protect(doc.path);else{unlinkSync(doc.path);symlinkSync(f.docs[1]!.path,doc.path)}})
  await assert.rejects(f.search(),{code:'teloa/forbidden'});assert.equal(f.embeddings,1)
 })
})

test('失效旧版本只按本范围已真实回读的同源新版本标记historical，不探测范围外版本',async t=>{
 const f=await fixture(t,2),[old,next]=f.docs
 assert.ok(old&&next);old.spec.sourceId=next.spec.sourceId
 const current=await f.search()
 assert.deepEqual(current.results.map(hit=>hit.resourceId),[next.id])
 assert.equal(current.coverage.pending.find(row=>row.resourceId===old.id)?.sourceState,'historical')
 next.scopes=['other'];f.sourceReads.clear()
 const restricted=await f.search()
 assert.deepEqual(restricted.results,[]);assert.deepEqual(restricted.coverage.searched,[])
 assert.equal(restricted.coverage.pending.find(row=>row.resourceId===old.id)?.sourceState,'changed')
 assert.equal(JSON.stringify(restricted).includes(next.id),false)
})

test('未知存储失败或损坏不吞为变版重试，也不返回已读的部分结果',async t=>{
 for(const error of [new WorkError('teloa/storage-corrupt','合成损坏'),new Error('合成未知传输失败')])await t.test(error.name+':'+error.message,async t=>{
  const f=await fixture(t,2)
  t.mock.method(f.resources,'readExcerptsInTransaction',async()=>{throw error})
  await assert.rejects(f.search(),{code:error instanceof WorkError?'teloa/storage-corrupt':'teloa/storage-unavailable'})
  assert.equal(f.embeddings,1)
 })
})
