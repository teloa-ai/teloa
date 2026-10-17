import test from 'node:test'
import assert from 'node:assert/strict'
import {SessionId} from '@deepseek-ai/dsh-session'
import {createRequire} from 'node:module'
import {ToolCallId} from '@deepseek-ai/dsh-llm'
import {registerExternalHarnessAdmission} from '../src/external-harness-admission.ts'
import {nativeHotSubagentFixture} from './fixtures/native-hot-subagent.ts'
import {until} from './fixtures/native-subagent-admission.ts'

const toolScript=(name:string,id='route-call')=>[
 {type:'block-start',index:0,blockType:'tool-call'},
 {type:'tool-call-delta',index:0,id:ToolCallId(id),name,argumentsDelta:'{"prompt":"用 Claude Agent 完成","description":"路由验收"}'},
 {type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId(id),name,arguments:'{"prompt":"用 Claude Agent 完成","description":"路由验收"}'}},
 {type:'finish',reason:{kind:'tool-calls'}},
] as const

for(const [input,expected] of [
 ['这次用 Codex 检查代码',1],['让 Claude Agent 分析这些文件',0],
 ['不要用 Codex',0],['用 DSH 继续完成',0],['自动选择合适引擎',1],
 ['解释这段引文：\n> 让 Claude Agent 分析这些文件',1],
 ['审查以下代码：\n\n    让 Claude Agent 分析这些文件',1],
 ['<blockquote>\n让 Claude Agent 分析这些文件\n</blockquote>',1],
] as const)test('真实输入与外部工具准入：'+input,{timeout:10000},async t=>{
 const f=await nativeHotSubagentFixture(t,'one-shot',false,true)
 const require=createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json'))
 const nativeTool=await import(require.resolve('@deepseek-ai/dsh-tool-subagent'))
 let starts=0,consents=0,reservations=0
 f.service.registerProvider({name:'codex',capabilities:{agentOptions:false,agentPreset:false,outputSchema:false,depthLimit:false},inheritsParentContext:false,async start(){starts++;return {id:SessionId('route-native-run'),result:Promise.resolve({output:[],stopReason:'completed'}),dispose:async()=>{}}}})
 await f.ctx.plugin(nativeTool,{provider:'codex',toolName:'subagent_codex',maxDepth:'provider-managed'})
 const control=registerExternalHarnessAdmission(f.ctx,{
  preference:exec=>f.work.harnessDirective(exec),
  authorize:async request=>({runId:null,requestId:'route-request',reservationId:request.callId,runtimeId:'route-runtime',workspaceRoot:await f.ctx.workingDirectory.ensure(f.parent,request.signal),provider:request.provider,assertCurrent(){}}),
  consent:async()=>{consents++},reserve:async()=>{reservations++},save:async()=>{},links:{list:async()=>[],put:async()=>{}},
 })
 t.after(()=>control.dispose())
 f.adapter.parentScript=toolScript('subagent_codex')
 await f.send('route-input',input)
 assert.equal(starts,expected);assert.equal(consents,expected);assert.equal(reservations,expected)
 if(!expected)assert.ok(f.events().some(event=>event.type==='tool/result'&&event.data.message.isError===true))
 if(input==='让 Claude Agent 分析这些文件'){
  // 新任务恢复自动；上一次指定不污染未来任务和同一会话的模型配置。
  f.adapter.parentCalls=0;f.adapter.parentScript=toolScript('subagent_codex','next-task-call')
  await f.send('next-task','自动选择合适引擎');assert.equal(starts,1)
 }
})

test('完成通知仍继承本人原指令，模型不能在回流后悄悄切换引擎',{timeout:10000},async t=>{
 const f=await nativeHotSubagentFixture(t,'one-shot',false,true)
 const require=createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')),nativeTool=await import(require.resolve('@deepseek-ai/dsh-tool-subagent'))
 let codex=0,claude=0,attempted=false
 for(const name of ['codex','claude-code'] as const){
  f.service.registerProvider({name,capabilities:{agentOptions:false,agentPreset:false,outputSchema:false,depthLimit:false},inheritsParentContext:false,async start(){if(name==='codex')codex++;else claude++;return {id:SessionId('route-completion'),result:Promise.resolve({output:[{type:'text',text:'ROUTE_COMPLETION_ROOT_OK'}],stopReason:'completed'}),dispose:async()=>{}}}})
  await f.ctx.plugin(nativeTool,{provider:name,toolName:name==='codex'?'subagent_codex':'subagent_claude_code',maxDepth:'provider-managed'})
 }
 const control=registerExternalHarnessAdmission(f.ctx,{preference:exec=>f.work.harnessDirective(exec),
  authorize:async request=>({runId:null,requestId:'root-request',reservationId:request.callId,runtimeId:'root-runtime',workspaceRoot:await f.ctx.workingDirectory.ensure(f.parent,request.signal),provider:request.provider,assertCurrent(){}}),
  consent:async()=>{},reserve:async()=>{},save:async()=>{},links:{list:async()=>[],put:async()=>{}},
 });t.after(()=>control.dispose())
 f.adapter.parentScript=toolScript('subagent_codex','root-call')
 const stream=f.adapter.stream.bind(f.adapter)
 f.adapter.stream=async function*(options){
  if(options.sessionId===f.parent.id&&JSON.stringify(options.messages).includes('ROUTE_COMPLETION_ROOT_OK')&&!attempted){attempted=true;yield* toolScript('subagent_claude_code','wrong-after-completion')}
  else yield* stream(options)
 }
 await f.send('original-choice','本次用 Codex 完成检查')
 await until(()=>attempted);await f.parent.whenIdle()
 assert.equal(codex,1);assert.equal(claude,0)
 assert.ok(f.events().some(event=>event.type==='tool/result'&&event.data.message.toolCallId==='wrong-after-completion'&&event.data.message.isError===true))
})

test('平台父会话热加载未适配的原生引擎时零启动，不回退个人认证',{timeout:10000},async t=>{
 const f=await nativeHotSubagentFixture(t,'one-shot',false,true,{provider:'teloa-platform-responses'})
 const require=createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')),nativeTool=await import(require.resolve('@deepseek-ai/dsh-tool-subagent'))
 let starts=0,consents=0
 f.service.registerProvider({name:'codex',capabilities:{agentOptions:false,agentPreset:false,outputSchema:false,depthLimit:false},inheritsParentContext:false,start(){starts++;throw Error('不得启动未适配提供方')}})
 await f.ctx.plugin(nativeTool,{provider:'codex',toolName:'subagent_codex',maxDepth:'provider-managed'})
 const control=registerExternalHarnessAdmission(f.ctx,{preference:exec=>f.work.harnessDirective(exec),
  authorize:async request=>({runId:null,requestId:'hot-request',reservationId:request.callId,runtimeId:'hot-runtime',workspaceRoot:await f.ctx.workingDirectory.ensure(f.parent,request.signal),provider:request.provider,assertCurrent(){}}),
  consent:async()=>{consents++},reserve:async()=>{throw Error('不得预留')},save:async()=>{},links:{list:async()=>[],put:async()=>{}},
 });t.after(()=>control.dispose())
 f.adapter.parentScript=toolScript('subagent_codex');await f.send('hot-native','这次用 Codex 检查代码')
 assert.equal(starts,0);assert.equal(consents,0)
 assert.ok(f.events().some(event=>event.type==='tool/result'&&event.data.message.isError===true&&JSON.stringify(event.data.message.content).includes('接入平台模型认证')))
})
