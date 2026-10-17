import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {homedir,tmpdir} from 'node:os'
import {join} from 'node:path'
import {mkdtemp,rm} from 'node:fs/promises'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId,createUserMessage} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {initializeResources} from '../../backend/src/capabilities/schema.ts'
import {ResourceService} from '../../backend/src/capabilities/resources.ts'
import {MarkdownKnowledgeService} from '../../backend/src/capabilities/markdown-knowledge.ts'
import {MarkdownKnowledgeCatalog,markdownKnowledgeReferenceId} from '../../backend/src/capabilities/markdown-knowledge-catalog.ts'
import {KnowledgeTreeService} from '../../backend/src/capabilities/knowledge-tree.ts'
import {KnowledgeResourceService} from '../../backend/src/capabilities/knowledge-resources.ts'
import {registerLibraryTools,type LibraryToolsPorts} from '../src/library-tools.ts'

const {Pool}=createRequire(new URL('../../backend/package.json',import.meta.url))('pg')
let container:StartedPostgreSqlContainer,pool:ResourceService['pool'],root:string
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeResources(pool)
 root=await mkdtemp(join(tmpdir(),'teloa-library-tools-'))
},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop();if(root)await rm(root,{recursive:true,force:true})})

async function setup(options:{instruction?:boolean;subagent?:boolean;ports?:Partial<LibraryToolsPorts>}={}){
 const owner='test:'+randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},knowledge=new MarkdownKnowledgeService(pool,root,'default',identity),resources=new ResourceService(pool,new MarkdownKnowledgeCatalog(knowledge),identity),knowledgeTree=new KnowledgeTreeService(pool,'default',identity),knowledgeResources=new KnowledgeResourceService(pool,knowledge,resources)
 const actor={ownerId:owner,kind:'human' as const,scopeIds:['general']}
 const ctx=new Context();await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('library-'+randomUUID()),...(options.subagent?{meta:{origin:'subagent' as const,delegationDepth:1}}:{}),agentOptions:{provider:'test',model:'test'}})
 const turn=()=>{agent.session.append('turn/start',{turn:0} as never);agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'按我的指令管理知识库和工作资料'}]}),{surfaceOp:'append'})}
 if(options.instruction!==false)turn()
 registerLibraryTools(ctx,{owner,conversation:async sessionId=>({ownerId:owner,sessionId,status:'ready'}),readTaskPolicy:async()=>null,actor:async(_sessionId,kind)=>({...actor,kind}),services:async()=>({resources,knowledge,knowledgeTree,knowledgeResources}),...options.ports})
 let seq=0;const call=(suffix:string,args:Record<string,unknown>={},callId?:string)=>ctx.tools.execute({agent,name:suffix.startsWith('teloa_')?suffix:'teloa_library_'+suffix,arguments:args,callId:ToolCallId(callId??'library-'+ ++seq),signal:AbortSignal.timeout(10_000)})
 const save=async()=>knowledge.createPaste(actor,{requestId:randomUUID(),title:'排障手册',category:'sop',topics:[],scopeIds:['general'],markdown:'# 第一版\n'})
 const draft=async(saved:Awaited<ReturnType<typeof save>>)=>resources.create(actor,{requestId:randomUUID(),title:saved.item.title,sourceId:markdownKnowledgeReferenceId(saved.item.id),sourceVersion:saved.version.contentHash,scopeIds:['general']})
 return {ctx,agent,owner,actor,resources,knowledge,knowledgeTree,knowledgeResources,turn,call,save,draft}
}
const value=(result:Awaited<ReturnType<Awaited<ReturnType<typeof setup>>['call']>>)=>JSON.parse(result.content.filter(item=>item.type==='text').map(item=>item.text).join('\n'))

