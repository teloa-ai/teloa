import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Pool} from './postgres-test-lifecycle.ts'
import {PostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeBusinessSpaces} from '../src/work/business-spaces.ts'
import {initializeProjects,ProjectService} from '../src/work/projects.ts'
import {initializeProjectContext,ProjectContextService,registerProjectMemoryAvailability} from '../src/work/project-context.ts'
import {initializeProjectRuntime,ProjectRuntimeService} from '../src/work/project-runtime.ts'
import {initializeProjectPersonalMemory,ProjectPersonalMemoryService} from '../src/work/project-personal-memory.ts'
test('真实PG：普通会话归属、关闭可选记忆、撤回换代和实际发送清单',{timeout:60000},async t=>{
 const container=await new PostgreSqlContainer('postgres:17-alpine').start()
 const pool=new Pool({connectionString:container.getConnectionUri()});t.after(async()=>{await pool.end();await container.stop()})
 await initializeBusinessSpaces(pool);await initializeProjects(pool);await initializeProjectContext(pool);await initializeProjectRuntime(pool)
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},projects=new ProjectService(pool,identity),context=new ProjectContextService(pool,identity)
 const project=await projects.create(owner,{requestId:randomUUID(),fields:{scope:'general',title:'项目运行',goal:'验证自动背景',dueDate:null,state:'planning',links:[],references:[]}})
 let submitted=false,running=false
 const runtime=new ProjectRuntimeService(pool,identity,{inspect:async(actor:string,sessionId:string)=>{assert.equal(actor,owner);return {sessionId,title:'普通会话',scope:'general',submitted,running,kind:'ordinary' as const}},sessions:async()=>[{sessionId:'ordinary-one',title:'普通会话'}]})
 t.after(()=>runtime.dispose())
 await context.mutate(owner,{requestId:randomUUID(),projectId:project.id,expectedVersion:0,change:{kind:'save-entry',entryId:null,entryKind:'rule',topic:'平台',markdown:'只做Mac'}})
 await context.mutate(owner,{requestId:randomUUID(),projectId:project.id,expectedVersion:1,change:{kind:'save-entry',entryId:null,entryKind:'memory',topic:'经验',markdown:'记忆独有内容'}})
 const binding=await runtime.bind(owner,{requestId:randomUUID(),sessionId:'ordinary-one',projectId:project.id,expectedVersion:0,memoryMode:'off'})
 assert.equal(binding.projectId,project.id)
 const prepared=await runtime.prepare(owner,{sessionId:'ordinary-one',messageId:'message-1',query:'经验是什么'})
 assert.ok(prepared);assert.match(prepared.text,/只做Mac/);assert.doesNotMatch(prepared.text,/记忆独有内容/)
 assert.equal((await runtime.uses(owner,{projectId:project.id})).rows.length,0,'预备不等于实际使用')
 await runtime.recordUsed(owner,{manifestId:prepared.manifestId,promptHash:'a'.repeat(64),generation:prepared.binding.generation,stage:'dispatched'})
 assert.equal((await runtime.uses(owner,{projectId:project.id})).rows.length,1)
 submitted=true
 await assert.rejects(runtime.bind(owner,{requestId:randomUUID(),sessionId:'ordinary-one',projectId:project.id,expectedVersion:binding.version,memoryMode:'enabled'}),/新建会话/)
 const source=(await context.get(owner,{projectId:project.id})).entries.find(e=>e.kind==='rule')!
 await context.mutate(owner,{requestId:randomUUID(),projectId:project.id,expectedVersion:2,change:{kind:'withdraw-entry',entryId:source.id}})
 assert.throws(()=>runtime.assertPreparedCurrentSync(owner,prepared))
 await assert.rejects(runtime.assertCurrent(owner,{sessionId:'ordinary-one',projectId:project.id,bindingVersion:binding.version,generation:prepared.binding.generation,contextVersion:prepared.binding.contextVersion,settingsVersion:prepared.binding.settingsVersion}))
 const next=await runtime.prepare(owner,{sessionId:'ordinary-one',messageId:'message-2',query:'继续'})
 assert.ok(next);assert.ok(next.binding.generation>prepared.binding.generation);assert.doesNotMatch(next.text,/只做Mac/);assert.equal(next.reset,true)
 running=true
 await assert.rejects(runtime.bind(owner,{requestId:randomUUID(),sessionId:'ordinary-one',projectId:null,expectedVersion:binding.version,memoryMode:'off'}),/运行/)
 running=false
 await runtime.bind(owner,{requestId:randomUUID(),sessionId:'ordinary-one',projectId:null,expectedVersion:binding.version,memoryMode:'off'})
 await assert.rejects(runtime.prepare(owner,{sessionId:'ordinary-one',messageId:'message-vague',query:'继续'}),/重新说明/)
 const detached=await runtime.prepare(owner,{sessionId:'ordinary-one',messageId:'message-3',query:'请开始新的独立核对任务'})
 assert.ok(detached);assert.equal(detached.binding.projectId,null);assert.equal(detached.reset,true);assert.match(detached.text,/Long-term memory is off/);assert.doesNotMatch(detached.text,/只做Mac/)
 await assert.rejects(runtime.settings('other',{projectId:project.id}))
})
test('真实PG：迟到派生工作冻结原受理项目与模式、必读预算及撤权标题',{timeout:60000},async t=>{
 const container=await new PostgreSqlContainer('postgres:17-alpine').start(),pool=new Pool({connectionString:container.getConnectionUri()});t.after(async()=>{await pool.end();await container.stop()})
 await initializeBusinessSpaces(pool);await initializeProjects(pool);await initializeProjectContext(pool);await initializeProjectRuntime(pool)
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},projects=new ProjectService(pool,identity),fields={scope:'general',title:'冻结甲',goal:'核对必需资料',dueDate:null,state:'planning',links:[],references:[]}
 const a=await projects.create(owner,{requestId:randomUUID(),fields}),b=await projects.create(owner,{requestId:randomUUID(),fields:{...fields,title:'冻结乙'}}),resourceId=randomUUID(),optionalResourceId=randomUUID()
 let readable=true,large=false,optionalReads=0;const resourceCalls:string[]=[]
 const runtime=new ProjectRuntimeService(pool,identity,{maxContextChars:1200,inspect:async(_owner,sessionId)=>({sessionId,title:sessionId,scope:'general',submitted:false,running:false,kind:sessionId.startsWith('child')?'task':'ordinary',...sessionId.startsWith('child')?{parentSessionId:'parent',parentMessageId:sessionId==='child'?'dispatched-root':'null-root',goal:'真实冻结工作目标'}:{}}),optionalMemories:async()=>{optionalReads++;return []},resource:async(_db,actor,id)=>{assert.equal(actor,owner);resourceCalls.push(id);if(!readable)throw Error('source denied');return {id,title:'撤权前资料题目',version:1,hash:'b'.repeat(64),markdown:large?'必要正文'.repeat(1000):'必须核对原版本',scopeIds:['general']}}})
 t.after(()=>runtime.dispose())
 const bind=await runtime.bind(owner,{requestId:randomUUID(),sessionId:'parent',projectId:a.id,expectedVersion:0,memoryMode:'off'})
 await runtime.configure(owner,{requestId:randomUUID(),projectId:a.id,expectedVersion:0,automatic:'verified',readPersonal:false,resources:[{resourceId,required:true},{resourceId:optionalResourceId,required:false}]})
 resourceCalls.length=0
 const root=await runtime.prepare(owner,{sessionId:'parent',messageId:'dispatched-root',query:'核对资料'});assert.ok(root);assert.equal(optionalReads,0);assert.deepEqual(resourceCalls,[resourceId,optionalResourceId],'关闭长期记忆保留本人已选资料的读取')
 await runtime.recordUsed(owner,{manifestId:root.manifestId,generation:root.binding.generation,promptHash:'c'.repeat(64)})
 await runtime.bind(owner,{requestId:randomUUID(),sessionId:'parent',projectId:b.id,expectedVersion:bind.version,memoryMode:'off'})
 const child=await runtime.prepare(owner,{sessionId:'child',messageId:'child-input',query:'执行原冻结工作'});assert.ok(child);assert.equal(child.binding.projectId,a.id);assert.equal(child.binding.memoryMode,'off');assert.match(child.text,/真实冻结工作目标/);assert.equal(optionalReads,0)
 readable=false;const use=(await runtime.uses(owner,{projectId:a.id})).rows[0]!;assert.equal(use.sources.find(s=>s.kind==='resource')!.title,'已失效来源')
 readable=true;large=true;await assert.rejects(runtime.prepare(owner,{sessionId:'child',messageId:'oversized',query:'执行原冻结工作'}),/超过当前输入预算/)
 const before=(await pool.query('select count(*)::int n from teloa_project_context_uses')).rows[0].n
 large=false;await runtime.assertCurrent(owner,{sessionId:'child',projectId:a.id,bindingVersion:child.binding.version,generation:child.binding.generation,contextVersion:child.binding.contextVersion,settingsVersion:child.binding.settingsVersion})
 assert.equal((await pool.query('select count(*)::int n from teloa_project_context_uses')).rows[0].n,before,'检查门禁不制造新使用记录')
 await runtime.bind(owner,{requestId:randomUUID(),sessionId:'parent',projectId:null,expectedVersion:2,memoryMode:'off'})
 const detached=await runtime.prepare(owner,{sessionId:'parent',messageId:'null-root',query:'独立明确工作'});assert.ok(detached);await runtime.recordUsed(owner,{manifestId:detached.manifestId,generation:detached.binding.generation,promptHash:'d'.repeat(64)})
 const nullChild=await runtime.prepare(owner,{sessionId:'child-null',messageId:'null-child',query:'原独立任务'});assert.ok(nullChild);assert.equal(nullChild.binding.projectId,null);assert.equal(nullChild.binding.memoryMode,'off');assert.equal(optionalReads,0,'无项目派生也保留原关闭策略')
 for(const rpcId of ['context-check','project-memory:x']){
  const sessionId=rpcId.startsWith('context')?'reserved-check':'reserved-extract',bound=await runtime.bind(owner,{requestId:randomUUID(),sessionId,projectId:a.id,expectedVersion:0,memoryMode:'off'})
  const input=await runtime.prepare(owner,{sessionId,messageId:'raw-client',query:'原受理任务',requestId:rpcId});assert.ok(input);await runtime.recordUsed(owner,{manifestId:input.manifestId,generation:input.binding.generation,promptHash:'d'.repeat(64)})
  assert.ok(await runtime.messageSnapshot(owner,sessionId,'raw-client'),'客户端保留词不能隐藏原消息')
  await runtime.bind(owner,{requestId:randomUUID(),sessionId,projectId:b.id,expectedVersion:bound.version,memoryMode:'off'})
  await assert.rejects(runtime.prepare(owner,{sessionId,messageId:'raw-client',query:'转投任务',requestId:rpcId}),/原消息/)
 }
})
test('真实PG：来源扫描前自动规则/记忆/分享的视图和输入即时隐藏',{timeout:60000},async t=>{
 const container=await new PostgreSqlContainer('postgres:17-alpine').start(),pool=new Pool({connectionString:container.getConnectionUri()});t.after(async()=>{await pool.end();await container.stop()})
 await initializeBusinessSpaces(pool);await initializeProjects(pool);await initializeProjectContext(pool);await initializeProjectRuntime(pool)
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},projects=new ProjectService(pool,identity),context=new ProjectContextService(pool,identity),fields={scope:'general',title:'即时核验',goal:'验证即时可读性',dueDate:null,state:'planning',links:[],references:[]}
 const source=await projects.create(owner,{requestId:randomUUID(),fields}),target=await projects.create(owner,{requestId:randomUUID(),fields:{...fields,title:'接收方'}})
 let available=true;const check=async()=>available,release=registerProjectMemoryAvailability(pool,owner,check);t.after(release)
 await context.mutate(owner,{requestId:randomUUID(),projectId:source.id,expectedVersion:0,change:{kind:'save-entry',entryId:null,entryKind:'rule',topic:'规则来源',markdown:'来源独有规则'}})
 await context.mutate(owner,{requestId:randomUUID(),projectId:source.id,expectedVersion:1,change:{kind:'save-entry',entryId:null,entryKind:'memory',topic:'记忆来源',markdown:'来源独有记忆'}})
 const memory=(await context.get(owner,{projectId:source.id})).entries.find(e=>e.kind==='memory')!;await context.mutate(owner,{requestId:randomUUID(),projectId:source.id,expectedVersion:2,change:{kind:'share',entryId:memory.id,entryVersion:memory.version,targetProjectId:target.id}})
 const runtime=new ProjectRuntimeService(pool,identity,{inspect:async(_owner,sessionId)=>({sessionId,title:'本人',scope:'general',submitted:false,running:false,kind:'ordinary'}),memoryAvailable:check});t.after(()=>runtime.dispose())
 await runtime.bind(owner,{requestId:randomUUID(),sessionId:'source-check',projectId:source.id,expectedVersion:0,memoryMode:'enabled'});await runtime.bind(owner,{requestId:randomUUID(),sessionId:'share-check',projectId:target.id,expectedVersion:0,memoryMode:'enabled'})
 const before=await runtime.prepare(owner,{sessionId:'source-check',messageId:'before',query:'来源独有记忆'});assert.ok(before);assert.match(before.text,/来源独有规则/)
 available=false
 const view=await context.get(owner,{projectId:source.id});assert.ok(view.entries.every(e=>e.state==='withdrawn'&&e.markdown===null&&e.topic==='已失效来源'))
 const shared=await context.get(owner,{projectId:target.id});assert.equal(shared.shares[0]!.status,'unavailable');assert.equal(shared.shares[0]!.markdown,null)
 const after=await runtime.prepare(owner,{sessionId:'source-check',messageId:'after',query:'来源独有记忆'});assert.ok(after);assert.ok(after.binding.generation>before.binding.generation);assert.doesNotMatch(after.text,/来源独有规则|来源独有记忆/)
 const shareInput=await runtime.prepare(owner,{sessionId:'share-check',messageId:'share-after',query:'来源独有记忆'});assert.ok(shareInput);assert.doesNotMatch(shareInput.text,/来源独有记忆/)
 assert.equal((await pool.query("select count(*)::int n from teloa_project_context_entries where state='active'")).rows[0].n,2,'只读投影不冒充后台实际撤回落账')
})
test('真实PG：个人单向读取、岗位全状态换代、原消息不能转投、辅助请求不改原轮',{timeout:60000},async t=>{
 const container=await new PostgreSqlContainer('postgres:17-alpine').start(),pool=new Pool({connectionString:container.getConnectionUri()})
 t.after(async()=>{await pool.end();await container.stop()})
 await initializeBusinessSpaces(pool);await initializeProjects(pool);await initializeProjectContext(pool);await initializeProjectRuntime(pool);await initializeProjectPersonalMemory(pool)
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},projects=new ProjectService(pool,identity),personal=new ProjectPersonalMemoryService(pool,identity)
 const fields={scope:'general',title:'源状态',goal:'完成测试目标',dueDate:null,state:'planning',links:[],references:[]}
 const project=await projects.create(owner,{requestId:randomUUID(),fields}),other=await projects.create(owner,{requestId:randomUUID(),fields:{...fields,title:'另一项目'}})
 let pending=false,submitted=false,roleVersion=1,roleText='岗位资料新状态',queries:string[]=[]
 const runtime=new ProjectRuntimeService(pool,identity,{inspect:async(_owner,sessionId)=>({sessionId,title:'本人会话',scope:'general',kind:sessionId==='restricted-child'?'subagent':'ordinary',submitted,running:false,pending,...sessionId==='restricted-child'?{parentSessionId:'same-message',parentMessageId:'original'}:{}}),optionalMemories:async(_db,_owner,_actor,query)=>{queries.push(query);return [{kind:'role',id:'role-memory',title:'岗位',version:roleVersion,hash:String(roleVersion).repeat(64),markdown:roleText,scopeIds:['general']}]}})
 t.after(()=>runtime.dispose())
 const binding=await runtime.bind(owner,{requestId:randomUUID(),sessionId:'same-message',projectId:project.id,expectedVersion:0,memoryMode:'enabled'})
 const saved=await personal.save(owner,{requestId:randomUUID(),expectedVersion:0,entryId:null,topic:'表达',markdown:'优先简洁中文'})
 await runtime.configure(owner,{requestId:randomUUID(),projectId:project.id,expectedVersion:0,automatic:'decisions',readPersonal:true,resources:[]})
 const original=await runtime.prepare(owner,{sessionId:'same-message',messageId:'original',query:'表达用中文'})
 assert.ok(original);assert.match(original.text,/优先简洁中文/);assert.ok(original.sources.some(s=>s.kind==='personal'))
 await runtime.recordUsed(owner,{manifestId:original.manifestId,promptHash:'a'.repeat(64),generation:original.binding.generation})
 await runtime.ackGeneration(owner,{sessionId:'same-message',generation:original.binding.generation})
 await runtime.prepare(owner,{sessionId:'same-message',messageId:'original',query:'完全无关',purpose:'extraction',requestId:'aux'})
 assert.deepEqual((await runtime.messageSnapshot(owner,'same-message','original'))!.sources,original.sources,'辅助提炼不能取代本人原轮来源')
 const context=new ProjectContextService(pool,identity)
 await context.mutate(owner,{requestId:randomUUID(),projectId:project.id,expectedVersion:0,change:{kind:'save-entry',entryId:null,entryKind:'memory',topic:'新增信息',markdown:'新增已确认的验收事实'}})
 const additive=await runtime.prepare(owner,{sessionId:'same-message',messageId:'additive',query:'完全无关'});assert.ok(additive);assert.equal(additive.binding.generation,original.binding.generation,'新增记忆保留当前会话连续性');assert.equal(additive.reset,false);assert.ok(additive.sources.some(s=>s.kind==='personal'),'实际来源保留同代历史的依赖')
 const child=await runtime.prepare(owner,{sessionId:'restricted-child',messageId:'limited-work',query:'表达用中文，新增信息和岗位资料'});assert.ok(child);assert.ok(child.sources.every(s=>s.kind!=='personal'&&s.kind!=='memory'&&s.kind!=='role'),'子Agent只取得父轮裁剪包，不自行扩大个人/可选来源')
 await personal.withdraw(owner,{requestId:randomUUID(),expectedVersion:saved.version,entryId:saved.entries[0]!.id})
 assert.throws(()=>runtime.assertPreparedCurrentSync(owner,original))
 const after=await runtime.prepare(owner,{sessionId:'same-message',messageId:'after',query:'表达用中文'});assert.ok(after);assert.ok(after.binding.generation>original.binding.generation);assert.doesNotMatch(after.text,/优先简洁中文/)
 roleVersion++;roleText='完全无关岗位变更'
 const changed=await runtime.prepare(owner,{sessionId:'same-message',messageId:'role-change',query:'无匹配词'});assert.ok(changed);assert.ok(changed.binding.generation>after.binding.generation,'未命中来源也会清洁旧模型代次');assert.ok(queries.every(q=>q===''))
 pending=true;await assert.rejects(runtime.bind(owner,{requestId:randomUUID(),sessionId:'same-message',projectId:other.id,expectedVersion:binding.version,memoryMode:'enabled'}),/受理/)
 pending=false;await runtime.bind(owner,{requestId:randomUUID(),sessionId:'same-message',projectId:other.id,expectedVersion:binding.version,memoryMode:'enabled'})
 await assert.rejects(runtime.prepare(owner,{sessionId:'same-message',messageId:'original',query:'原任务'}),/原消息/)
 submitted=true;await assert.rejects(runtime.bind(owner,{requestId:randomUUID(),sessionId:'first-off',projectId:project.id,expectedVersion:0,memoryMode:'off'}),/新建会话/)
 const cold=new ProjectRuntimeService(pool,identity,runtime.ports);t.after(()=>cold.dispose())
 const current=await cold.prepare(owner,{sessionId:'same-message',messageId:'new-task',query:'请明确开展另一项目任务'});assert.ok(current);assert.equal(current.binding.projectId,other.id)
 assert.equal((await personal.get(owner)).version,2,'项目输入和提炼不写个人真源')
})
