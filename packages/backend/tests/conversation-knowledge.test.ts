import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {mkdtemp,rm} from 'node:fs/promises'
import {homedir,tmpdir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeResources} from '../src/capabilities/schema.ts'
import {MarkdownKnowledgeService} from '../src/capabilities/markdown-knowledge.ts'
import {MarkdownKnowledgeCatalog} from '../src/capabilities/markdown-knowledge-catalog.ts'
import {ResourceService,type ResourceActor} from '../src/capabilities/resources.ts'
import {ConversationKnowledgeService} from '../src/work/conversation-knowledge.ts'
import {WorkError} from '@teloa/contract'

let container:StartedPostgreSqlContainer,pool:Pool,root:string
const identity={id:randomUUID,now:()=>new Date().toISOString()}
before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeResources(pool);root=await mkdtemp(join(tmpdir(),'teloa-conversation-knowledge-'))},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop();if(root)await rm(root,{recursive:true,force:true})})
const actor=():ResourceActor=>({ownerId:randomUUID(),kind:'human',scopeIds:['general']})
const command=(requestId=randomUUID(),markdown='# 发布 SOP\n')=>({schema:'teloa.conversation-knowledge-command/v1' as const,requestId,origin:{sessionId:'session-1',messageId:'instruction-1',seq:9,selectionHash:'b'.repeat(64)},subject:{sessionId:'session-1',messageId:'answer-1',seq:8,role:'assistant' as const,at:'2026-09-12T10:00:00.000Z',selectionHash:'a'.repeat(64),markdown},target:{workspaceId:'default' as const,title:'发布 SOP',category:'sop' as const,topics:['发布'],scopeIds:['general'] as ['general']}})
function services(resourceOverride?:Partial<ResourceService>){const knowledge=new MarkdownKnowledgeService(pool,root,'default',identity),resources=new ResourceService(pool,new MarkdownKnowledgeCatalog(knowledge),identity);return {knowledge,resources,service:new ConversationKnowledgeService(pool,knowledge,(resourceOverride?Object.assign(Object.create(resources),resourceOverride):resources) as ResourceService,identity.now)}}

test('同请求并发只创建一个知识版本、一个资源和一个 active 回执',async()=>{
 const user=actor(),{service}=services(),input=command()
 const [first,second]=await Promise.all([service.save(user,input),service.save(user,input)])
 assert.deepEqual(second,first);assert.equal(first.status,'active')
 if(first.status!=='active')throw Error('未保存')
 const counts=await pool.query(`select (select count(*)::int from teloa_conversation_knowledge_operations where owner_id=$1) operations,(select count(*)::int from teloa_knowledge_items where owner_id=$1) knowledge,(select count(*)::int from teloa_resources where owner_id=$1) resources`,[user.ownerId])
 assert.deepEqual(counts.rows[0],{operations:1,knowledge:1,resources:1})
 assert.deepEqual(await service.get(user,{requestId:input.requestId}),first)
 await assert.rejects(service.save(user,{...input,target:{...input.target,category:'policy'}}),{code:'teloa/conflict'})
})

test('资源提交成功后丢失回包，沿用 requestId 恢复既有投影且不重复',async()=>{
 const user=actor(),base=services(),input=command(),apply=base.resources.apply.bind(base.resources);let lose=true
 const uncertain=new ConversationKnowledgeService(pool,base.knowledge,{create:base.resources.create.bind(base.resources),findDraft:base.resources.findDraft.bind(base.resources),getResource:base.resources.getResource.bind(base.resources),apply:async(...args)=>{const result=await apply(...args);if(lose){lose=false;throw new WorkError('teloa/storage-unavailable','提交回包丢失')}return result}},identity.now)
 const pending=await uncertain.save(user,input);assert.equal(pending.status,'needs-recovery');assert.equal(pending.status==='needs-recovery'&&pending.stage,'resource-applying')
 const recovered=await uncertain.save(user,input);assert.equal(recovered.status,'active')
 assert.equal((await pool.query('select count(*)::int count from teloa_resources where owner_id=$1',[user.ownerId])).rows[0].count,1)
 assert.equal((await pool.query('select count(*)::int count from teloa_resource_drafts where owner_id=$1',[user.ownerId])).rows[0].count,1)
})

test('回执与来源目录保留真实范围、资料类型、主题和固定摘要',async()=>{
 const user=actor(),{service,resources}=services(),input=command(),receipt=await service.save(user,input);assert.equal(receipt.status,'active')
 const directory=await resources.sourceDirectory(user)
 const expectedHash=createHash('sha256').update(input.subject.markdown).digest('hex'),knowledgeSource=directory.find(row=>row.version===expectedHash)
 assert.deepEqual(knowledgeSource?.knowledge&&{workspaceId:knowledgeSource.knowledge.workspaceId,category:knowledgeSource.knowledge.category,topics:knowledgeSource.knowledge.topics,scopeIds:knowledgeSource.knowledge.scopeIds},{workspaceId:'default',category:'sop',topics:['发布'],scopeIds:['general']})
})

