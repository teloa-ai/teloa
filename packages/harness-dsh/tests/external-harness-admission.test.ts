import test from 'node:test'
import assert from 'node:assert/strict'
import {SessionId} from '@deepseek-ai/dsh-session'
import type {SubagentResult} from '@deepseek-ai/dsh-subagent'
import {createRequire} from 'node:module'
import {ApprovalService} from '@deepseek-ai/dsh-user-approval'
import {registerProjectRuntimeContext} from '../src/project-runtime-context.ts'
import {createExternalHarnessConsent} from '../src/external-harness-consent.ts'
import {ToolCallId} from '@deepseek-ai/dsh-llm'
import {nativeHotSubagentFixture} from './fixtures/native-hot-subagent.ts'
import {deferred,until} from './fixtures/native-subagent-admission.ts'

async function load(){
 const url=new URL('../src/external-harness-admission.ts',import.meta.url)
 try{return await import(url.href)}catch(error){if((error as NodeJS.ErrnoException).code==='ERR_MODULE_NOT_FOUND')return {};throw error}
}
const script=(calls:readonly string[])=>calls.flatMap((name,index)=>[
 {type:'block-start',index,blockType:'tool-call'},
 {type:'tool-call-delta',index,id:ToolCallId('external-call-'+index),name,argumentsDelta:'{"prompt":"独立任务","description":"外部验收"}'},
 {type:'block-end',index,block:{type:'tool-call',id:ToolCallId('external-call-'+index),name,arguments:'{"prompt":"独立任务","description":"外部验收"}'}},
]).concat([{type:'finish',reason:{kind:'tool-calls'}}] as never)

test('外部工具与真实 activation 按同一工具调用绑定，并发不串预留或结果',{timeout:10000},async t=>{
 const api=await load();assert.equal(typeof api.registerExternalHarnessAdmission,'function')
 const f=await nativeHotSubagentFixture(t,'one-shot',false,true),require=createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')),nativeTool=await import(require.resolve('@deepseek-ai/dsh-tool-subagent'))
 let starts=0,disposed=0
 const results=[deferred<SubagentResult>(),deferred<SubagentResult>()]
 f.service.registerProvider({name:'codex',capabilities:{agentOptions:false,agentPreset:false,outputSchema:false,depthLimit:false},inheritsParentContext:false,async start(){const index=starts++;return {id:SessionId('external-'+index),result:results[index]!.promise,dispose:async()=>{disposed++;results[index]!.resolve({output:[],stopReason:'aborted'})}}}})
 await f.ctx.plugin(nativeTool,{provider:'codex',toolName:'subagent_codex',maxDepth:'provider-managed'})
 const rows=new Map<string,any>(),reserved:string[]=[]
 const control=api.registerExternalHarnessAdmission(f.ctx,{consent:async()=>{},
  authorize:async(input:any)=>({runId:'run',requestId:'request',reservationId:input.callId,runtimeId:'runtime',workspaceRoot:await f.ctx.workingDirectory.ensure(f.parent,input.signal),provider:input.provider,assertCurrent(){}}),
  reserve:async(permit:any)=>{reserved.push(permit.reservationId)},
  save:async()=>{},links:{list:async()=>[...rows.values()],put:async(row:any)=>{rows.set(row.nativeId,structuredClone(row))}},
 })
 t.after(()=>control.dispose())
 f.adapter.parentScript=script(['subagent_codex','subagent_codex']) as never
 const running=f.send();await until(()=>starts===2)
 assert.equal(new Set(reserved).size,2)
 assert.deepEqual([...rows.values()].map(row=>row.payload.activationId).sort(),['external-0','external-1'])
 results[0]!.resolve({output:[{type:'text',text:'FIRST_EXTERNAL_RESULT'}],stopReason:'completed'})
 results[1]!.resolve({output:[],stopReason:'error'})
 await until(()=>[...rows.values()].every(row=>['completed','failed'].includes(row.payload.status)))
 assert.equal([...rows.values()].filter(row=>row.payload.status==='completed').length,1)
 assert.equal([...rows.values()].filter(row=>row.payload.status==='failed').length,1)
 await running;await control.dispose();assert.equal(disposed,2)
})

