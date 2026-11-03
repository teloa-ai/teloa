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
import {initializeResources,openResourceDatabase,initializeBusinessSpaces,BusinessSpaceService,BusinessScopeService,initializeConversationWork,ConversationWorkService,type ResourceActor} from '@teloa/backend'
import {WorkError,readRetrievalSearchResult} from '@teloa/contract'
import {registerLocalRetrieval,authorizeOrdinaryRetrievalContext,embeddingProviderId,knowledgeSearchToolName,type EmbeddingServiceLike} from '../src/local-retrieval.ts'
import {registerTaskToolGuard,type TaskToolPolicy} from '../src/task-tool-guard.ts'
import {readSessionEvents} from '../src/session-events.ts'
import type {BusinessConversationAuthorizationPorts} from '../src/business-conversation-authorization.ts'

// 只替代向量推理：原生工具守卫、宿主、资料内容仓与 PostgreSQL 索引走真实链路。
test('原生检索工具与真库：本人加入、会话范围、岗位授权、移出撤回及取消续建',{timeout:60000},async t=>{
 // 已有隔离测试库可复用其配置；缺省仍由测试拥有独立容器，不接触产品运行库。
 const externalConfig=process.env.TELOA_RETRIEVAL_TEST_DATABASE_CONFIG
 if(!externalConfig){process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'}
 const container=externalConfig?undefined:await new PostgreSqlContainer('postgres:17-alpine').withDatabase('teloa').start()
 const root=externalConfig?undefined:await mkdtemp(join(tmpdir(),'teloa-retrieval-host-db-'))
 let database:Awaited<ReturnType<typeof openResourceDatabase>>|undefined
 let ctx:Context|undefined,host:ReturnType<typeof registerLocalRetrieval>|undefined
 t.after(async()=>{
  await host?.dispose()
  await ctx?.fiber.dispose()
  await database?.pool.end()
  await container?.stop()
  if(root)await rm(root,{recursive:true,force:true})
 })
 const config=externalConfig??join(root!,'database.json')
 if(!externalConfig)await writeFile(config,JSON.stringify({connectionString:container!.getConnectionUri()}),{mode:0o600})
 database=await openResourceDatabase(config,{id:randomUUID,now:()=>new Date().toISOString()})
 await initializeResources(database.pool)
 const db=database,owner='retrieval-test-'+randomUUID()
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
 let ordinaryPorts:BusinessConversationAuthorizationPorts|undefined
 host=registerLocalRetrieval(ctx,{
  owner,conversation:async id=>({ownerId:owner,sessionId:id,status:'ready',scopeIds:['general']}),requestedRoleId:async()=>null,role:async()=>null,
  readTaskPolicy:async()=>policy,
  ordinaryAuthorization:(exec,fallback)=>ordinaryPorts?authorizeOrdinaryRetrievalContext(ordinaryPorts,exec,fallback):Promise.resolve(fallback),
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

 // 与正常项目入口相同：Conversation 元数据仍为 general，业务身份由正式 work-context 服务保存。
 await initializeBusinessSpaces(db.pool);await initializeConversationWork(db.pool)
 const identity={id:randomUUID,now:()=>new Date().toISOString()},space=await new BusinessSpaceService(db.pool,identity).ensurePersonal(owner)
 const scope='business_'+randomUUID().replaceAll('-','')
 await BusinessScopeService.ensure(db.pool,owner,{scope,title:'项目资料隔离',kind:'domain',spaceId:space.id})
 human.scopeIds.push(scope)
 const {agent:projectAgent}=await ctx.agents.create({sessionId:SessionId('project-'+randomUUID()),agentOptions:{provider:'test',model:'test'}})
 const conversation=async(id:string)=>({ownerId:owner,sessionId:id,status:'ready' as const,scopeIds:['general']})
 const contexts=new ConversationWorkService(db.pool,identity.now,async(actor,id)=>{
  if(actor!==owner||!ctx!.agents.get(SessionId(id)))throw new WorkError('teloa/forbidden','会话不属于本人')
  return {...await conversation(id),submitted:readSessionEvents(ctx!.agents.get(SessionId(id))!.session).some(event=>event.type==='user/message'&&event.data.source.kind==='user')}
 })
 const context=await contexts.setContext(owner,{requestId:randomUUID(),sessionId:projectAgent.id,scopeId:scope,roleId:null,expectedVersion:0})
 assert.equal(context.scopeId,scope);assert.deepEqual((await conversation(projectAgent.id)).scopeIds,['general'])
 projectAgent.session.append('turn/start',{turn:1})
 projectAgent.session.append('user/message',createUserMessage({source:{kind:'user',rpcId:randomUUID()},content:[{type:'text',text:'查阅交付窗口'}]}),{surfaceOp:'append'})
 const oldGeneral=await add('海棠交付窗口',['general'],'更正：预约须提前5个工作日，负责人为林乙。此版替代v1。')
 const current=await add('海棠交付窗口',[scope],'预约须提前3个工作日，负责人为陈甲。')
 let accessRevoked=false
 ordinaryPorts={owner,conversation,readTaskPolicy:async()=>null,isRoleConversation:async()=>false,isTaskConversation:async()=>false,binding:async()=>undefined,context:id=>contexts.context(owner,{sessionId:id}),scopes:async()=>accessRevoked?[]:(await new BusinessScopeService(db.pool).list(owner)).map(({scope,title})=>({scope,title}))}
 await host.handle('retrieval/enroll',{sourceIds:[oldGeneral.sourceId,current.sourceId]},AbortSignal.timeout(10000));await host.idle()
 const result=await ctx.tools.execute({agent:projectAgent,name:knowledgeSearchToolName,arguments:{query:'海棠交付窗口'},callId:ToolCallId(randomUUID()),signal:AbortSignal.timeout(10000)})
 assert.equal(result.isError,false,JSON.stringify(result))
 const scoped=readRetrievalSearchResult(JSON.parse(result.content.filter(item=>item.type==='text').map(item=>item.text).join('\n')))
 assert.deepEqual(scoped.coverage.searched.map(item=>item.resourceId),[current.id])
 assert.deepEqual(scoped.coverage.pending,[])
 assert.equal(scoped.results[0]!.resourceId,current.id);assert.match(scoped.results[0]!.excerpt,/3个工作日.*陈甲/)
 assert.ok(scoped.results.every(hit=>hit.resourceId!==oldGeneral.id&&!hit.excerpt.includes('林乙')),'旧 general D04-v2 不能冒充项目来源')
 const exec={agent:projectAgent,signal:AbortSignal.timeout(10000)},authorization=await authorizeOrdinaryRetrievalContext(ordinaryPorts,exec,{actor:{ownerId:owner,kind:'agent',scopeIds:['general']},targetScopes:['general']})
 const hit=scoped.results[0]!,readHit={resourceId:hit.resourceId,resourceVersion:hit.resourceVersion,sourceVersion:hit.sourceVersion,chars:hit.chars}
 const readExcerpt=async(actor=authorization.actor,targetScopes=authorization.targetScopes,input=readHit)=>{
  const client=await db.pool.connect()
  try{await client.query('begin');return await db.service.readExcerptsInTransaction(client,actor,targetScopes,[input])}finally{await client.query('rollback');client.release()}
 }
 await authorization.assertCurrent!()
 assert.equal((await readExcerpt())[0]!.excerpt,hit.excerpt,'检索后读沿同一主体与业务范围取得固定版本摘录')
 await assert.rejects(readExcerpt({...authorization.actor,ownerId:'other-owner'}),error=>error instanceof WorkError&&error.code==='teloa/forbidden')
 await assert.rejects(readExcerpt(authorization.actor,['general']),error=>error instanceof WorkError&&error.code==='teloa/forbidden')
 await assert.rejects(readExcerpt(authorization.actor,authorization.targetScopes,{...readHit,sourceVersion:'0'.repeat(64)}),error=>error instanceof WorkError&&error.code==='teloa/version-conflict')
 await assert.rejects(readExcerpt(authorization.actor,authorization.targetScopes,{...readHit,resourceId:oldGeneral.id,resourceVersion:oldGeneral.version,sourceVersion:oldGeneral.sourceVersion}),error=>error instanceof WorkError&&error.code==='teloa/forbidden')
 accessRevoked=true
 await assert.rejects(authorization.assertCurrent!(),error=>error instanceof WorkError&&error.code==='teloa/forbidden')
 const revoked=await ctx.tools.execute({agent:projectAgent,name:knowledgeSearchToolName,arguments:{query:'交付窗口'},callId:ToolCallId(randomUUID()),signal:AbortSignal.timeout(10000)})
 assert.equal(revoked.isError,true)
 accessRevoked=false
 await db.service.withdraw(human,{resourceId:current.id,expectedVersion:current.version})
 await assert.rejects(readExcerpt(),error=>error instanceof WorkError&&error.code==='teloa/resource-withdrawn')
 assert.deepEqual(downloads,[])
})
