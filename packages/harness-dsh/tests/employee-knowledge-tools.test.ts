import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtemp,rm} from 'node:fs/promises'
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
import {Pool} from '../../backend/tests/postgres-test-lifecycle.ts'
import {initializeResources,MarkdownKnowledgeService,MarkdownKnowledgeCatalog,KnowledgeResourceService,ResourceService,EmployeeKnowledgeService,RoleService,initializeRoles,initializeCollaboration,initializeTasks,initializeObjectConversations,initializeTaskRuns,TaskService,ObjectConversationService,TaskRunService,RetrievalIndexService,resolveEmployeeKnowledgeReferences,previewEmployeeKnowledgeImportResetInTransaction,confirmEmployeeKnowledgeImportResetInTransaction,retireEmployeeKnowledgeImportDocumentsInTransaction,type ResourceActor} from '@teloa/backend'
import {registerEmployeeKnowledgeTools} from '../src/employee-knowledge-tools.ts'
import {narrowEmployeeReferenceRules} from '../src/employee-reference-aliases.ts'
import {referenceReadTool,referenceServerName,mcpResourceListTools,referenceToolRules,taskRunToolRules,validateReferenceToolRules} from '../src/role-tool-grants.ts'
import {registerLibraryTools} from '../src/library-tools.ts'
import {KnowledgeTreeService} from '../../backend/src/capabilities/knowledge-tree.ts'
import {roleRetrievalAuthorization} from '../src/role-retrieval-authorization.ts'
import {registerLocalRetrieval,embeddingProviderId} from '../src/local-retrieval.ts'
import {registerTaskToolGuard,type TaskToolPolicy} from '../src/task-tool-guard.ts'

