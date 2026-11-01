import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {createAssistantMessage,createSystemMessage,createUserMessage,freezeMessage,ToolCallId,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {createHash} from 'node:crypto'
import {Session,SessionId,type SessionMessageProjection} from '@deepseek-ai/dsh-session'
import {patchedHotLlmPackage,HotAdapter,textAnswer,toolAnswer,drain,nativeHotCausalityFixture,hotGate} from './fixtures/native-hot-causality.ts'
import {Context} from '@deepseek-ai/cordis'
import {registerProjectRuntimeContext,type ProjectRuntimePrepared,type ProjectRuntimeContextPorts} from '../src/project-runtime-context.ts'
import {WorkError,encodeEmployeeMention,type DigitalRole} from '@teloa/contract'
import {registerEmployeeMentionContext} from '../src/employee-mention-context.ts'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {TokenMeter} from '@deepseek-ai/dsh-token-meter'
import {patchedNativePackage} from './fixtures/native-patched-package.ts'
import {nativeHotSubagentFixture} from './fixtures/native-hot-subagent.ts'
import {nativeProviderKernel} from './fixtures/native-input-provider.ts'
import {createNativeWorkInput} from '../src/native-work-input.ts'
import {nativeInputIdentity} from '../src/native-input-access.ts'
import {WorkAccess} from '@teloa/backend'
import {tmpdir} from 'node:os'
import {installResidentModelBudget} from '../src/resident-model-budget.ts'
import {defineTool} from '@deepseek-ai/dsh-tools'
import * as workBehavior from '../src/work-behavior.ts'
import {productIdentityText} from '../src/work-prompts/product-identity.ts'

declare module '@deepseek-ai/dsh-session'{interface SessionEventMap{'test/owner-input-projection':{targetSeq:number}}}

function projectPorts(){
 const state={generation:1,retainUserInputFromGeneration:undefined as number|undefined,text:'项目规则：只交付桌面版，保留 {{literal}}。',memoryMode:'enabled' as 'enabled'|'off',calls:0,uses:[] as Parameters<ProjectRuntimeContextPorts['recordUsed']>[0][],prepared:[] as ProjectRuntimePrepared[]}
 const ports:ProjectRuntimeContextPorts={owner:'project-owner',
  async prepare(input){const prepared:ProjectRuntimePrepared={binding:{sessionId:input.sessionId,projectId:'project-one',version:1,title:'项目会话',memoryMode:state.memoryMode,generation:state.generation,contextVersion:state.generation,settingsVersion:state.generation},manifestId:'manifest-'+(++state.calls),text:state.text,sources:[{kind:'rule',id:'rule-one',version:state.generation,hash:'a'.repeat(64),title:'桌面交付规则'}],reset:state.generation>1,providerSessionId:input.sessionId+'-generation-'+state.generation,...state.retainUserInputFromGeneration===undefined?{}:{retainUserInputFromGeneration:state.retainUserInputFromGeneration}};state.prepared.push(prepared);return prepared},
  async assertCurrent(input){if(input.generation!==state.generation)throw new WorkError('teloa/conflict','generation changed')},
  assertPreparedCurrentSync(prepared){if(prepared.binding.generation!==state.generation)throw new WorkError('teloa/conflict','generation changed')},
  async recordUsed(input){state.uses.push(input)},
 }
 return {state,ports}
}
test('冷会话无当前prepared时按持久binding关闭记忆与结果发布，原非项目会话保留经验',async t=>{
 const f=await nativeHotCausalityFixture(t),{ports}=projectPorts()
 let binding:ProjectRuntimePrepared['binding']|null={sessionId:'cold',projectId:null,version:1,memoryMode:'off',generation:1,title:'冷会话',contextVersion:0,settingsVersion:0}
 const runtime=registerProjectRuntimeContext(f.ctx,{...ports,readBinding:async()=>binding})
 t.after(()=>runtime.close())
 assert.equal(await runtime.memoryEnabled('cold'),false)
 assert.equal(await runtime.legacyRoleExperienceEnabled('cold'),false)
 await assert.rejects(runtime.assertResultCurrent('cold'),error=>error instanceof WorkError)
 binding={...binding!,projectId:'project-one',memoryMode:'enabled'}
 assert.equal(await runtime.legacyRoleExperienceEnabled('cold'),false)
 await assert.rejects(runtime.assertResultCurrent('cold'),error=>error instanceof WorkError)
 binding=null
 assert.equal(await runtime.legacyRoleExperienceEnabled('cold'),true)
 await runtime.assertResultCurrent('cold')
})
test('关闭记忆的实际模型工具调用不能进入员工记忆写入体',async t=>{
 const f=await nativeHotCausalityFixture(t),{ports,state}=projectPorts();state.memoryMode='off'
 const runtime=registerProjectRuntimeContext(f.ctx,ports);t.after(()=>runtime.close())
 let written=0
 f.ctx.tools.register(defineTool({name:'teloa_role_memory_propose',description:'实际记忆写入边界',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{written++;return 'saved'}}))
 f.adapter.scripts.push(toolAnswer.map(chunk=>chunk.type==='tool-call-delta'?{...chunk,name:'teloa_role_memory_propose'}:chunk),textAnswer)
 await sendText(f,'不要读写长期记忆','memory-off-write')
 assert.equal(written,0)
})
test('清洁模型输入保留原prompt waterfall最终装配的必要系统规则',async t=>{
 const f=await nativeHotCausalityFixture(t),{ports}=projectPorts()
 f.ctx.on('system-prompt/assemble',async(_assembly,_context,next)=>{const result=await next();return {...result,sections:[...result.sections,{name:'trusted-system-rule',text:'必要系统规则：保留真实工具许可。'}]}},{prepend:true})
 const runtime=registerProjectRuntimeContext(f.ctx,ports);t.after(()=>runtime.close())
 f.adapter.scripts.push(textAnswer)
 await sendText(f,'继续当前项目','final-system-waterfall')
 assert.match(JSON.stringify(f.adapter.requests[0]?.messages),/必要系统规则：保留真实工具许可/)
})
test('关闭记忆只接受固定SDK与宿主的必要上下文，未知记忆provider不能进入真实模型请求',async t=>{
 const f=await nativeHotCausalityFixture(t),{ports,state}=projectPorts();state.memoryMode='off'
 const necessary=['sandbox:policy','approval:policy','subagent:delegation','teloa:work-behavior-runtime','teloa/role-identity','teloa/saved-draft-state']
 for(const name of necessary)f.ctx.systemPrompt.context({name,order:100,text:'必要上下文 '+name})
 await f.ctx.plugin(workBehavior,{productOnly:true})
 f.ctx.systemPrompt.context({name:'future:memory-provider',order:110,text:'未来记忆不能穿透-F713'})
 f.ctx.systemPrompt.context({name:'teloa/role-experience',order:111,text:'旧经验不能穿透-E713'})
 f.ctx.systemPrompt.section({name:'trusted-system-constraint',order:100,text:'必要安全系统规则-S713'})
 const runtime=registerProjectRuntimeContext(f.ctx,ports);t.after(()=>runtime.close())
 const acceptedProductCounts:number[]=[]
 f.ctx.on('system-prompt/assemble',async(_assembly,context,next)=>{const result=await next();if(context.agent===f.agent)acceptedProductCounts.push(result.contexts.filter(row=>row.name==='teloa:product-identity').length);return result},{prepend:true})
 f.adapter.scripts.push(textAnswer,textAnswer)
 await sendText(f,'仅使用必要项目资料','off-context-admission')
 await sendText(f,'继续当前项目，不打开记忆','off-context-next')
 assert.equal(f.adapter.requests.length,2)
 assert.ok(acceptedProductCounts.length>=2)
 assert.ok(acceptedProductCounts.every(count=>count===1),'原生刷新前的项目最终装配也显式保留唯一产品规则')
 for(const input of f.adapter.requests){
  const request=input.messages.flatMap(message=>message.content.flatMap(part=>part.type==='text'?[part.text]:[])).join('\n')
  for(const name of necessary)assert.match(request,new RegExp('必要上下文 '+name))
  assert.equal(request.split(productIdentityText).length-1,1,'关闭记忆的真实模型请求仍仅包含一份宿主产品与用量规则')
  assert.match(request,/必要安全系统规则-S713/)
  assert.match(request,/项目规则：只交付桌面版/)
  assert.doesNotMatch(request,/未来记忆不能穿透-F713|旧经验不能穿透-E713/)
 }
})
test('同项目同代次的正式fork子Agent清除父模型旧历史，不借父marker跳过最小输入重建',async t=>{
 const f=await nativeHotSubagentFixture(t,'continuable'),{ports}=projectPorts()
 const runtime=registerProjectRuntimeContext(f.ctx,{...ports,prepare:async input=>{const prepared=await ports.prepare(input);return {...prepared!,retainUserInputFromGeneration:1,text:input.sessionId===f.parent.id?'父项目背景':'子任务获准的项目背景'}}})
 t.after(()=>runtime.close());f.adapter.parentId=f.parent.id+'-generation-1';f.adapter.parentCalls=1
 const old=createUserMessage({source:{kind:'user',rpcId:'old-owner-history'},content:[{type:'text',text:'此前个人历史：private-parent-history'}]})
 await f.work.withNewInput(f.parent,old,{producer:'prompt',identity:'old-owner-history'},()=>f.parent.followup(old));await f.parent.whenIdle()
 f.adapter.parentCalls=0;await f.send('fresh-child-delegation')
 const child=f.candidates.find(candidate=>candidate.kind==='initial')?.agent;assert.ok(child)
 const request=f.adapter.requests.find(request=>request.sessionId===child.id+'-generation-1');assert.ok(request)
 assert.match(JSON.stringify(request.messages),/子任务获准的项目背景/)
 assert.doesNotMatch(JSON.stringify(request.messages),/private-parent-history/)
 assert.ok(f.parent.session.snapshotEvents().some(event=>event.type==='user/message'&&JSON.stringify(event.data).includes('private-parent-history')))
})
async function sendText(f:Awaited<ReturnType<typeof nativeHotCausalityFixture>>,text:string,id:string,agent:Agent=f.agent){
 const message=createUserMessage({source:{kind:'user',rpcId:id},content:[{type:'text',text}]})
 await f.work.withNewInput(agent,message,{producer:'prompt',identity:id},()=>agent.followup(message))
 await agent.whenIdle();return message
}
async function compactionFixture(t:TestContext,config:{contextWindow?:number;thresholdRatio?:number}={}){
 const pkg=await patchedNativePackage<typeof import('@deepseek-ai/dsh-compaction-basic')>(t,{packageName:'@deepseek-ai/dsh-compaction-basic',compatBasename:'dsh-compaction-basic-0.2.1-rc.2-summary-request'})
 const basic=pathToFileURL(join(pkg.root,'lib/index.js')).href
 const copy=async(relative:string,name:string,replacements:Record<string,string>={})=>{
  const origin=new URL(relative,import.meta.url),require=createRequire(origin)
  const source=(await readFile(origin,'utf8')).replace(/from (['"])([^'"]+)\1/g,(original,_quote,specifier:string)=>{
   if(specifier.startsWith('node:'))return original
   const target=replacements[specifier]??(specifier.startsWith('.')?new URL(specifier,origin).href:pathToFileURL(require.resolve(specifier)).href)
   return 'from '+JSON.stringify(target)
  })
  const file=join(pkg.root,name);await writeFile(file,source);return pathToFileURL(file).href
 }
 const causality=await copy('../src/native-work-causality.ts','project-native-work-causality.ts',{'@deepseek-ai/dsh-compaction-basic':basic})
 const input=await copy('../src/native-work-input.ts','project-native-work-input.ts',{'./native-work-causality.ts':causality})
 const kernel=await copy('./fixtures/native-hot-causality.ts','project-native-hot-causality.ts',{'../../src/native-work-input.ts':input})
 const module=await import(kernel) as {nativeHotCausalityFixture:typeof nativeHotCausalityFixture}
 const f=await module.nativeHotCausalityFixture(t)
 await f.ctx.plugin(TokenMeter)
 f.adapter.resolveModel=async(provider,model)=>({provider,id:model,name:model,inputModalities:['text'] as const,context:{contextWindow:config.contextWindow??2400},defaultMaxTokens:256})
 await f.agent.ctx.plugin(pkg.namespace.BasicCompactionEngine,{headroomTokens:128,maxTokens:256,retainTokens:0,compactionRetries:0,maxOverflowRetries:1,...config.thresholdRatio===undefined?{}:{thresholdRatio:config.thresholdRatio}})
 return f
}

test('受审最终投影保留prepared模型路由，冻结原请求与历史，provider仅收到新代次',async t=>{
 const pkg=await patchedHotLlmPackage(t),ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(pkg.LlmRuntime)
 const llm=ctx.llm as typeof ctx.llm&{installStreamProjection:(project:(original:Readonly<GenerateOptions>,resolved:Readonly<GenerateOptions>)=>Readonly<GenerateOptions>)=>void}
 assert.equal(typeof llm.installStreamProjection,'function','固定兼容底座需要实际provider投影接口')
 const adapter=new HotAdapter();adapter.scripts.push(textAnswer);llm.registerAdapter(['hot-test'],adapter)
 const original=Object.freeze({provider:'hot-test',model:'hot-model',sessionId:SessionId('logical-session'),messages:Object.freeze([createUserMessage({source:{kind:'user'},content:[{type:'text',text:'撤回的旧材料'}]})])}) as unknown as GenerateOptions
 llm.installStreamProjection((source,resolved)=>{assert.equal(source,original);return Object.freeze({...resolved,sessionId:SessionId('logical-session-generation-2'),messages:Object.freeze([createUserMessage({source:{kind:'user'},content:[{type:'text',text:'当前许可输入'}]})])}) as unknown as GenerateOptions})
 const prepared=await llm.prepareCall(original)
 await drain(prepared.stream(original))
 assert.equal(adapter.requests[0]?.sessionId,'logical-session-generation-2')
 assert.doesNotMatch(JSON.stringify(adapter.requests[0]),/撤回的旧材料/)
 assert.match(JSON.stringify(original),/撤回的旧材料/)
 assert.ok(Object.isFrozen(adapter.requests[0]))
})

test('受审provider投影不能更改原prepared模型、控制参数或工具许可',async t=>{
 const pkg=await patchedHotLlmPackage(t),ctx=new Context();t.after(()=>ctx.fiber.dispose());await ctx.plugin(pkg.LlmRuntime)
 const llm=ctx.llm as typeof ctx.llm&{installStreamProjection:(project:(original:Readonly<GenerateOptions>,resolved:Readonly<GenerateOptions>)=>Readonly<GenerateOptions>)=>void}
 const adapter=new HotAdapter();adapter.scripts.push(textAnswer);llm.registerAdapter(['hot-test'],adapter)
 const messages:GenerateOptions['messages']=[];Object.freeze(messages)
 const original=Object.freeze({provider:'hot-test',model:'hot-model',messages})
 llm.installStreamProjection((_original,resolved)=>Object.freeze({...resolved,model:'unapproved-model'}))
 const prepared=await llm.prepareCall(original),chunks=await drain(prepared.stream(original))
 assert.equal(adapter.requests.length,0)
 assert.ok(chunks.some(chunk=>chunk.type==='finish'&&chunk.reason.kind==='error'))
})

test('清洁surface重建保留人工历史，移除旧回复、工具与摘要并维持系统头约束',async()=>{
 const runtime=await import('../src/project-runtime-context.ts')
 const session=Session.create(SessionId('surface-history'))
 session.append('system/message',{turn:1,step:1,message:createSystemMessage('系统规则')},{surfaceOp:'append'})
 const original=session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'旧项目材料'}]}),{surfaceOp:'append'})
 session.append('assistant/message',{turn:1,step:1,message:createAssistantMessage({source:{provider:'hot-test',model:'hot-model'},content:[{type:'text',text:'受污染的旧回复'}]}),stream:[]},{surfaceOp:'append'})
 const before=session.snapshotEvents()
 runtime.rebuildProjectModelSurface(session,2)
 assert.deepEqual(session.snapshotEvents().slice(0,before.length),before)
 assert.equal(session.snapshotEvents().find(event=>event.seq===original.seq),original)
 assert.doesNotMatch(JSON.stringify(session.deriveMessages()),/旧项目材料|受污染的旧回复/)
 assert.match(JSON.stringify(session.deriveMessages()),/系统规则/)
 const count=session.snapshotEvents().length
 runtime.rebuildProjectModelSurface(session,2)
 assert.equal(session.snapshotEvents().length,count,'同代次不能重复生成surface替换')
})

