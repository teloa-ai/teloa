import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeRoles} from '../../backend/src/work/roles.ts'
import {initializeTasks,TaskService} from '../../backend/src/work/tasks.ts'
import {initializeTaskTransitions,initializeTaskCompletions,TaskTransitions} from '../../backend/src/work/task-transitions.ts'
import {initializeArtifacts,ArtifactService} from '../../backend/src/work/artifacts.ts'
import {initializeArtifactSnapshots} from '../../backend/src/work/artifact-snapshots.ts'
import {taskArtifactSource} from '../../backend/src/work/artifact-task-source.ts'
import {initializeConversationWork,workRequestChildId} from '../../backend/src/work/conversation-work.ts'
import {initializeBusinessSpaces} from '../../backend/src/work/business-spaces.ts'
import {initializeProjects,ProjectService} from '../../backend/src/work/projects.ts'
import {initializeProjectContext,ProjectContextService,registerProjectMemoryAvailability} from '../../backend/src/work/project-context.ts'
import {initializeProjectRuntime,ProjectRuntimeService} from '../../backend/src/work/project-runtime.ts'
import {createTaskCompletionVerifiers} from '../src/task-completion-verifiers.ts'
import {createProjectMemoryVerifiedAdapter} from '../src/project-memory-verified-adapter.ts'
import {initializeResources} from '../../backend/src/capabilities/schema.ts'
import {ResourceService} from '../../backend/src/capabilities/resources.ts'
import {ReferenceCatalog} from '../../mcp-reference/src/catalog.ts'
import {WorkError} from '@teloa/contract'
import type {TaskRunService} from '@teloa/backend'
const {Pool}=createRequire(new URL('../../backend/package.json',import.meta.url))('pg') as {Pool:new(options:Record<string,unknown>)=>TaskRunService['pool']}
let pool:TaskRunService['pool'],container:StartedPostgreSqlContainer
const identity={id:randomUUID,now:()=>new Date().toISOString()}
before(async()=>{
 container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri(),max:4,statement_timeout:4000})
 await initializeRoles(pool);await initializeTasks(pool);await initializeTaskTransitions(pool);await initializeArtifactSnapshots(pool);await initializeArtifacts(pool);await initializeTaskCompletions(pool);await initializeConversationWork(pool)
 await initializeBusinessSpaces(pool);await initializeProjects(pool);await initializeProjectContext(pool);await initializeProjectRuntime(pool)
 await initializeResources(pool)
})
after(async()=>{await pool?.end();await container?.stop()})

