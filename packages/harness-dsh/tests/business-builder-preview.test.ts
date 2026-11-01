import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createRequire} from 'node:module'
import {Context} from '@deepseek-ai/cordis'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {LlmAdapter,LlmRuntime,createUserMessage,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime,defineTool} from '@deepseek-ai/dsh-tools'
import {WorkError,readBusinessConfigurationCandidateVersioned} from '@teloa/contract'
import {businessConfigurationHash,type BusinessConfigurationDraft} from '@teloa/backend'
import {registerBusinessBuilderPreview} from '../src/business-builder-preview.ts'
import {registerBusinessBuilderTools,type BusinessBuilderToolsPorts} from '../src/business-builder-tools.ts'
import {nativeHotCausalityFixture} from './fixtures/native-hot-causality.ts'
import {registerProjectRuntimeContext} from '../src/project-runtime-context.ts'
import {readSessionEvents} from '../src/session-events.ts'

// 真实 DSH loop/模型协议/会话记录；只有推理与数据库端口为受控替身。无PG、无外部模型。
async function fixture(t:TestContext,guarded=false){
 const native=guarded?await nativeHotCausalityFixture(t):undefined
 const ctx=native?.ctx??new Context()
 if(!native){t.after(()=>ctx.fiber.dispose());for(const plugin of [LlmRuntime,SessionStore,SessionProjectionRegistry,SystemPrompt,ToolRuntime,AgentRegistry])await ctx.plugin(plugin);await ctx.plugin(AgentLoop,{agents:[]})}
 // 新建 builder 不允许绑定项目；真实宿主仍安装项目准入，未绑定须由真源明确返回 null。
 if(native){const runtime=registerProjectRuntimeContext(ctx,{owner:'preview-owner',readBinding:async()=>null,prepare:async()=>null,assertCurrent:async()=>{},assertPreparedCurrentSync:()=>{},recordUsed:async()=>{throw Error('unbound builder must not use project context')}});t.after(runtime.close)}
 const owner='owner:'+randomUUID(),scope='business_'+randomUUID().replaceAll('-',''),now='2026-10-31T00:00:00.000Z'
 const candidate=readBusinessConfigurationCandidateVersioned({format:'teloa.business-configuration/v1',scope,title:'场地预约',sources:[{sourceId:'local-bookings',kind:'local-records'}],definitions:[],pages:[]})
 let draft:BusinessConfigurationDraft={id:randomUUID(),ownerId:owner,scope,revision:1,baseVersion:0,status:'draft',hash:businessConfigurationHash(candidate),candidate,createdAt:now,updatedAt:now}
 const {agent}=await ctx.agents.create({sessionId:SessionId('preview-'+randomUUID()),agentOptions:{provider:'controlled',model:'preview-test'}})
 ctx.provide('sessionController',{resolveAgent:async()=>({agent})} as never)
 const binding={requestId:randomUUID(),kind:'builder' as const,title:'场地预约',sessionId:agent.id,draftId:draft.id,createdAt:now,updatedAt:now}
 const formalWrites={configuration:0,employee:0,plan:0,connectionAuthorization:0};let draftWrites=0,loseReply=false,unrequestedTool=false,changeDuringModel:(()=>void)|undefined,reply:unknown
 const receipts=new Map<string,{spec:string;result:BusinessConfigurationDraft}>(),requests:GenerateOptions[]=[],errors:unknown[]=[]
 ctx.on('agent/error',({error})=>{errors.push(error)})
 for(const key of Object.keys(formalWrites) as (keyof typeof formalWrites)[])ctx.tools.register(defineTool({name:'formal_'+key,description:'Must never execute in preview',parameters:{},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},execute:async()=>{formalWrites[key]++;return 'unexpected'}}))
 const patch=()=>({upsertDefinitions:[{kind:'object-type',definition:{format:'teloa.business-object-type/v1',id:'booking',version:'1.0.0',domain:scope,title:'预约',unit:'项',lead:'跟进本人预约',sourceId:'local-bookings',fields:[{name:'subject',label:'主题',from:'主题',type:'text',required:true},{name:'guests',label:'来宾人数',from:'人数',type:'number',required:true,integer:true,minimum:0}]}}],upsertPages:[{id:'bookings',title:'预约',kind:'records',objectType:'booking',fields:['subject','guests'],allowCreate:true,allowEdit:true,allowArchive:true}],homePageId:'bookings'})
 reply=patch()
 class Model extends LlmAdapter{
  override async resolveModel(provider:string,model:string){return {provider,id:model,name:model,inputModalities:['text'] as const}}
  async *stream(options:GenerateOptions):AsyncIterable<StreamChunk>{
   requests.push(options);changeDuringModel?.();if(unrequestedTool){
    yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'tool-call-delta',index:0,id:'unexpected-call' as never,name:'formal_configuration',argumentsDelta:'{}'};yield {type:'block-end',index:0,block:{type:'tool-call',id:'unexpected-call' as never,name:'formal_configuration',arguments:'{}'}};yield {type:'finish',reason:{kind:'tool-calls'}};return
   };const text=typeof reply==='string'?reply:JSON.stringify(reply)
   yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'finish',reason:{kind:'stop'}}
  }
 }
 ctx.llm.registerAdapter(['controlled'],new Model())
 const ports:BusinessBuilderToolsPorts={owner,conversation:async sessionId=>({ownerId:owner,sessionId,status:'ready'}),readTaskPolicy:async()=>null,isRoleConversation:async()=>false,isTaskConversation:async()=>false,binding:async()=>binding,draft:async()=>draft,
  reviseReceipt:async input=>{const prior=receipts.get(input.requestId);if(prior&&prior.spec!==JSON.stringify(input))throw new WorkError('teloa/conflict','request changed');return prior?.result},
  revise:async input=>{
   assert.equal(input.draftId,draft.id);assert.equal(input.expectedRevision,draft.revision)
   const next=readBusinessConfigurationCandidateVersioned({...draft.candidate,title:input.patch.title??draft.candidate.title,definitions:input.patch.upsertDefinitions??draft.candidate.definitions,pages:input.patch.upsertPages??draft.candidate.pages,homePageId:input.patch.homePageId??draft.candidate.homePageId})
   draft={...draft,revision:draft.revision+1,candidate:next,hash:businessConfigurationHash(next)};draftWrites++;receipts.set(input.requestId,{spec:JSON.stringify(input),result:draft});if(loseReply)throw Error('reply lost after commit');return draft
  },upgradeFormat:async()=>{throw Error('not a preview operation')}}
 let register=registerBusinessBuilderPreview
 if(native){
  // 与正常打包一样，将这份未改写生产源码解析到同一受管 Session 包；不替换产品逻辑或追加许可。
  const origin=new URL('../src/business-builder-preview.ts',import.meta.url),require=createRequire(origin),temporary=await mkdtemp(join(tmpdir(),'teloa-preview-graph-'));t.after(()=>rm(temporary,{recursive:true,force:true}))
  const source=(await readFile(origin,'utf8')).replace(/from (['"])([^'"]+)\1/g,(original,_quote,specifier:string)=>specifier.startsWith('node:')?original:'from '+JSON.stringify(specifier==='@deepseek-ai/dsh-session'?native.sessionPackage.moduleUrl:specifier.startsWith('.')?new URL(specifier,origin).href:pathToFileURL(require.resolve(specifier)).href))
  const file=join(temporary,'business-builder-preview.ts');await writeFile(file,source);register=(await import(pathToFileURL(file).href)).registerBusinessBuilderPreview
 }
 let host=register(ctx,ports);registerBusinessBuilderTools(ctx,{...ports,previewOnly:host.isPreviewOnly})
 const mode=(value:'preview'|'assisted',requestId=randomUUID())=>host.mode({action:'set',sessionId:agent.id,draftId:draft.id,expectedRevision:draft.revision,requestId,mode:value})
 const readMode=()=>host.mode({action:'read',sessionId:agent.id,draftId:draft.id})
 const run=async(text='做一个预约清单，来宾人数只允许非负整数。只看草案，不采用或授权。')=>{const rpcId=randomUUID(),message=createUserMessage({source:{kind:'user',rpcId:rpcId as never},content:[{type:'text',text}]});if(native)await native.work.withNewInput(agent,message,{producer:'prompt',identity:rpcId},()=>agent.followup(message));else agent.followup(message);await agent.whenIdle()}
 return {ctx,agent,ports,requests,formalWrites,errors,mode,readMode,callMode:(payload:unknown)=>host.mode(payload),run,patch,draft:()=>draft,draftWrites:()=>draftWrites,reply:(v:unknown)=>{reply=v},unrequestedTool:()=>{unrequestedTool=true},during:(fn:()=>void)=>{changeDuringModel=fn},mutate:(fn:(d:BusinessConfigurationDraft)=>BusinessConfigurationDraft)=>{draft=fn(draft)},lost:()=>{loseReply=true},restore:()=>{host.dispose();host=register(ctx,ports)}}
}
test('真实原生模型回包patch由host校验并仅存同草案；模型tools为空，四类正式写集0',async t=>{
 const f=await fixture(t);await f.mode('preview');await f.run()
 assert.deepEqual(f.errors,[]);assert.equal(f.requests.length,1);assert.equal(f.requests[0]!.tools?.length??0,0);assert.equal(f.draftWrites(),1);assert.equal(f.draft().revision,2);assert.equal(f.draft().status,'draft');assert.equal(f.draft().candidate.pages[0]!.id,'bookings')
 assert.ok(JSON.stringify(f.requests[0]!.messages).includes('来宾人数只允许非负整数'));assert.ok(JSON.stringify(f.requests[0]!.messages).includes('local-bookings'));assert.doesNotMatch(JSON.stringify(f.requests[0]!.messages),/formal_configuration|当前业务搭建草案/)
 assert.deepEqual(f.formalWrites,{configuration:0,employee:0,plan:0,connectionAuthorization:0});assert.equal(readSessionEvents(f.agent.session).filter(e=>e.type==='tool/call').length,0)
})
test('非法JSON/patch不能写草案或正式集合',async t=>{
 for(const value of ['not json',{owner:'other',patch:{}},{upsertDefinitions:[{kind:'object-type',definition:{bad:true}}]}]){
  const f=await fixture(t);await f.mode('preview');f.reply(value);await f.run();assert.equal(f.requests.length,1);assert.equal(f.draftWrites(),0);assert.equal(f.draft().revision,1);assert.ok(f.errors.length);assert.ok(Object.values(f.formalWrites).every(x=>x===0))
 }
})
test('生成期间owner/revision改变均拒绝采用，原用户状态不被覆盖',async t=>{
 for(const kind of ['owner','revision']){
  const f=await fixture(t);await f.mode('preview');f.during(()=>f.mutate(d=>kind==='owner'?{...d,ownerId:'other'}:{...d,revision:d.revision+1,hash:'b'.repeat(64)}));await f.run();assert.equal(f.draftWrites(),0);assert.ok(f.errors.length);assert.ok(Object.values(f.formalWrites).every(x=>x===0))
 }
})
test('commit后回包未知只读恢复同id/revision，不再发模型或覆盖草案',async t=>{
 const f=await fixture(t);await f.mode('preview');f.lost();const id=f.draft().id;await f.run();assert.equal(f.draftWrites(),1);assert.equal(f.draft().revision,2);assert.ok(f.errors.length)
 f.restore();assert.equal((await f.readMode()).mode,'preview');assert.equal(f.draft().id,id);assert.equal(f.draft().revision,2);assert.equal(f.requests.length,1);assert.ok(Object.values(f.formalWrites).every(x=>x===0))
})
test('取消生成不提交patch；重新读取意图/草案不重放模型，明确assisted仍保留原工具路径',async t=>{
 const f=await fixture(t);await f.mode('preview');f.during(()=>f.agent.cancel('user' as never));await f.run();assert.equal(f.draftWrites(),0);assert.equal(f.draft().revision,1)
 f.restore();assert.equal((await f.readMode()).mode,'preview');assert.equal(f.requests.length,1)
 await f.mode('assisted');assert.equal((await f.readMode()).mode,'assisted');assert.ok(f.ctx.tools.get('teloa_business_builder_revise'));assert.ok(Object.values(f.formalWrites).every(x=>x===0))
})
test('mode原请求幂等与same owner/draft/revision；额外授权字段和越权目标均拒绝',async t=>{
 const f=await fixture(t),id=randomUUID();await f.mode('preview',id);await f.mode('preview',id)
 await assert.rejects(f.mode('assisted',id),{code:'teloa/conflict'})
 const payload={action:'read',sessionId:f.agent.id,draftId:f.draft().id}
 await assert.rejects(f.callMode({...payload,owner:'other'}),{code:'teloa/invalid-input'})
 await assert.rejects(f.callMode({...payload,draftId:randomUUID()}),{code:'teloa/forbidden'})
 await assert.rejects(f.callMode({...payload,sessionId:'other-session'}),{code:'teloa/forbidden'})
 await assert.rejects(f.callMode({action:'set',sessionId:f.agent.id,draftId:f.draft().id,requestId:randomUUID(),expectedRevision:2,mode:'preview'}),{code:'teloa/version-conflict'})
 assert.equal(f.requests.length,0);assert.equal(f.draftWrites(),0)
})

test('完整原生最终受理/因果/模型准入与未绑定项目守卫中预览仍零工具，仅host草案保存',async t=>{
 const f=await fixture(t,true);await f.mode('preview');await f.run()
 assert.deepEqual(f.errors,[]);assert.equal(f.requests.length,1);assert.equal(f.requests[0]!.tools?.length??0,0);assert.equal(f.draftWrites(),1);assert.equal(f.draft().revision,2)
 assert.ok(Object.values(f.formalWrites).every(value=>value===0));assert.equal(readSessionEvents(f.agent.session).filter(e=>e.type==='tool/call').length,0)
 assert.equal(readSessionEvents(f.agent.session).filter(e=>e.type==='turn/end').at(-1)?.data.reason.kind,'completed')
})

test('模型在零工具请求中伪造工具调用仍不执行，不能借错误回合继续模型或保存草案',async t=>{
 const f=await fixture(t,true);await f.mode('preview');f.unrequestedTool();await f.run()
 assert.equal(f.requests.length,1);assert.equal(f.requests[0]!.tools?.length??0,0);assert.equal(f.draftWrites(),0);assert.ok(Object.values(f.formalWrites).every(value=>value===0));assert.ok(f.errors.length)
})

test('新预览请求只含本次原文和可信当前schema，不携带旧会话指令或旧失败答案',async t=>{
 const f=await fixture(t,true);await f.mode('preview');f.reply('OLD-INVALID-REPLY-AC41');await f.run('OLD-OWNER-INSTRUCTION-AC41')
 assert.equal(f.draftWrites(),0);f.reply(f.patch());await f.run('本次只生成场地预约清单。')
 assert.equal(f.requests.length,2);assert.doesNotMatch(JSON.stringify(f.requests[1]!.messages),/OLD-INVALID-REPLY-AC41|OLD-OWNER-INSTRUCTION-AC41/)
 assert.match(JSON.stringify(f.requests[1]!.messages),/本次只生成场地预约清单/);assert.match(JSON.stringify(readSessionEvents(f.agent.session)),/OLD-INVALID-REPLY-AC41/);assert.equal(f.draftWrites(),1);assert.ok(Object.values(f.formalWrites).every(value=>value===0))
})
