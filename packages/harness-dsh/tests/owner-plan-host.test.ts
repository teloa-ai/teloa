import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import type {Context as HostContext} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {z} from 'zod'
import {readFile} from 'node:fs/promises'
import {realpathSync} from 'node:fs'
import ts from 'typescript'
// @ts-expect-error 复用既有官方 SDK 夹具；mjs 没有声明文件。
import {createRuntime,defineTool,createUserMessage} from '../../../tests/native-auto-review-fixture.mjs'
import {MessageId} from '@deepseek-ai/dsh-llm'
import {WorkError,readModelReference,type OwnerPlanFields,type PlanWorkConfiguration} from '@teloa/contract'
import type {OwnerPlanAuthority,OwnerPlanSource,TaskRun} from '@teloa/backend'
import {createOwnerPlanHost,readOwnerPlanSourceRun} from '../src/owner-plan-host.ts'
import {taskRunToolRules,webToolRules,validateReferenceToolRules} from '../src/role-tool-grants.ts'
import {nativeToolRules} from '../src/native-tool-access.ts'
import {workspaceFileToolRules} from '../src/workspace-file-access.ts'
import {ownerExternalHarnessToolRules,validateOwnerToolRules} from '../src/external-harness-policy.ts'
import type {TaskRunPorts} from '../src/task-run-driver.ts'
type PoolClient=Parameters<OwnerPlanAuthority['verifySource']>[0]

const owner='owner',source={kind:'method-reuse',artifactId:'10000000-0000-4000-8000-000000000001',version:1,basisHash:'a'.repeat(64),acceptedSource:{sessionId:'owner-plan-source',messageId:'accepted-message',messageSeq:3,requestId:'20000000-0000-4000-8000-000000000001'}} satisfies OwnerPlanSource,requestId='30000000-0000-4000-8000-000000000001'
const trigger={kind:'schedule' as const,cadence:'daily' as const,weekday:1,time:'09:00',timezone:'Asia/Singapore' as const},fields:OwnerPlanFields={title:'原方法计划',goal:'核对原资料',scope:'general',roleId:null,executor:{kind:'owner'},dataScope:'只用原资料',delivery:'在本人工作台核对',trigger,notificationPolicy:'attention'},configuration:PlanWorkConfiguration={completion:{kind:'manual'},triggers:[{kind:'schedule',schedule:trigger}],budget:{maxTokens:200000,maxElapsedMs:120000,maxGoalRounds:4,maxConcurrent:1,maxRetries:1,stagnationRounds:2,money:null},overlap:'forbid',missed:'coalesce',safeRecovery:true}

