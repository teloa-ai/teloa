import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {PostgreSqlContainer} from '@testcontainers/postgresql'
import {createUserMessage,LlmAdapter,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {Pool} from '../../backend/tests/postgres-test-lifecycle.ts'
import {initializeBusinessSpaces} from '../../backend/src/work/business-spaces.ts'
import {initializeProjects,ProjectService} from '../../backend/src/work/projects.ts'
import {initializeProjectContext} from '../../backend/src/work/project-context.ts'
import {initializeProjectRuntime,ProjectRuntimeService} from '../../backend/src/work/project-runtime.ts'
import {registerProjectRuntimeContext} from '../src/project-runtime-context.ts'
import {nativeHotCausalityFixture,nativeHotLlmFixture,textAnswer,drain} from './fixtures/native-hot-causality.ts'

test('真实Loop与PG：使用凭据以adapter开始为界，取消不伪造或抹除派发',{timeout:60000},async t=>{
 const container=await new PostgreSqlContainer('postgres:17-alpine').start(),pool=new Pool({connectionString:container.getConnectionUri()})
 t.after(async()=>{await pool.end();await container.stop()})
 await initializeBusinessSpaces(pool);await initializeProjects(pool);await initializeProjectContext(pool);await initializeProjectRuntime(pool)
 for(const scenario of ['first-cancel','later-aux-cancel','adapter-failure'] as const)await t.test(scenario,async child=>{
  const f=await nativeHotCausalityFixture(child),owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()}
  const project=await new ProjectService(pool,identity).create(owner,{requestId:randomUUID(),fields:{scope:'general',title:'派发边界',goal:'保留真实来源',dueDate:null,state:'planning',links:[],references:[]}})
  const runtime=new ProjectRuntimeService(pool,identity,{inspect:async(_owner,sessionId)=>({sessionId,title:'派发边界',scope:'general',submitted:false,running:false,kind:'ordinary'})})
  child.after(()=>runtime.dispose())
  await runtime.bind(owner,{requestId:randomUUID(),sessionId:f.agent.id,projectId:project.id,expectedVersion:0,memoryMode:'off'})
  const abort=new AbortController();let cancelAux=false
  const native=registerProjectRuntimeContext(f.ctx,{owner,readBinding:id=>runtime.getBinding(owner,id),prepare:input=>runtime.prepare(owner,input),assertCurrent:async input=>{if(cancelAux)abort.abort();await runtime.assertCurrent(owner,input)},assertPreparedCurrentSync:input=>runtime.assertPreparedCurrentSync(owner,input),recordUsed:input=>runtime.recordUsed(owner,input),ackGeneration:async input=>{await runtime.ackGeneration(owner,input);if(scenario==='first-cancel')f.agent.cancel({kind:'user'})}})
  child.after(()=>native.close())
  if(scenario!=='adapter-failure')f.adapter.scripts.push(textAnswer)
  const message=await f.send('dispatch-'+scenario);await f.agent.whenIdle()
  const uses=()=>runtime.uses(owner,{projectId:project.id,sessionId:f.agent.id})
  const snapshot=()=>runtime.messageSnapshot(owner,f.agent.id,message.id)
  if(scenario==='first-cancel'){
   assert.equal(f.adapter.requests.length,0)
   assert.equal((await uses()).rows.length,0,'最终闸前取消不能凭预写状态声称已使用')
   assert.equal(await snapshot(),null)
   return
  }
  assert.equal(f.adapter.requests.length,1)
  assert.equal((await uses()).rows.length,1)
  assert.equal((await snapshot())?.projectId,project.id)
  if(scenario==='adapter-failure'){assert.equal(f.adapter.yielded.length,0,'已开始但零delta的失败仍保留使用');return}
  const prepared=native.preparedForSession(f.agent.id);assert.ok(prepared)
  const read=async()=>(await pool.query('select stage,prompt_hash from teloa_project_context_uses where id=$1',[prepared.manifestId])).rows[0]
  const messages=[createUserMessage({source:{kind:'user'},content:[{type:'text',text:'本次辅助请求在最终复核取消'}]})];Object.freeze(messages)
  const before=await read(),options=Object.freeze({provider:'hot-test',model:'hot-model',sessionId:f.agent.id,signal:abort.signal,messages})
  const source={ownerId:owner,sessionId:f.agent.id,messageId:message.id,eventId:'dispatch-boundary'},lease=Object.freeze({assertCurrent(){runtime.assertPreparedCurrentSync(owner,prepared)}})
  await assert.rejects(drain(native.withAuxiliaryContext(prepared,options,()=>f.work.withAuxiliaryModel({source,options,lease},()=>f.ctx.llm.stream(options)),()=>{cancelAux=true})))
  assert.equal(f.adapter.requests.length,1,'辅助请求最终复核取消，没有第二次adapter执行')
  assert.deepEqual(await read(),before,'未开始的辅助请求不能覆盖原派发摘要')
  assert.equal((await uses()).rows.length,1);assert.equal((await snapshot())?.projectId,project.id)
 })
})

