import test from 'node:test'
import assert from 'node:assert/strict'
import {SessionSeq,type UserMessage} from '@deepseek-ai/dsh-session'
import {createUserMessage,ToolCallId,type GenerateOptions} from '@deepseek-ai/dsh-llm'
import {defineTool,type ToolExecution,type ToolExecutionResult} from '@deepseek-ai/dsh-tools'
import {loopWorkFixture,loopText,loopTool,type LoopWorkInput,type LoopWorkRuntime} from './fixtures/native-loop-work-admission.ts'
const options={timeout:10000}

test('原官方Free与补口未require未policy均保持真实Loop模型行为',options,async t=>{
 for(const original of [true,false]){
  const f=await loopWorkFixture(t,original);f.adapter.scripts.push(loopText)
  await f.send();assert.equal(f.adapter.requests.length,1)
  assert.equal(f.events.filter(e=>e.type==='turn/end').at(-1)?.data.reason.kind,'completed')
 }
})
test('required缺provider阻断新工作且零model，真实turn/end收尾仍提交',options,async t=>{
 const f=await loopWorkFixture(t);f.loop.requireWorkAdmission();f.adapter.scripts.push(loopText)
 await f.send();assert.equal(f.adapter.requests.length,0)
 assert.equal(f.events.filter(e=>e.type==='turn/start').length,1)
 assert.equal(f.events.filter(e=>e.type==='turn/end').length,1)
 assert.equal(f.agent.inbox.nextTurn.length,1)
})
test('真实phase描述符固定exact事件/claim/request/Agent且按官方顺序调用',options,async t=>{
 const f=await loopWorkFixture(t),seen:LoopWorkInput[]=[],requests:GenerateOptions[]=[]
 f.ctx.on('llm/stream',async function*(request,next){requests.push(request);yield* next()})
 f.loop.requireWorkAdmission();f.loop.installWorkAdmission(input=>{
  assert.equal(Object.isFrozen(input),true);assert.equal(input.agent,f.agent);assert.equal(Object.isFrozen(input.agent),false)
  if('event' in input)assert.ok(f.events.includes(input.event))
  if(input.kind==='claim'){assert.equal(f.agent.inbox.nextTurn.includes(input.message),false);assert.equal(input.target,'next-turn')}
  if(input.kind==='request')assert.equal(Object.isFrozen(input.options),true)
  seen.push(input)
 })
 f.adapter.scripts.push(loopText);await f.send()
 assert.deepEqual(seen.map(s=>s.kind),['turn-start','claim','step-start','request','step-end','turn-end'])
 const request=seen.find(s=>s.kind==='request');assert.ok(request?.kind==='request');assert.equal(request.options,requests[0])
 assert.equal(f.adapter.requests.length,1)
})
test('公开session/claimed/prestep/request事件与runtime反射均不能调用私有策略',options,async t=>{
 const f=await loopWorkFixture(t),seen:LoopWorkInput[]=[]
 f.loop.installWorkAdmission(input=>{seen.push(input)})
 const message=createUserMessage({source:{kind:'user'},content:[]}),signal=new AbortController().signal
 f.ctx.emit('session/event',f.agent.session,{type:'turn/start',seq:SessionSeq(0),time:1,data:{turn:42}})
 f.ctx.emit('agent/inbox/claimed',{agent:f.agent,message,turn:42})
 await f.ctx.waterfall('agent/pre-step',{agent:f.agent,messages:[],turn:42,step:1,signal},()=>Promise.resolve({kind:'enter' as const,messages:[]}))
 await f.ctx.waterfall('agent/request',{agent:f.agent,turn:42,step:1,signal},()=>Promise.resolve({provider:'loop-test',model:'loop-model'}))
 assert.equal(seen.length,0)
 const holder=Reflect.get(f.loop,'runtime');assert.deepEqual(Object.keys(holder),['ctx'])
 assert.equal(Reflect.get(holder,'invoke'),undefined);assert.equal(Reflect.get(holder,'dispatch'),undefined)
})
test('原与scoped receiver共享唯一私有holder，不能替换或重复安装/非法函数',options,async t=>{
 const f=await loopWorkFixture(t),scoped=f.ctx.extend().agentLoop as LoopWorkRuntime,holder=Reflect.get(f.loop,'runtime')
 for(const receiver of [f.loop,scoped]){
  assert.equal(Reflect.get(receiver,'runtime'),holder)
  assert.equal(Reflect.set(receiver,'runtime',{ctx:f.ctx}),false)
  assert.throws(()=>Object.defineProperty(receiver,'runtime',{value:{ctx:f.ctx}}),TypeError)
 }
 for(const value of [null,false,{},Promise.resolve()])assert.throws(()=>f.loop.installWorkAdmission(value as unknown as (input:LoopWorkInput)=>void))
 scoped.requireWorkAdmission();scoped.installWorkAdmission(()=>{})
 assert.throws(()=>f.loop.installWorkAdmission(()=>{}));f.adapter.scripts.push(loopText);await f.send()
 assert.equal(f.adapter.requests.length,1)
})
for(const kind of ['promise','thenable'])test(`异步${kind}策略拒绝且接住潜在reject，零model`,options,async t=>{
 const f=await loopWorkFixture(t);f.loop.requireWorkAdmission()
 f.loop.installWorkAdmission((()=>kind==='promise'?Promise.reject(Error('async policy')):{then(_resolve:unknown,reject:(error:unknown)=>void){reject(Error('thenable policy'))}}) as unknown as (input:LoopWorkInput)=>void)
 f.adapter.scripts.push(loopText);await f.send();await new Promise<void>(r=>setImmediate(r))
 assert.equal(f.adapter.requests.length,0);assert.equal(f.events.filter(e=>e.type==='turn/end').length,1)
})
test('真实request策略否决保持step/turn结束回执，零model',options,async t=>{
 const f=await loopWorkFixture(t),seen:LoopWorkInput[]=[];f.loop.requireWorkAdmission();f.loop.installWorkAdmission(input=>{seen.push(input);if(input.kind==='request')throw Error('request denied')})
 f.adapter.scripts.push(loopText);await f.send();assert.equal(f.adapter.requests.length,0)
 assert.deepEqual(seen.map(s=>s.kind),['turn-start','claim','step-start','request','step-end','turn-end'])
})
test('真实Loop planned ToolExecutionInput在scheduler.prepare之前登记，否决零工具且结果收尾',options,async t=>{
 const f=await loopWorkFixture(t),seen:LoopWorkInput[]=[];let tools=0,pre=0
 f.ctx.tools.register(defineTool({name:'loop_result',description:'真实工具',parameters:{},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},async execute(){tools++;return 'result'}}))
 f.ctx.on('tools/pre-execute',async(exec,next)=>{pre++;const phase=seen.find(x=>x.kind==='tool-prepare');assert.ok(phase?.kind==='tool-prepare');assert.equal(phase.input.callId,exec.callId);return next()})
 f.loop.requireWorkAdmission();f.loop.installWorkAdmission(input=>{seen.push(input);if(input.kind==='tool-prepare')throw Error('planned input denied')})
 f.adapter.scripts.push(loopTool);await f.send();assert.equal(f.adapter.requests.length,1);assert.equal(pre,0);assert.equal(tools,0)
 assert.equal(f.events.filter(e=>e.type==='tool/call').length,1);assert.equal(f.events.filter(e=>e.type==='tool/result').length,1)
 assert.equal(seen.at(-1)?.kind,'turn-end')
})