async function fixture(t:TestContext,expectedSource:OwnerPlanSource=source,run?:TaskRun){
 const runtime=await createRuntime(t) as {ctx:HostContext;adapter:{requests:unknown[]};create:(id:string,meta?:{agentPreset:string})=>Promise<Agent>},ctx=runtime.ctx,agent=await runtime.create(source.acceptedSource.sessionId,{agentPreset:'teloa-standard'}),route={provider:'native-auto-review-test',model:'scripted',reasoningEffort:'high'}
 const accepted=agent.session.append('user/message',{...createUserMessage({source:{kind:'user',rpcId:source.acceptedSource.requestId},content:[{type:'text',text:'请将这份成果保存为计划，先保存，不启用。'}]}),id:MessageId(source.acceptedSource.messageId)},{surfaceOp:'append'});assert.equal(accepted.seq,source.acceptedSource.messageSeq)
 const routeSchema=z.object({provider:z.string(),model:z.string(),reasoningEffort:z.string().optional()}).transform(value=>readModelReference(value))
 ctx.sessionProjections.register({key:'modelSelection',stateSchema:z.object({lastUsed:routeSchema.nullable(),pending:routeSchema.nullable()}),stateVersion:1,init:()=>({lastUsed:null,pending:route}),apply:(state,event)=>event.type==='model/selection'?{...state,pending:event.data}:state,wire:{viewSchema:z.object({lastUsed:routeSchema.nullable(),next:routeSchema.nullable()}),view:state=>({lastUsed:state.lastUsed,next:state.pending??state.lastUsed})}})
 ctx.provide('sessionController',{resolveAgent:async()=>({agent}),modelCatalog:async()=>({default:{provider:'wrong-global',model:'never'}})} as never)
 ctx.provide('agentPresets',{resolve:async(id:string)=>({id}),serviceFor:()=>undefined} as never)
 const executions:string[]=[]
 for(const name of ['read','write','edit','get_goal','subagent_codex','subagent_claude_code','web_search','web_fetch'])ctx.tools.register(defineTool({name,description:name,parameters:{},output:{schema:{type:'string'},render:(_args:unknown,result:string)=>[{type:'text' as const,text:result}]},execute:async()=>{executions.push(name);return 'not expected'}}))
 ctx.provide('goals',{} as never)
 let stale=false,verifyCalls=0,context:Record<string,unknown>|undefined={session_id:agent.session.id,scope_id:'general',role_id:null,version:1,locked:true},roleLink=false
 const queries:string[]=[],db={query:async(sql:string)=>{queries.push(sql);if(sql.includes('teloa_conversation_work_contexts'))return {rows:context?[context]:[]};if(sql.includes('teloa_object_conversations'))return {rows:roleLink?[{kind:'role'}]:[]};throw Error('Unexpected database statement')}} as unknown as PoolClient
 const authority=createOwnerPlanHost(ctx,{owner,conversation:async(_actor,id)=>({ownerId:owner,sessionId:id,status:'ready'}),verifySource:async(actualDb,actor,actualSource)=>{assert.equal(actualDb,db);assert.equal(actor,owner);assert.deepEqual(actualSource,expectedSource);verifyCalls++;if(stale)throw new WorkError('teloa/version-conflict','原成果已撤回');return {intent:'save-paused'}},...(run?{sourceRun:async(actualDb:PoolClient,actor:string,value:OwnerPlanSource)=>{assert.equal(actualDb,db);assert.equal(actor,owner);assert.deepEqual(value,expectedSource);return run}}:{})})
 return {...runtime,ctx,agent,authority,db,queries,executions,route,verifyCalls:()=>verifyCalls,setStale:()=>{stale=true},setContext:(next:typeof context)=>{context=next},setRoleLink:()=>{roleLink=true}}
}