test('真实目录创建重命名移动同对象，版本拒绝与同call幂等',async t=>{
 const f=await setup();t.after(()=>f.ctx.fiber.dispose())
 const initial=value(await f.call('directory')),input={parentId:initial.tree.space.rootNodeId,title:'规范',expectedDirectoryRevision:initial.tree.space.directoryRevision}
 const created=await f.call('create_folder',input,'folder-1');assert.equal(created.isError,false,JSON.stringify(created))
 const folder=value(created).mutation;assert.deepEqual(value(await f.call('create_folder',input,'folder-1')),value(created))
 assert.deepEqual(['schema','ownerId','kind','id','title','version','state','sourceSession','sessionId'].map(key=>value(created)[key]),['teloa.library-result/v1',f.owner,'knowledge-node',folder.node.id,'规范',folder.space.directoryRevision,'active',f.agent.session.id,f.agent.session.id])
 assert.equal((await f.call('create_folder',{...input,title:'不同请求'},'folder-1')).isError,true)
 assert.equal((await f.call('rename',{nodeId:folder.node.id,title:'过期',expectedDirectoryRevision:input.expectedDirectoryRevision})).isError,true)
 const renamed=value(await f.call('rename',{nodeId:folder.node.id,title:'团队规范',expectedDirectoryRevision:folder.space.directoryRevision})).mutation
 const child=value(await f.call('create_folder',{parentId:initial.tree.space.rootNodeId,title:'子目录',expectedDirectoryRevision:renamed.space.directoryRevision},'folder-2')).mutation
 assert.notEqual(child.node.id,folder.node.id)
 const moved=value(await f.call('move',{nodeId:child.node.id,parentId:folder.node.id,expectedDirectoryRevision:child.space.directoryRevision})).mutation
 assert.equal(moved.node.parentId,folder.node.id);assert.equal(moved.node.id,child.node.id)
 assert.equal((await f.call('move',{nodeId:folder.node.id,parentId:child.node.id,expectedDirectoryRevision:moved.space.directoryRevision})).isError,true)
})

test('知识保存不产生工作资料；固定版本读取按原会话scope隔离',async t=>{
 const f=await setup();t.after(()=>f.ctx.fiber.dispose());const tree=value(await f.call('directory')).tree
 const input={title:'配置规则',category:'policy',topics:['规则'],scopeIds:['general'],markdown:'# 配置规则\n',parentId:tree.space.rootNodeId,expectedDirectoryRevision:tree.space.directoryRevision}
 const saved=await f.call('save',input,'save-1');assert.equal(saved.isError,false,JSON.stringify(saved));assert.deepEqual(value(await f.call('save',input,'save-1')),value(saved))
 const knowledge=value(saved).knowledge;assert.equal((await f.resources.list(f.actor)).resources.length,0)
 assert.equal(value(saved).id,knowledge.item.id);assert.equal(value(saved).state,'saved');assert.equal(value(saved).version,1)
 assert.equal(Object.hasOwn(knowledge.version,'markdown'),false)
 assert.equal(value(await f.call('versions',{knowledgeId:knowledge.item.id})).versions.length,1)
 assert.equal(value(await f.call('read_version',{knowledgeId:knowledge.item.id,version:1})).version.markdown,input.markdown)
 const secret=await f.knowledge.createPaste({...f.actor,scopeIds:['secret']},{requestId:randomUUID(),title:'私密资料',category:'policy',topics:[],scopeIds:['secret'],markdown:'private-body'})
 assert.equal((await f.call('read_version',{knowledgeId:secret.item.id,version:1})).isError,true)
 assert.ok(!JSON.stringify(value(await f.call('directory'))).includes('私密资料'))
 const large=await f.knowledge.createPaste(f.actor,{requestId:randomUUID(),title:'大资料',category:'reference',topics:[],scopeIds:['general'],markdown:'x'.repeat(256*1024+1)})
 const largeRead=await f.call('read_version',{knowledgeId:large.item.id,version:1});assert.equal(largeRead.isError,true);assert.ok(JSON.stringify(largeRead).includes('256 KiB'))
})