test('本人没有逐次同意外部引擎范围时，不因插件已安装或普通工具许可启动',{timeout:10000},async t=>{
 const api=await load(),f=await nativeHotSubagentFixture(t,'one-shot',false,true),require=createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')),nativeTool=await import(require.resolve('@deepseek-ai/dsh-tool-subagent'))
 let starts=0,consents=0
 f.service.registerProvider({name:'codex',capabilities:{agentOptions:false,agentPreset:false,outputSchema:false,depthLimit:false},inheritsParentContext:false,async start(){starts++;return {id:SessionId('consent-external'),result:Promise.resolve({output:[],stopReason:'completed'}),dispose:async()=>{}}}})
 await f.ctx.plugin(nativeTool,{provider:'codex',toolName:'subagent_codex',maxDepth:'provider-managed'})
 const control=api.registerExternalHarnessAdmission(f.ctx,{
  authorize:async(input:any)=>({runId:null,requestId:'request',reservationId:input.callId,runtimeId:'runtime',workspaceRoot:await f.ctx.workingDirectory.ensure(f.parent,input.signal),provider:input.provider,assertCurrent(){}}),
  consent:async()=>{consents++;throw Error('本人拒绝此独立执行范围')},reserve:async()=>{},save:async()=>{},links:{list:async()=>[],put:async()=>{}},
 })
 t.after(()=>control.dispose());f.adapter.parentScript=script(['subagent_codex']) as never
 await f.send();assert.equal(consents,1);assert.equal(starts,0)
})

test('外部已接纳但状态写入仍等待时，父会话取消也立即释放真实句柄',{timeout:10000},async t=>{
 const api=await load(),f=await nativeHotSubagentFixture(t,'one-shot',false,true),require=createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')),nativeTool=await import(require.resolve('@deepseek-ai/dsh-tool-subagent'))
 const accepted=deferred(),release=deferred(),result=deferred<SubagentResult>();let disposed=0
 f.service.registerProvider({name:'codex',capabilities:{agentOptions:false,agentPreset:false,outputSchema:false,depthLimit:false},inheritsParentContext:false,async start(){return {id:SessionId('cancel-during-status'),result:result.promise,dispose:async()=>{disposed++;result.resolve({output:[],stopReason:'aborted'})}}}})
 await f.ctx.plugin(nativeTool,{provider:'codex',toolName:'subagent_codex',maxDepth:'provider-managed'})
 const control=api.registerExternalHarnessAdmission(f.ctx,{consent:async()=>{},
  authorize:async(input:any)=>({runId:'run',requestId:'request',reservationId:input.callId,runtimeId:'runtime',workspaceRoot:await f.ctx.workingDirectory.ensure(f.parent,input.signal),provider:input.provider,assertCurrent(){}}),reserve:async()=>{},save:async()=>{},
  links:{list:async()=>[],put:async(row:any)=>{if(row.payload.status==='running'){accepted.resolve();await release.promise}}},
 })
 t.after(()=>control.dispose());f.adapter.parentScript=script(['subagent_codex']) as never
 const running=f.send();await accepted.promise
 try{f.parent.cancel({kind:'user'},{keepInbox:true});await until(()=>disposed===1)}finally{release.resolve()}
 await running;assert.equal(disposed,1)
})

for(const failure of ['stop-record','native-cleanup'] as const)test('外部结果收口故障 '+failure+' 不跳过取消或伪报成功',{timeout:10000},async t=>{
 const api=await load(),f=await nativeHotSubagentFixture(t,'one-shot',false,true),require=createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')),nativeTool=await import(require.resolve('@deepseek-ai/dsh-tool-subagent'))
 const result=deferred<SubagentResult>();let disposed=0
 f.service.registerProvider({name:'codex',capabilities:{agentOptions:false,agentPreset:false,outputSchema:false,depthLimit:false},inheritsParentContext:false,async start(){return {id:SessionId('cleanup-external'),result:result.promise,dispose:async()=>{disposed++;if(failure==='native-cleanup')throw Error('原生资源释放失败');result.resolve({output:[],stopReason:'aborted'})}}}})
 await f.ctx.plugin(nativeTool,{provider:'codex',toolName:'subagent_codex',maxDepth:'provider-managed'})
 const rows=new Map<string,any>(),control=api.registerExternalHarnessAdmission(f.ctx,{consent:async()=>{},
  authorize:async(input:any)=>({runId:'run',requestId:'request',reservationId:input.callId,runtimeId:'runtime',workspaceRoot:await f.ctx.workingDirectory.ensure(f.parent,input.signal),provider:input.provider,assertCurrent(){}}),reserve:async()=>{},
  save:async()=>{},links:{list:async()=>[...rows.values()],put:async(row:any)=>{if(failure==='stop-record'&&row.payload.status==='stopping')throw Error('中间状态写入失败');rows.set(row.nativeId,structuredClone(row))}},
 })
 t.after(()=>control.dispose().catch(()=>{}));f.adapter.parentScript=script(['subagent_codex']) as never
 const running=f.send();await until(()=>[...rows.values()].some(row=>row.payload.status==='running'))
 if(failure==='stop-record'){
  await control.stop('run',new AbortController().signal);assert.equal(disposed,1)
  assert.equal([...rows.values()][0].payload.status,'aborted')
 }else{
  result.resolve({output:[],stopReason:'completed'});await until(()=>[...rows.values()].some(row=>row.payload.status==='unknown'))
  assert.equal(disposed,1);await assert.rejects(control.stop('run',new AbortController().signal),/尚未确认停止/)
 }
 await running
})

