import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp,mkdir,writeFile,rename,rm } from 'node:fs/promises'
import { homedir,tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime,LlmAdapter,ToolCallId,createUserMessage,type GenerateOptions,type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionStore,SessionId } from '@deepseek-ai/dsh-session'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { PostgreSqlContainer } from '@testcontainers/postgresql'
import { ConversationService,FileConversationRepository,openResourceDatabase,initializeResources } from '@teloa/backend'
import { isKnowledgeResourceRevision,isKnowledgeTree,isKnowledgeTreeMutation,isKnowledgeVersion,isKnowledgeVersionSummary,isResourceDraft,isSourceReference,isWorkResource,encodeResourceReference,isResourceRecoveryPage,isResourceHistoryPage } from '@teloa/contract'
import { registerResources,resourceEndpoints } from '../src/resources.ts'

// 仅替代外部模型；真实 Agent、工具运行器、pre-step、PG 与原生 JSONL 均参与。
class ScriptedResourceAdapter extends LlmAdapter {
  requests:GenerateOptions[]=[]
  script:StreamChunk[][]=[]
  override async resolveModel(provider:string,model:string){return {provider,id:model,name:model}}
  async *stream(options:GenerateOptions):AsyncIterable<StreamChunk>{
    this.requests.push(options)
    const response=this.script.shift()
    if(!response)throw Error('未预期的模型调用')
    yield* response
  }
}
const textResponse=(text:string):StreamChunk[]=>[
  {type:'block-start',index:0,blockType:'text'},
  {type:'text-delta',index:0,text},
  {type:'block-end',index:0,block:{type:'text',text}},
  {type:'finish',reason:{kind:'stop'}},
]
const createResponse=(fields:object):StreamChunk[]=>{
  const id=ToolCallId('create-resource-draft'),name='teloa_resources_create',args=JSON.stringify(fields)
  return [
    {type:'block-start',index:0,blockType:'tool-call'},
    {type:'tool-call-delta',index:0,id,name,argumentsDelta:args},
    {type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:args}},
    {type:'finish',reason:{kind:'tool-calls'}},
  ]
}
async function mount(root:string,adapter:ScriptedResourceAdapter){
  const ctx=new Context()
  try{
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop,{agents:[]})
    await ctx.plugin(JsonlSessionPersistence,{root:join(root,'sessions')})
    ctx.llm.registerAdapter(['test-resources'],adapter)
    const conversations=new ConversationService(new FileConversationRepository(join(root,'conversations.json')),{create:async()=>{throw Error('测试通过原生工厂创建')},inspect:async id=>{assert.ok(ctx.agents.list().some(agent=>agent.session.id===id))}},{id:randomUUID,now:()=>new Date().toISOString()})
    const resources=registerResources(ctx,root,'test-owner',conversations,async id=>{
      const agent=ctx.agents.list().find(agent=>agent.session.id===id)
      assert.ok(agent)
      return agent.session
    })
    return {ctx,resources,conversations}
  }catch(error){await ctx.fiber.dispose();throw error}
}
test('真实 Agent 工具创建与 UI 提交同一草案；引用进入目标消息、撤回阻断，冷重启保留原生历史',{timeout:180_000},async t=>{
  process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
  process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
  const container=await new PostgreSqlContainer('postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73').withDatabase('teloa').start()
  t.after(()=>container.stop())
  const root=await mkdtemp(join(tmpdir(),'teloa-native-resources-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const config=join(root,'.runtime/teloa/database.json')
  await mkdir(join(root,'.runtime/teloa'),{recursive:true})
  await writeFile(config,JSON.stringify({connectionString:container.getConnectionUri()}),{mode:0o600})
  const database=await openResourceDatabase(config,{id:randomUUID,now:()=>new Date().toISOString()})
  t.after(()=>database.pool.end())
  await initializeResources(database.pool)
  const adapter=new ScriptedResourceAdapter(),first=await mount(root,adapter)
  t.after(()=>first.ctx.fiber.dispose())
  for(const endpoint of ['knowledge/tree','knowledge/create-folder','knowledge/rename-node','knowledge/move-node','knowledge/list-versions','knowledge/read-version','knowledge/revise-resource','knowledge/restore-resource'])assert.ok(resourceEndpoints.includes(endpoint),'RPC 端点必须显式注册：'+endpoint)
  for(const endpoint of ['knowledge/revise','knowledge/restore'])assert.equal(resourceEndpoints.includes(endpoint),false,'低级知识写端点不能绕过可引用资源投影：'+endpoint)
  const created=await database.knowledge.createPaste({ownerId:'test-owner',kind:'human',scopeIds:['general']},{requestId:randomUUID(),title:'可编辑知识',category:'sop',topics:['值班'],scopeIds:['general'],markdown:'# 第一版\n'})
  const tree=await first.resources.handle('knowledge/tree',{})
  assert.ok(isKnowledgeTree(tree))
  const folder=await first.resources.handle('knowledge/create-folder',{requestId:randomUUID(),parentId:tree.space.rootNodeId,title:'运行手册',expectedDirectoryRevision:tree.space.directoryRevision})
  assert.ok(isKnowledgeTreeMutation(folder))
  const renamed=await first.resources.handle('knowledge/rename-node',{requestId:randomUUID(),nodeId:folder.node.id,title:'生产手册',expectedDirectoryRevision:folder.space.directoryRevision})
  assert.ok(isKnowledgeTreeMutation(renamed)&&renamed.node.title==='生产手册')
  const moved=await first.resources.handle('knowledge/move-node',{requestId:randomUUID(),nodeId:renamed.node.id,parentId:tree.space.rootNodeId,position:0,expectedDirectoryRevision:renamed.space.directoryRevision})
  assert.ok(isKnowledgeTreeMutation(moved)&&moved.node.parentId===tree.space.rootNodeId)
  const versions=await first.resources.handle('knowledge/list-versions',{knowledgeId:created.item.id})
  assert.ok(Array.isArray(versions)&&versions.every(isKnowledgeVersionSummary))
  assert.deepEqual(versions.map(version=>version.version),[1])
  const firstVersion=await first.resources.handle('knowledge/read-version',{knowledgeId:created.item.id,version:1})
  assert.ok(isKnowledgeVersion(firstVersion))
  assert.equal(firstVersion.markdown,'# 第一版\n')
  await assert.rejects(first.resources.handle('knowledge/revise',{requestId:randomUUID(),knowledgeId:created.item.id,expectedVersion:1,markdown:'# 绕过投影\n'}),{code:'teloa/not-found'})
  await assert.rejects(first.resources.handle('knowledge/restore',{requestId:randomUUID(),knowledgeId:created.item.id,version:1,expectedVersion:1}),{code:'teloa/not-found'})

  const projected=await database.knowledge.createPaste({ownerId:'test-owner',kind:'human',scopeIds:['general']},{requestId:randomUUID(),title:'投影知识',category:'sop',topics:['投影'],scopeIds:['general'],markdown:'# 投影第一版\n'})
  const projectedDraft=await database.service.create({ownerId:'test-owner',kind:'human',scopeIds:['general']},{requestId:randomUUID(),title:projected.item.title,sourceId:'knowledge_'+projected.item.id,sourceVersion:projected.version.contentHash,scopeIds:['general']})
  const projectedResource=await database.service.apply({ownerId:'test-owner',kind:'human',scopeIds:['general']},{draftId:projectedDraft.id,expectedVersion:projectedDraft.version})
  const projectionRequest=randomUUID(),projectionInput={requestId:projectionRequest,knowledgeId:projected.item.id,expectedKnowledgeVersion:1,resourceId:projectedResource.id,expectedResourceVersion:1,markdown:'# 投影第二版\n'}
  const projection=await first.resources.handle('knowledge/revise-resource',projectionInput)
  assert.ok(isKnowledgeResourceRevision(projection))
  assert.equal(projection.knowledge.item.currentVersion,2)
  assert.equal(projection.resource.sourceVersion,projection.knowledge.version.contentHash)
  assert.deepEqual(await first.resources.handle('knowledge/revise-resource',projectionInput),projection,'RPC 回包丢失后必须恢复同一投影')
  const projectionRestore=await first.resources.handle('knowledge/restore-resource',{requestId:randomUUID(),knowledgeId:projected.item.id,expectedKnowledgeVersion:2,resourceId:projection.resource.id,expectedResourceVersion:projection.resource.version,restoreVersion:1})
  assert.ok(isKnowledgeResourceRevision(projectionRestore))
  assert.equal(projectionRestore.knowledge.item.currentVersion,3)
  assert.equal(projectionRestore.knowledge.version.markdown,'# 投影第一版\n')
  await assert.rejects(first.resources.handle('knowledge/revise-resource',{...projectionInput,ownerId:'forged'}),{code:'teloa/invalid-input'})
  const sessionId=SessionId(randomUUID())
  const {agent}=await first.ctx.agents.create({sessionId,meta:{cwd:root},agentOptions:{provider:'test-resources',model:'scripted'}})
  await first.conversations.ensure('test-owner',{sessionId})
  const sources=await first.resources.handle('resources/sources',{})
  assert.ok(Array.isArray(sources)&&isSourceReference(sources[0]))
  const source=sources[0],fields={title:'Agent 代拟资料',sourceId:source.id,sourceVersion:source.version,scopeIds:['general']}
  adapter.script.push(createResponse(fields),textResponse('草案已创建，请核对。'))
  agent.followup(createUserMessage({source:{kind:'user',rpcId:'request-create'},content:[{type:'text',text:'为通用工作创建一份资料草案'}]}))
  await agent.whenIdle()
  const toolResult=adapter.requests[1]?.messages.find(message=>message.role==='tool')
  assert.ok(toolResult?.role==='tool'&&!toolResult.isError,'草案工具必须真的执行成功')
  const draft:unknown=JSON.parse(toolResult.content.filter(block=>block.type==='text').map(block=>block.text).join('\n'))
  assert.ok(isResourceDraft(draft))
  const edited=await first.resources.handle('resources/update',{...fields,title:'本人核对后的资料',draftId:draft.id,expectedVersion:draft.version})
  assert.ok(isResourceDraft(edited))
  assert.equal(edited.id,draft.id)
  const resource=await first.resources.handle('resources/apply',{draftId:edited.id,expectedVersion:edited.version})
  assert.ok(isWorkResource(resource))
  const message=createUserMessage({source:{kind:'user',rpcId:'request-read'},content:[{type:'text',text:'请根据这份资料整理摘要 '+encodeResourceReference(resource)}]})
  adapter.script.push(textResponse('已收到目标会话的资料。'))
  agent.followup(message)
  await agent.whenIdle()
  assert.equal(adapter.requests.length,3)
  const attached=agent.session.snapshotEvents().filter(event=>event.type==='user/message'&&event.data.source.kind==='plugin:teloa.resources')
  assert.equal(attached.length,1,'附带资料必须写入原生消息日志且不重复')
  const event=attached[0]!
  assert.equal(event.type,'user/message')
  if(event.type!=='user/message')throw Error('不是资料消息')
  const body=event.data.content.find(block=>block.type==='text')
  assert.ok(body?.type==='text')
  const context=JSON.parse(body.text.slice(body.text.indexOf('\n')+1))
  assert.equal(context.snapshot.sessionId,sessionId)
  assert.equal(context.snapshot.messageId,message.id)
  assert.equal(context.snapshot.requestId,'request-read')
  assert.equal(context.contents[0].title,'本人核对后的资料')
  assert.equal(context.contents[0].sourceVersion,source.version)
  assert.ok(adapter.requests[2]!.messages.some(item=>item.content.some(block=>block.type==='text'&&block.text===body.text)),'发给模型的上下文必须包含获准正文')
  await first.resources.handle('resources/withdraw',{resourceId:resource.id,expectedVersion:resource.version})
  agent.followup(createUserMessage({source:{kind:'user',rpcId:'request-after-withdraw'},content:[{type:'text',text:'再次读取 '+encodeResourceReference(resource)}]}))
  await agent.whenIdle()
  assert.equal(adapter.requests.length,3,'撤回后必须在调用模型前阻断')
  const endings=agent.session.snapshotEvents().filter(event=>event.type==='turn/end')
  assert.match(JSON.stringify(endings.at(-1)),/resource-withdrawn|撤回/)
  const lastEnd=endings.at(-1)!
  assert.equal(lastEnd.data.reason.kind,'error')
  if(lastEnd.data.reason.kind!=='error')throw Error('未留下原生失败记录')
  assert.equal(lastEnd.data.reason.error.code,'teloa/resources/resource-withdrawn','资料失败必须保留可辨识的稳定错误码')
  const recovery=await first.resources.handle('resources/recovery',{sessionId})
  assert.ok(isResourceRecoveryPage(recovery))
  assert.equal(recovery.failures.length,1)
  assert.equal(recovery.failures[0]!.messages[0]!.text,'再次读取 '+encodeResourceReference(resource))
  const referenceHistory=await first.resources.handle('resources/history',{sessionId})
  assert.ok(isResourceHistoryPage(referenceHistory))
  assert.equal(referenceHistory.items.length,1)
  assert.equal(referenceHistory.items[0]!.references[0]!.metadata?.title,'本人核对后的资料','撤回不能用当前目录改写历史名称')
  assert.equal(referenceHistory.items[0]!.references[0]!.version,1)
  assert.equal(JSON.stringify(referenceHistory).includes(body.text),false,'历史目录不返回资料正文')
  await assert.rejects(first.resources.handle('resources/history',{sessionId,ownerId:'forged'}),{code:'teloa/invalid-input'})
  await assert.rejects(first.resources.handle('resources/recovery',{sessionId,ownerId:'forged'}),{code:'teloa/invalid-input'})
  const anotherId=SessionId(randomUUID())
  await first.ctx.agents.create({sessionId:anotherId,meta:{cwd:root},agentOptions:{provider:'test-resources',model:'scripted'}})
  await first.conversations.ensure('another-owner',{sessionId:anotherId})
  await assert.rejects(first.resources.handle('resources/recovery',{sessionId:anotherId}),{code:'teloa/forbidden'})
  await assert.rejects(first.resources.handle('resources/history',{sessionId:anotherId}),{code:'teloa/forbidden'})
  const reads=await database.pool.query('select outcome from teloa_resource_reads r join teloa_message_snapshots s on r.snapshot_id=s.id where s.session_id=$1',[sessionId])
  assert.deepEqual(reads.rows.map(row=>row.outcome).sort(),['failed','provided'])
  const childId=SessionId(randomUUID()),inherited=agent.session.seq
  const {agent:child}=await first.ctx.agents.create({sessionId:childId,meta:{cwd:root,parentSession:sessionId,isSeeded:true},seed:agent.session.snapshotEvents(),inheritedEventCount:inherited,agentOptions:{provider:'test-resources',model:'scripted'}})
  await first.conversations.ensure('test-owner',{sessionId:childId})
  child.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'子会话自己的引用 '+encodeResourceReference(resource)}]}),{surfaceOp:'append'})
  child.followup(createUserMessage({source:{kind:'user',rpcId:'child-after-withdraw'},content:[{type:'text',text:'子会话读取 '+encodeResourceReference(resource)}]}))
  await child.whenIdle()
  const childHistory=await first.resources.handle('resources/history',{sessionId:childId}),childRecovery=await first.resources.handle('resources/recovery',{sessionId:childId})
  assert.ok(isResourceHistoryPage(childHistory)&&isResourceRecoveryPage(childRecovery))
  assert.equal(childHistory.items.length,1,'父会话引用不能进入子会话目录')
  assert.ok(childHistory.items[0]!.seq>=inherited)
  assert.equal(childRecovery.failures.length,1,'父会话失败不能进入子会话恢复目录')
  assert.equal(childRecovery.failures[0]!.messages[0]!.text,'子会话读取 '+encodeResourceReference(resource))
  const historical=JSON.parse(JSON.stringify(agent.session.snapshotEvents()))
  await first.ctx.fiber.dispose()
  const second=await mount(root,new ScriptedResourceAdapter())
  t.after(()=>second.ctx.fiber.dispose())
  const resumed=await second.ctx.agents.resume({resumeSessionId:sessionId,agentOptions:{provider:'test-resources',model:'scripted'}})
  assert.deepEqual(resumed.agent.session.snapshotEvents().slice(0,historical.length),historical,'新的宿主必须从原生 JSONL 保留全部原历史')
  assert.deepEqual(resumed.agent.session.snapshotEvents().slice(historical.length).map(event=>event.type),['session/end-seed'],'只允许原生恢复边界，不能重放工具或伪造业务事件')
  const resumedChild=await second.ctx.agents.resume({resumeSessionId:childId,agentOptions:{provider:'test-resources',model:'scripted'}})
  assert.equal(resumedChild.agent.session.inheritedEventCount,inherited)
  assert.ok(resumedChild.agent.session.firstLiveSeq>inherited,'恢复边界与 fork 继承边界必须不同')
  assert.deepEqual(await second.resources.handle('resources/history',{sessionId:childId}),childHistory)
  assert.deepEqual(await second.resources.handle('resources/recovery',{sessionId:childId}),childRecovery)
  // 新宿主尚未打开资料数据库，临时拿走自身测试配置仍应能从原生日志恢复。
  await rename(config,config+'.offline')
  try{
    assert.deepEqual(await second.resources.handle('resources/recovery',{sessionId}),recovery)
    assert.deepEqual(await second.resources.handle('resources/history',{sessionId}),referenceHistory)
  }finally{await rename(config+'.offline',config)}
  // 超过 256 KiB 的资料只能加入本地检索，不出现在消息引用候选里（发出去也会被拒）。
  const owner={ownerId:'test-owner',kind:'human' as const,scopeIds:['general']},large=await database.knowledge.createPaste(owner,{requestId:randomUUID(),title:'超大知识',category:'reference',topics:[],scopeIds:['general'],markdown:'# 超大\n'+'a'.repeat(300*1024)})
  const largeDraft=await database.service.create(owner,{requestId:randomUUID(),title:large.item.title,sourceId:'knowledge_'+large.item.id,sourceVersion:large.version.contentHash,scopeIds:['general']})
  await database.service.apply(owner,{draftId:largeDraft.id,expectedVersion:largeDraft.version})
  const candidates=await second.resources.candidates(sessionId)
  assert.deepEqual(candidates.map(item=>item.id),[projectionRestore.resource.id],'重启只能恢复知识修订后的最新 active 投影，不能让旧资源重新可选')
})