test('换项目不能沿用本人输入保留标记，原事件仍保留供本人查看',async()=>{
 const {rebuildProjectModelSurface}=await import('../src/project-runtime-context.ts'),session=Session.create(SessionId('project-change'))
 session.append('system/message',{turn:1,step:1,message:createSystemMessage('系统规则')},{surfaceOp:'append'})
 const original=session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'仅项目甲可用的本人订单'}]}),{surfaceOp:'append'})
 session.append('user/message',createUserMessage({source:{kind:'runtime-context',form:'snapshot',sections:[{name:'teloa/project-context-generation',text:JSON.stringify([session.id,'project-a',1])}]},content:[{type:'text',text:'项目甲上下文'}]}),{surfaceOp:'append'})
 rebuildProjectModelSurface(session,JSON.stringify([session.id,'project-b',2]),1)
 assert.doesNotMatch(JSON.stringify(session.deriveMessages()),/仅项目甲可用|项目甲上下文/)
 assert.equal(session.snapshotEvents().find(event=>event.seq===original.seq),original)
})

test('压缩来源恢复遵守原消息的已提交projection，不从原日志复活已替换正文',async()=>{
 const {rebuildProjectModelSurface}=await import('../src/project-runtime-context.ts')
 const projection:SessionMessageProjection<'test/owner-input-projection'>={type:'test/owner-input-projection',project(event,context){
  const target=context.events.find(row=>row.seq===event.data.targetSeq);assert.ok(target?.type==='user/message')
  return new Map([[target.seq,freezeMessage({...target.data,content:[{type:'text',text:'已投影的本人订单：4件27.25元。'}]})]])
 }}
 const session=Session.create(SessionId('projected-owner-history'),undefined,undefined,undefined,[projection])
 session.append('system/message',{turn:1,step:1,message:createSystemMessage('系统规则')},{surfaceOp:'append'})
 const original=session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'不得复活的原文 RAW-REDACTED'}]}),{surfaceOp:'append'})
 const marker=session.append('user/message',createUserMessage({source:{kind:'runtime-context',form:'snapshot',sections:[{name:'teloa/project-context-generation',text:JSON.stringify([session.id,null,1])}]},content:[{type:'text',text:'旧岗位指引'}]}),{surfaceOp:'append'})
 session.append('test/owner-input-projection',{targetSeq:original.seq})
 // SDK形状的checkpoint只作projection边界夹具；真正压缩生成在另一个官方Loop用例覆盖。
 session.append('user/message',createUserMessage({source:{kind:'compact-checkpoint',compactionId:'projection-checkpoint' as never},content:[{type:'text',text:'混合旧摘要 MIXED-SUMMARY'}]}),{surfaceOp:{op:'replace',startSeq:original.seq,endSeq:marker.seq},sourceEventSeqs:[original.seq,marker.seq]})
 rebuildProjectModelSurface(session,JSON.stringify([session.id,null,2]),1)
 const messages=JSON.stringify(session.deriveMessages())
 assert.match(messages,/27\.25/);assert.doesNotMatch(messages,/RAW-REDACTED|MIXED-SUMMARY|旧岗位指引/)
 const count=session.snapshotEvents().length
 rebuildProjectModelSurface(session,JSON.stringify([session.id,null,2]),1)
 assert.equal(session.snapshotEvents().length,count,'恢复后的同代次装配不得重复追加')
 assert.match(JSON.stringify(session.snapshotEvents().find(event=>event.seq===original.seq)),/RAW-REDACTED/,'人工历史不被回写')
})