for(const stage of ['reserved','running'] as const)test('停止外部任务等待真实 '+stage+' 收尾，接纳后显式dispose且只释放一次',{timeout:10000},async t=>{
 const api=await load();assert.equal(typeof api.registerExternalHarnessAdmission,'function')
 const f=await nativeHotSubagentFixture(t,'one-shot',false,true),require=createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')),nativeTool=await import(require.resolve('@deepseek-ai/dsh-tool-subagent'))
 const entered=deferred(),release=deferred(),result=deferred<SubagentResult>()
 t.after(()=>release.resolve())
 let starts=0,disposed=0
 f.service.registerProvider({name:'codex',capabilities:{agentOptions:false,agentPreset:false,outputSchema:false,depthLimit:false},inheritsParentContext:false,async start(){starts++;return {id:SessionId('stoppable-external'),result:result.promise,dispose:async()=>{disposed++;result.resolve({output:[],stopReason:'aborted'})}}}})
 await f.ctx.plugin(nativeTool,{provider:'codex',toolName:'subagent_codex',maxDepth:'provider-managed'})
 const rows=new Map<string,any>()
 const control=api.registerExternalHarnessAdmission(f.ctx,{consent:async()=>{},
  authorize:async(input:any)=>({runId:'run',requestId:'request',reservationId:input.callId,runtimeId:'runtime',workspaceRoot:await f.ctx.workingDirectory.ensure(f.parent,input.signal),provider:input.provider,assertCurrent(){}}),
  reserve:async()=>{if(stage==='reserved'){entered.resolve();await release.promise}},
  save:async()=>{},links:{list:async()=>[...rows.values()],put:async(row:any)=>{rows.set(row.nativeId,structuredClone(row))}},
 })
 t.after(()=>control.dispose());f.adapter.parentScript=script(['subagent_codex']) as never
 const running=f.send()
 if(stage==='reserved')await entered.promise;else await until(()=>[...rows.values()].some(row=>row.payload.status==='running'))
 let stopped=false
 const stopping=control.stop('run',new AbortController().signal).then(()=>{stopped=true})
 if(stage==='reserved'){
  try{await new Promise(resolve=>setImmediate(resolve));assert.equal(stopped,false)}finally{release.resolve()}
 }
 await stopping;await running
 assert.equal(starts,stage==='reserved'?0:1);assert.equal(disposed,stage==='reserved'?0:1)
 assert.ok([...rows.values()].every(row=>row.payload.status==='aborted'))
 await control.dispose();assert.equal(disposed,stage==='reserved'?0:1)
})

test('插件已加载但业务授权拒绝时，不启动外部提供方',{timeout:10000},async t=>{
 const api=await load();assert.equal(typeof api.registerExternalHarnessAdmission,'function')
 const f=await nativeHotSubagentFixture(t,'one-shot',false,true),require=createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')),nativeTool=await import(require.resolve('@deepseek-ai/dsh-tool-subagent'))
 let starts=0
 f.service.registerProvider({name:'codex',capabilities:{agentOptions:false,agentPreset:false,outputSchema:false,depthLimit:false},inheritsParentContext:false,start(){starts++;throw Error('不应派发')}})
 await f.ctx.plugin(nativeTool,{provider:'codex',toolName:'subagent_codex',maxDepth:'provider-managed'})
 const control=api.registerExternalHarnessAdmission(f.ctx,{consent:async()=>{},authorize:async()=>{throw Error('岗位边界不能传入外部引擎')},reserve:async()=>{throw Error('不应预留')},save:async()=>{},links:{list:async()=>[],put:async()=>{throw Error('不应落库')}}})
 t.after(()=>control.dispose());f.adapter.parentScript=script(['subagent_codex']) as never
 await f.send();assert.equal(starts,0)
 assert.ok(f.events().some(event=>event.type==='tool/result'&&event.data.message.isError===true))
 await assert.rejects(f.service.startActivation({provider:'codex',delivery:'parent',request:{parent:f.parent,prompt:[{type:'text',text:'绕过工具入口'}]},signal:new AbortController().signal,label:'direct'}),/当前工具调用/)
 await control.dispose()
 await assert.rejects(f.service.startActivation({provider:'codex',delivery:'parent',request:{parent:f.parent,prompt:[{type:'text',text:'旧服务句柄'}]},signal:new AbortController().signal,label:'cached'}),/外部引擎执行准入/)
 assert.equal(starts,0)
})