test('目录修改在真实事务中保护目标页面与文件夹子树范围，拒绝无副作用并保留CAS和本人UI行为',async t=>{
 const f=await setup();t.after(()=>f.ctx.fiber.dispose())
 let tree=await f.knowledgeTree.list(f.actor,{})
 const restricted=await f.knowledgeTree.createFolder(f.actor,{requestId:randomUUID(),parentId:tree.space.rootNodeId,title:'受限目录',expectedDirectoryRevision:tree.space.directoryRevision})
 const secret=await f.knowledge.createPaste({...f.actor,scopeIds:['secret']},{requestId:randomUUID(),title:'私密页',category:'policy',topics:[],scopeIds:['secret'],markdown:'secret',parentId:restricted.node.id,expectedDirectoryRevision:restricted.space.directoryRevision})
 tree=await f.knowledgeTree.list(f.actor,{})
 const secretPage=tree.nodes.find(node=>node.type==='page'&&node.knowledgeId===secret.item.id)!
 const count=async()=>Number((await pool.query('select count(*) from teloa_knowledge_directory_operations where owner_id=$1',[f.owner])).rows[0].count)
 const before=await count()
 for(const [name,args] of [
  ['rename',{nodeId:secretPage.id,title:'越界改名'}],
  ['rename',{nodeId:restricted.node.id,title:'越界目录名'}],
  ['move',{nodeId:restricted.node.id,parentId:tree.space.rootNodeId,position:0}]
 ] as const){
  const result=await f.call(name,{...args,expectedDirectoryRevision:tree.space.directoryRevision})
  assert.equal(result.isError,true,JSON.stringify(result));assert.ok(JSON.stringify(result).includes('无权执行'),JSON.stringify(result))
  assert.deepEqual(await f.knowledgeTree.list(f.actor,{}),tree);assert.equal(await count(),before)
 }
 const general=await f.save();tree=await f.knowledgeTree.list(f.actor,{})
 const generalPage=tree.nodes.find(node=>node.type==='page'&&node.knowledgeId===general.item.id)!
 const targetDenied=await f.call('move',{nodeId:generalPage.id,parentId:restricted.node.id,expectedDirectoryRevision:tree.space.directoryRevision})
 assert.equal(targetDenied.isError,true,JSON.stringify(targetDenied));assert.ok(JSON.stringify(targetDenied).includes('无权执行'),JSON.stringify(targetDenied))
 assert.deepEqual(await f.knowledgeTree.list(f.actor,{}),tree);assert.equal(await count(),before)
 const renamed=await f.call('rename',{nodeId:generalPage.id,title:'范围内改名',expectedDirectoryRevision:tree.space.directoryRevision},'scoped-rename')
 assert.equal(renamed.isError,false,JSON.stringify(renamed));assert.equal(value(renamed).mutation.node.id,generalPage.id)
 assert.equal((await f.call('rename',{nodeId:generalPage.id,title:'旧版本',expectedDirectoryRevision:tree.space.directoryRevision})).isError,true)
 tree=await f.knowledgeTree.list(f.actor,{})
 const clean=await f.knowledgeTree.createFolder(f.actor,{requestId:randomUUID(),parentId:tree.space.rootNodeId,title:'普通目录',expectedDirectoryRevision:tree.space.directoryRevision})
 const moved=await f.call('move',{nodeId:generalPage.id,parentId:clean.node.id,expectedDirectoryRevision:clean.space.directoryRevision})
 assert.equal(moved.isError,false,JSON.stringify(moved));assert.equal(value(moved).mutation.node.parentId,clean.node.id)
 tree=await f.knowledgeTree.list(f.actor,{})
 const uiRename=await f.knowledgeTree.renameNode(f.actor,{requestId:randomUUID(),nodeId:secretPage.id,title:'本人页面操作',expectedDirectoryRevision:tree.space.directoryRevision})
 assert.equal(uiRename.node.title,'本人页面操作')
 f.actor.scopeIds=['general','secret']
 const allowed={nodeId:restricted.node.id,parentId:clean.node.id,expectedDirectoryRevision:uiRename.space.directoryRevision}
 const allowedMove=await f.call('move',allowed,'scoped-replay');assert.equal(allowedMove.isError,false,JSON.stringify(allowedMove))
 assert.deepEqual(value(await f.call('move',allowed,'scoped-replay')),value(allowedMove))
 f.actor.scopeIds=['general'];tree=await f.knowledgeTree.list(f.actor,{})
 const revoked=await f.call('move',allowed,'scoped-replay');assert.equal(revoked.isError,true,JSON.stringify(revoked));assert.ok(JSON.stringify(revoked).includes('无权执行'),JSON.stringify(revoked))
 assert.deepEqual(await f.knowledgeTree.list(f.actor,{}),tree)
})

