import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {PostgreSqlContainer} from '@testcontainers/postgresql'
import {Pool} from '../../backend/tests/postgres-test-lifecycle.ts'
import {initializeBusinessSpaces} from '../../backend/src/work/business-spaces.ts'
import {initializeProjects,ProjectService} from '../../backend/src/work/projects.ts'
import {initializeProjectContext,ProjectContextService} from '../../backend/src/work/project-context.ts'
import {initializeProjectRuntime,ProjectRuntimeService} from '../../backend/src/work/project-runtime.ts'
import {registerProjectRuntimeContext} from '../src/project-runtime-context.ts'
import {clearComposerSuggestionCache,readComposerSuggestion,readSuggestionFacts} from '../src/composer-suggestion.ts'
import {nativeHotCausalityFixture,textAnswer,hotGate} from './fixtures/native-hot-causality.ts'
import {WorkError} from '@teloa/contract'
import {Context} from '@deepseek-ai/cordis'

test('输入建议事实只取本人输入，不让运行上下文代替用户问题',()=>{
 const events=[
  {seq:1,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'请核对我给的清单'}]}},
  {seq:2,type:'user/message',data:{source:{kind:'runtime-context',form:'snapshot'},content:[{type:'text',text:'内部资料：仅由宿主提供，不能冒充用户'}]}},
  {seq:3,type:'assistant/message',data:{message:{content:[{type:'text',text:'已核对，请确认交付格式。'}]}}},
 ]
 assert.deepEqual(readSuggestionFacts(events),{question:'请核对我给的清单',answer:'已核对，请确认交付格式。',answerSeq:3})
})

test('输入建议诊断不回显任意会话参数或换行',async()=>{
 const ctx=new Context(),logs:unknown[][]=[]
 try{
  ctx.provide('agents',{get:()=>undefined} as never)
  ctx.logger.info=(...args:unknown[])=>{logs.push(args)}
  const result=await readComposerSuggestion(ctx,{owner:'test-owner',model:async()=>{throw Error('不能调用模型')}},{sessionId:'private synthetic identifier\nINJECTED LOG'})
  assert.deepEqual(result,{text:null});assert.equal(logs.length,1)
  assert.match(String(logs[0]![1]),/^[a-f0-9]{12}$/)
  assert.doesNotMatch(JSON.stringify(logs),/private synthetic|INJECTED LOG/)
 }finally{await ctx.fiber.dispose()}
})