test('真实SDK：启动回执写失败取消在途next，关闭一次并抛宿主错误',{timeout:10000},async t=>{
 const f=await nativeHotLlmFixture(t),failure=Error('controlled receipt storage failure')
 let calls=0,closed=0,aborted=false,notified=0;const unhandled:unknown[]=[]
 const observe=(error:unknown)=>unhandled.push(error);process.on('unhandledRejection',observe);t.after(()=>process.off('unhandledRejection',observe))
 class Adapter extends LlmAdapter{
  async resolveModel(provider:string,model:string){return {provider,id:model,name:model,inputModalities:['text'] as const}}
  stream(options:GenerateOptions):AsyncIterable<StreamChunk>{
   return {[Symbol.asyncIterator](){return {next(){calls++;return new Promise<IteratorResult<StreamChunk>>((_resolve,reject)=>{options.signal!.addEventListener('abort',()=>{aborted=true;reject(options.signal!.reason)},{once:true})})},return(){closed++;return Promise.resolve({done:true,value:undefined})}}}}
  }
 }
 f.llm.registerAdapter(['receipt-test'],new Adapter())
 const install=Reflect.get(Object.getPrototypeOf(f.llm) as object,'installStreamProjection') as Function
 Reflect.apply(install,f.llm,[(_original:unknown,resolved:Readonly<GenerateOptions>)=>Object.freeze({...resolved,messages:Object.freeze([...resolved.messages])}),undefined,async()=>{notified++;throw failure}])
 await assert.rejects(drain(f.llm.stream({provider:'receipt-test',model:'receipt-model',messages:[]})),error=>error===failure)
 await new Promise(resolve=>setImmediate(resolve))
 assert.equal(calls,1);assert.equal(notified,1);assert.equal(aborted,true);assert.equal(closed,1);assert.deepEqual(unhandled,[])
})

test('真实SDK：首次next同步/异步失败只记一次启动，构造失败不记',{timeout:10000},async t=>{
 for(const mode of ['sync-next','async-next','construct'] as const)await t.test(mode,async child=>{
  const f=await nativeHotLlmFixture(child);let notified=0,calls=0
  class Adapter extends LlmAdapter{
   async resolveModel(provider:string,model:string){return {provider,id:model,name:model,inputModalities:['text'] as const}}
   stream():AsyncIterable<StreamChunk>{
    if(mode==='construct')throw Error('controlled construction failure')
    return {[Symbol.asyncIterator](){return {next(){calls++;if(mode==='sync-next')throw Error('controlled sync failure');return Promise.reject(Error('controlled async failure'))}}}}
   }
  }
  f.llm.registerAdapter(['receipt-test'],new Adapter())
  const install=Reflect.get(Object.getPrototypeOf(f.llm) as object,'installStreamProjection') as Function
  Reflect.apply(install,f.llm,[(_original:unknown,resolved:Readonly<GenerateOptions>)=>Object.freeze({...resolved,messages:Object.freeze([...resolved.messages])}),undefined,()=>{notified++}])
  const chunks=await drain(f.llm.stream({provider:'receipt-test',model:'receipt-model',messages:[]}))
  assert.equal(chunks.at(-1)?.type,'finish');assert.equal(notified,mode==='construct'?0:1);assert.equal(calls,notified)
 })
})

test('真实SDK：启动回执等待后准入撤回，取消并关闭在途请求一次',{timeout:10000},async t=>{
 const f=await nativeHotLlmFixture(t);let allowed=true,calls=0,closed=0,aborted=false
 class Adapter extends LlmAdapter{
  async resolveModel(provider:string,model:string){return {provider,id:model,name:model,inputModalities:['text'] as const}}
  stream(options:GenerateOptions):AsyncIterable<StreamChunk>{
   return {[Symbol.asyncIterator](){return {next(){calls++;return new Promise<IteratorResult<StreamChunk>>((_resolve,reject)=>{options.signal!.addEventListener('abort',()=>{aborted=true;reject(options.signal!.reason)},{once:true})})},return(){closed++;return Promise.resolve({done:true,value:undefined})}}}}
  }
 }
 f.llm.registerAdapter(['receipt-test'],new Adapter());f.llm.installStreamAdmission(()=>{if(!allowed)throw Error('controlled authorization revoked')})
 const install=Reflect.get(Object.getPrototypeOf(f.llm) as object,'installStreamProjection') as Function
 Reflect.apply(install,f.llm,[(_original:unknown,resolved:Readonly<GenerateOptions>)=>Object.freeze({...resolved,messages:Object.freeze([...resolved.messages])}),undefined,async()=>{await Promise.resolve();allowed=false}])
 const chunks=await drain(f.llm.stream({provider:'receipt-test',model:'receipt-model',messages:[]}))
 assert.equal(chunks.at(-1)?.type,'finish');assert.equal(calls,1);assert.equal(aborted,true);assert.equal(closed,1)
})