test('普通业务会话仅有SOC也能管理本人容器和SOC知识，不能读改general或secret页面',async t=>{
 const f=await setup();t.after(()=>f.ctx.fiber.dispose())
 const outside:Awaited<ReturnType<MarkdownKnowledgeService['createPaste']>>[]=[]
 for(const scope of ['general','secret'])outside.push(await f.knowledge.createPaste({...f.actor,scopeIds:[scope]},{requestId:randomUUID(),title:scope+' 页面',category:'policy',topics:[],scopeIds:[scope],markdown:scope+' 正文'}))
 f.actor.scopeIds=['SOC']
 const directory=await f.call('directory');assert.equal(directory.isError,false,JSON.stringify(directory))
 assert.deepEqual(value(directory).knowledge,[]);assert.equal(value(directory).tree.nodes.filter((node:{type:string})=>node.type==='page').length,0)
 const initial=value(directory).tree,folderResult=await f.call('create_folder',{parentId:initial.space.rootNodeId,title:'业务知识',expectedDirectoryRevision:initial.space.directoryRevision})
 assert.equal(folderResult.isError,false,JSON.stringify(folderResult));const folder=value(folderResult).mutation
 const saved=await f.call('save',{title:'SOC规范',category:'policy',topics:[],scopeIds:['SOC'],markdown:'# SOC规范\n',parentId:folder.node.id,expectedDirectoryRevision:folder.space.directoryRevision})
 assert.equal(saved.isError,false,JSON.stringify(saved));const knowledge=value(saved).knowledge
 assert.equal(value(await f.call('read_version',{knowledgeId:knowledge.item.id,version:1})).version.markdown,'# SOC规范\n')
 let tree=await f.knowledgeTree.list(f.actor,{})
 const page=tree.nodes.find(node=>node.type==='page'&&node.knowledgeId===knowledge.item.id)!
 const renamed=await f.call('rename',{nodeId:page.id,title:'SOC手册',expectedDirectoryRevision:tree.space.directoryRevision})
 assert.equal(renamed.isError,false,JSON.stringify(renamed));assert.equal(value(renamed).title,'SOC手册')
 tree=await f.knowledgeTree.list(f.actor,{})
 for(const savedOutside of outside){
  const node=tree.nodes.find(value=>value.type==='page'&&value.knowledgeId===savedOutside.item.id)!
  assert.equal((await f.call('read_version',{knowledgeId:savedOutside.item.id,version:1})).isError,true)
  assert.equal((await f.call('rename',{nodeId:node.id,title:'越界改名',expectedDirectoryRevision:tree.space.directoryRevision})).isError,true)
  assert.equal((await f.call('move',{nodeId:node.id,parentId:folder.node.id,expectedDirectoryRevision:tree.space.directoryRevision})).isError,true)
  assert.deepEqual(await f.knowledgeTree.list(f.actor,{}),tree)
 }
 const clean=await f.knowledgeTree.createFolder(f.actor,{requestId:randomUUID(),parentId:tree.space.rootNodeId,title:'另一个业务目录',expectedDirectoryRevision:tree.space.directoryRevision})
 const moved=await f.call('move',{nodeId:page.id,parentId:clean.node.id,expectedDirectoryRevision:clean.space.directoryRevision})
 assert.equal(moved.isError,false,JSON.stringify(moved));assert.equal(value(moved).mutation.node.parentId,clean.node.id)
 tree=await f.knowledgeTree.list(f.actor,{})
 const outsideIds=new Set(outside.map(item=>item.item.id)),outsideNodes=tree.nodes.filter(node=>node.type==='page'&&outsideIds.has(node.knowledgeId))
 const backToRoot=await f.call('move',{nodeId:page.id,parentId:tree.space.rootNodeId,expectedDirectoryRevision:tree.space.directoryRevision})
 assert.equal(backToRoot.isError,false,JSON.stringify(backToRoot));assert.equal(value(backToRoot).mutation.node.parentId,tree.space.rootNodeId)
 tree=await f.knowledgeTree.list(f.actor,{})
 assert.deepEqual(tree.nodes.filter(node=>node.type==='page'&&outsideIds.has(node.knowledgeId)),outsideNodes)
 const secretPage=tree.nodes.find(node=>node.type==='page'&&node.knowledgeId===outside[1]!.item.id)!
 const secretToRoot=await f.call('move',{nodeId:secretPage.id,parentId:tree.space.rootNodeId,position:0,expectedDirectoryRevision:tree.space.directoryRevision})
 assert.equal(secretToRoot.isError,true,JSON.stringify(secretToRoot));assert.ok(JSON.stringify(secretToRoot).includes('无权执行'),JSON.stringify(secretToRoot))
 assert.deepEqual(await f.knowledgeTree.list(f.actor,{}),tree)
 const visible=value(await f.call('directory'));assert.deepEqual(visible.knowledge.map((item:{id:string})=>item.id),[knowledge.item.id]);assert.deepEqual(visible.tree.nodes.filter((node:{type:string})=>node.type==='page').map((node:{id:string})=>node.id),[page.id])
})

