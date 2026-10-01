import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {Context} from '@deepseek-ai/cordis'
import {LlmRuntime} from '@deepseek-ai/dsh-llm'
import {SessionStore} from '@deepseek-ai/dsh-session'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {BusinessSpaceService,ConversationService,FileConversationRepository,ProjectService,initializeTeloaDatabase,openResourceDatabase} from '@teloa/backend'
import {createProjectHandler} from '../src/projects.ts'
import {registerResources} from '../src/resources.ts'
let container:StartedPostgreSqlContainer,pool:ProjectService['pool'],directory:string
before(async()=>{container=await new PostgreSqlContainer('postgres:17-alpine').withDatabase('teloa').start();directory=await mkdtemp(join(tmpdir(),'teloa-project-handler-'));const path=join(directory,'database.json');process.env.TELOA_RUNTIME_ROOT=directory;await writeFile(path,JSON.stringify({connectionString:container.getConnectionUri()}),{mode:0o600});pool=(await openResourceDatabase(path,{id:randomUUID,now:()=>new Date().toISOString()})).pool;await initializeTeloaDatabase(pool)},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop();if(directory)await rm(directory,{recursive:true,force:true})})
test('项目端点真实落库，重建 handler 后读取并拒绝伪造本人',async()=>{
 const owner=randomUUID(),get=async()=>new ProjectService(pool,{id:randomUUID,now:()=>new Date().toISOString()}),handle=createProjectHandler(owner,get)
 const fields={scope:'general',title:'Launch',goal:'Ship',dueDate:null,state:'planning',links:[]}
 const project=await handle('projects/create',{requestId:randomUUID(),fields}) as {id:string}
 const detail=await createProjectHandler(owner,get)('projects/get',{projectId:project.id}) as {project:{title:string}}
 assert.equal(detail.project.title,'Launch')
 await assert.rejects(handle('projects/list',{scope:'general',ownerId:'someone'}),{code:'teloa/invalid-input'})
 await assert.rejects(createProjectHandler(randomUUID(),get)('projects/get',{projectId:project.id}),{code:'teloa/not-found'})
 await assert.rejects(handle('projects/delete',{projectId:project.id}),{code:'teloa/not-found'})
})
test('overview 端点真实聚合两业务并分页，未知键拒绝；get 回包含 references 且占位不带标题；fields 七键通过八键拒绝',async()=>{
 const owner=randomUUID(),get=async()=>new ProjectService(pool,{id:randomUUID,now:()=>new Date().toISOString()}),handle=createProjectHandler(owner,get)
 const base={title:'Launch',goal:'Ship',dueDate:null,state:'planning',links:[],references:[]}
 const general=await handle('projects/create',{requestId:randomUUID(),fields:{...base,scope:'general'}}) as {id:string;version:number}
 const soc=await handle('projects/create',{requestId:randomUUID(),fields:{...base,scope:'SOC'}}) as {id:string}
 const first=await handle('projects/overview',{scope:null,state:null,cursor:null,limit:1}) as {rows:Array<{id:string}>;nextCursor:string|null}
 assert.equal(first.rows.length,1);assert.equal(typeof first.nextCursor,'string')
 const second=await handle('projects/overview',{scope:null,state:null,cursor:first.nextCursor,limit:1}) as {rows:Array<{id:string}>;nextCursor:string|null}
 assert.deepEqual([...first.rows,...second.rows].map(row=>row.id).sort(),[general.id,soc.id].sort());assert.equal(second.nextCursor,null)
 await assert.rejects(handle('projects/overview',{scope:null,state:null,cursor:null,limit:1,owner}),{code:'teloa/invalid-input'})
 await assert.rejects(handle('projects/overview',{scope:null,state:null,limit:1}),{code:'teloa/invalid-input'})
 const {pool:db}=await get();const resourceId=randomUUID()
 await db.query("insert into teloa_resources(id,owner_id,revision,status,spec,created_at,updated_at) values($1,$2,1,'active',$3,now(),now())",[resourceId,owner,JSON.stringify({title:'SOC secret runbook',sourceId:'runbook',sourceVersion:'a'.repeat(64),scopeIds:['SOC']})])
 const edited=await handle('projects/edit',{projectId:general.id,expectedVersion:1,fields:{...base,scope:'general',references:[{kind:'resource',id:resourceId,scope:'SOC'}]}}) as {version:number}
 assert.equal(edited.version,2)
 await assert.rejects(handle('projects/edit',{projectId:general.id,expectedVersion:2,fields:{...base,scope:'general',extra:true}}),{code:'teloa/invalid-input'})
 await db.query("update teloa_resources set status='withdrawn' where id=$1",[resourceId])
 const detail=await handle('projects/get',{projectId:general.id}) as {references:Array<Record<string,unknown>>;items:unknown[]}
 assert.deepEqual(Object.keys(detail).sort(),['items','project','references','summary'])
 assert.deepEqual(detail.references,[{kind:'resource',id:resourceId,scope:'SOC',title:null,state:null,version:null,available:false}]);assert.equal(detail.items.length,0)
})
test('真端点 resources/create→apply 的 B 业务资料被 A 业务项目引用，真端点 withdraw 后 projects/get 回占位且不泄露标题',{timeout:60000},async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},ctx=new Context()
 try{
  // registerResources 挂工具与 pre-step 钩子，需要与宿主相同的最小插件栈（照 resources-agent.test 的 mount）。
  for(const plugin of [LlmRuntime,SessionStore,SessionProjectionRegistry,SystemPrompt,ToolRuntime,AgentRegistry])await ctx.plugin(plugin)
  await ctx.plugin(AgentLoop,{agents:[]})
  await new BusinessSpaceService(pool,identity).ensurePersonal(owner)
  const conversations=new ConversationService(new FileConversationRepository(join(directory,'conversations-'+owner+'.json')),{create:async()=>{throw Error('测试不创建会话')},inspect:async()=>{}},identity)
  const resources=registerResources(ctx,directory,owner,conversations,async()=>{throw Error('测试不读原生历史')})
  const sources=await resources.handle('resources/sources',{}) as Array<{id:string;version:string}>
  assert.ok(sources.length>0,'资料来源目录不能为空')
  const draft=await resources.handle('resources/create',{requestId:randomUUID(),title:'SOC 值班手册',sourceId:sources[0]!.id,sourceVersion:sources[0]!.version,scopeIds:['SOC']}) as {id:string;version:number}
  const resource=await resources.handle('resources/apply',{draftId:draft.id,expectedVersion:draft.version}) as {id:string;version:number;status:string}
  assert.equal(resource.status,'active')
  const projects=createProjectHandler(owner,async()=>new ProjectService(pool,identity)),base={title:'Launch',goal:'Ship',dueDate:null,state:'planning',links:[],references:[]}
  const project=await projects('projects/create',{requestId:randomUUID(),fields:{...base,scope:'general',references:[{kind:'resource',id:resource.id,scope:'SOC'}]}}) as {id:string}
  const live=await projects('projects/get',{projectId:project.id}) as {references:Array<Record<string,unknown>>}
  assert.deepEqual(live.references,[{kind:'resource',id:resource.id,scope:'SOC',title:'SOC 值班手册',state:'active',version:resource.version,available:true}])
  const withdrawn=await resources.handle('resources/withdraw',{resourceId:resource.id,expectedVersion:resource.version}) as {status:string}
  assert.equal(withdrawn.status,'withdrawn')
  const after=await projects('projects/get',{projectId:project.id}) as {references:Array<Record<string,unknown>>;items:unknown[]}
  assert.deepEqual(after.references,[{kind:'resource',id:resource.id,scope:'SOC',title:null,state:null,version:null,available:false}]);assert.equal(after.items.length,0)
  await assert.rejects(projects('projects/create',{requestId:randomUUID(),fields:{...base,scope:'general',references:[{kind:'resource',id:resource.id,scope:'SOC'}]}}),{code:'teloa/forbidden'})
 }finally{await ctx.fiber.dispose()}
})