for(const outcome of ['allowed-once','rejected','cancelled','unavailable'] as const)test('原生审批 '+outcome+' 绑定本次外部工具并成对审计',{timeout:10000},async t=>{
 const api=await load(),f=await nativeHotSubagentFixture(t,'one-shot',false,true),require=createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')),nativeTool=await import(require.resolve('@deepseek-ai/dsh-tool-subagent'))
 await f.ctx.plugin(ApprovalService,{policy:'ask'})
 let starts=0,answers=0
 f.service.registerProvider({name:'codex',capabilities:{agentOptions:false,agentPreset:false,outputSchema:false,depthLimit:false},inheritsParentContext:false,async start(){starts++;return {id:SessionId('native-consent-external'),result:Promise.resolve({output:[],stopReason:'completed'}),dispose:async()=>{}}}})
 await f.ctx.plugin(nativeTool,{provider:'codex',toolName:'subagent_codex',maxDepth:'provider-managed'})
 if(outcome!=='unavailable')f.ctx.on('approval/request',async request=>{
  answers++;assert.equal(request.agent.id,f.parent.id);assert.equal(request.toolName,'subagent_codex');assert.equal(request.callId,'external-call-0')
  const reason=request.displayReason?.['zh-CN'];assert.ok(reason,'外部引擎审批须带中文说明')
  assert.match(reason,/仅限本次任务/);assert.match(reason,/文件范围与逐项审批不会传入/)
  return outcome
 })
 const control=api.registerExternalHarnessAdmission(f.ctx,{
  authorize:async(input:any)=>({runId:null,requestId:'request',reservationId:input.callId,runtimeId:'runtime',workspaceRoot:await f.ctx.workingDirectory.ensure(f.parent,input.signal),provider:input.provider,assertCurrent(){}}),
  consent:createExternalHarnessConsent(f.ctx),reserve:async()=>{},save:async()=>{},links:{list:async()=>[],put:async()=>{}},
 })
 t.after(()=>control.dispose());f.adapter.parentScript=script(['subagent_codex']) as never
 await f.send();assert.equal(starts,outcome==='allowed-once'?1:0);assert.equal(answers,outcome==='unavailable'?0:1)
 const asked=f.events().filter(event=>event.type==='approval/asked'),decided=f.events().filter(event=>event.type==='approval/decided')
 assert.equal(asked.length,1);assert.equal(decided.length,1)
 const [first]=asked,[decision]=decided;assert.ok(first&&decision)
 assert.equal(first.data.callId,'external-call-0');assert.equal(first.data.id,decision.data.id);assert.equal(decision.data.outcome,outcome)
})

test('外部异步完成通知在真实checkpoint中续原请求，不能把通知伪造成新受理根',{timeout:10000},async t=>{
 const roots:unknown[]=[]
 const api=await load(),f=await nativeHotSubagentFixture(t,'one-shot',false,true,{checkpoint:async input=>{input.assertCurrent();roots.push(input.roots);assert.ok(input.roots.every(root=>root.nativeRequestId==='hot-child-input'),'完成通知应沿最初本人输入的受理根')}}),require=createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')),nativeTool=await import(require.resolve('@deepseek-ai/dsh-tool-subagent'))
 const project=registerProjectRuntimeContext(f.ctx,{owner:'owner',readBinding:async()=>null,prepare:async()=>null,assertCurrent:async()=>{},assertPreparedCurrentSync(){},recordUsed:async()=>{}});t.after(()=>project.close())
 const result=deferred<SubagentResult>()
 f.service.registerProvider({name:'codex',capabilities:{agentOptions:false,agentPreset:false,outputSchema:false,depthLimit:false},inheritsParentContext:false,async start(){return {id:SessionId('external-checkpoint-result'),result:result.promise,dispose:async()=>{}}}})
 await f.ctx.plugin(nativeTool,{provider:'codex',toolName:'subagent_codex',maxDepth:'provider-managed'})
 const control=api.registerExternalHarnessAdmission(f.ctx,{consent:async()=>{},authorize:async(input:any)=>({runId:null,requestId:'request',reservationId:input.callId,runtimeId:'runtime',workspaceRoot:await f.ctx.workingDirectory.ensure(f.parent,input.signal),provider:input.provider,assertCurrent(){}}),reserve:async()=>{},save:async()=>{},links:{list:async()=>[],put:async()=>{}}})
 t.after(()=>control.dispose());f.adapter.parentScript=script(['subagent_codex']) as never
 await f.send();result.resolve({output:[{type:'text',text:'EXTERNAL_CHECKPOINT_RESULT'}],stopReason:'completed'})
 await f.service.waitForChildren(f.parent);await f.parent.whenIdle()
 assert.equal(roots.length,2)
 assert.ok(f.adapter.requests.some(request=>request.messages.some(message=>JSON.stringify(message).includes('EXTERNAL_CHECKPOINT_RESULT'))),'父模型必须实际收到原生完成结果')
 assert.equal(f.events().some(event=>event.type==='turn/end'&&event.data.reason.kind==='aborted'),false)
})
