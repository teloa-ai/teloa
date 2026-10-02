import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {Context} from '@deepseek-ai/cordis'
import {AgentRegistry,type ModelSelection} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {LlmRuntime,LlmAdapter,LlmError,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SessionController} from '@deepseek-ai/dsh-api-session-controller'
import * as SessionModelScope from '../src/native-session-model.ts'
import TeloaAttachmentStore from '../src/attachment-guard.ts'
import {tempHome} from './fixtures/credentials.ts'

const require=createRequire(import.meta.url)
const officialRequire=createRequire(require.resolve('@deepseek-ai/dsh-api-session-controller/package.json'))
const gatewayRequire=createRequire(officialRequire.resolve('@deepseek-ai/dsh-api-gateway/package.json'))
const {default:TypertRegistry}=await import(gatewayRequire.resolve('@deepseek-ai/dsh-typert-registry'))
const {default:TypertGateway}=await import(officialRequire.resolve('@deepseek-ai/dsh-api-gateway'))

class Adapter extends LlmAdapter{
 override async listModels(provider:string){
  return ['original','small','specialist','large','slow','after-failure','local-only','native-again','text-only'].map(id=>({provider,id,name:id,inputModalities:['text'] as const}))
 }
 beforeResolve:(model:string)=>Promise<void>=async()=>{}
 requests:GenerateOptions[]=[]
 override async resolveModel(provider:string,model:string){
  await this.beforeResolve(model)
  if(model==='missing')throw new LlmError('missing','UNKNOWN_MODEL')
  return {provider,id:model,name:model,inputModalities:['text'] as const}
 }
 async *stream(options:GenerateOptions):AsyncIterable<StreamChunk>{
  this.requests.push(options)
  yield {type:'block-start',index:0,blockType:'text'}
  yield {type:'text-delta',index:0,text:'done'}
  yield {type:'block-end',index:0,block:{type:'text',text:'done'}}
  yield {type:'finish',reason:{kind:'stop'}}
 }
}

/** 真实 Controller/Remote/AgentLoop；仅模型提供方和宿主外围文件入口用内存夹具。 */
async function fixture(t:TestContext){
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry)
 await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 await ctx.plugin(TeloaAttachmentStore,{dshHome:await tempHome(t)})
 await ctx.plugin(TypertRegistry);await ctx.plugin(TypertGateway)
 let selected:ModelSelection={provider:'test',model:'original'}
 const saves:ModelSelection[]=[]
 ctx.provide('agentDefaultModel',{currentSelection:()=>({...selected}),saveSelection:async(next:ModelSelection)=>{saves.push(next);selected={...next}}})
 ctx.provide('fileUploads',{registerAgentResolver:()=>()=>{},bindPrompt:()=>({commit(){},[Symbol.dispose](){}})})
 ctx.provide('fs',{})
 ctx.provide('sessionQuery',{})
 ctx.provide('workspaceRegistry',{archivedSessionIds:[]})
 ctx.provide('teloaSessionModelScope',{isIdentityLinked:async(id:string)=>id!=='ordinary'})
 const adapter=new Adapter();ctx.llm.registerAdapter(['test'],adapter)
 await ctx.plugin(SessionController,{nativeOpen:false})
 const scopePlugin=ctx.plugin(SessionModelScope);await scopePlugin
 const agents=await Promise.all(['twin','employee','ordinary'].map(async id=>(await ctx.agents.create({sessionId:SessionId(id),agentOptions:{provider:'test',model:'original'}})).agent))
 const gateway=Reflect.get(ctx,'typertGateway') as {invoke(request:{namespace:string;method:string;args:Record<string,unknown>}):Promise<unknown>}
 const select=(id:string,model:string)=>gateway.invoke({namespace:'session',method:'selectModel',args:{request:{sessionId:id,provider:'test',model}}})
 return {ctx,adapter,agents,saves,select,scopePlugin,defaultModel:()=>selected}
}