// 原生工具、权限守卫、知识服务与PostgreSQL完整接线；没有LLM/MCP/HTTP调用。
test('员工知识正式工具：独立副本、CAS、历史恢复、Run冻结与索引权限',{timeout:90_000},async t=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 const container=await new PostgreSqlContainer('postgres:17-alpine').start(),pool=new Pool({connectionString:container.getConnectionUri()}),root=await mkdtemp(join(tmpdir(),'teloa-employee-knowledge-runtime-')),ctx=new Context()
 t.after(async()=>{await ctx.fiber.dispose();await pool.end();await container.stop();await rm(root,{recursive:true,force:true})})
 await initializeResources(pool);await initializeRoles(pool);await initializeCollaboration(pool);await initializeTasks(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool)
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},human:ResourceActor={ownerId:owner,kind:'human',scopeIds:['general']},knowledge=new MarkdownKnowledgeService(pool,root,'default',identity),resources=new ResourceService(pool,new MarkdownKnowledgeCatalog(knowledge),identity),employeeKnowledge=new EmployeeKnowledgeService(pool,knowledge,resources,identity),roles=new RoleService(pool,identity),retrieval=new RetrievalIndexService(pool,resources,identity),profileHash='b'.repeat(64)
 employeeKnowledge.setRetrievalProfileReader(()=>profileHash)
 const source=await knowledge.createPaste(human,{requestId:randomUUID(),title:'值班手册',category:'sop',topics:[],scopeIds:['general'],markdown:'# 原手册\n\n原始规则。'}),draft=await resources.create(human,{requestId:randomUUID(),title:source.item.title,sourceId:'knowledge_'+source.item.id,sourceVersion:source.version.contentHash,scopeIds:['general']}),origin=await resources.apply(human,{draftId:draft.id,expectedVersion:draft.version})
 const addRole=async(name:string)=>{const role=await roles.create(owner,{requestId:randomUUID(),fields:{name,kind:'employee',scopes:['general'],duty:'核查规则',dataScope:'只读',executionScope:'分析',runtimeConfig:{agentPresetId:'test'},skills:[],knowledge:[origin.id],responsibility:{triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]}}});await pool.query("update teloa_roles set state='active' where owner_id=$1 and id=$2",[owner,role.id]);return (await roles.get(owner,role.id))!}
 const role=await addRole('值班员'),other=await addRole('其他员工')
 for(const plugin of [LlmRuntime,SystemPrompt,ToolRuntime,SessionStore,SessionProjectionRegistry,AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('employee-knowledge-'+randomUUID()),agentOptions:{provider:'test',model:'test'}})
 agent.session.append('turn/start',{turn:1});agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'编辑值班员的值班手册，保留其他员工。'}]}),{surfaceOp:'append'})
 let policy:TaskToolPolicy|null=null,boundRole:string|null=null,changes=0
 const conversation=async(sessionId:string)=>({ownerId:owner,sessionId,status:'ready' as const}),readTaskPolicy=async()=>policy
 registerEmployeeKnowledgeTools(ctx,{owner,conversation,readTaskPolicy,requestedRoleId:async()=>boundRole,role:id=>roles.get(owner,id),humanActor:async()=>human,service:async()=>employeeKnowledge,changed:()=>{changes++}})
 registerLibraryTools(ctx,{owner,conversation,readTaskPolicy,actor:async(_sessionId,kind)=>({...human,kind}),services:async()=>({resources,knowledge,knowledgeTree:new KnowledgeTreeService(pool,'default',identity),knowledgeResources:new KnowledgeResourceService(pool,knowledge,resources)})})
 registerTaskToolGuard(ctx,readTaskPolicy)
 const call=(suffix:string,args:Record<string,unknown>,id=randomUUID())=>ctx.tools.execute({agent,name:'teloa_employee_knowledge_'+suffix,arguments:args,callId:ToolCallId(id),signal:AbortSignal.timeout(15_000)})
 const value=(result:Awaited<ReturnType<typeof call>>)=>{const text=result.content.filter(item=>item.type==='text').map(item=>item.text).join('\n');assert.equal(result.isError,false,text);return JSON.parse(text).result}
 const initial=value(await call('list',{roleId:role.id}))[0];assert.equal(initial.editing,'fork-on-write')
 const current=value(await call('read',{roleId:role.id,resourceId:origin.id}));assert.equal(current.markdown,source.version.markdown)
 await retrieval.enroll(human,{sourceIds:[origin.sourceId]})
 const embedder={profileHash,embed:async(_kind:'query'|'passage',texts:string[])=>texts.map(()=>new Float32Array(1024).fill(1/32))}
 await retrieval.buildPending(human,embedder,AbortSignal.timeout(15_000))
 const edit={roleId:role.id,resourceId:origin.id,expectedBodyVersion:current.bodyVersion,expectedContentHash:current.contentHash,markdown:'# 员工规则\n\n仅此员工的修订。'},callId=randomUUID(),revision=value(await call('edit',edit,callId)),head=revision.document
 assert.equal(revision.forked,true);assert.notEqual(head.resource.id,origin.id);assert.equal(head.indexState,'pending');assert.equal(changes,1)
 assert.deepEqual(value(await call('edit',edit,callId)),revision)
 assert.equal(value(await call('status',{requestId:revision.requestId})).requestId,revision.requestId)
 assert.equal((await call('edit',{...edit,markdown:'旧版本误覆盖'})).isError,true)
 assert.equal((await roles.get(owner,role.id))!.version,role.version)
 assert.equal((await employeeKnowledge.read(human,{roleId:other.id,resourceId:origin.id})).markdown,source.version.markdown)
 const authorization=await roleRetrievalAuthorization(agent.session.id,{owner,requestedRoleId:async()=>role.id,role:id=>roles.get(owner,id),resolveKnowledge:role=>resolveEmployeeKnowledgeReferences(pool,owner,role.id,role.knowledge)})
 assert.deepEqual(authorization!.knowledgeIds,[head.resource.id])
 const pending=await retrieval.search(authorization!.actor,authorization!.targetScopes,{query:'规则'},embedder,AbortSignal.timeout(15_000),authorization!.knowledgeIds)
 assert.equal(pending.results.length,0);assert.equal(pending.coverage.pending.length,1)
 await retrieval.buildPending(human,embedder,AbortSignal.timeout(15_000))
 const task=await new TaskService(pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'核查',goal:'按当前手册核查',scope:'general'},assignee:{roleId:role.id,expectedVersion:role.version}}),sessionId=randomUUID(),conversationId=randomUUID(),inspect=async()=>({id:conversationId,sessionId,ownerId:owner,status:'ready'})
 await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(pool,identity,inspect),run=await runs.prepare(owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:role.version,sessionId,expectedLinkVersion:1},undefined,async(_target,role,db)=>await resources.executionKnowledgeInTransaction(db,{...human,kind:'agent'},['general'],role.knowledge))
 assert.equal(run.knowledge[0]!.id,head.resource.id);assert.equal(run.knowledge[0]!.sourceVersion,head.contentHash)
 const restored=value(await call('restore',{roleId:role.id,resourceId:origin.id,expectedBodyVersion:head.bodyVersion,expectedContentHash:head.contentHash,restoreVersion:1})).document
 assert.equal(restored.markdown,source.version.markdown);assert.equal(value(await call('versions',{roleId:role.id,resourceId:origin.id})).length,3)
 const claim=await runs.claim(owner,{runId:run.id});assert.deepEqual(claim.target!.knowledgeIds,[head.resource.id]);assert.equal(claim.run.inputText,run.inputText)
 const frozen=await retrieval.search(authorization!.actor,['general'],{query:'员工'},embedder,AbortSignal.timeout(15_000),claim.target!.knowledgeIds)
 assert.deepEqual(frozen.coverage.searched.map(row=>row.resourceId),[head.resource.id])
 const all=(await retrieval.status(human,profileHash)).items.map(row=>row.resourceId);assert.ok(all.includes(origin.id));assert.ok(all.includes(restored.resource.id));assert.ok(!all.includes(head.resource.id))
 policy={allowedTools:['teloa_knowledge_search','teloa_employee_knowledge_edit']};assert.equal((await call('edit',{...edit,expectedBodyVersion:restored.bodyVersion,expectedContentHash:restored.contentHash})).isError,true)
 policy=null;boundRole=role.id;assert.equal((await call('list',{roleId:other.id})).isError,true)
 assert.equal((await call('list',{roleId:role.id,ownerId:'arbitrary'})).isError,true)
 await resources.withdraw(human,{resourceId:restored.resource.id,expectedVersion:restored.resource.version})
 await assert.rejects(runs.executionScope(owner,{runId:run.id}),{code:'teloa/resource-withdrawn'})
 const revoked=await retrieval.search(authorization!.actor,['general'],{query:'员工'},embedder,AbortSignal.timeout(15_000),[head.resource.id]);assert.equal(revoked.results.length,0)
 // 未提交知识沿同一正式工具链修订、历史恢复，不需要先造工作资料。
 const standalone=await knowledge.createPaste(human,{requestId:randomUUID(),title:'独立笔记',category:'reference',topics:[],scopeIds:['general'],markdown:'初稿'})
 const libraryCall=async(name:string,args:Record<string,unknown>)=>{const result=await ctx.tools.execute({agent,name:'teloa_library_'+name,arguments:args,callId:ToolCallId(randomUUID()),signal:AbortSignal.timeout(15_000)});const text=result.content.filter(item=>item.type==='text').map(item=>item.text).join('\n');assert.equal(result.isError,false,text);return JSON.parse(text)}
 const revised=await libraryCall('revise_standalone',{knowledgeId:standalone.item.id,expectedKnowledgeVersion:1,markdown:'修改稿'})
 assert.equal(revised.knowledge.item.currentVersion,2)
 const recovered=await libraryCall('restore_standalone',{knowledgeId:standalone.item.id,expectedKnowledgeVersion:2,restoreVersion:1});assert.equal(recovered.knowledge.item.currentVersion,3)
 // 归档正文只能由 TaskRunService 为真实已冻结 Run 签发的进程内能力回读。
 const otherBefore=await employeeKnowledge.read(human,{roleId:other.id,resourceId:origin.id}),otherEdit=await employeeKnowledge.revise(human,{requestId:randomUUID(),roleId:other.id,resourceId:origin.id,expectedBodyVersion:otherBefore.bodyVersion,expectedContentHash:otherBefore.contentHash,markdown:'# 另一员工固定快照'})
 const fixedTask=await new TaskService(pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'保留原快照',goal:'核对原资料',scope:'general'},assignee:{roleId:other.id,expectedVersion:other.version}}),fixedSession=randomUUID(),fixedConversation=randomUUID(),fixedInspect=async()=>({id:fixedConversation,sessionId:fixedSession,ownerId:owner,status:'ready'})
 await new ObjectConversationService(pool,fixedInspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:fixedTask.id,expectedObjectVersion:1,sessionId:fixedSession,expectedLinkVersion:0,action:'link'})
 const fixedRuns=new TaskRunService(pool,identity,fixedInspect),fixedRun=await fixedRuns.prepare(owner,{requestId:randomUUID(),taskId:fixedTask.id,expectedTaskVersion:1,roleId:other.id,expectedRoleVersion:other.version,sessionId:fixedSession,expectedLinkVersion:1},undefined,async(_target,role,db)=>resources.executionKnowledgeInTransaction(db,{...human,kind:'agent'},['general'],role.knowledge))
 await fixedRuns.claim(owner,{runId:fixedRun.id})
 await retrieval.buildPending(human,embedder,AbortSignal.timeout(15_000))
 const resetDb=await pool.connect();try{await resetDb.query('begin');const scope={originResourceIds:[origin.id]},plan=await previewEmployeeKnowledgeImportResetInTransaction(resetDb,owner,scope);await confirmEmployeeKnowledgeImportResetInTransaction(resetDb,owner,{...scope,expectedDigest:plan.digest,resetId:randomUUID(),now:identity.now()});await resetDb.query('commit')}catch(error){await resetDb.query('rollback');throw error}finally{resetDb.release()}
 const agentActor={...human,kind:'agent' as const},archiveId=otherEdit.document.resource.id,fixedScope=await fixedRuns.executionScope(owner,{runId:fixedRun.id})
 assert.ok(fixedScope.fixedKnowledgeRead)
 await assert.rejects(resources.executionKnowledge(agentActor,['general'],[archiveId]),{code:'teloa/not-found'})
 await assert.rejects(resources.executionKnowledge(agentActor,['general'],[archiveId],undefined,{runId:fixedRun.id} as never),{code:'teloa/not-found'})
 assert.deepEqual(await resources.executionKnowledge(agentActor,['general'],[archiveId],undefined,fixedScope.fixedKnowledgeRead),fixedRun.knowledge)
 const {agent:runAgent}=await ctx.agents.create({sessionId:SessionId(fixedSession),agentOptions:{provider:'test',model:'test'}})
 const retrievalHost=registerLocalRetrieval(ctx,{owner,conversation:async sessionId=>({...await conversation(sessionId),scopeIds:['general']}),readTaskPolicy,requestedRoleId:async()=>null,role:async()=>other,
  taskAuthorization:async sessionId=>{assert.equal(sessionId,fixedSession);return {actor:agentActor,targetScopes:['general'],...(fixedScope.knowledgeIds===undefined?{}:{knowledgeIds:fixedScope.knowledgeIds}),...(fixedScope.fixedKnowledgeRead===undefined?{}:{fixedKnowledgeRead:fixedScope.fixedKnowledgeRead})}},humanActor:async()=>human,retrieval:async()=>retrieval,
  embedding:()=>({snapshot:()=>({providers:[{id:embeddingProviderId,location:'host-local',catalogId:'teloa.model.qwen3-embedding-0-6b',catalogVersion:'1.0.0',profileHash,variant:'fp32',totalMemoryBytes:16*1024**3,memoryRisk:false,preparation:{phase:'ready'}}]}),prepare:()=>{throw Error('不得准备或下载')},cancelPreparation:async()=>{},embed:async(_id,input)=>({profileHash,vectors:await embedder.embed(input.kind,input.texts)})}),admit:work=>work(),log:()=>{}})
 t.after(()=>retrievalHost.dispose())
 policy={allowedTools:['teloa_knowledge_search']}
 const searched=await ctx.tools.execute({agent:runAgent,name:'teloa_knowledge_search',arguments:{query:'固定快照'},callId:ToolCallId(randomUUID()),signal:AbortSignal.timeout(15_000)})
 assert.equal(searched.isError,false,JSON.stringify(searched));const searchResult=JSON.parse(searched.content.filter(row=>row.type==='text').map(row=>row.text).join('\n'));assert.deepEqual(searchResult.coverage.searched.map((row:{resourceId:string})=>row.resourceId),[archiveId]);assert.match(searchResult.results[0].excerpt,/另一员工固定快照/)
 policy=null

 await assert.rejects(resources.executionKnowledge(agentActor,['general'],[head.resource.id],undefined,fixedScope.fixedKnowledgeRead),{code:'teloa/not-found'})
 await assert.rejects(employeeKnowledge.status(human,{requestId:otherEdit.requestId}),{code:'teloa/not-found'})
 await assert.rejects(employeeKnowledge.revise(human,{requestId:otherEdit.requestId,roleId:other.id,resourceId:origin.id,expectedBodyVersion:otherBefore.bodyVersion,expectedContentHash:otherBefore.contentHash,markdown:'# 另一员工固定快照'}),{code:'teloa/not-found'})
 const retired=await pool.connect();try{await retired.query('begin');await retireEmployeeKnowledgeImportDocumentsInTransaction(retired,owner,{previousLoadId:randomUUID(),loadId:randomUUID(),resources:[{resourceId:origin.id,localId:'guide'}],now:identity.now()});await retired.query('commit')}finally{retired.release()}
 assert.deepEqual((await roleRetrievalAuthorization(fixedSession,{owner,requestedRoleId:async()=>other.id,role:id=>roles.get(owner,id),resolveKnowledge:role=>resolveEmployeeKnowledgeReferences(pool,owner,role.id,role.knowledge)}))!.knowledgeIds,[])
 assert.deepEqual(await employeeKnowledge.list(human,{roleId:other.id,requireReady:true}),[])
 const globalAfterRemoval=await retrieval.search(agentActor,['general'],{query:'原手册'},embedder,AbortSignal.timeout(15_000));assert.deepEqual(globalAfterRemoval.coverage.searched,[]);assert.deepEqual(globalAfterRemoval.coverage.pending,[])
 const retainedScope=await fixedRuns.executionScope(owner,{runId:fixedRun.id});assert.deepEqual(await resources.executionKnowledge(agentActor,['general'],[archiveId],undefined,retainedScope.fixedKnowledgeRead),fixedRun.knowledge)
 const futureTask=await new TaskService(pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'移除后的新任务',goal:'只看有效资料',scope:'general'},assignee:{roleId:other.id,expectedVersion:other.version}}),futureSession=randomUUID(),futureConversation=randomUUID(),futureInspect=async()=>({id:futureConversation,sessionId:futureSession,ownerId:owner,status:'ready'})
 await new ObjectConversationService(pool,futureInspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:futureTask.id,expectedObjectVersion:1,sessionId:futureSession,expectedLinkVersion:0,action:'link'})
 const futureRuns=new TaskRunService(pool,identity,futureInspect),futureRun=await futureRuns.prepare(owner,{requestId:randomUUID(),taskId:futureTask.id,expectedTaskVersion:1,roleId:other.id,expectedRoleVersion:other.version,sessionId:futureSession,expectedLinkVersion:1},undefined,async(_target,effective)=>{assert.deepEqual(effective.knowledge,[]);return []})
 assert.deepEqual(futureRun.knowledge,[]);assert.deepEqual((await roles.get(owner,other.id))!.knowledge,[origin.id])
 const futureClaim=await futureRuns.claim(owner,{runId:futureRun.id});assert.deepEqual(futureClaim.target!.knowledgeIds,[]);assert.deepEqual((await futureRuns.executionScope(owner,{runId:futureRun.id})).knowledgeIds,[])
 // 真实DB的移除标记只收窄对应公共读取参数，保留其余精确参数及原已授权检索。
 const removedPublic=randomUUID(),keptPublic=randomUUID(),publicHash='c'.repeat(64),keptHash='d'.repeat(64)
 for(const [id,sourceId,sourceVersion] of [[removedPublic,'workbench',publicHash],[keptPublic,'capabilities',keptHash]])await pool.query("insert into teloa_resources values($1,$2,1,'active',$3,$4,$4)",[id,owner,JSON.stringify({title:sourceId,sourceId,sourceVersion,scopeIds:['general']}),identity.now()])
 const publicRole=await roles.create(owner,{requestId:randomUUID(),fields:{name:'公共资料岗',kind:'employee',scopes:['general'],duty:'核查',dataScope:'只读',executionScope:'分析',skills:[],knowledge:[removedPublic,keptPublic],responsibility:{triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]}}})
 const retirePublic=async(ids:string[])=>{const db=await pool.connect();try{await db.query('begin');await retireEmployeeKnowledgeImportDocumentsInTransaction(db,owner,{previousLoadId:randomUUID(),loadId:randomUUID(),resources:ids.map((resourceId,index)=>({resourceId,localId:'public-'+index})),now:identity.now()});await db.query('commit')}finally{db.release()}}
 await retirePublic([removedPublic])
 const savedRules=[{name:referenceReadTool,allowed:[{id:'workbench',version:publicHash},{id:'capabilities',version:keptHash}]},...mcpResourceListTools.map(name=>({name,allowed:[{server:referenceServerName}]})),{name:'teloa_knowledge_search',anyArguments:true as const,allowed:[]}],keptContent={id:keptPublic,version:1,title:'剩余资料',sourceId:'capabilities',sourceVersion:keptHash,scopeIds:['general'],text:'保留的正文'}
 const narrowed=await narrowEmployeeReferenceRules(pool,owner,publicRole.id,publicRole.knowledge,savedRules,[keptContent]);assert.deepEqual(narrowed.find(rule=>rule.name===referenceReadTool)!.allowed,[{id:'capabilities',version:keptHash}]);validateReferenceToolRules(narrowed,taskRunToolRules(referenceToolRules([keptContent])));assert.equal(savedRules[0]!.allowed.length,2)
 await retirePublic([keptPublic]);assert.deepEqual(await narrowEmployeeReferenceRules(pool,owner,publicRole.id,publicRole.knowledge,savedRules,[]),[{name:'teloa_knowledge_search',anyArguments:true,allowed:[]}])


})