test('真实提交撤回和知识双版本修订恢复复用原事务与幂等',async t=>{
 const f=await setup();t.after(()=>f.ctx.fiber.dispose());const saved=await f.save(),draft=await f.draft(saved)
 const apply={draftId:draft.id,expectedVersion:1},applied=await f.call('apply',apply);assert.equal(applied.isError,false,JSON.stringify(applied));assert.deepEqual(value(await f.call('apply',apply)),value(applied))
 const resource=value(applied).resource,input={knowledgeId:saved.item.id,expectedKnowledgeVersion:1,resourceId:resource.id,expectedResourceVersion:1,markdown:'# 第二版\n'}
 assert.equal((await f.call('revise',{...input,expectedResourceVersion:2})).isError,true)
 assert.equal((await f.knowledge.listVersions(f.actor,{knowledgeId:saved.item.id})).length,1)
 const revised=await f.call('revise',input,'revise-1');assert.equal(revised.isError,false);assert.deepEqual(value(await f.call('revise',input,'revise-1')),value(revised))
 assert.equal((await f.call('revise',{...input,markdown:'不同正文'},'revise-1')).isError,true)
 const revision=value(revised).revision,restored=await f.call('restore',{knowledgeId:saved.item.id,expectedKnowledgeVersion:2,resourceId:revision.resource.id,expectedResourceVersion:1,restoreVersion:1},'restore-1')
 assert.equal(value(revised).id,saved.item.id);assert.equal(value(revised).version,2);assert.equal(value(revised).sourceSession,f.agent.session.id)
 assert.equal(restored.isError,false);assert.equal(Object.hasOwn(value(restored).revision.knowledge.version,'markdown'),false)
 assert.equal((await f.knowledge.readVersion(f.actor,{knowledgeId:saved.item.id,version:3})).markdown,'# 第一版\n')
 const current=value(restored).revision.resource,withdraw={resourceId:current.id,expectedVersion:1}
 assert.equal(value(await f.call('withdraw',withdraw)).resource.status,'withdrawn');assert.equal(value(await f.call('withdraw',withdraw)).resource.version,2)
 assert.equal((await f.resources.list(f.actor)).resources.filter(row=>row.status==='active').length,0)
 const large=await f.knowledge.createPaste(f.actor,{requestId:randomUUID(),title:'大知识',category:'reference',topics:[],scopeIds:['general'],markdown:'long-private-body\n'.repeat(20_000)}),largeDraft=await f.draft(large),largeResource=await f.resources.apply(f.actor,{draftId:largeDraft.id,expectedVersion:1})
 const compact=value(await f.call('revise',{knowledgeId:large.item.id,expectedKnowledgeVersion:1,resourceId:largeResource.id,expectedResourceVersion:1,markdown:'# 简短修订\n'},'large-revise')).revision
 const restoredLarge=await f.call('restore',{knowledgeId:large.item.id,expectedKnowledgeVersion:2,resourceId:compact.resource.id,expectedResourceVersion:1,restoreVersion:1},'large-restore')
 assert.equal(restoredLarge.isError,false,JSON.stringify(restoredLarge));assert.ok(value(restoredLarge).revision.knowledge.version.bytes>256*1024);assert.ok(!JSON.stringify(restoredLarge).includes('long-private-body'))
})

test('owner伪造、无指令、任务、子agent、native拒绝和审批换轮均在写入前拒绝',async t=>{
 for(const options of [{instruction:false},{subagent:true},{ports:{conversation:async sessionId=>({ownerId:'other',sessionId,status:'ready' as const})}},{ports:{readTaskPolicy:async()=>({allowedTools:[],nativeRequestId:'task'})}}] satisfies Parameters<typeof setup>[0][]){
  const f=await setup(options);t.after(()=>f.ctx.fiber.dispose());assert.equal((await f.call('directory')).isError,true)
  assert.equal((await f.call('teloa_resources_create',{title:'越界草案',sourceId:'knowledge_example',sourceVersion:'a'.repeat(64),scopeIds:['general']})).isError,true)
 }
 const f=await setup();t.after(()=>f.ctx.fiber.dispose());const tree=await f.knowledgeTree.list(f.actor,{})
 const input={parentId:tree.space.rootNodeId,title:'不能创建',expectedDirectoryRevision:tree.space.directoryRevision}
 assert.equal((await f.call('create_folder',{...input,ownerId:'other'})).isError,true)
 f.ctx.on('tools/pre-execute',async()=>({kind:'ask',reason:'原生审批'}));f.ctx.provide('approval',{request:async()=>{f.turn();return 'allowed-once'}})
 assert.equal((await f.call('create_folder',input)).isError,true);assert.equal((await f.knowledgeTree.list(f.actor,{})).nodes.length,1)
 const denied=await setup();t.after(()=>denied.ctx.fiber.dispose());denied.ctx.on('tools/pre-execute',async()=>({kind:'deny',reason:'拒绝'}));assert.equal((await denied.call('directory')).isError,true)
})