test('OwnerPlan 原来源复核使用同一事务，通用本人范围之外不能继承授权',async t=>{
 const f=await fixture(t);const lease=await f.authority.verifySource(f.db,owner,source);lease.assertCurrent();assert.equal(f.verifyCalls(),1)
 assert.ok(f.queries.every(q=>/^select /i.test(q)),'宿主不创建表、另取连接或写来源')
 await assert.rejects(f.authority.verifySource(f.db,'foreign',source),{code:'teloa/forbidden'})
 f.setContext({session_id:f.agent.session.id,scope_id:'SOC',role_id:null,version:2,locked:true});await assert.rejects(f.authority.verifySource(f.db,owner,source),{code:'teloa/forbidden'})
 f.setContext(undefined);f.setRoleLink();await assert.rejects(f.authority.verifySource(f.db,owner,source),{code:'teloa/forbidden'})
 assert.deepEqual(f.adapter.requests,[]);assert.deepEqual(f.executions,[])
})
test('capture 固定原会话真实模型/预设与现有工具规则，不以全局默认或空清单代替',async t=>{
 const f=await fixture(t),result=await f.authority.capture(owner,{requestId,fields,source,configuration,intent:'save-paused'},f.db)
 assert.deepEqual(result.policy.modelPolicy,{primary:f.route});assert.equal(result.policy.agentPresetId,'teloa-standard')
 for(const name of ['read','write','edit','get_goal','web_search','web_fetch','subagent_codex','subagent_claude_code'])assert.ok(result.policy.allowedTools.includes(name),name)
 assert.ok(result.policy.argumentRules?.some(r=>r.name==='write'&&r.workspaceFiles==='default-workspace'));assert.ok(result.policy.argumentRules?.some(r=>r.name==='get_goal'&&r.anyArguments))
 assert.ok(result.policy.argumentRules?.some(r=>r.name==='subagent_claude_code'&&r.externalHarness==='owner-general'&&r.anyArguments===undefined))
 assert.equal(JSON.stringify(result.policy).includes('wrong-global'),false);result.admission.assertCurrent()
 f.agent.session.append('model/selection',{...f.route,model:'changed'});assert.throws(()=>result.admission.assertCurrent(),{code:'teloa/version-conflict'})
 assert.deepEqual(f.adapter.requests,[]);assert.deepEqual(f.executions,[])
})
test('异步模型准备期间换来源模型拒绝，未知模型来源与创造模式不猜默认',async t=>{
 const f=await fixture(t);let release:(()=>void)|undefined,entered:(()=>void)|undefined;const waiting=new Promise<void>(resolve=>{entered=resolve})
 f.ctx.sessionController.modelCatalog=async()=>{entered!();await new Promise<void>(resolve=>{release=resolve});return {default:null,groups:[]} as never}
 const pending=f.authority.capture(owner,{requestId,fields,source,configuration,intent:'save-paused'},f.db);await waiting;f.agent.session.append('model/selection',{...f.route,model:'changed'});release!();await assert.rejects(pending,{code:'teloa/version-conflict'})
 const g=await fixture(t);g.ctx.sessionProjections.stateOf=(()=>undefined) as typeof g.ctx.sessionProjections.stateOf
 await assert.rejects(g.authority.capture(owner,{requestId,fields,source,configuration,intent:'save-paused'},g.db),{code:'teloa/dependency-unavailable'})
 const h=await fixture(t);Object.defineProperty(h.agent.session,'header',{value:{...h.agent.session.header,agentPreset:'cordis'}})
 await assert.rejects(h.authority.capture(owner,{requestId,fields,source,configuration,intent:'save-paused'},h.db),{code:'teloa/forbidden'})
 assert.deepEqual(f.adapter.requests,[]);assert.deepEqual(g.adapter.requests,[]);assert.deepEqual(h.adapter.requests,[])
})
test('撤回/错误本人明确拒绝；确认端口只返回窄 automation 准入不启动计划',async t=>{
 const f=await fixture(t);f.setStale();await assert.rejects(f.authority.verifySource(f.db,owner,source),{code:'teloa/version-conflict'})
 await assert.rejects(f.authority.capture('foreign',{requestId,fields,source,configuration,intent:'save-paused'},f.db),{code:'teloa/forbidden'})
 await assert.rejects(f.authority.capture(owner,{requestId,fields:{...fields,scope:'SOC'} as unknown as OwnerPlanFields,source,configuration,intent:'save-paused'},f.db),{code:'teloa/forbidden'})
 const lease=await f.authority.authorize(owner,{requestId,planId:'40000000-0000-4000-8000-000000000001',expectedVersion:2,expectedConfigVersion:1,operation:'enable',source});lease.assertCurrent()
 assert.deepEqual(f.adapter.requests,[]);assert.deepEqual(f.executions,[])
})