test('两条真实普通会话使用相同规则，实际adapter输入与manifest分别归属原会话',async t=>{
 const f=await nativeHotCausalityFixture(t),p=projectPorts();const runtime=registerProjectRuntimeContext(f.ctx,p.ports);t.after(runtime.close)
 f.adapter.scripts.push(textAnswer,textAnswer)
 await sendText(f,'核对第一条工作','first');await sendText(f,'核对第二条工作','second',f.other)
 assert.equal(f.adapter.requests.length,2)
 for(const request of f.adapter.requests){assert.match(JSON.stringify(request.messages),/只交付桌面版/);assert.match(JSON.stringify(request.messages),/\{\{literal\}\}/);assert.equal(request.toolHistory,undefined)}
 assert.equal(f.adapter.requests[0]?.sessionId,f.agent.id+'-generation-1')
 assert.equal(f.adapter.requests[1]?.sessionId,f.other.id+'-generation-1')
 assert.equal(p.state.uses.filter(use=>use.stage==='dispatched').length,2)
 assert.notEqual(p.state.uses.filter(use=>use.stage==='dispatched')[0]?.manifestId,p.state.uses.filter(use=>use.stage==='dispatched')[1]?.manifestId)
})

test('规则撤回后的下一模型代次清除衍生回复与工具历史，人工历史仍可追溯',async t=>{
 const f=await nativeHotCausalityFixture(t),p=projectPorts();const runtime=registerProjectRuntimeContext(f.ctx,p.ports);t.after(runtime.close)
 f.adapter.scripts.push(toolAnswer,textAnswer,textAnswer)
 await sendText(f,'依原规则执行工具','before')
 const prior=f.agent.session.snapshotEvents();assert.equal(f.counters.tools,1)
 p.state.generation++;p.state.text='项目新规则：当前输入才是可用依据。'
 await sendText(f,'按当前规则继续，不重做工具','after')
 assert.equal(f.adapter.requests.length,3)
 const request=f.adapter.requests.at(-1)!
 assert.equal(request.sessionId,f.agent.id+'-generation-2')
 assert.doesNotMatch(JSON.stringify(request),/只交付桌面版|hot-result|replayState/)
 assert.match(JSON.stringify(request),/当前输入才是可用依据/)
 assert.deepEqual(f.agent.session.snapshotEvents().slice(0,prior.length),prior)
 assert.equal(f.counters.tools,1,'rebase不能重发已执行工具')
})

test('模型middleware等待期间项目代次失效，最终固定闸口拒绝零adapter派发',async t=>{
 const f=await nativeHotCausalityFixture(t),p=projectPorts();const runtime=registerProjectRuntimeContext(f.ctx,p.ports);t.after(runtime.close)
 const gate=hotGate();t.after(gate.release);f.adapter.scripts.push(textAnswer)
 f.ctx.on('llm/stream',async function*(request,next){await gate.wait(request.signal);yield* next()})
 const running=sendText(f,'待核对输入','delayed');await gate.entered
 p.state.generation++;gate.release();await running
 assert.equal(f.adapter.requests.length,0)
 assert.equal(p.state.uses.filter(use=>use.stage==='dispatched').length,0)
})

