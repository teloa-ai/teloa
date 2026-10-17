import assert from 'node:assert/strict'
import type {TestContext} from 'node:test'
import {createRequire,registerHooks} from 'node:module'
import {mkdtemp,readFile,realpath,rm,mkdir} from 'node:fs/promises'
import {join} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {parse} from 'yaml'
import {Context} from '@deepseek-ai/cordis'
import {LlmAdapter,ToolCallId,createUserMessage,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {SessionId} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {patchedCorePackages} from './native-final-session.ts'
import ProjectWorkingDirectory from '../../src/native-working-directory-guard.ts'
import {official,textResponse} from '../../../../tests/native-auto-review-fixture.mjs'

/** 原生完整 Loop/Tools/Session 与官方真实子进程，仅模型 IO 使用逐次脚本。 */
export async function nativePtcToolPath(t:TestContext){
 // 宿主平台允许部分系统临时目录写入；沙箱拒写验收必须置于项目测试目录。
 const base=fileURLToPath(new URL('../../../../.runtime/',import.meta.url));await mkdir(base,{recursive:true})
 const root=await realpath(await mkdtemp(join(base,'teloa-u4-tool-path-'))),workspace=join(root,'project')
 await mkdir(workspace)
 const graph=await patchedCorePackages(t,{toolsCompat:'dsh-tools-0.2.1-rc.2-scoped-ptc'}),ctx=new Context()
 t.after(async()=>{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true})})
 for(const plugin of [graph.llmPackage.LlmRuntime,graph.sessionPackage.SessionStore,SessionProjectionRegistry,SystemPrompt,graph.toolsPackage.ToolRuntime,graph.agentPackage.AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(graph.loopPackage.AgentLoop,{agents:[]})
 await ctx.plugin((await official('dsh-user-approval')).default,{policy:'ask'})
 await ctx.plugin((await official('dsh-sandbox-policy')).default,{mode:'workspace-write',workspaceRoot:workspace})
 await ctx.plugin((await official('dsh-fs-sandbox')).default,{})
 await ctx.plugin((await official('dsh-subprocess-local')).default)
 await ctx.plugin((await official('dsh-sandbox-local')).default,{})
 await ctx.plugin((await official('dsh-ptc-runtime-node')).default,{})
 await ctx.plugin(ProjectWorkingDirectory,{defaultDirectory:workspace})
 ctx.provide('shell',{sandboxMode:'workspace-write'} as never)
 await ctx.plugin((await official('dsh-permission-presets')).default,{presets:{'read-only':{sandbox:'read-only',approval:'ask'},'workspace-write':{sandbox:'workspace-write',approval:'ask'}}})
 class Scripted extends LlmAdapter{
  requests:GenerateOptions[]=[]
  scripts=new Map<string,StreamChunk[][]>()
  override async resolveModel(provider:string,model:string){return {provider,id:model,name:model,defaultMaxTokens:1024}}
  async *stream(options:GenerateOptions){this.requests.push(options);const script=this.scripts.get(String(options.sessionId))?.shift();assert.ok(script,'禁止未脚本化模型调用');yield* script}
 }
 const adapter=new Scripted();ctx.llm.registerAdapter(['u4-scripted'],adapter)
 const require=createRequire(import.meta.url),anchor=createRequire(require.resolve('@deepseek-ai/dsh/package.json'))
 // 允许未安装新依赖的源码树借用本轮登记的同版本官方输入；候选验证不设此变量。
 const providers=createRequire(process.env.TELOA_TEST_PTC_PROVIDER_ANCHOR??new URL('../../package.json',import.meta.url))
 const local='@teloa/harness-dsh/native-ptc-selection',localUrl=new URL('../../src/native-ptc-selection.ts',import.meta.url).href
 const resolve=(name:string)=>name===local?localUrl:pathToFileURL((name.includes('ptc-runtime-python')?providers:anchor).resolve(name)).href
 const hook=registerHooks({resolve:(name,context,next)=>{if(name===local||name.startsWith('@deepseek-ai/')){try{return {url:resolve(name),shortCircuit:true}}catch{}}return next(name,context)}})
 t.after(()=>hook.deregister())
 const {Loader,Group}=await official('cordis-plugin-loader')
 class PresetLoader extends Loader{write(){};async import(name:string){return import(resolve(name))}}
 await ctx.plugin(PresetLoader)
 ctx.loader.builtins.group=Group
 const rows=[]
 for(const id of ['ptc','ptc-persistent','ptc-python']){
  const parsed=parse(await readFile(new URL('../../../bundle/agent-presets/'+id+'.patch.yml',import.meta.url),'utf8'),{customTags:[{tag:'tag:yaml.org,2002:js',resolve:(value:string)=>({__jsExpr:value})}]})
  const declaration=id==='ptc'?{id:'preset-ptc',name:'@deepseek-ai/dsh-agent-preset',config:parsed[0].config}:parsed[0].insert[0]
  // 本定向图逐字消费选定 provider/binding/presentation 和原 agent-instructions；其他工具按测试明确装配。
  declaration.config.plugins=declaration.config.plugins.filter((row:{id:string})=>['selected-code-runtime','tool-presentation','agent-instructions'].includes(row.id))
  rows.push(declaration)
 }
 await ctx.loader.root.update([{id:'registry',name:'@deepseek-ai/dsh-agent-preset-registry',config:{default:'ptc'}},...rows]);await ctx.loader.await()
 for(const id of ['ptc','ptc-persistent','ptc-python'])assert.equal((await ctx.agentPresets.resolve(id)).broken,undefined,id)
 let calls=0
 const handles=new WeakMap<Agent,{dispose:()=>Promise<void>}>()
 const create=async(preset:string,id=preset+'-'+Math.random().toString(36).slice(2))=>{
  const handle=await ctx.agents.create({sessionId:SessionId(id),meta:{cwd:workspace},agentOptions:{provider:'u4-scripted',model:'tools'},setup:async scope=>{await ctx.agentPresets.mount(scope,preset)}})
  handles.set(handle.agent,handle);return handle.agent
 }
 const invoke=async(agent:Agent,name:string,args:Record<string,unknown>,signal=AbortSignal.timeout(15000))=>{
  const id=ToolCallId('u4-'+ ++calls),argumentsText=JSON.stringify(args)
  adapter.scripts.set(String(agent.id),[[{type:'block-start',index:0,blockType:'tool-call'},{type:'tool-call-delta',index:0,id,name,argumentsDelta:argumentsText},{type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:argumentsText}},{type:'finish',reason:{kind:'tool-calls'}}],textResponse('done')])
  const abort=()=>agent.cancel({kind:'user'});signal.addEventListener('abort',abort,{once:true})
  try{
   signal.throwIfAborted();agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'本轮已授权工具路径验证'}]}));await agent.whenIdle()
   const event=agent.session.snapshotEvents().find(event=>event.type==='tool/result'&&event.data.message.toolCallId===id)
   assert.ok(event?.type==='tool/result','真实 Loop 必须记录工具回执');return event.data.message
  }finally{signal.removeEventListener('abort',abort)}
 }
 const run=(agent:Agent,code:string,signal?:AbortSignal)=>invoke(agent,'run_code',{description:'本轮代码工具验证',code},signal)
 return {ctx,root,workspace,adapter,create,invoke,run,graph,dispose:async(agent:Agent)=>{const handle=handles.get(agent);assert.ok(handle);await handle.dispose()}}
}