const manualSource={kind:'method-reuse',artifactId:source.artifactId,version:1,basisHash:source.basisHash,taskId:'50000000-0000-4000-8000-000000000001'} satisfies OwnerPlanSource
function completedSource():TaskRun{return {id:'60000000-0000-4000-8000-000000000001',taskId:manualSource.taskId,taskVersion:2,roleId:null,roleVersion:null,executor:{kind:'owner',grantId:requestId,grantVersion:1},linkVersion:1,sessionId:source.acceptedSource.sessionId,nativeRequestId:'70000000-0000-4000-8000-000000000001',state:'ended',evidence:{state:'ended',reason:'completed',turn:0,messageSeq:3,endSeq:8},stopRequestedAt:null,allowedTools:['read'],argumentRules:[{name:'read',allowed:[],workspaceFiles:'default-workspace'}],skills:[],knowledge:[],memory:[],inputText:'原冻结输入',createdAt:'2026-10-17T00:00:00Z',agentPresetId:'teloa-standard',modelPolicy:{primary:{provider:'native-auto-review-test',model:'scripted',reasoningEffort:'high'}}}}
test('人工认可源精确复用 owner Run 原policy，role源不继承私有工具/资料或当前UI模型',async t=>{
 const original=completedSource(),f=await fixture(t,manualSource,original)
 f.agent.session.append('model/selection',{...f.route,model:'unrelated-ui-model'})
 const result=await f.authority.capture(owner,{requestId,fields,source:manualSource,configuration,intent:'save-paused'},f.db)
 assert.deepEqual(result.policy,{allowedTools:original.allowedTools,modelPolicy:original.modelPolicy,argumentRules:original.argumentRules,agentPresetId:original.agentPresetId})
 const {executor:_executor,...roleRun}=original,roleSource:TaskRun={...roleRun,roleId:'80000000-0000-4000-8000-000000000001',roleVersion:7,allowedTools:['private_role_secret'],knowledge:[{id:'private',title:'私有资料',version:1,scope:'SOC',text:'PRIVATE_ROLE_TEXT'} as never]}
 const g=await fixture(t,manualSource,roleSource),role=await g.authority.capture(owner,{requestId,fields,source:manualSource,configuration,intent:'save-paused'},g.db)
 assert.deepEqual(role.policy.modelPolicy,roleSource.modelPolicy);assert.equal(role.policy.allowedTools.includes('private_role_secret'),false);assert.equal(JSON.stringify(role.policy).includes('PRIVATE_ROLE_TEXT'),false)
 assert.ok(role.policy.allowedTools.includes('read'));assert.deepEqual(f.adapter.requests,[]);assert.deepEqual(g.adapter.requests,[])
})
test('人工源缺Run或有歧义不猜latest，producer已登记却丢失不降级其他Run',async()=>{
 let queries:string[]=[]
 const db=(responses:unknown[])=>({query:async(sql:string)=>{queries.push(sql);return {rows:responses.shift()}}}) as unknown as PoolClient
 await assert.rejects(readOwnerPlanSourceRun(db([[{relation:null}],[]]),owner,manualSource),{code:'teloa/dependency-unavailable'})
 queries=[];await assert.rejects(readOwnerPlanSourceRun(db([[{relation:null}],[{},{}]]),owner,manualSource),{code:'teloa/dependency-unavailable'});assert.equal(queries.some(q=>/order by|desc/i.test(q)),false)
 queries=[];await assert.rejects(readOwnerPlanSourceRun(db([[{relation:'producers'}],[{run_id:'fixed'}],[]]),owner,manualSource),{code:'teloa/dependency-unavailable'});assert.equal(queries.filter(q=>q.includes('teloa_task_runs')).length,1);assert.match(queries.at(-1)!,/id=\$2 and task_id=\$3/)
})