test('模型流途中撤回，迟到工具调用不能进入真实工具体',async t=>{
 const f=await nativeHotCausalityFixture(t),p=projectPorts();const runtime=registerProjectRuntimeContext(f.ctx,p.ports);t.after(runtime.close)
 f.adapter.scripts.push(toolAnswer,textAnswer)
 f.ctx.on('llm/stream',async function*(request,next){for await(const chunk of next()){if(chunk.type==='tool-call-delta')p.state.generation++;yield chunk}})
 await sendText(f,'准备执行工具','stream-revoke')
 assert.equal(f.adapter.requests.length,1);assert.equal(f.counters.tools,0)
 assert.notEqual(f.events().filter(event=>event.type==='turn/end').at(-1)?.data.reason.kind,'completed')
})

test('真实工具已开始后撤回保留实际执行证据，阻止后续模型与衍生输入',async t=>{
 const f=await nativeHotCausalityFixture(t),p=projectPorts();const runtime=registerProjectRuntimeContext(f.ctx,p.ports);t.after(runtime.close)
 const gate=hotGate();t.after(gate.release);f.setToolAction(async exec=>gate.wait(exec.signal));f.adapter.scripts.push(toolAnswer,textAnswer)
 const running=sendText(f,'执行一次工具','tool-revoke');await gate.entered
 p.state.generation++;gate.release();await running
 assert.equal(f.counters.tools,1);assert.equal(f.adapter.requests.length,1)
 assert.equal(f.events().filter(event=>event.type==='user/message'&&event.data.source.kind!=='user'&&event.data.source.kind!=='runtime-context').length,0)
})

test('关闭记忆仍注入规则，实际任务输入不携带冻结岗位记忆',async t=>{
 const f=await nativeHotCausalityFixture(t),p=projectPorts();p.state.memoryMode='off';const runtime=registerProjectRuntimeContext(f.ctx,p.ports);t.after(runtime.close)
 f.adapter.scripts.push(textAnswer)
 const input=JSON.stringify({schema:'teloa.task-run-input/v2',task:{goal:'完成真实目标'},role:{id:'role-one'},knowledge:{contents:['保留知识']},memory:{contents:['禁止发送的冻结经验']}})
 await sendText(f,input,'memory-off')
 assert.equal(f.adapter.requests.length,1)
 assert.match(JSON.stringify(f.adapter.requests[0]),/只交付桌面版|完成真实目标|保留知识/)
 assert.doesNotMatch(JSON.stringify(f.adapter.requests[0]),/禁止发送的冻结经验/)
 assert.equal(await runtime.memoryEnabled(f.agent.id),false)
})

test('项目开启记忆仍由统一输入真源装配，旧Task冻结memory不形成第二份事实',async t=>{
 const f=await nativeHotCausalityFixture(t),p=projectPorts();p.state.text+='\n当前获准岗位经验：核对新版本来源。'
 const runtime=registerProjectRuntimeContext(f.ctx,p.ports);t.after(runtime.close);f.adapter.scripts.push(textAnswer)
 const input=JSON.stringify({schema:'teloa.task-run-input/v2',task:{goal:'完成当前目标'},role:{id:'role-one'},knowledge:{contents:[]},memory:{contents:['旧冻结经验不再授信']}})
 await sendText(f,input,'memory-single-source')
 assert.equal(f.adapter.requests.length,1)
 assert.doesNotMatch(JSON.stringify(f.adapter.requests[0]),/旧冻结经验不再授信/)
 assert.match(JSON.stringify(f.adapter.requests[0]),/当前获准岗位经验/)
 assert.equal(await runtime.memoryEnabled(f.agent.id),true)
 assert.equal(await runtime.legacyRoleExperienceEnabled(f.agent.id),false)
})

test('官方压缩请求使用同一许可代次与远端身份，实际摘要发送也记录使用清单',async t=>{
 const f=await compactionFixture(t),p=projectPorts();const runtime=registerProjectRuntimeContext(f.ctx,p.ports);t.after(runtime.close)
 f.adapter.scripts.push(textAnswer,textAnswer,textAnswer)
 await sendText(f,'长历史'.repeat(5000),'summary-before')
 await sendText(f,'继续当前工作','summary-after')
 assert.deepEqual(f.adapter.requests.map(request=>request.purpose??'main'),['main','compaction','main'])
 for(const request of f.adapter.requests)assert.equal(request.sessionId,f.agent.id+'-generation-1')
 assert.equal(p.state.uses.filter(use=>use.stage==='dispatched').length,3)
 assert.ok(f.events().some(event=>event.type==='compaction/end'&&!event.data.error))
})

test('岗位换代从官方压缩节点恢复本人订单，连续换代与再次压缩不能穿透撤回断点',async t=>{
 const f=await compactionFixture(t),p=projectPorts(),runtime=registerProjectRuntimeContext(f.ctx,p.ports);t.after(runtime.close)
 const longText='OLD-ASSISTANT-DERIVED '.repeat(2500),longAnswer:readonly StreamChunk[]=[{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text:longText},{type:'block-end',index:0,block:{type:'text',text:longText}},{type:'finish',reason:{kind:'stop'}}]
 f.adapter.scripts.push(longAnswer,textAnswer,textAnswer,textAnswer,textAnswer)
 await sendText(f,'订单 J2-A 4件27.25元；J2-B 2件9.50元。','orders-before-compaction')
 await sendText(f,'下一步继续核对。','compact-original-orders')
 assert.equal(f.events().filter(event=>event.type==='compaction/end'&&!event.data.error).length,1)
 const original=f.events().find(event=>event.type==='user/message'&&event.data.source.kind==='user'&&'rpcId'in event.data.source&&event.data.source.rpcId==='orders-before-compaction')!
 assert.ok(!f.agent.session.surface.nodes.includes(original.seq),'原订单确已被官方压缩替换')
 p.state.generation=2;p.state.retainUserInputFromGeneration=1;p.state.text='当前岗位新职责 NEW-ROLE-RULE'
 await sendText(f,'新增 J2-C 3件18.75元，合并原订单。','role-after-compaction')
 let request=JSON.stringify(f.adapter.requests.at(-1)!.messages)
 assert.match(request,/27\.25/);assert.match(request,/9\.50/);assert.match(request,/18\.75/)
 assert.match(request,/NEW-ROLE-RULE/);assert.doesNotMatch(request,/OLD-ASSISTANT-DERIVED|只交付桌面版/)
 p.state.generation=3
 await sendText(f,'再按当前职责复核。','second-role-update')
 assert.match(JSON.stringify(f.adapter.requests.at(-1)!.messages),/27\.25/,'宿主恢复节点在连续软换代中保留原本人输入')
 p.state.generation=4;p.state.retainUserInputFromGeneration=undefined;p.state.text='撤回后仅使用新资料。'
 f.adapter.scripts.push(longAnswer,textAnswer,textAnswer,textAnswer)
 await sendText(f,'开始新的独立工作 OWNER-AFTER-REVOKE。','hard-rebuild')
 await sendText(f,'补充本次独立输入。','compact-after-revoke')
 assert.equal(f.events().filter(event=>event.type==='compaction/end'&&!event.data.error).length,2)
 p.state.generation=5;p.state.retainUserInputFromGeneration=4
 await sendText(f,'岗位已更新，继续本次独立工作。','role-after-hard-compaction')
 request=JSON.stringify(f.adapter.requests.at(-1)!.messages)
 assert.match(request,/OWNER-AFTER-REVOKE/)
 assert.doesNotMatch(request,/27\.25|9\.50|18\.75|OLD-ASSISTANT-DERIVED/,'压缩来源追溯必须在硬重建节点停止')
 assert.equal(f.events().filter(event=>event.type==='user/message'&&event.data.source.kind==='user'&&'rpcId'in event.data.source&&event.data.source.rpcId==='orders-before-compaction').length,1,'恢复不能伪造第二次本人发送')
})