test('正式ResourceService持行锁读取派发资料回执，不被核验事务的只读模式拒绝',async t=>{
 const owner=randomUUID(),sessionId='formal-resource-'+randomUUID(),messageId=randomUUID(),root=await mkdtemp(join(tmpdir(),'teloa-verified-resource-'))
 t.after(()=>rm(root,{recursive:true,force:true}))
 await writeFile(join(root,'evidence.md'),'# 核验资料\n这是本人明确选用的业务资料。')
 const catalog=new ReferenceCatalog(root,[{id:'verified-resource',title:'业务依据',file:'evidence.md'}]),resourceService=new ResourceService(pool,catalog,identity)
 const draft=await resourceService.create({ownerId:owner,kind:'human',scopeIds:['general']},{requestId:randomUUID(),title:'业务依据',sourceId:'verified-resource',sourceVersion:(await catalog.list()).references[0]!.version,scopeIds:['general']})
 const saved=await resourceService.apply({ownerId:owner,kind:'human',scopeIds:['general']},{draftId:draft.id,expectedVersion:draft.version})
 const inspect=async(_owner:string,id:string)=>({sessionId:id,title:'本人业务会话',scope:'general',kind:'ordinary' as const,submitted:false,running:false})
 let concurrentUpdate=false,conflicts=0
 const resource=async(db:Parameters<ResourceService['readForIndexInTransaction']>[0],actor:string,id:string,scopes:string[])=>{
  if(concurrentUpdate){concurrentUpdate=false;conflicts++;await pool.query('update teloa_resources set updated_at=updated_at where owner_id=$1 and id=$2',[actor,id])}
  const {resource,text}=await resourceService.readForIndexInTransaction(db,{ownerId:actor,kind:'human',scopeIds:scopes},id);return {...resource,hash:createHash('sha256').update(text).digest('hex'),markdown:text}
 }
 const runtime=new ProjectRuntimeService(pool,identity,{inspect,resource});t.after(()=>runtime.dispose())
 const project=await new ProjectService(pool,identity).create(owner,{requestId:randomUUID(),fields:{scope:'general',title:'真实回执核验',goal:'核验固定资料使用关系',dueDate:null,state:'planning',links:[],references:[]}})
 await runtime.bind(owner,{requestId:randomUUID(),sessionId,projectId:project.id,expectedVersion:0,memoryMode:'enabled'})
 await runtime.configure(owner,{requestId:randomUUID(),projectId:project.id,expectedVersion:0,automatic:'verified',readPersonal:false,resources:[{resourceId:saved.id,required:true}]})
 const prepared=await runtime.prepare(owner,{sessionId,messageId,query:'请核验选定资料'});assert.ok(prepared)
 await runtime.recordUsed(owner,{manifestId:prepared.manifestId,generation:prepared.binding.generation,promptHash:'a'.repeat(64),stage:'dispatched'})
 const adapter=createProjectMemoryVerifiedAdapter({owner,pool,inspect,resource,runs:async()=>({}) as never}),sourceId='project-resource-use:'+prepared.manifestId+':'+saved.id
 // 清单 SELECT 已建立 repeatable-read 快照，其他连接改写同一资料行会使 FOR SHARE 报 40001。
 concurrentUpdate=true
 const evidence=await adapter.loadVerifiedEvidence(owner,sourceId)
 assert.equal(conflicts,1)
 assert.ok(evidence);assert.equal(evidence.messageId,messageId);assert.equal(evidence.assertion,'项目资料《业务依据》的第 1 版已在该项目的会话中使用。')
 assert.deepEqual(await adapter.verifiedSources(sessionId,messageId),[sourceId])
 const context=new ProjectContextService(pool,identity)
 await context.mutate(owner,{requestId:randomUUID(),projectId:project.id,expectedVersion:0,change:{kind:'save-entry',entryId:null,entryKind:'memory',topic:'已核验的资料使用',markdown:evidence.assertion}})
 // 公开回看会把自己的事务交给原始依据核验，必须兼容正式 ResourceService 的版本行锁。
 const releaseAvailability=registerProjectMemoryAvailability(pool,owner,async(db,actor)=>!!await adapter.loadVerifiedEvidence(actor,sourceId,db));t.after(releaseAvailability)
 const visible=await context.get(owner,{projectId:project.id})
 assert.equal(visible.entries[0]?.markdown,evidence.assertion)
 const recovered:string[]=[]
 await assert.rejects(adapter.recover(new AbortController().signal,async input=>{recovered.push(input.verifiedSourceIds[0]!);throw new WorkError('teloa/dependency-unavailable','受控入队冲突',{retryable:true})}),error=>error instanceof WorkError&&error.details?.retryable===true)
 await adapter.recover(new AbortController().signal,async input=>{recovered.push(input.verifiedSourceIds[0]!)})
 assert.deepEqual(recovered,[sourceId,sourceId],'瞬态入队失败不推进真实回执扫描位置')
 await resourceService.withdraw({ownerId:owner,kind:'human',scopeIds:['general']},{resourceId:saved.id,expectedVersion:saved.version})
 assert.equal(await adapter.loadVerifiedEvidence(owner,sourceId),null)
 const hidden=await context.get(owner,{projectId:project.id});assert.equal(hidden.entries[0]?.state,'withdrawn');assert.equal(hidden.entries[0]?.markdown,null)
})

