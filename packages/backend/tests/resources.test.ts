import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import { createHash,randomUUID } from 'node:crypto'
import { mkdtemp,writeFile,rm } from 'node:fs/promises'
import { tmpdir,homedir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { ReferenceCatalog,ReferenceError } from '@teloa/mcp-reference/catalog'
import { WorkError } from '@teloa/contract'
import { ResourceService, type ResourceActor } from '../src/capabilities/resources.ts'
import { initializeResources } from '../src/capabilities/schema.ts'

let container:StartedPostgreSqlContainer,pool:Pool,root:string
before(async()=>{
  // testcontainers 不读取 docker context；仅绑定本机 OrbStack，不改系统 socket。
  process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
  process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
  container=await new PostgreSqlContainer('postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73').start()
  pool=new Pool({connectionString:container.getConnectionUri()})
  await initializeResources(pool)
  root=await mkdtemp(join(tmpdir(),'teloa-resource-test-'))
}, {timeout:60000})
after(async()=>{await pool?.end();await container?.stop();if(root)await rm(root,{recursive:true,force:true})})
async function fixture(){
  const sourceId=randomUUID(),file=sourceId+'.md'
  await writeFile(join(root,file),'# 依据\n这是一份明确的资料。')
  const catalog=new ReferenceCatalog(root,[{id:sourceId,title:'资料',file}])
  const actor:ResourceActor={ownerId:randomUUID(),kind:'human',scopeIds:['general','design']}
  const input={requestId:randomUUID(),title:'公共整理依据',sourceId,sourceVersion:(await catalog.list()).references[0]!.version,scopeIds:['general']}
  const service=new ResourceService(pool,catalog,{id:randomUUID,now:()=>new Date('2026-09-10T00:00:00Z').toISOString()})
  return {actor,input,service,file}
}
test('Agent 创建与 UI 编辑共用草案；并发创建、提交分别得到同一个对象',async()=>{
  const {actor,input,service}=await fixture()
  const [a,b]=await Promise.all([service.create({...actor,kind:'agent'},input),service.create(actor,input)])
  assert.equal(a.id,b.id)
  const {requestId:_,...fields}=input
  const edit=await service.update(actor,{draftId:a.id,expectedVersion:a.version,...fields,title:'界面修订后的资料'})
  assert.equal(edit.title,'界面修订后的资料')
  const [r1,r2]=await Promise.all([service.apply(actor,{draftId:edit.id,expectedVersion:edit.version}),service.apply(actor,{draftId:edit.id,expectedVersion:edit.version})])
  assert.equal(r1.id,r2.id)
  assert.equal(r1.title,edit.title)
  const listed=await service.list(actor)
  assert.equal(listed.resources.length,1)
  assert.equal(listed.drafts[0]!.resourceId,r1.id)
})
test('来源目录携带可信主体，提交与两类读取复用当前事务连接',async()=>{
  const {actor,input,file}=await fixture()
  const base=new ReferenceCatalog(root,[{id:input.sourceId,title:'资料',file}])
  const calls:string[]=[]
  const catalog={
    async list(context?:{actor:ResourceActor}){assert.deepEqual(context?.actor,actor);calls.push('list');return base.list()},
    async read(id:string,version:string,context?:{actor:ResourceActor;client?:import('pg').PoolClient;scopeIds?:string[]}){
      assert.deepEqual(context?.actor,actor)
      assert.deepEqual(context?.scopeIds,['general'])
      assert.ok(context?.client,'来源必须收到当前事务连接')
      const result=await context.client.query('select txid_current_if_assigned() as tx')
      assert.equal(result.rowCount,1)
      calls.push('read')
      return base.read(id,version)
    },
  }
  const service=new ResourceService(pool,catalog,{id:randomUUID,now:()=>new Date().toISOString()})
  await service.sourceDirectory(actor)
  const draft=await service.create(actor,input)
  const resource=await service.apply(actor,{draftId:draft.id,expectedVersion:1})
  await service.executionKnowledge(actor,['general'],[resource.id])
  await service.resolve(actor,{sessionId:randomUUID(),scopeIds:['general']},{messageId:randomUUID(),references:[{id:resource.id,version:1}]})
  assert.deepEqual(calls,['list','read','read','read'])
})
test('固定来源的范围与存储错误不被伪装为临时不可用',async()=>{
  const {actor,input}=await fixture()
  const catalog={async list():Promise<never>{throw new WorkError('teloa/storage-corrupt','固定目录损坏')},async read():Promise<never>{throw new WorkError('teloa/forbidden','来源不属于目标范围')}}
  const service=new ResourceService(pool,catalog,{id:randomUUID,now:()=>new Date().toISOString()})
  await assert.rejects(service.sourceDirectory(actor),{code:'teloa/storage-corrupt'})
  const draft=await service.create(actor,input)
  await assert.rejects(service.apply(actor,{draftId:draft.id,expectedVersion:1}),{code:'teloa/forbidden'})
  const directory=await service.list(actor)
  assert.equal(directory.resources.length,0)
  assert.equal(directory.drafts[0]?.status,'draft')
})
test('旧版本、并发编辑、其他主体、越权范围和 Agent 提交不能改写对象',async()=>{
  const {actor,input,service}=await fixture(),draft=await service.create(actor,input)
  await assert.rejects(service.create(actor,{...input,title:'另一意图'}),{code:'teloa/conflict'})
  await assert.rejects(service.create(actor,{...input,requestId:randomUUID(),ownerId:'forged'}),{code:'teloa/invalid-input'})
  await assert.rejects(service.create(actor,{...input,requestId:randomUUID(),scopeIds:['finance']}),{code:'teloa/forbidden'})
  await assert.rejects(service.apply({...actor,kind:'agent'},{draftId:draft.id,expectedVersion:1}),{code:'teloa/forbidden'})
  await assert.rejects(service.apply({...actor,ownerId:'other'},{draftId:draft.id,expectedVersion:1}),{code:'teloa/forbidden'})
  const {requestId:_,...fields}=input
  const updates=await Promise.allSettled([service.update(actor,{draftId:draft.id,expectedVersion:1,...fields,title:'A'}),service.update(actor,{draftId:draft.id,expectedVersion:1,...fields,title:'B'})])
  assert.equal(updates.filter(item=>item.status==='fulfilled').length,1)
  assert.equal((updates.find(item=>item.status==='rejected') as PromiseRejectedResult).reason.code,'teloa/version-conflict')
  await assert.rejects(service.apply(actor,{draftId:draft.id,expectedVersion:1}),{code:'teloa/version-conflict'})
})
test('来源变化阻止提交与读取，正文不静默换版本',async()=>{
  const {actor,input,service,file}=await fixture(),draft=await service.create(actor,input)
  const resource=await service.apply(actor,{draftId:draft.id,expectedVersion:1})
  const another=await service.create(actor,{...input,requestId:randomUUID()})
  await writeFile(join(root,file),'# 新的未批准依据')
  await assert.rejects(service.apply(actor,{draftId:another.id,expectedVersion:1}),{code:'teloa/version-conflict'})
  await assert.rejects(service.resolve(actor,{sessionId:randomUUID(),scopeIds:['general']},{messageId:randomUUID(),references:[{id:resource.id,version:resource.version}]}),{code:'teloa/version-conflict'})
})
test('消息引用快照绑定目标与消息，重复意图幂等；同一消息不能换引用',async()=>{
  const {actor,input,service}=await fixture(),draft=await service.create(actor,input)
  const resource=await service.apply(actor,{draftId:draft.id,expectedVersion:1})
  const target={sessionId:randomUUID(),scopeIds:['general']},message={messageId:randomUUID(),requestId:'native-request-1',references:[{id:resource.id,version:resource.version}]}
  const [a,b]=await Promise.all([service.resolve(actor,target,message),service.resolve(actor,target,message)])
  assert.equal(a.snapshot.id,b.snapshot.id)
  assert.equal(a.snapshot.messageId,message.messageId)
  assert.equal(a.snapshot.requestId,message.requestId)
  assert.equal(a.snapshot.sessionId,target.sessionId)
  assert.equal(a.contents[0]!.sourceVersion,input.sourceVersion)
  assert.match(a.contents[0]!.text,/明确的资料/)
  await assert.rejects(service.resolve(actor,target,{...message,references:[{id:resource.id,version:2}]}),{code:'teloa/snapshot-conflict'})
  await assert.rejects(service.resolve(actor,{sessionId:randomUUID(),scopeIds:['design']},message),{code:'teloa/forbidden'})
  await assert.rejects(service.resolve({...actor,ownerId:'other'},target,message),{code:'teloa/forbidden'})
})
test('撤回后旧快照也不能重新展开；失败读取可查，历史快照仍保留',async()=>{
  const {actor,input,service}=await fixture(),draft=await service.create(actor,input)
  const resource=await service.apply(actor,{draftId:draft.id,expectedVersion:1})
  const target={sessionId:randomUUID(),scopeIds:['general']},message={messageId:randomUUID(),references:[{id:resource.id,version:resource.version}]}
  const first=await service.resolve(actor,target,message)
  await service.withdraw(actor,{resourceId:resource.id,expectedVersion:resource.version})
  await assert.rejects(service.resolve(actor,target,message),{code:'teloa/resource-withdrawn'})
  const rows=await pool.query('select outcome from teloa_resource_reads where snapshot_id=$1 order by created_at,id',[first.snapshot.id])
  assert.deepEqual(rows.rows.map(row=>row.outcome).sort(),['failed','provided'])
  assert.equal((await pool.query('select count(*)::int as count from teloa_message_snapshots where id=$1',[first.snapshot.id])).rows[0].count,1)
})

test('岗位知识读取仅接受启用资料ID并核对本人、岗位与目标范围',async()=>{
 const {actor,input,service}=await fixture()
 const draft=await service.create(actor,input),resource=await service.apply(actor,{draftId:draft.id,expectedVersion:draft.version})
 const rows=await service.executionKnowledge({...actor,kind:'agent'},['general'],[resource.id])
 assert.equal(rows[0]!.id,resource.id);assert.equal(rows[0]!.version,1);assert.match(rows[0]!.text,/明确的资料/)
 await assert.rejects(service.executionKnowledge(actor,['design'],[resource.id]),{code:'teloa/forbidden'})
 await assert.rejects(service.executionKnowledge({...actor,ownerId:randomUUID()},['general'],[resource.id]),{code:'teloa/forbidden'})
 await assert.rejects(service.executionKnowledge(actor,['general'],['公共整理依据']),{code:'teloa/invalid-input'})
 await service.withdraw(actor,{resourceId:resource.id,expectedVersion:1})
 await assert.rejects(service.executionKnowledge(actor,['general'],[resource.id]),{code:'teloa/resource-withdrawn'})
})
test('岗位知识来源变化不静默读取新版，取消和重复声明被拒绝',async()=>{
 const {actor,input,service,file}=await fixture()
 const draft=await service.create(actor,input),resource=await service.apply(actor,{draftId:draft.id,expectedVersion:draft.version})
 await assert.rejects(service.executionKnowledge(actor,['general'],[resource.id,resource.id]),{code:'teloa/invalid-input'})
 await writeFile(join(root,file),'内容已变化')
 await assert.rejects(service.executionKnowledge(actor,['general'],[resource.id]),{code:'teloa/version-conflict'})
 const controller=new AbortController();controller.abort()
 await assert.rejects(service.executionKnowledge(actor,['general'],[resource.id],controller.signal))
})
test('任务知识使用调用者事务读取固定资源版本，不退回当前最新版',async()=>{
 const {actor,input,service}=await fixture(),draft=await service.create(actor,input),saved=await service.apply(actor,{draftId:draft.id,expectedVersion:draft.version}),db=await pool.connect()
 try{
  await db.query('begin')
  const rows=await service.executionKnowledgeReferencesInTransaction(db,{...actor,kind:'agent'},['general'],[{id:saved.id,version:1}])
  assert.equal(rows[0]!.id,saved.id);assert.equal(rows[0]!.version,1);assert.match(rows[0]!.text,/明确的资料/)
  await assert.rejects(service.executionKnowledgeReferencesInTransaction(db,{...actor,kind:'agent'},['general'],[{id:saved.id,version:2}]),{code:'teloa/version-conflict'})
  await db.query("update teloa_resources set status='withdrawn',revision=2 where id=$1",[saved.id])
  await assert.rejects(service.executionKnowledgeReferencesInTransaction(db,{...actor,kind:'agent'},['general'],[{id:saved.id,version:1}]),{code:'teloa/resource-withdrawn'})
 }finally{await db.query('rollback');db.release()}
})

/** 内存来源：按 (id, 版本) 固定正文，可放入超过文件目录 128 KiB 限制的大正文。 */
function memoryCatalog(){
 const texts=new Map<string,string>()
 return {
  add(id:string,text:string){const version=createHash('sha256').update(text).digest('hex');texts.set(id+'@'+version,text);return version},
  reads:0,
  async list(){return {schema:'teloa.reference-list/v1' as const,references:[]}},
  async sizes(refs:readonly {id:string;version:string}[]){const sizes=new Map<string,number>();for(const ref of refs){const text=texts.get(ref.id+'@'+ref.version);if(text!==undefined)sizes.set(ref.id+'@'+ref.version,Buffer.byteLength(text))};return sizes},
  async read(id:string,version:string){
   this.reads++
   const text=texts.get(id+'@'+version)
   if(text===undefined)throw new ReferenceError('reference/version-conflict','资料版本已变化。')
   return {schema:'teloa.reference/v1' as const,id,title:'资料',source:id,version,bytes:Buffer.byteLength(text),text}
  },
 }
}
async function memoryResource(text:string,scopeIds=['general']){
 const catalog=memoryCatalog(),sourceId=randomUUID(),sourceVersion=catalog.add(sourceId,text)
 const actor:ResourceActor={ownerId:randomUUID(),kind:'human',scopeIds:['general','design']}
 const service=new ResourceService(pool,catalog,{id:randomUUID,now:()=>new Date().toISOString()})
 const draft=await service.create(actor,{requestId:randomUUID(),title:'检索资料',sourceId,sourceVersion,scopeIds})
 return {actor,service,catalog,resource:await service.apply(actor,{draftId:draft.id,expectedVersion:draft.version})}
}
async function inTransaction<T>(work:(client:import('pg').PoolClient)=>Promise<T>):Promise<T>{
 const client=await pool.connect()
 try{await client.query('begin');return await work(client)}finally{await client.query('rollback');client.release()}
}
test('建索引读口只接受本人主体，单份正文不超过 2 MiB，已撤回报 resource-withdrawn',async()=>{
 const {actor,service,resource}=await memoryResource('# 甲\r\n正文')
 const read=await inTransaction(client=>service.readForIndexInTransaction(client,actor,resource.id))
 assert.equal(read.resource.id,resource.id)
 assert.equal(read.text,'# 甲\r\n正文')
 await assert.rejects(inTransaction(client=>service.readForIndexInTransaction(client,{...actor,kind:'agent'},resource.id)),{code:'teloa/forbidden'})
 await assert.rejects(inTransaction(client=>service.readForIndexInTransaction(client,{...actor,ownerId:randomUUID()},resource.id)),{code:'teloa/forbidden'})
 await assert.rejects(inTransaction(client=>service.readForIndexInTransaction(client,actor,'不是资源')),{code:'teloa/invalid-input'})
 const exact=await memoryResource('资'.repeat(Math.floor(2*1024*1024/3))+'a'.repeat(2*1024*1024%3))
 assert.equal(Buffer.byteLength((await inTransaction(client=>exact.service.readForIndexInTransaction(client,exact.actor,exact.resource.id))).text),2*1024*1024)
 const large=await memoryResource('a'.repeat(2*1024*1024+1))
 await assert.rejects(inTransaction(client=>large.service.readForIndexInTransaction(client,large.actor,large.resource.id)),{code:'teloa/invalid-input'})
 await service.withdraw(actor,{resourceId:resource.id,expectedVersion:1})
 await assert.rejects(inTransaction(client=>service.readForIndexInTransaction(client,actor,resource.id)),{code:'teloa/resource-withdrawn'})
})
test('摘录读口核对范围、资料版本与正文版本，按规范化区间切片且单条与总量有上限',async()=>{
 const text='# 标题\r\n'+'资'.repeat(3000)
 const {actor,service,resource}=await memoryResource(text)
 const hit={resourceId:resource.id,resourceVersion:1,sourceVersion:resource.sourceVersion,chars:[0,4] as [number,number]}
 const agent={...actor,kind:'agent' as const}
 const rows=await inTransaction(client=>service.readExcerptsInTransaction(client,agent,['general'],[hit,{...hit,chars:[5,8]}]))
 assert.deepEqual(rows.map(row=>row.excerpt),['# 标题','资资资'])
 assert.equal(rows[0]!.resource.id,resource.id)
 const wide=await inTransaction(client=>service.readExcerptsInTransaction(client,agent,['general'],Array.from({length:8},()=>({...hit,chars:[5,3005] as [number,number]}))))
 assert.equal(wide.length,8)
 for(const row of wide)assert.ok(Buffer.byteLength(row.excerpt)<=2048&&row.excerpt.startsWith('资'))
 assert.ok(wide.reduce((sum,row)=>sum+Buffer.byteLength(row.excerpt),0)<=16*1024)
 await assert.rejects(inTransaction(client=>service.readExcerptsInTransaction(client,agent,['general'],Array.from({length:9},()=>hit))),{code:'teloa/invalid-input'})
 await assert.rejects(inTransaction(client=>service.readExcerptsInTransaction(client,agent,['general'],[{...hit,chars:[4,4]}])),{code:'teloa/invalid-input'})
 await assert.rejects(inTransaction(client=>service.readExcerptsInTransaction(client,agent,['general'],[{...hit,extra:1}])),{code:'teloa/invalid-input'})
 await assert.rejects(inTransaction(client=>service.readExcerptsInTransaction(client,agent,['design'],[hit])),{code:'teloa/forbidden'})
 await assert.rejects(inTransaction(client=>service.readExcerptsInTransaction(client,{...agent,ownerId:randomUUID()},['general'],[hit])),{code:'teloa/forbidden'})
 await assert.rejects(inTransaction(client=>service.readExcerptsInTransaction(client,agent,['general'],[{...hit,resourceVersion:2}])),{code:'teloa/version-conflict'})
 await assert.rejects(inTransaction(client=>service.readExcerptsInTransaction(client,agent,['general'],[{...hit,sourceVersion:'0'.repeat(64)}])),{code:'teloa/version-conflict'})
 await assert.rejects(inTransaction(client=>service.readExcerptsInTransaction(client,agent,['general'],[{...hit,chars:[5,9000]}])),{code:'teloa/storage-corrupt'})
 await service.withdraw(actor,{resourceId:resource.id,expectedVersion:1})
 await assert.rejects(inTransaction(client=>service.readExcerptsInTransaction(client,agent,['general'],[hit])),{code:'teloa/resource-withdrawn'})
})

async function memoryResources(entries:{title:string;text:string;scopeIds?:string[]}[]){
 const catalog=memoryCatalog(),actor:ResourceActor={ownerId:randomUUID(),kind:'human',scopeIds:['general','design']}
 const service=new ResourceService(pool,catalog,{id:randomUUID,now:()=>new Date().toISOString()}),resources=[]
 for(const entry of entries){
  const sourceId=randomUUID(),sourceVersion=catalog.add(sourceId,entry.text)
  const draft=await service.create(actor,{requestId:randomUUID(),title:entry.title,sourceId,sourceVersion,scopeIds:entry.scopeIds??['general']})
  resources.push(await service.apply(actor,{draftId:draft.id,expectedVersion:draft.version}))
 }
 return {actor,service,resources,catalog}
}
test('单份超过 256 KiB 的资料选入岗位或任务时报「只能加入本地检索使用」，多份合计超限仍报合计',async()=>{
 const single=await memoryResources([{title:'年度制度汇编',text:'a'.repeat(300*1024)}]),[big]=single.resources
 const agent={...single.actor,kind:'agent' as const},message='资料「年度制度汇编」有 300 KiB，超过员工/任务全文上限 256 KiB，只能加入本地检索使用。'
 await assert.rejects(single.service.executionKnowledge(agent,['general'],[big!.id]),(error:any)=>error?.code==='teloa/invalid-input'&&error.message===message)
 await assert.rejects(inTransaction(client=>single.service.executionKnowledgeReferencesInTransaction(client,agent,['general'],[{id:big!.id,version:big!.version}])),(error:any)=>error?.code==='teloa/invalid-input'&&error.message===message)
 const pair=await memoryResources([{title:'上半年',text:'b'.repeat(150*1024)},{title:'下半年',text:'c'.repeat(150*1024)}]),[first,second]=pair.resources
 const pairAgent={...pair.actor,kind:'agent' as const}
 await assert.rejects(pair.service.executionKnowledge(pairAgent,['general'],[first!.id,second!.id]),(error:any)=>error?.code==='teloa/invalid-input'&&error.message==='员工资料正文总量过大，请缩小本次资料范围。')
 await assert.rejects(inTransaction(client=>pair.service.executionKnowledgeReferencesInTransaction(client,pairAgent,['general'],[{id:first!.id,version:first!.version},{id:second!.id,version:second!.version}])),(error:any)=>error?.code==='teloa/invalid-input'&&error.message==='任务知识正文总量过大，请缩小本次资料范围。')
 const exact=await memoryResources([{title:'刚好',text:'d'.repeat(256*1024)}])
 assert.equal((await exact.service.executionKnowledge({...exact.actor,kind:'agent'},['general'],[exact.resources[0]!.id]))[0]!.text.length,256*1024)
})
test('300 KiB 资料可加入本地检索，256 KiB 之后的区间也能按摘录命中',async()=>{
 const text='前言\n'+'资'.repeat(100*1024)+'\n结尾处的关键条款'
 const {actor,service,resource}=await memoryResource(text)
 assert.ok(Buffer.byteLength(text)>=300*1024)
 const read=await inTransaction(client=>service.readForIndexInTransaction(client,actor,resource.id))
 assert.equal(read.text,text)
 const start=text.indexOf('关键条款'),hit={resourceId:resource.id,resourceVersion:1,sourceVersion:resource.sourceVersion,chars:[start,start+4] as [number,number]}
 assert.ok(Buffer.byteLength(text.slice(0,start))>256*1024)
 const [row]=await inTransaction(client=>service.readExcerptsInTransaction(client,{...actor,kind:'agent'},['general'],[hit]))
 assert.equal(row!.excerpt,'关键条款')
})
test('消息引用资料有独立上限：单份超过 256 KiB 或合计超过 1 MiB 拒绝并留下失败读取记录',async()=>{
 const single=await memoryResources([{title:'年度制度汇编',text:'a'.repeat(300*1024)}]),[big]=single.resources
 const target={sessionId:randomUUID(),scopeIds:['general']},message={messageId:randomUUID(),references:[{id:big!.id,version:big!.version}]}
 await assert.rejects(single.service.resolve(single.actor,target,message),(error:any)=>error?.code==='teloa/invalid-input'&&error.message==='资料「年度制度汇编」有 300 KiB，超过单条消息引用全文上限 256 KiB，只能加入本地检索使用。')
 assert.deepEqual((await pool.query('select r.outcome from teloa_resource_reads r join teloa_message_snapshots s on s.id=r.snapshot_id where s.message_id=$1',[message.messageId])).rows.map(row=>row.outcome),['failed'])
 const many=await memoryResources(Array.from({length:5},(_,index)=>({title:'分册'+index,text:String(index).repeat(250*1024)})))
 const refs=many.resources.map(resource=>({id:resource.id,version:resource.version}))
 const allowed=await many.service.resolve(many.actor,{sessionId:randomUUID(),scopeIds:['general']},{messageId:randomUUID(),references:refs.slice(0,4)})
 assert.equal(allowed.contents.length,4)
 await assert.rejects(many.service.resolve(many.actor,{sessionId:randomUUID(),scopeIds:['general']},{messageId:randomUUID(),references:refs}),(error:any)=>error?.code==='teloa/invalid-input'&&error.message==='引用资料正文合计超过 1 MiB，请减少本条消息引用的资料。')
})

test('保存岗位资料或任务知识前按来源登记的字节数预检 256 KiB，不读正文',async()=>{
 const set=await memoryResources([{title:'年度制度汇编',text:'a'.repeat(300*1024)},{title:'上半年',text:'b'.repeat(150*1024)},{title:'下半年',text:'c'.repeat(150*1024)},{title:'刚好',text:'d'.repeat(256*1024)}])
 const [big,first,second,exact]=set.resources,reads=set.catalog.reads
 await assert.rejects(set.service.checkFullTextBudget(set.actor,[first!.id,big!.id],'role'),(error:any)=>error?.code==='teloa/invalid-input'&&error.message==='资料「年度制度汇编」有 300 KiB，超过员工/任务全文上限 256 KiB，只能加入本地检索使用。')
 await assert.rejects(set.service.checkFullTextBudget(set.actor,[first!.id,second!.id],'role'),(error:any)=>error?.code==='teloa/invalid-input'&&error.message==='员工资料正文总量过大，请缩小本次资料范围。')
 await assert.rejects(set.service.checkFullTextBudget(set.actor,[first!.id,second!.id],'task'),(error:any)=>error?.code==='teloa/invalid-input'&&error.message==='任务知识正文总量过大，请缩小本次资料范围。')
 await set.service.checkFullTextBudget(set.actor,[exact!.id],'role')
 await set.service.checkFullTextBudget(set.actor,[],'task')
 // 其他本人的资料、不存在或格式不对的资料不在这里判断，交给执行准备时的既有校验。
 await set.service.checkFullTextBudget({...set.actor,ownerId:randomUUID()},[big!.id],'role')
 await set.service.checkFullTextBudget(set.actor,[randomUUID(),'不是资源'],'role')
 await assert.rejects(set.service.checkFullTextBudget(set.actor,['不是资源','不是资源',big!.id],'role'),/年度制度汇编/)
 assert.equal(set.catalog.reads,reads,'预检只看登记字节数，不读正文')
 assert.deepEqual([...(await set.service.fullTextBytes(set.actor,[big!,exact!])).entries()],[[big!.id,300*1024],[exact!.id,256*1024]])
 const {read:_read,sizes:_sizes,...bare}=set.catalog
 const plain=new ResourceService(pool,{...bare,read:set.catalog.read.bind(set.catalog)},{id:randomUUID,now:()=>new Date().toISOString()})
 await plain.checkFullTextBudget(set.actor,[big!.id],'role')
 assert.equal((await plain.fullTextBytes(set.actor,[big!])).size,0,'来源不登记字节数时不拦，执行准备仍按正文复核')
})
test('工具授权只读岗位资料的来源与版本，不读正文，超大资料不连累授权页',async()=>{
 const set=await memoryResources([{title:'年度制度汇编',text:'a'.repeat(300*1024)},{title:'设计规范',text:'设计',scopeIds:['design']}])
 const [big,design]=set.resources,agent={...set.actor,kind:'agent' as const},reads=set.catalog.reads
 const rows=await set.service.executionKnowledgeReferences(agent,['general'],[big!.id])
 assert.deepEqual(rows.map(row=>({id:row.id,version:row.version,sourceId:row.sourceId,sourceVersion:row.sourceVersion})),[{id:big!.id,version:1,sourceId:big!.sourceId,sourceVersion:big!.sourceVersion}])
 assert.equal(set.catalog.reads,reads)
 await assert.rejects(set.service.executionKnowledgeReferences(agent,['general'],[design!.id]),{code:'teloa/forbidden'})
 await assert.rejects(set.service.executionKnowledgeReferences(agent,['general'],[big!.id,big!.id]),{code:'teloa/invalid-input'})
 await set.service.withdraw(set.actor,{resourceId:big!.id,expectedVersion:1})
 await assert.rejects(set.service.executionKnowledgeReferences(agent,['general'],[big!.id]),{code:'teloa/resource-withdrawn'})
})
test('任务引用与消息引用恰好 256 KiB 通过',async()=>{
 const set=await memoryResources([{title:'刚好',text:'e'.repeat(256*1024)}]),[exact]=set.resources,agent={...set.actor,kind:'agent' as const}
 const rows=await inTransaction(client=>set.service.executionKnowledgeReferencesInTransaction(client,agent,['general'],[{id:exact!.id,version:exact!.version}]))
 assert.equal(Buffer.byteLength(rows[0]!.text),256*1024)
 const resolved=await set.service.resolve(set.actor,{sessionId:randomUUID(),scopeIds:['general']},{messageId:randomUUID(),references:[{id:exact!.id,version:exact!.version}]})
 assert.equal(Buffer.byteLength(resolved.contents[0]!.text),256*1024)
})