test('岗位换代恢复超窗本人历史时零派发且保留原压缩节点，选择更大窗口后可重新继续',async t=>{
 const f=await compactionFixture(t,{contextWindow:3600,thresholdRatio:0.45}),p=projectPorts(),runtime=registerProjectRuntimeContext(f.ctx,p.ports);t.after(runtime.close)
 const overflow:Array<{purpose:string;tokens:number}>=[],stream=f.adapter.stream.bind(f.adapter)
 f.adapter.stream=async function*(options){
  const capacity=options.model==='large-model'?16000:3600
  const tokens=options.messages.reduce((total,message)=>total+f.ctx.tokenMeter.estimateMessage(message.id===undefined?createUserMessage({source:{kind:'runtime-context',form:'notice',summary:'Capacity measurement fixture'},content:message.content}):message),0)+(options.maxTokens??256)
  if(tokens>capacity){overflow.push({purpose:options.purpose??'main',tokens});throw Error('fixture: context window exceeded')}
  yield* stream(options)
 }
 f.adapter.scripts.push(...Array.from({length:12},()=>textAnswer))
 await sendText(f,'OWNER-FIRST 27.25 '+ 'a'.repeat(7400),'long-owner-first')
 await sendText(f,'OWNER-SECOND 9.50 '+ 'b'.repeat(7400),'long-owner-second')
 await sendText(f,'核对两份原输入。','long-owner-compacted')
 assert.equal(f.events().filter(event=>event.type==='compaction/end'&&!event.data.error).length,2,'先由真实官方引擎完成两次压缩')
 assert.deepEqual(overflow,[],'原会话在小窗口内可正常运行')
 const surface=[...f.agent.session.surface.nodes],dispatched=f.adapter.requests.length
 p.state.generation=2;p.state.retainUserInputFromGeneration=1;p.state.text='岗位已更新 NEW-ROLE-LIMIT'
 await sendText(f,'使用两份原输入继续核对。','long-owner-denied')
 assert.deepEqual(overflow,[],'恢复预验必须在首次超窗主请求或摘要请求之前拒绝')
 assert.equal(f.adapter.requests.length,dispatched)
 assert.deepEqual([...f.agent.session.surface.nodes],surface,'拒绝不能改写原 checkpoint 或代次 marker')
 const failure=f.events().filter(event=>event.type==='turn/end').at(-1)
 assert.ok(failure?.type==='turn/end'&&failure.data.reason.kind==='error')
 assert.match(failure.data.reason.error.message,/更大.*上下文|上下文.*更大/)
 assert.equal(f.agent.status,'idle','已 claim 的失败回合必须退出，不能锁住输入')
 f.adapter.resolveModel=async(provider,model)=>({provider,id:model,name:model,inputModalities:['text'] as const,context:{contextWindow:model==='large-model'?16000:3600},defaultMaxTokens:256})
 // 官方 Agent 选模的 prompt/request 双 waterfall；不修改旧 request/header 冒充新模型。
 const {installModelSelection}=await import('@deepseek-ai/dsh-agent')
 const release=installModelSelection(f.agent.ctx,{current:{provider:'hot-test',model:'large-model'},assembled:undefined});t.after(release)
 await sendText(f,'使用两份原输入继续核对。','long-owner-retry')
 const request=f.adapter.requests.at(-1)!
 assert.equal(request.model,'large-model')
 assert.match(JSON.stringify(request.messages),/OWNER-FIRST 27\.25/);assert.match(JSON.stringify(request.messages),/OWNER-SECOND 9\.50/)
 assert.deepEqual(overflow,[])
 assert.equal(f.adapter.requests.length,dispatched+1,'扩大窗口后的恢复只向新模型派发；旧小模型不得先摘要展开后的历史')
 assert.equal(f.events().filter(event=>event.type==='turn/end').at(-1)?.data.reason.kind,'completed')
 for(const rpcId of ['long-owner-first','long-owner-second','long-owner-retry'])assert.equal(f.events().filter(event=>event.type==='user/message'&&event.data.source.kind==='user'&&'rpcId'in event.data.source&&event.data.source.rpcId===rpcId).length,1)
 assert.equal(f.counters.tools,0)
})

test('岗位恢复暂存经官方压缩并在pre-step取消后，重试仍恢复原本人输入且不复活旧混合正文',async t=>{
 const f=await compactionFixture(t),p=projectPorts(),runtime=registerProjectRuntimeContext(f.ctx,p.ports);t.after(runtime.close)
 const old='OLD-MIXED-ANSWER '.repeat(2500),answer:readonly StreamChunk[]=[{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text:old},{type:'block-end',index:0,block:{type:'text',text:old}},{type:'finish',reason:{kind:'stop'}}]
 f.adapter.scripts.push(answer,textAnswer,textAnswer,textAnswer,textAnswer)
 await sendText(f,'原订单 OWNER-CANCELLED 27.25。','owner-before-cancel')
 await sendText(f,'核对原订单。','owner-before-role-update')
 assert.equal(f.events().filter(event=>event.type==='compaction/end'&&!event.data.error).length,1)
 p.state.generation=2;p.state.retainUserInputFromGeneration=1;p.state.text='当前新岗位 NEW-AFTER-CANCEL'
 const before=f.adapter.requests.length
 const cancel=f.agent.ctx.on('agent/pre-step',async({agent,signal})=>{
  assert.doesNotMatch(JSON.stringify(agent.session.deriveMessages()),/OWNER-CANCELLED|OLD-MIXED-ANSWER|只交付桌面版/,'暂存阶段既不展开历史也不保留旧岗位混合正文')
  const nodes=agent.session.surface.nodes
  const compaction=agent.ctx.get('compaction') as import('@deepseek-ai/dsh-compaction-basic').BasicCompactionEngine|undefined;assert.ok(compaction)
  await compaction.compactRegion(nodes[1]!,nodes.at(-1)!,agent,signal)
  agent.cancel({kind:'user'});signal.throwIfAborted()
  throw Error('fixture cancellation did not abort')
 })
 await sendText(f,'继续原订单。','owner-role-cancelled');cancel()
 assert.equal(f.agent.status,'idle')
 const stopped=f.events().filter(event=>event.type==='turn/end').at(-1)
 assert.equal(stopped?.data.reason.kind,'aborted',JSON.stringify(stopped?.data.reason))
 const interim=f.adapter.requests.slice(before)
 assert.equal(interim.length,1);assert.equal(interim[0]?.purpose,'compaction')
 assert.doesNotMatch(JSON.stringify(interim),/OWNER-CANCELLED|OLD-MIXED-ANSWER|只交付桌面版/)
 await sendText(f,'继续原订单。','owner-role-retried')
 assert.match(JSON.stringify(f.adapter.requests.at(-1)?.messages),/OWNER-CANCELLED 27\.25/)
 assert.doesNotMatch(JSON.stringify(f.adapter.requests.at(-1)?.messages),/OLD-MIXED-ANSWER|只交付桌面版/)
 assert.equal(f.events().filter(event=>event.type==='turn/end').at(-1)?.data.reason.kind,'completed')
 assert.equal(f.events().filter(event=>event.type==='user/message'&&event.data.source.kind==='user'&&'rpcId'in event.data.source&&event.data.source.rpcId==='owner-before-cancel').length,1)
 assert.equal(f.counters.tools,0)
})