test('确定失败持久化发生阶段，状态查询不从已有字段猜测',async()=>{
 const user=actor(),base=services(),input=command(),failed=new ConversationKnowledgeService(pool,base.knowledge,{create:async()=>{throw new WorkError('teloa/forbidden','来源范围不允许。')},apply:base.resources.apply.bind(base.resources),findDraft:base.resources.findDraft.bind(base.resources),getResource:base.resources.getResource.bind(base.resources)},identity.now)
 const receipt=await failed.save(user,input)
 assert.deepEqual(receipt.status==='failed'&&{stage:receipt.stage,code:receipt.error.code},{stage:'knowledge-saved',code:'teloa/forbidden'})
 assert.deepEqual(await failed.get(user,{requestId:input.requestId}),receipt)
})

test('并发交错中的迟到失败不能把已成功终态回退为 failed',async()=>{
 const user=actor(),base=services(),input=command(),realCreate=base.resources.create.bind(base.resources)
 let release!:()=>void,entered!:()=>void
 const blocked=new Promise<void>(resolve=>{release=resolve}),atCreate=new Promise<void>(resolve=>{entered=resolve})
 const first=new ConversationKnowledgeService(pool,base.knowledge,{create:async()=>{entered();await blocked;throw new WorkError('teloa/forbidden','迟到失败')},apply:base.resources.apply.bind(base.resources),findDraft:base.resources.findDraft.bind(base.resources),getResource:base.resources.getResource.bind(base.resources)},identity.now)
 const second=new ConversationKnowledgeService(pool,base.knowledge,{create:realCreate,apply:base.resources.apply.bind(base.resources),findDraft:base.resources.findDraft.bind(base.resources),getResource:base.resources.getResource.bind(base.resources)},identity.now)
 const firstSave=first.save(user,input);await atCreate
 const secondReceipt=await second.save(user,input);assert.equal(secondReceipt.status,'active')
 release();const firstReceipt=await firstSave
 assert.deepEqual(firstReceipt,secondReceipt)
 assert.deepEqual(await first.get(user,{requestId:input.requestId}),secondReceipt)
 const stored=(await pool.query('select stage,receipt,error from teloa_conversation_knowledge_operations where owner_id=$1 and request_id=$2',[user.ownerId,input.requestId])).rows[0]
 assert.equal(stored.stage,'active');assert.ok(stored.receipt);assert.equal(stored.error,null)
 await assert.rejects(pool.query("update teloa_conversation_knowledge_operations set error='{\"code\":\"teloa/forbidden\",\"message\":\"late\"}'::jsonb where owner_id=$1 and request_id=$2",[user.ownerId,input.requestId]))
})

test('读取 active 回执重算命令摘要并拒绝阶段列和回执篡改',async()=>{
 const cases=[
  async(ownerId:string,requestId:string)=>pool.query("update teloa_conversation_knowledge_operations set command_spec=jsonb_set(command_spec,'{origin,selectionHash}',to_jsonb($3::text)) where owner_id=$1 and request_id=$2",[ownerId,requestId,'c'.repeat(64)]),
  async(ownerId:string,requestId:string)=>pool.query("update teloa_conversation_knowledge_operations set stage='knowledge-saved',receipt=null where owner_id=$1 and request_id=$2",[ownerId,requestId]),
  async(ownerId:string,requestId:string)=>pool.query("update teloa_conversation_knowledge_operations set receipt=jsonb_set(receipt,'{resource,version}','999'::jsonb) where owner_id=$1 and request_id=$2",[ownerId,requestId]),
 ]
 for(const mutate of cases){
  const user=actor(),{service}=services(),input=command(),receipt=await service.save(user,input);assert.equal(receipt.status,'active')
  await mutate(user.ownerId,input.requestId)
  await assert.rejects(service.get(user,{requestId:input.requestId}),{code:'teloa/storage-corrupt'})
 }
})

test('读取 active 回执核对真实知识固定版本和工作资料对象',async()=>{
 {
  const user=actor(),{service}=services(),input=command(),receipt=await service.save(user,input);if(receipt.status!=='active')throw Error('未保存')
  await pool.query("update teloa_resources set spec=jsonb_set(spec,'{sourceVersion}',to_jsonb($2::text)) where id=$1",[receipt.resource.id,'d'.repeat(64)])
  await assert.rejects(service.get(user,{requestId:input.requestId}),{code:'teloa/storage-corrupt'})
 }
 {
  const user=actor(),{service}=services(),input=command(),receipt=await service.save(user,input);if(receipt.status!=='active')throw Error('未保存')
  await pool.query("update teloa_knowledge_items set workspace_id='other' where id=$1",[receipt.knowledge.id])
  await assert.rejects(service.get(user,{requestId:input.requestId}),{code:'teloa/storage-corrupt'})
 }
})