test('正式 index 的本人计划准备回调保原 allowlist/rules，不追加CLI或资料；普通本人路径不变',async t=>{
 const text=await readFile(new URL('../src/index.ts',import.meta.url),'utf8'),file=ts.createSourceFile('index.ts',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS)
 let expression:ts.Expression|undefined
 const visit=(node:ts.Node)=>{if(ts.isBinaryExpression(node)&&node.left.getText(file)==='runPorts.prepareOwnerPolicy')expression=node.right;ts.forEachChild(node,visit)};visit(file);assert.ok(expression)
 const f=await fixture(t),original=completedSource();let planned:unknown={allowedTools:original.allowedTools,argumentRules:original.argumentRules,modelPolicy:original.modelPolicy,agentPresetId:original.agentPresetId},materials:unknown[]=[],knowledge:unknown[]=[],knowledgeReads=0
 const values={ctx:f.ctx,owner,brandString:(id:string)=>id,WorkError,taskRunToolRules,nativeToolRules,workspaceFileToolRules,webToolRules,validateReferenceToolRules,ownerExternalHarnessToolRules,validateOwnerToolRules,realpathSync,runService:async()=>({preparationTarget:async()=>({ownerPlanPolicy:planned})}),taskMaterialService:async()=>({list:async()=>materials}),readRunKnowledge:(value:unknown)=>value,readExecutionKnowledge:async()=>{knowledgeReads++;return knowledge}}
 const body=ts.transpileModule('const callback='+expression.getText(file),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText
 const callback=new Function(...Object.keys(values),body+';return callback')(...Object.values(values)) as NonNullable<TaskRunPorts['prepareOwnerPolicy']>
 const target={taskId:manualSource.taskId,taskVersion:2,sessionId:f.agent.session.id,linkVersion:1,scope:'general'},signal=AbortSignal.timeout(5000)
 assert.deepEqual(await callback(f.agent.session.id,'teloa-standard',signal,target),{allowedTools:['read'],argumentRules:original.argumentRules,knowledge:[]});assert.equal(knowledgeReads,0)
 planned={...(planned as object),allowedTools:['unregistered-tool']};await assert.rejects(callback(f.agent.session.id,'teloa-standard',signal,target),{code:'teloa/forbidden'})
 planned={allowedTools:original.allowedTools,argumentRules:original.argumentRules,modelPolicy:original.modelPolicy,agentPresetId:original.agentPresetId};materials=[{resourceId:'added'}];await assert.rejects(callback(f.agent.session.id,'teloa-standard',signal,target),{code:'teloa/forbidden'})
 planned=undefined;materials=[];const ordinary=await callback(f.agent.session.id,'teloa-standard',signal,target);assert.ok(ordinary.allowedTools.includes('subagent_codex'));assert.ok(ordinary.allowedTools.includes('write'));assert.equal(knowledgeReads,1)
 assert.ok(ordinary.argumentRules?.some(rule=>rule.name==='subagent_codex'&&rule.externalHarness==='owner-general'))
 materials=[{available:true,resourceId:'selected-material',resourceVersion:1}];knowledge=[{id:'selected-material',version:1}]
 const restricted=await callback(f.agent.session.id,'teloa-standard',signal,target);assert.equal(restricted.allowedTools.some(name=>name==='subagent_codex'||name==='subagent_claude_code'),false);assert.equal(restricted.argumentRules?.some(rule=>rule.externalHarness!==undefined),false)
 assert.deepEqual(f.adapter.requests,[]);assert.deepEqual(f.executions,[])
})

test('来源核验后异步等待期间原本人消息被替换，最终capture拒绝旧意图',async t=>{
 const f=await fixture(t);let release:(()=>void)|undefined,entered:(()=>void)|undefined;const waiting=new Promise<void>(resolve=>{entered=resolve})
 f.ctx.sessionController.modelCatalog=async()=>{entered!();await new Promise<void>(resolve=>{release=resolve});return {default:null,groups:[]} as never}
 const pending=f.authority.capture(owner,{requestId,fields,source,configuration,intent:'save-paused'},f.db);await waiting
 f.agent.session.append('user/message',createUserMessage({source:{kind:'user',rpcId:source.acceptedSource.requestId},content:[{type:'text',text:'不要保存。'}]}),{surfaceOp:{op:'replace',startSeq:source.acceptedSource.messageSeq,endSeq:source.acceptedSource.messageSeq},sourceEventSeqs:[source.acceptedSource.messageSeq]} as never)
 release!();await assert.rejects(pending,{code:'teloa/version-conflict'});assert.deepEqual(f.adapter.requests,[]);assert.deepEqual(f.executions,[])
})