test('真实 Remote 选模只改身份会话，普通会话仍沿用官方默认保存',async t=>{
 const {ctx,agents,saves,select,defaultModel}=await fixture(t)
 await select('twin','small');await select('employee','specialist')
 assert.deepEqual(saves,[]);assert.equal(defaultModel().model,'original')
 assert.equal(ctx.agentDefaultModel.currentSelection().model,'original','其他原生服务读到的默认不变')
 assert.equal(agents[0]!.session.snapshotEvents().find(event=>event.type==='model/selection')?.data.model,'small')
 assert.equal(agents[1]!.session.snapshotEvents().find(event=>event.type==='model/selection')?.data.model,'specialist')
 await select('ordinary','large');assert.equal(defaultModel().model,'large');assert.equal(saves.length,1)
})

test('并发会话的默认写入边界互不污染，失败后请求作用域释放',async t=>{
 const {adapter,select,saves,defaultModel}=await fixture(t)
 let start!:()=>void,release!:()=>void
 const started=new Promise<void>(resolve=>{start=resolve}),blocked=new Promise<void>(resolve=>{release=resolve})
 adapter.beforeResolve=async model=>{if(model==='slow'){start();await blocked}}
 const twin=select('twin','slow');await started
 await select('ordinary','large');release();await twin
 assert.deepEqual(saves,[{provider:'test',model:'large'}]);assert.equal(defaultModel().model,'large')
 await assert.rejects(select('twin','missing'),(error:any)=>error.code==='session/model-unavailable')
 await select('ordinary','after-failure');assert.equal(defaultModel().model,'after-failure')
})

test('归属查询失败不退回全局写入，原生会话选择仍可使用',async t=>{
 const {ctx,select,saves,agents}=await fixture(t)
 ctx.teloaSessionModelScope.isIdentityLinked=async()=>{throw Error('database unavailable')}
 await select('ordinary','local-only');assert.deepEqual(saves,[])
 assert.equal(agents[2]!.session.snapshotEvents().find(event=>event.type==='model/selection')?.data.model,'local-only')
})

test('插件卸载还原公开方法，重新挂载不会叠加失效包装',async t=>{
 const {ctx,scopePlugin,select,saves,defaultModel}=await fixture(t)
 await scopePlugin.dispose()
 await select('twin','native-again');assert.equal(defaultModel().model,'native-again')
 await ctx.plugin(SessionModelScope)
 await select('twin','small');assert.equal(saves.length,1);assert.equal(defaultModel().model,'native-again')
})

test('插件卸载等待在途选择，不让已开始的身份会话误写默认',async t=>{
 const {adapter,scopePlugin,select,saves}=await fixture(t)
 let start!:()=>void,release!:()=>void
 const started=new Promise<void>(resolve=>{start=resolve}),blocked=new Promise<void>(resolve=>{release=resolve})
 adapter.beforeResolve=async()=>{start();await blocked}
 const selection=select('twin','slow');await started
 const disposing=scopePlugin.dispose();release();await selection;await disposing
 assert.deepEqual(saves,[])
})

test('实际原生发送使用会话缓存选模，失效选择不覆盖有效选择',async t=>{
 const {ctx,select,adapter,agents,saves}=await fixture(t)
 await select('twin','small')
 await assert.rejects(select('twin','missing'))
 await ctx.sessionController.prompt({sessionId:SessionId('twin'),requestId:'scoped-prompt' as never,mode:'queue',content:[{type:'text',text:'hello'}]},new AbortController().signal)
 await agents[0]!.whenIdle()
 assert.equal(adapter.requests.at(-1)?.model,'small',JSON.stringify(agents[0]!.session.snapshotEvents().filter(event=>event.type==='turn/end')));assert.deepEqual(saves,[])
 assert.equal(agents[0]!.session.snapshotEvents().filter(event=>event.type==='model/selection').length,1)
})

test('原生图片准入读取身份会话的选择，不绕过图片能力校验',async t=>{
 const {ctx,select,adapter,agents}=await fixture(t)
 await select('twin','text-only')
 await assert.rejects(ctx.sessionController.prompt({sessionId:SessionId('twin'),requestId:'image' as never,mode:'queue',content:[{type:'image',mediaType:'image/png',data:'invalid-image'}]},new AbortController().signal),(error:any)=>error.code==='session/attachment-invalid'&&error.details.reason==='MODEL_DOES_NOT_SUPPORT_IMAGES')
 assert.equal(adapter.requests.length,0)
 assert.equal(agents[0]!.session.snapshotEvents().filter(event=>event.type==='user/message').length,0)
})