test('真实Loop与PG：建议缓存、上下文撤回与请求取消',{timeout:90000},async t=>{
 console.error('suggestion-runtime container:start')
 const container=await new PostgreSqlContainer('postgres:17-alpine').start(),pool=new Pool({connectionString:container.getConnectionUri()})
 console.error('suggestion-runtime container:ready')
 t.after(async()=>{console.error('suggestion-runtime cleanup:start');await pool.end();await container.stop()})
 await initializeBusinessSpaces(pool);await initializeProjects(pool);await initializeProjectContext(pool);await initializeProjectRuntime(pool)
 console.error('suggestion-runtime schema:ready')
 for(const scenario of ['cache','none','parallel','withdraw','cancel','model-error','terminal-error','partial-error','terminal-aborted','truncated'] as const)await t.test(scenario,async child=>{
  console.error('suggestion-runtime scenario:'+scenario)
  clearComposerSuggestionCache();child.after(clearComposerSuggestionCache)
  const f=await nativeHotCausalityFixture(child),owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()}
  // 服务仅发布真实因果夹具的 input，不替代其准入、派发、会话或模型实现。
  f.ctx.provide('teloaNativeInput',{input:f.work} as never)
  const project=await new ProjectService(pool,identity).create(owner,{requestId:randomUUID(),fields:{scope:'general',title:'建议来源验收',goal:'建议不越过当前可用来源',dueDate:null,state:'planning',links:[],references:[]}})
  const context=new ProjectContextService(pool,identity)
  await context.mutate(owner,{requestId:randomUUID(),projectId:project.id,expectedVersion:0,change:{kind:'save-entry',entryId:null,entryKind:'rule',topic:'交付规则',markdown:'交付前只核对本人给出的清单。'}})
  const entry=(await context.get(owner,{projectId:project.id})).entries[0]!
  const runtime=new ProjectRuntimeService(pool,identity,{inspect:async(_owner,sessionId)=>({sessionId,title:'建议来源验收',scope:'general',submitted:false,running:false,kind:'ordinary'})})
  child.after(()=>runtime.dispose())
  await runtime.bind(owner,{requestId:randomUUID(),sessionId:f.agent.id,projectId:project.id,expectedVersion:0,memoryMode:'off'})
  const native=registerProjectRuntimeContext(f.ctx,{owner,readBinding:id=>runtime.getBinding(owner,id),prepare:input=>runtime.prepare(owner,input),assertCurrent:input=>runtime.assertCurrent(owner,input),assertPreparedCurrentSync:input=>runtime.assertPreparedCurrentSync(owner,input),recordUsed:input=>runtime.recordUsed(owner,input),ackGeneration:input=>runtime.ackGeneration(owner,input)})
  child.after(()=>native.close())
  f.adapter.scripts.push(textAnswer);await f.send('suggestion-'+scenario);await f.agent.whenIdle()
  assert.equal(f.adapter.requests.length,1)
  const diagnostics:unknown[][]=[]
  child.mock.method(f.ctx.logger,'info',(...args:unknown[])=>{diagnostics.push(args)})
  child.mock.method(f.ctx.logger,'warn',(...args:unknown[])=>{diagnostics.push(args)})
  const before=f.events().length,ports={owner,model:async()=>{if(scenario==='model-error')throw new WorkError('teloa/unavailable','private synthetic credential and prompt must not be logged');return {provider:'hot-test',model:'hot-model'}}},read=(signal?:AbortSignal)=>readComposerSuggestion(f.ctx,ports,{sessionId:f.agent.id},signal)
  const terminal=scenario==='terminal-error'||scenario==='partial-error'||scenario==='terminal-aborted'||scenario==='truncated'
  const failedFinish=scenario==='truncated'?{kind:'max-tokens' as const}:{kind:scenario==='terminal-aborted'?'aborted' as const:'error' as const,failure:{code:'TEST_SYNTHETIC',message:'private synthetic provider failure; never log'}}
  f.adapter.scripts.push(terminal?[
   ...(scenario==='partial-error'||scenario==='truncated'?textAnswer.slice(0,-1):[]),
   {type:'finish',reason:failedFinish},
  ]:scenario==='none'?[
   {type:'block-start',index:0,blockType:'text'},
   {type:'text-delta',index:0,text:'NONE'},
   {type:'block-end',index:0,block:{type:'text',text:'NONE'}},
   {type:'finish',reason:{kind:'stop'}},
  ]:textAnswer)
  if(terminal){
   assert.deepEqual(await read(),{text:null},'错误、取消或截断流不能把部分正文作为可采纳建议')
   assert.equal(f.adapter.requests.length,2)
   f.adapter.scripts.push(textAnswer)
   assert.deepEqual(await read(),{text:'done'},'失败不缓存为空建议，下一次本人读取必须可重新计算')
   assert.equal(f.adapter.requests.length,3)
   assert.ok(diagnostics.some(row=>row.includes('failed')&&row.includes('model-result')),'失败终态必须与正常 NONE 区分')
   assert.doesNotMatch(JSON.stringify(diagnostics),/private synthetic provider failure/)
  }else if(scenario==='model-error'){
   assert.deepEqual(await read(),{text:null})
   assert.equal(f.adapter.requests.length,1,'准备失败不派发辅助模型')
   assert.ok(diagnostics.some(row=>row.includes('failed')&&row.includes('model-prepare')&&row.includes('teloa/unavailable')),'模型准备失败须记录脱敏阶段，不能冒充正常 NONE')
   assert.doesNotMatch(JSON.stringify(diagnostics),/private synthetic|credential and prompt/)
  }else if(scenario==='cancel'){
   const gate=hotGate(),abort=new AbortController()
   // 外部 prepare 可能延迟响应取消：旧调用未退出时，新本人读取也不能复用它。
   f.adapter.prepareGate={...gate,wait:()=>gate.wait()}
   try{
    const pending=read(abort.signal);await gate.entered;abort.abort()
    assert.deepEqual(await pending,{text:null},'本人取消请求后不能继续派发或返回建议')
    assert.equal(f.adapter.requests.length,1,'取消在prepare等待中生效，不能启动第二次adapter')
    assert.deepEqual(await read(AbortSignal.timeout(2000)),{text:'done'},'旧取消调用尚未清理也不能阻塞新读取')
    assert.equal(f.adapter.requests.length,2)
   }finally{gate.release()}
  }else if(scenario==='parallel'){
   const gate=hotGate();f.adapter.prepareGate=gate
   const first=read();await gate.entered
   const second=read();gate.release()
   assert.deepEqual(await Promise.all([first,second]),[{text:'done'},{text:'done'}])
   assert.equal(f.adapter.requests.length,2,'同一回复的并发读取只生成一次')
  }else{
   const expected=scenario==='none'?null:'done'
   assert.deepEqual(await read(),{text:expected});assert.equal(f.adapter.requests.length,2)
   if(scenario==='none')assert.ok(diagnostics.some(row=>row.includes('abstained')&&row.includes('result')),'正常 NONE 与调用失败须可区分')
   if(scenario==='withdraw')await context.mutate(owner,{requestId:randomUUID(),projectId:project.id,expectedVersion:1,change:{kind:'withdraw-entry',entryId:entry.id}})
   assert.deepEqual(await read(),{text:scenario==='withdraw'?null:expected},'缓存也必须遵守当前来源有效性，NONE 是可复用的有效结果')
   assert.equal(f.adapter.requests.length,2,'重复读取或来源失效不能另发模型请求')
  }
  assert.equal(f.events().length,before,'辅助建议不追加消息或发起用户任务')
 })
})