test('岗位恢复容量包括已持久化的显式输出上限，不用新模型默认值覆盖',async t=>{
 const f=await compactionFixture(t,{contextWindow:16000,thresholdRatio:0.1}),p=projectPorts(),runtime=registerProjectRuntimeContext(f.ctx,p.ports);t.after(runtime.close)
 const explicit=f.agent.ctx.on('agent/request',async(_payload,next)=>({...await next(),maxTokens:4000}))
 f.adapter.scripts.push(...Array.from({length:6},()=>textAnswer))
 await sendText(f,'OWNER-CAPPED '+ 'a'.repeat(7400),'owner-with-output-cap')
 await sendText(f,'核对原输入。','owner-cap-compacted');explicit()
 assert.equal(f.events().filter(event=>event.type==='compaction/end'&&!event.data.error).length,1)
 assert.equal(f.agent.session.requestHeader()?.config.maxTokens,4000)
 assert.notEqual(f.agent.session.requestHeader()?.adapterDefaults?.maxTokens,true)
 f.adapter.resolveModel=async(provider,model)=>({provider,id:model,name:model,inputModalities:['text'] as const,context:{contextWindow:model==='smaller-model'?5000:16000},defaultMaxTokens:256})
 const {installModelSelection}=await import('@deepseek-ai/dsh-agent')
 const release=installModelSelection(f.agent.ctx,{current:{provider:'hot-test',model:'smaller-model'},assembled:undefined});t.after(release)
 const surface=[...f.agent.session.surface.nodes],before=f.adapter.requests.length
 p.state.generation=2;p.state.retainUserInputFromGeneration=1
 await sendText(f,'继续核对原输入。','owner-cap-denied')
 assert.equal(f.adapter.requests.length,before,'历史显式4000输出加恢复正文超过5000窗口，应在主/摘要派发前拒绝')
 assert.deepEqual([...f.agent.session.surface.nodes],surface)
 const failure=f.events().filter(event=>event.type==='turn/end').at(-1)
 assert.ok(failure?.type==='turn/end'&&failure.data.reason.kind==='error')
 assert.match(failure.data.reason.error.message,/上下文窗口/)
})

test('撤回后先清洁重建再处理压缩，旧长资料不会进入下一摘要或主模型',async t=>{
 const f=await compactionFixture(t),p=projectPorts();const runtime=registerProjectRuntimeContext(f.ctx,p.ports);t.after(runtime.close)
 f.adapter.scripts.push(textAnswer,textAnswer,textAnswer)
 await sendText(f,'已经撤回的长历史'.repeat(5000),'dirty-summary-before')
 p.state.generation++;p.state.text='新的可用项目规则'
 await sendText(f,'只按当前输入继续','dirty-summary-after')
 assert.equal(f.adapter.requests.length,2,'重建后的干净surface不应因旧历史压力触发摘要')
 assert.doesNotMatch(JSON.stringify(f.adapter.requests.at(-1)),/已经撤回的长历史|只交付桌面版/)
})

test('真实受管子Agent继承项目规则和关闭记忆策略，父子仍使用原物理执行链',async t=>{
 const f=await nativeHotSubagentFixture(t,'one-shot'),p=projectPorts();p.state.memoryMode='off'
 const runtime=registerProjectRuntimeContext(f.ctx,p.ports);t.after(runtime.close)
 f.adapter.parentId=f.parent.id+'-generation-1'
 await f.send('project-child')
 assert.equal(f.candidates.length,1)
 const child=f.candidates[0]!.agent
 const requests=f.adapter.requests.filter(request=>request.sessionId===child.id+'-generation-1')
 assert.equal(requests.length,1)
 assert.match(JSON.stringify(requests[0]),/只交付桌面版/)
 assert.equal(p.state.prepared.find(row=>row.binding.sessionId===child.id)?.binding.memoryMode,'off')
 assert.equal(f.counts.tools,1);assert.equal(f.adapter.parentCalls,2)
 assert.equal(f.events().filter(event=>event.type==='turn/end').at(-1)?.data.reason.kind,'completed')
})

test('自动提炼沿真实来源、项目代次和一次性辅助证明调用原adapter，结束后不能重放',async t=>{
 const f=await nativeHotCausalityFixture(t),p=projectPorts();const runtime=registerProjectRuntimeContext(f.ctx,p.ports);t.after(runtime.close)
 f.adapter.scripts.push(textAnswer,textAnswer)
 const original=await sendText(f,'确认已经验证的偏好','memory-source')
 assert.equal(typeof f.work.withAuxiliaryModel,'function','提炼需要受控辅助模型许可口')
 const prepared=p.state.prepared[0]!
 const messages=[createUserMessage({source:{kind:'user'},content:[{type:'text',text:'从已授权来源提出候选'}]})];Object.freeze(messages)
 const options=Object.freeze({provider:'hot-test',model:'hot-model',sessionId:f.agent.id,messages})
 const lease=Object.freeze({assertCurrent(){p.ports.assertPreparedCurrentSync(prepared)}})
 const source={ownerId:p.ports.owner,sessionId:f.agent.id,messageId:original.id,eventId:'stored-extraction-event'}
 let dispatches=0
 await drain(runtime.withAuxiliaryContext(prepared,options,()=>f.work.withAuxiliaryModel({source,options,lease},()=>f.ctx.llm.stream(options)),async()=>{assert.equal(f.adapter.requests.length,1);dispatches++}))
 assert.equal(dispatches,1)
 assert.equal(f.adapter.requests.length,2)
 assert.equal(f.adapter.requests[1]?.sessionId,f.agent.id+'-generation-1')
 assert.equal(f.adapter.requests[1]?.tools,undefined)
 await assert.rejects(drain(f.ctx.llm.stream(options)))
 assert.equal(f.adapter.requests.length,2)
})
test('辅助SDK真实派发入口以前的许可失效不触发预算登记',async t=>{
 const f=await nativeHotCausalityFixture(t),p=projectPorts(),runtime=registerProjectRuntimeContext(f.ctx,p.ports);t.after(runtime.close)
 f.adapter.scripts.push(textAnswer)
 const original=await sendText(f,'确认可提炼事实','zero-aux-dispatch'),prepared=p.state.prepared[0]!
 const messages=[createUserMessage({source:{kind:'user'},content:[{type:'text',text:'提炼候选'}]})];Object.freeze(messages)
 const options=Object.freeze({provider:'hot-test',model:'hot-model',sessionId:f.agent.id,messages})
 const gate=hotGate();t.after(gate.release);f.adapter.prepareGate=gate
 const lease=Object.freeze({assertCurrent(){p.ports.assertPreparedCurrentSync(prepared)}}),source={ownerId:p.ports.owner,sessionId:f.agent.id,messageId:original.id,eventId:'zero-dispatch-event'}
 let dispatches=0
 const result=drain(runtime.withAuxiliaryContext(prepared,options,()=>f.work.withAuxiliaryModel({source,options,lease},()=>f.ctx.llm.stream(options)),()=>{dispatches++}));const denied=assert.rejects(result)
 await gate.entered;p.state.generation++;gate.release();await denied
 assert.equal(dispatches,0);assert.equal(f.adapter.requests.length,1)
})

test('辅助提炼拒绝假的source与带工具请求，不从公共历史标签授予许可',async t=>{
 const f=await nativeHotCausalityFixture(t),p=projectPorts();const runtime=registerProjectRuntimeContext(f.ctx,p.ports);t.after(runtime.close)
 f.adapter.scripts.push(textAnswer,textAnswer)
 const original=await sendText(f,'真正的人工指令','aux-source')
 const prepared=p.state.prepared[0]!,lease=Object.freeze({assertCurrent(){p.ports.assertPreparedCurrentSync(prepared)}})
 const messages=[createUserMessage({source:{kind:'user'},content:[{type:'text',text:'候选提炼'}]})];Object.freeze(messages)
 const source={ownerId:p.ports.owner,sessionId:f.agent.id,messageId:'fake-message',eventId:'event'}
 const request=()=>Object.freeze({provider:'hot-test',model:'hot-model',sessionId:f.agent.id,messages})
 let options=request()
 await assert.rejects(drain(runtime.withAuxiliaryContext(prepared,options,()=>f.work.withAuxiliaryModel({source,options,lease},()=>f.ctx.llm.stream(options)))))
 const fabricated=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'公开append并非真实受理'}]})
 f.agent.session.append('user/message',fabricated,{surfaceOp:'append'})
 options=request()
 await assert.rejects(drain(runtime.withAuxiliaryContext(prepared,options,()=>f.work.withAuxiliaryModel({source:{...source,messageId:fabricated.id},options,lease},()=>f.ctx.llm.stream(options)))))
 const withTools=Object.freeze({...request(),tools:[]})
 await assert.rejects(drain(runtime.withAuxiliaryContext(prepared,withTools,()=>f.work.withAuxiliaryModel({source:{...source,messageId:original.id},options:withTools,lease},()=>f.ctx.llm.stream(withTools)))))
 assert.equal(f.adapter.requests.length,1)
})