for(const mode of ['once','missing','repeat','late','promise-after-publish'])test(`真实context回执后${mode}发布遵守同步单次scope和已写边界`,options,async t=>{
 const f=await loopWorkFixture(t),seen:LoopWorkInput[]=[],context=createUserMessage({source:{kind:'tool',callId:ToolCallId('loop-call')},content:[{type:'text',text:'工具上下文'}]})
 let actualExec:ToolExecution|undefined,actualResult:ToolExecutionResult|undefined,lateFailure=false,late:Promise<void>|undefined
 f.ctx.tools.register(defineTool({name:'loop_result',description:'真实上下文工具',parameters:{},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},async execute(_a,exec){exec.deferContext(context);return 'result'}}))
 f.ctx.on('tools/result',(exec,result)=>{actualExec=exec;actualResult=result})
 f.loop.requireWorkAdmission();f.loop.installWorkAdmission((input=>{
  seen.push(input);if(input.kind!=='context')return
  assert.equal(input.exec,actualExec);assert.equal(input.result,actualResult);assert.equal(input.result.additionalContexts?.[0],input.context)
  assert.equal(f.events.filter(e=>e.type==='tool/result').length,1)
  if(mode==='missing')return
  if(mode==='late'){late=Promise.resolve().then(()=>{assert.throws(input.publish);lateFailure=true});return}
  input.publish()
  if(mode==='repeat')assert.throws(input.publish)
  if(mode==='promise-after-publish')return Promise.reject(Error('late policy failure'))
 }) as (input:LoopWorkInput)=>void)
 f.adapter.scripts.push(loopTool,loopText);await f.send();await late;await new Promise<void>(r=>setImmediate(r))
 const inserts=f.events.filter(e=>e.type==='agent/inbox/spliced'&&e.data.target==='next-step'&&e.data.inserted.some(m=>m.id===context.id))
 assert.equal(inserts.length,mode==='missing'||mode==='late'?0:1)
 assert.equal(seen.filter(x=>x.kind==='context').length,1)
 if(mode==='once'||mode==='repeat')assert.equal(f.adapter.requests.length,2)
 if(mode==='late')assert.equal(lateFailure,true)
 if(mode==='promise-after-publish'){assert.equal(f.adapter.requests.length,1);assert.equal(f.agent.inbox.nextStep[0]?.id,context.id)}
 assert.equal(f.events.filter(e=>e.type==='tool/result').length,1)
 assert.equal(f.events.filter(e=>e.type==='turn/end').length,1)
})