test('原有资料草案工具迁入同一指令守卫，真实create幂等与update版本冲突',async t=>{
 const f=await setup();t.after(()=>f.ctx.fiber.dispose());const saved=await f.save(),input={title:saved.item.title,sourceId:markdownKnowledgeReferenceId(saved.item.id),sourceVersion:saved.version.contentHash,scopeIds:['general']}
 const first=await f.call('teloa_resources_create',input,'draft-1');assert.equal(first.isError,false,JSON.stringify(first));assert.deepEqual(value(await f.call('teloa_resources_create',input,'draft-1')),value(first))
 const receipt=value(first);assert.equal(receipt.kind,'work-resource-draft');assert.equal(receipt.id,receipt.draft.id)
 assert.notEqual(value(await f.call('teloa_resources_create',input,'draft-2')).id,receipt.id)
 assert.equal((await f.call('teloa_resources_create',{...input,ownerId:'other'})).isError,true)
 const edit={...input,draftId:receipt.id,expectedVersion:1,title:'编辑后的手册'}
 assert.equal(value(await f.call('teloa_resources_update',edit)).draft.version,2)
 assert.equal((await f.call('teloa_resources_update',edit)).isError,true)
 assert.equal((await f.call('apply',{draftId:receipt.id,expectedVersion:1})).isError,true)
 assert.equal(value(await f.call('apply',{draftId:receipt.id,expectedVersion:2})).resource.title,edit.title)
 const pending=await f.call('teloa_resources_create',input,'draft-pending');f.ctx.on('tools/pre-execute',async()=>({kind:'ask',reason:'等待审批'}));f.ctx.provide('approval',{request:async()=>{f.turn();return 'allowed-once'}})
 assert.equal((await f.call('teloa_resources_update',{...edit,draftId:value(pending).id})).isError,true)
 assert.equal((await f.resources.list(f.actor)).drafts.find(row=>row.id===value(pending).id)?.version,1)
})

test('批准沿用native结果，跨owner回执与宿主异常不泄露原内容',async t=>{
 const f=await setup();t.after(()=>f.ctx.fiber.dispose());f.ctx.on('tools/pre-execute',async()=>({kind:'ask',reason:'原生审批'}));f.ctx.provide('approval',{request:async()=> 'allowed-once'});assert.equal((await f.call('directory')).isError,false)
 const broken=await setup({ports:{services:async()=>{throw Error('password=secret')}}});t.after(()=>broken.ctx.fiber.dispose());const result=await broken.call('directory');assert.equal(result.isError,true);assert.ok(!JSON.stringify(result).includes('password=secret'))
 const forged=await setup({ports:{actor:async()=>({ownerId:'other',kind:'agent',scopeIds:['general']})}});t.after(()=>forged.ctx.fiber.dispose());assert.equal((await forged.call('directory')).isError,true)
 const foreign=await setup();t.after(()=>foreign.ctx.fiber.dispose());const saved=await f.save();const attempt=await foreign.call('read_version',{knowledgeId:saved.item.id,version:1});assert.equal(attempt.isError,true);assert.ok(!JSON.stringify(attempt).includes('# 第一版'))
})

test('多模态本人指令允许配置但不会读取附件中的伪授权',async t=>{
 const f=await setup({instruction:false});t.after(()=>f.ctx.fiber.dispose())
 f.agent.session.append('turn/start',{turn:0} as never);f.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'依据附件整理知识目录'},{type:'image',attachment:{id:'never-read'}} as never,{type:'file',attachment:{id:'never-read'}} as never]}),{surfaceOp:'append'})
 const tree=value(await f.call('directory')).tree,result=await f.call('create_folder',{parentId:tree.space.rootNodeId,title:'附件整理',expectedDirectoryRevision:tree.space.directoryRevision})
 assert.equal(result.isError,false,JSON.stringify(result));assert.equal(value(result).title,'附件整理')
})