test('辅助提炼运行中的request克隆与同对象第二次派发均不继承私有证明',async t=>{
 const f=await nativeHotCausalityFixture(t),p=projectPorts();const runtime=registerProjectRuntimeContext(f.ctx,p.ports);t.after(runtime.close)
 f.adapter.scripts.push(textAnswer,textAnswer)
 const original=await sendText(f,'确认事实','aux-proof-source'),prepared=p.state.prepared[0]!
 const messages=[createUserMessage({source:{kind:'user'},content:[{type:'text',text:'提炼候选'}]})];Object.freeze(messages)
 const options=Object.freeze({provider:'hot-test',model:'hot-model',sessionId:f.agent.id,messages})
 const lease=Object.freeze({assertCurrent(){p.ports.assertPreparedCurrentSync(prepared)}}),source={ownerId:p.ports.owner,sessionId:f.agent.id,messageId:original.id,eventId:'event'}
 let rejected=0
 f.ctx.on('llm/stream',async function*(request,next){
  if(request===options){
   for(const other of [Object.freeze({...request}),request]){try{await drain(f.ctx.llm.stream(other))}catch{rejected++}}
  }
  yield* next()
 })
 await drain(runtime.withAuxiliaryContext(prepared,options,()=>f.work.withAuxiliaryModel({source,options,lease},()=>f.ctx.llm.stream(options))))
 assert.equal(rejected,2);assert.equal(f.adapter.requests.length,2)
})

test('已持独立owner预算的辅助请求不重复进入resident Run预算，证明退出后不保留豁免',async t=>{
 const f=await nativeHotCausalityFixture(t),p=projectPorts();const runtime=registerProjectRuntimeContext(f.ctx,p.ports);t.after(runtime.close);f.adapter.scripts.push(textAnswer,textAnswer)
 const original=await sendText(f,'确认可提炼经验','owner-budget-source'),prepared=p.state.prepared[0]!
 let lookups=0
 const close=installResidentModelBudget(f.ctx,{owner:p.ports.owner,pool:{} as never,identity:{id:()=> 'budget-test',now:()=>new Date().toISOString()},runs:async()=>{throw Error('辅助请求不能读取Run')},controls:{} as never,budgets:{} as never,resolveRun:async()=>{lookups++;throw Error('辅助请求不能重复建立Run预算')},nativeInput:f.work,report:()=>{}});t.after(close)
 const messages=[createUserMessage({source:{kind:'user'},content:[{type:'text',text:'独立预算提炼候选'}]})];Object.freeze(messages)
 const options=Object.freeze({provider:'hot-test',model:'hot-model',sessionId:f.agent.id,messages}),source={ownerId:p.ports.owner,sessionId:f.agent.id,messageId:original.id,eventId:'budget-event'},lease=Object.freeze({assertCurrent(){p.ports.assertPreparedCurrentSync(prepared)}})
 await drain(runtime.withAuxiliaryContext(prepared,options,()=>f.work.withAuxiliaryModel({source,options,lease},()=>f.ctx.llm.stream(options))))
 assert.equal(f.adapter.requests.length,2);assert.equal(lookups,0)
 assert.equal(f.work.hasAuxiliaryModelAdmission(options),false)
 assert.equal(f.work.hasAuxiliaryModelAdmission(Object.freeze({...options})),false)
})

test('真实JSONL冷恢复重核项目许可并重建provider代次，待办仅执行一次',async t=>{
 const f=await nativeProviderKernel(t),root=await mkdtemp(join(tmpdir(),'teloa-project-cold-'))
 t.after(()=>rm(root,{recursive:true,force:true}))
 await f.ctx.plugin(f.persistencePackage,{root,compression:'none'})
 const access=new WorkAccess(),work=createNativeWorkInput(f.ctx,access,async input=>{input.assertCurrent()},undefined,async input=>Object.freeze({roots:Object.freeze(input.messages.map(message=>{const rpc=Reflect.get(message.source,'rpcId'),identity=nativeInputIdentity(message,rpc);return Object.freeze({sessionId:input.sessionId,messageId:message.id,nativeRequestId:identity.nativeRequestId??null,payloadSha256:identity.payloadSha256})})),assertCurrent(){input.signal.throwIfAborted()}}))
 t.after(work.close)
 await f.ctx.plugin(f.loopPackage.AgentLoop,{agents:[]})
 const p=projectPorts(),runtime=registerProjectRuntimeContext(f.ctx,p.ports);t.after(runtime.close)
 const adapter=new HotAdapter();adapter.scripts.push(textAnswer,textAnswer);f.ctx.llm.registerAdapter(['hot-test'],adapter)
 const source=await f.ctx.agents.create({sessionId:SessionId('project-cold'),agentOptions:{provider:'hot-test',model:'hot-model'}})
 const first=createUserMessage({source:{kind:'user',rpcId:'cold-first'},content:[{type:'text',text:'先按旧规则工作'}]})
 await work.withNewInput(source.agent,first,{producer:'prompt',identity:'cold-first'},()=>source.agent.followup(first));await source.agent.whenIdle()
 const pending=createUserMessage({source:{kind:'user',rpcId:'cold-pending'},content:[{type:'text',text:'冷恢复继续当前目标'}]})
 await work.withNewInput(source.agent,pending,{producer:'prompt',identity:'cold-pending'},()=>source.agent.inbox.append('next-turn',pending))
 assert.equal(await f.sessions.flush(source.agent.session),true)
 const before=source.agent.session.snapshotEvents();await source.dispose()
 p.state.generation++;p.state.text='重启后当前可用规则'
 const restored=await f.ctx.agents.resume({resumeSessionId:source.agent.id,agentOptions:{provider:'hot-test',model:'hot-model'}});await restored.agent.whenIdle()
 assert.equal(adapter.requests.length,2)
 assert.equal(adapter.requests[1]?.sessionId,'project-cold-generation-2')
 assert.doesNotMatch(JSON.stringify(adapter.requests[1]),/只交付桌面版|先按旧规则工作/)
 assert.match(JSON.stringify(adapter.requests[1]),/重启后当前可用规则|冷恢复继续当前目标/)
 assert.deepEqual(restored.agent.session.snapshotEvents().slice(0,before.length),before)
 assert.equal(restored.agent.session.snapshotEvents().filter(event=>event.type==='user/message'&&event.data.id===pending.id).length,1)
 await restored.dispose()
})