test('正式资料摘要验证回执回读原父消息与固定成果，资料改版和权限变化使证据失效',async()=>{
 const owner=randomUUID(),parentRequest=randomUUID(),sessionId='original-'+randomUUID(),messageId=randomUUID(),requestId=randomUUID()
 const policy={kind:'verified',verifier:'material-version-summary',verifierVersion:1,authorizationVersion:1} as const
 const tasks=new TaskService(pool,identity),states=new TaskTransitions(pool,identity)
 const initial=await tasks.create(owner,{requestId:workRequestChildId(parentRequest,'task'),fields:{title:'资料核对',goal:'核对固定版本',scope:'general'}})
 // 隔离读取契约夹具给定正式计划策略；本用例不把此夹具当作公开 Task 创建或真实计划执行证据。
 await pool.query('update teloa_tasks set definition=jsonb_set(definition,\'{completionPolicy}\',$3::jsonb) where owner_id=$1 and id=$2',[owner,initial.id,policy])
 const task=await states.change(owner,{taskId:initial.id,requestId:randomUUID(),expectedVersion:1,action:'start'})
 const parent={requestId:parentRequest,sessionId,messageId,messageSeq:3,kind:'task',executor:'general',scope:'general',title:'资料核对',goal:'核对固定版本'}
 await pool.query('insert into teloa_conversation_work_requests(owner_id,request_id,session_id,request_spec,targets,failures,stopped_at,created_at,task_child_request_id) values($1,$2,$3,$4,\'[]\',\'{}\',null,$5,$6)',[owner,parentRequest,sessionId,parent,identity.now(),workRequestChildId(parentRequest,'task')])
 const text='本轮核对的固定资料正文。',hash=createHash('sha256').update(text).digest('hex'),resourceId=randomUUID()
 const fixed={id:resourceId,version:1,title:'验收材料',sourceId:'controlled_source',sourceVersion:hash,text}
 const run={id:randomUUID(),taskId:task.id,state:'ended',evidence:{state:'ended',reason:'completed',endSeq:12},knowledge:[fixed]}
 const artifacts=new ArtifactService(pool,identity,async(actor,source,db)=>({source:await taskArtifactSource(db,actor,source.id,true),sessionIds:[]}))
 const verifier=createTaskCompletionVerifiers({material:async()=>fixed,saveMaterialSummaryArtifact:async(input,delivery)=>({receiptId:delivery.requestId,artifact:await artifacts.createInTransaction(input.db,owner,{requestId:delivery.requestId,source:await taskArtifactSource(input.db,owner,task.id,true),content:delivery.content})})})
 const candidate={runId:run.id,terminalEventSeq:12,receiptIds:[],artifactIds:[]},db=await pool.connect()
 try{
  await db.query('begin')
  const result=await verifier['material-version-summary']({ownerId:owner,task,run,policy,candidate,db} as never)
  assert.equal(result.verified,true);assert.ok(result.artifact)
  await states.changeInTransaction(db,owner,{requestId,taskId:task.id,expectedVersion:task.version,action:'complete',artifact:result.artifact,note:'正式验证交付'},{candidate,policy,receiptIds:result.receiptIds})
  await db.query('commit')
 }catch(error){await db.query('rollback');throw error}finally{db.release()}
 let current={id:resourceId,version:1,hash},scope='general'
 const adapter=createProjectMemoryVerifiedAdapter({owner,pool,runs:async()=>({get:async()=>run,conversationParent:async()=>({sessionId,requestId:parentRequest,executor:'general'})}) as never,inspect:async()=>({sessionId,title:'原消息',scope,kind:'ordinary',submitted:true,running:false}),resource:async()=>current})
 const sourceId='project-completion:'+requestId,evidence=await adapter.loadVerifiedEvidence(owner,sourceId)
 assert.ok(evidence);assert.equal(evidence.sessionId,sessionId);assert.equal(evidence.messageId,messageId);assert.equal(evidence.receiptId,requestId)
 assert.equal(evidence.assertion,'已核对资料《验收材料》的第 1 版，并保存本次资料版本摘要（成果第 1 版）。')
 assert.ok(evidence.text.includes(evidence.assertion));assert.equal(evidence.text.includes(text),false)
 assert.deepEqual(await adapter.verifiedSources(sessionId,messageId),[sourceId])
 assert.deepEqual(await adapter.forRun(run as never),{sessionId,messageId,verifiedSourceIds:[sourceId]})
 current={...current,version:2};assert.equal(await adapter.loadVerifiedEvidence(owner,sourceId),null)
 current={...current,version:1};scope='other';assert.equal(await adapter.loadVerifiedEvidence(owner,sourceId),null)
 await assert.rejects(adapter.loadVerifiedEvidence(randomUUID(),sourceId),{code:'teloa/forbidden'})
 scope='general'
 await assert.rejects(adapter.recover(new AbortController().signal,async()=>{throw Error('temporary downstream failure')}),/temporary downstream failure/)
 let recovered=0;await adapter.recover(new AbortController().signal,async()=>{recovered++});assert.equal(recovered,1)
 await pool.query('update teloa_task_transitions set request_spec=request_spec-\'verifiedCompletion\' where owner_id=$1 and request_id=$2',[owner,requestId])
 assert.equal(await adapter.loadVerifiedEvidence(owner,sourceId),null)
})
test('实际项目派发清单证明本人选用的资料版本，prepared或提炼清单不能伪装使用回执',async()=>{
 const owner=randomUUID(),sessionId='resource-use-'+randomUUID(),messageId=randomUUID(),resourceId=randomUUID(),body='真实选用资料正文',hash=createHash('sha256').update(body).digest('hex')
 let current={id:resourceId,title:'业务资料',version:1,hash,markdown:body,scopeIds:['general']},scope='general'
 const inspect=async(_owner:string,id:string)=>({sessionId:id,title:'本人项目会话',scope,kind:'ordinary' as const,submitted:false,running:false})
 const project=await new ProjectService(pool,identity).create(owner,{requestId:randomUUID(),fields:{scope:'general',title:'真实输入',goal:'验真当前资料版本',dueDate:null,state:'planning',links:[],references:[]}})
 const runtime=new ProjectRuntimeService(pool,identity,{inspect,resource:async()=>current})
 try{
  await runtime.bind(owner,{requestId:randomUUID(),sessionId,projectId:project.id,expectedVersion:0,memoryMode:'enabled'})
  await runtime.configure(owner,{requestId:randomUUID(),projectId:project.id,expectedVersion:0,automatic:'verified',readPersonal:false,resources:[{resourceId,required:true}]})
  const use=await runtime.prepare(owner,{sessionId,messageId,query:'读取本项目资料'});assert.ok(use)
  const adapter=createProjectMemoryVerifiedAdapter({owner,pool,inspect,runs:async()=>({}) as never,resource:async()=>current}),sourceId='project-resource-use:'+use.manifestId+':'+resourceId
  assert.equal(await adapter.loadVerifiedEvidence(owner,sourceId),null)
  await runtime.recordUsed(owner,{manifestId:use.manifestId,generation:use.binding.generation,promptHash:'a'.repeat(64),stage:'dispatched'})
  const evidence=await adapter.loadVerifiedEvidence(owner,sourceId);assert.ok(evidence)
  assert.equal(evidence.messageId,messageId);assert.equal(evidence.assertion,'项目资料《业务资料》的第 1 版已在该项目的会话中使用。');assert.equal(evidence.text.includes(body),false)
  assert.deepEqual(await adapter.verifiedSources(sessionId,messageId),[sourceId])
  const extraction=await runtime.prepare(owner,{sessionId,messageId,query:'提炼',purpose:'extraction',requestId:randomUUID()});assert.ok(extraction)
  await runtime.recordUsed(owner,{manifestId:extraction.manifestId,generation:extraction.binding.generation,promptHash:'b'.repeat(64),stage:'dispatched'})
  assert.equal(await adapter.loadVerifiedEvidence(owner,'project-resource-use:'+extraction.manifestId+':'+resourceId),null)
  current={...current,version:2};assert.equal(await adapter.loadVerifiedEvidence(owner,sourceId),null)
  current={...current,version:1};scope='other';assert.equal(await adapter.loadVerifiedEvidence(owner,sourceId),null)
  await assert.rejects(adapter.loadVerifiedEvidence(randomUUID(),sourceId),{code:'teloa/forbidden'})
 }finally{runtime.dispose()}
})
