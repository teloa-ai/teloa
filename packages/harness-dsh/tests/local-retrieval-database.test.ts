import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {homedir,tmpdir} from 'node:os'
import {join} from 'node:path'
import {PostgreSqlContainer} from '@testcontainers/postgresql'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId,createUserMessage} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {initializeResources,openResourceDatabase,type ResourceActor} from '@teloa/backend'
import {WorkError,readRetrievalSearchResult} from '@teloa/contract'
import {registerLocalRetrieval,embeddingProviderId,knowledgeSearchToolName,type EmbeddingServiceLike} from '../src/local-retrieval.ts'
import {registerTaskToolGuard,type TaskToolPolicy} from '../src/task-tool-guard.ts'

// 只替代向量推理：原生工具守卫、宿主、资料内容仓与 PostgreSQL 索引走真实链路。
test('原生检索工具与真库：本人加入、会话范围、岗位授权、移出撤回及取消续建',{timeout:60000},async t=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 const container=await new PostgreSqlContainer('postgres:17-alpine').withDatabase('teloa').start()
 const root=await mkdtemp(join(tmpdir(),'teloa-retrieval-host-db-'))
 let database:Awaited<ReturnType<typeof openResourceDatabase>>|undefined
 let ctx:Context|undefined,host:ReturnType<typeof registerLocalRetrieval>|undefined
 t.after(async()=>{
  await host?.dispose()
  await ctx?.fiber.dispose()
  await database?.pool.end()
  await container.stop()
  await rm(root,{recursive:true,force:true})
 })
 const config=join(root,'database.json')
 await writeFile(config,JSON.stringify({connectionString:container.getConnectionUri()}),{mode:0o600})
 database=await openResourceDatabase(config,{id:randomUUID,now:()=>new Date().toISOString()})
 await initializeResources(database.pool)
 const db=database,owner='retrieval-test-owner'
 const human:ResourceActor={ownerId:owner,kind:'human',scopeIds:['general','soc']}
 const add=async(title:string,scopeIds:string[],markdown:string)=>{
  const {item,version}=await db.knowledge.createPaste(human,{requestId:randomUUID(),title,category:'sop',topics:['检索验收'],scopeIds,markdown})
  const draft=await db.service.create(human,{requestId:randomUUID(),title,sourceId:'knowledge_'+item.id,sourceVersion:version.contentHash,scopeIds})
  return db.service.apply(human,{draftId:draft.id,expectedVersion:draft.version})
 }
 const general=await add('差旅制度',['general'],'# 差旅制度\n\n报销前须由部门负责人审批。')
 const soc=await add('安全值班规则',['soc'],'# 安全值班规则\n\n高危告警须由安全值班员核验。')
 const hash='a'.repeat(64),embeds:{kind:string;texts:string[]}[]=[],downloads:string[]=[]
 const embedding:EmbeddingServiceLike={
  snapshot:()=>({providers:[{id:embeddingProviderId,location:'host-local',catalogId:'teloa.model.qwen3-embedding-0-6b',catalogVersion:'1.0.0',profileHash:hash,variant:'fp32',totalMemoryBytes:16*1024**3,memoryRisk:false,preparation:{phase:'ready'}}]}),
  prepare:id=>{downloads.push(id)},cancelPreparation:async()=>{},
  embed:async(_id,input,signal)=>{signal.throwIfAborted();embeds.push({kind:input.kind,texts:[...input.texts]});return {profileHash:hash,vectors:input.texts.map(()=>new Float32Array(1024).fill(1/32))}},
 }
 ctx=new Context()
 for(const plugin of [LlmRuntime,SystemPrompt,ToolRuntime,SessionStore,SessionProjectionRegistry,AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(AgentLoop,{agents:[]})
 const sessionId='local-retrieval-db-session'
 const {agent}=await ctx.agents.create({sessionId:SessionId(sessionId),agentOptions:{provider:'test',model:'test'}})
 agent.session.append('turn/start',{turn:1})
 agent.session.append('user/message',createUserMessage({source:{kind:'user',rpcId:'request'},content:[{type:'text',text:'查一下规则'}]}),{surfaceOp:'append'})
 let policy:TaskToolPolicy|null=null
 host=registerLocalRetrieval(ctx,{
  owner,conversation:async id=>({ownerId:owner,sessionId:id,status:'ready',scopeIds:['general']}),
  readTaskPolicy:async()=>policy,
  taskAuthorization:async()=>({actor:{ownerId:owner,kind:'agent',scopeIds:['soc']},targetScopes:['soc']}),
  humanActor:async()=>human,retrieval:async()=>db.retrieval,embedding:()=>embedding,admit:work=>work(),log:()=>{},
 })
 registerTaskToolGuard(ctx,async()=>policy)
 const invoke=()=>ctx!.tools.execute({agent,name:knowledgeSearchToolName,arguments:{query:'谁负责核验'},callId:ToolCallId(randomUUID()),signal:AbortSignal.timeout(10000)})
 const search=async()=>{
  const result=await invoke()
  const text=result.content.filter(item=>item.type==='text').map(item=>item.text).join('\n')
  assert.equal(result.isError,false,text)
  return readRetrievalSearchResult(JSON.parse(text))
 }
 await host.handle('retrieval/enroll',{sourceIds:[general.sourceId,soc.sourceId]},AbortSignal.timeout(10000))
 await host.idle()
 assert.equal((await db.retrieval.status(human,hash)).items.filter(item=>item.state==='ready').length,2)
 const ordinary=await search()
 assert.deepEqual(ordinary.coverage.searched.map(item=>item.resourceId),[general.id])
 assert.deepEqual(ordinary.coverage.pending,[],'范围外资料既不列出也不计数')
 assert.match(ordinary.results[0]!.excerpt,/部门负责人/)
 assert.equal(ordinary.results[0]!.sourceVersion,general.sourceVersion)
 policy={allowedTools:[]}
 const beforeDenied=embeds.length
 assert.equal((await invoke()).isError,true)
 assert.equal(embeds.length,beforeDenied,'未授权不执行向量推理')
 policy={allowedTools:[knowledgeSearchToolName]}
 const managed=await search()
 assert.deepEqual(managed.coverage.searched.map(item=>item.resourceId),[soc.id],'使用岗位目标范围，不继承普通会话的范围')
 assert.match(managed.results[0]!.excerpt,/安全值班员/)
 await db.service.withdraw(human,{resourceId:soc.id,expectedVersion:soc.version})
 const beforeWithdrawn=embeds.length
 const withdrawn=await search()
 assert.deepEqual(withdrawn.results,[])
 assert.deepEqual(withdrawn.coverage.searched,[])
 assert.deepEqual(withdrawn.coverage.pending,[])
 assert.equal(embeds.length,beforeWithdrawn,'撤回后无可检索资料时不推理')
 policy=null
 await host.handle('retrieval/remove',{sourceIds:[general.sourceId]},AbortSignal.timeout(10000))
 assert.deepEqual((await search()).results,[])
 const vectors=await db.pool.query('select count(*)::int as count from teloa_retrieval_indexes where source_id=$1',[general.sourceId])
 assert.equal(vectors.rows[0].count,0,'移出后索引删除，不能继续使用缓存')
 assert.deepEqual(downloads,[],'检索与建索引不触发模型下载')

 // 真实索引分批提交：首批已入库，第二批推理中取消；续建只能推理剩余块。
 const handbook=await add('巡检手册',['general'],Array.from({length:70},(_,n)=>`# 第${n}节\n\n第${n}节规定编号${n}的设备每周巡检一次并登记。\n`).join('\n'))
 const originalEmbed=embedding.embed,batches:number[]=[]
 let entered!:()=>void
 const secondBatch=new Promise<void>(resolve=>{entered=resolve})
 embedding.embed=async(id,input,signal)=>{
  if(input.kind==='passage'){
   batches.push(input.texts.length)
   if(batches.length===2){
    entered()
    await new Promise<void>((_resolve,reject)=>{
     const abort=()=>reject(new WorkError('teloa/cancelled','验收取消'))
     if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true})
    })
   }
  }
  return originalEmbed(id,input,signal)
 }
 await host.handle('retrieval/enroll',{sourceIds:[handbook.sourceId]},AbortSignal.timeout(10000))
 await secondBatch
 await host.handle('retrieval/reindex',{},AbortSignal.timeout(10000))
 await host.handle('retrieval/cancel',{},AbortSignal.timeout(10000))
 const chunks=async()=>(await db.pool.query('select count(*)::int as count from teloa_retrieval_chunks c join teloa_retrieval_indexes i on i.id=c.index_id where i.resource_id=$1',[handbook.id])).rows[0].count
 assert.equal(await chunks(),32,'取消保留首批已提交向量')
 assert.deepEqual(batches,[32,32],'取消同时清除排队补跑')
 assert.equal((await db.retrieval.status(human,hash)).items.find(item=>item.sourceId===handbook.sourceId)!.state,'building')
 assert.equal(host.building(),false)
 await host.handle('retrieval/reindex',{},AbortSignal.timeout(10000))
 await host.idle()
 assert.equal(await chunks(),70)
 assert.deepEqual(batches,[32,32,32,6],'已提交首批不再推理，第二批取消后重新推理')
 assert.equal((await db.retrieval.status(human,hash)).items.find(item=>item.sourceId===handbook.sourceId)!.state,'ready')
 assert.match((await search()).results[0]!.excerpt,/巡检/)
 assert.deepEqual(downloads,[])
})