test('项目会话中模型改写项目目标/标题被校验层拦下，普通字段修改仍可执行',async t=>{
 const f=await nativeHotCausalityFixture(t),p=projectPorts(),goal='项目目标：只交付社区版 Web 工作台。'
 const hashGoal=(text:string)=>createHash('sha256').update(text).digest('hex')
 const runtime=registerProjectRuntimeContext(f.ctx,{...p.ports,prepare:async input=>{const prepared=await p.ports.prepare(input);if(!prepared)return null;return {...prepared,sources:[{kind:'project' as const,id:'project-one',version:1,title:'项目甲',hash:hashGoal(goal)},...prepared.sources]}}})
 t.after(()=>runtime.close())
 let executions=0
 f.ctx.tools.register(defineTool({name:'teloa_projects_change',description:'项目定义修改夹具',parameters:{projectId:{type:'string',required:true},expectedVersion:{type:'integer',required:true},fields:{type:'object',required:true,additionalProperties:true}},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text' as const,text:value}]},execute:async()=>{executions++;return 'saved'}}))
 f.adapter.scripts.push(projectChangeAnswer({projectId:'project-one',expectedVersion:1,fields:{title:'项目甲',goal:goal+'\n\n## 决策\n- 内部代号：PX-204',dueDate:null,state:'planning',links:[],references:[]}}),textAnswer)
 await sendText(f,'决定：本项目内部代号为 PX-204','project-goal-memory')
 assert.equal(executions,0,'项目目标改写必须在工具校验层被拦下')
 assert.equal(f.events().filter(event=>event.type==='turn/end').at(-1)?.data.reason.kind,'completed','工具被拦不等于整轮失败')
 const request=JSON.stringify(f.adapter.requests.at(-1))
 assert.match(request,/项目定义/,'模型必须收到可执行的原因')
 assert.match(request,/not a memory store/,'提示层同时声明项目定义不是记忆载体')
 f.adapter.scripts.push(projectChangeAnswer({projectId:'project-one',expectedVersion:2,fields:{title:'项目甲',goal,dueDate:null,state:'archived',links:[],references:[]}}),textAnswer)
 await sendText(f,'把这个项目归档','project-state-change')
 assert.equal(executions,1,'未改写目标/标题的普通字段修改不应被拦')
})

function projectChangeAnswer(args:unknown):readonly StreamChunk[]{
 const text=JSON.stringify(args),id=ToolCallId('project-change-'+Math.random().toString(36).slice(2))
 return [
  {type:'block-start',index:0,blockType:'tool-call'},
  {type:'tool-call-delta',index:0,id,name:'teloa_projects_change',argumentsDelta:text},
  {type:'block-end',index:0,block:{type:'tool-call',id,name:'teloa_projects_change',arguments:text}},
  {type:'finish',reason:{kind:'tool-calls'}},
 ]
}

test('MEM06 同代次受管正文按稳定段落替换，纯继续不重复且原审计前缀保留',async t=>{
 const f=await nativeHotCausalityFixture(t),p=projectPorts(),runtime=registerProjectRuntimeContext(f.ctx,p.ports);t.after(runtime.close)
 t.after(()=>t.diagnostic('MEM06 fixture adapter requests='+f.adapter.requests.length))
 const a='MEM06_AUTOMATIC_A',b='MEM06_AUTOMATIC_B'
 const body=(request:GenerateOptions)=>request.messages.flatMap(message=>message.content.flatMap(block=>block.type==='text'?[block.text]:[])).join('\n')
 const count=(text:string,value:string)=>text.split(value).length-1
 p.state.text=a;f.adapter.scripts.push(textAnswer,textAnswer,textAnswer)
 await sendText(f,'第一个独立问题','mem06-stable-a')
 const original=f.agent.session.snapshotEvents(),firstRequest=JSON.stringify(f.adapter.requests[0])
 p.state.text=b;await sendText(f,'新的独立问题','mem06-stable-b')
 assert.equal(count(body(f.adapter.requests[1]!),a),0);assert.equal(count(body(f.adapter.requests[1]!),b),1)
 p.state.text=a+'\n'+b;await sendText(f,'继续','mem06-stable-continue')
 assert.equal(count(body(f.adapter.requests[2]!),a),1);assert.equal(count(body(f.adapter.requests[2]!),b),1)
 assert.deepEqual(f.agent.session.snapshotEvents().slice(0,original.length),original)
 assert.equal(JSON.stringify(f.adapter.requests[0]),firstRequest)
 assert.ok(f.agent.session.snapshotEvents().some(event=>event.type==='user/message'&&event.data.source.kind==='runtime-context'&&JSON.stringify(event.data).includes(a)),'旧自动段落仍保留在原审计事件中')
})

test('MEM06 只替换受管自动段落，本人同文、模型引用与显式工具读取保留',async t=>{
 const f=await nativeHotCausalityFixture(t),p=projectPorts(),runtime=registerProjectRuntimeContext(f.ctx,p.ports);t.after(runtime.close)
 t.after(()=>t.diagnostic('MEM06 fixture adapter requests='+f.adapter.requests.length))
 const a='MEM06_EXPLICIT_A',b='MEM06_CURRENT_B',owner='本人原话 '+a+' '+a,quote='已明确引用 '+a;let reads=0
 f.ctx.tools.register(defineTool({name:'mem06_read_exact',description:'按本人要求读取合成值',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{reads++;return a}}))
 const quoted=textAnswer.map(chunk=>chunk.type==='text-delta'?{...chunk,text:quote}:chunk.type==='block-end'&&chunk.block.type==='text'?{...chunk,block:{...chunk.block,text:quote}}:chunk)
 const tool=toolAnswer.map(chunk=>chunk.type==='tool-call-delta'?{...chunk,name:'mem06_read_exact'}:chunk.type==='block-end'&&chunk.block.type==='tool-call'?{...chunk,block:{...chunk.block,name:'mem06_read_exact'}}:chunk)
 f.adapter.scripts.push(quoted,tool,textAnswer);p.state.text=a
 await sendText(f,owner,'mem06-owner-literal')
 const original=f.agent.session.snapshotEvents();p.state.text=a+'\n'+b
 await sendText(f,'请通过 mem06_read_exact 读取原值','mem06-explicit-read')
 const request=f.adapter.requests.at(-1)!,texts=(message:typeof request.messages[number])=>message.content.flatMap(block=>block.type==='text'?[block.text]:[]).join('\n')
 const automatic=request.messages.filter(message=>message.source?.kind==='runtime-context'&&message.source.form==='snapshot'&&message.source.sections.some(section=>section.name==='teloa/project-context')).map(texts).join('\n')
 assert.equal(automatic.split(a).length-1,1);assert.equal(automatic.split(b).length-1,1)
 assert.ok(request.messages.some(message=>message.source?.kind==='user'&&texts(message)===owner))
 assert.ok(request.messages.some(message=>message.source?.kind==='model'&&texts(message)===quote))
 assert.ok(request.messages.some(message=>message.role==='tool'&&texts(message)===a));assert.equal(reads,1)
 assert.deepEqual(f.agent.session.snapshotEvents().slice(0,original.length),original)
})


test('NF01记忆关闭仍保留本轮员工来源及指定知识，下一轮撤回旧身份且不读取经验',async t=>{
 const f=await nativeHotCausalityFixture(t),{ports,state}=projectPorts();state.memoryMode='off'
 const runtime=registerProjectRuntimeContext(f.ctx,ports);t.after(()=>runtime.close())
 const role={id:'11111111-1111-4111-8111-111111111111',ownerId:'project-owner',version:1,name:'本轮研判员-NF01',kind:'employee',state:'active',scopes:['SOC'],duty:'核对本岗位证据-NF01',dataScope:'本岗位',executionScope:'仅沟通和派发',skills:[],knowledge:[]} as unknown as DigitalRole
 const marker=encodeEmployeeMention({roleId:role.id,roleVersion:1})
 const selected=registerEmployeeMentionContext(f.ctx,{applies:async()=>true,resolve:async(sessionId,text)=>text.includes(marker)?{reference:{roleId:role.id,roleVersion:1},role,sessionId,scopeId:'SOC',assertCurrent:async()=>{}}:null,material:async()=>({knowledge:'本轮明确指定资料-NF01',experience:'关闭记忆不得发送-NF01',allowedTools:[],argumentRules:[],assertCurrent:async()=>{}})})
 t.after(()=>selected.dispose());f.adapter.scripts.push(textAnswer,textAnswer)
 await sendText(f,marker+' 请核对本岗位','off-selected-employee')
 const first=JSON.stringify(f.adapter.requests[0]?.messages)
 assert.match(first,/本轮研判员-NF01/);assert.match(first,/teloa.employee-mention/);assert.match(first,/本轮明确指定资料-NF01/)
 assert.doesNotMatch(first,/关闭记忆不得发送-NF01/)
 await sendText(f,'普通问题，不选择员工','off-no-employee')
 const next=JSON.stringify(f.adapter.requests[1]?.messages)
 assert.doesNotMatch(next,/本轮研判员-NF01|核对本岗位证据-NF01|本轮明确指定资料-NF01|关闭记忆不得发送-NF01/)
})
