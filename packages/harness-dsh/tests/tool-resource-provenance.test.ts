import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createRequire,registerHooks} from 'node:module'
import {parse} from 'yaml'
import {Context} from '@deepseek-ai/cordis'
import {LlmRuntime,ToolCallId} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime,defineTool,type ToolExecutionResult} from '@deepseek-ai/dsh-tools'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SkillRegistry} from '@deepseek-ai/dsh-skill'
import {getToolResourceProvenance,type ToolResourceUseSnapshot} from '../src/tool-resource-provenance.ts'
import * as resourcePlugin from '../src/tool-resource-provenance.ts'
import {createManagedMcpConnectionHandler,type ManagedConnectorEntry} from '../src/managed-mcp-connections.ts'

const source=(providerId:string)=>({kind:'plugin' as const,providerId,name:'扩展 '+providerId})
const tool=(name='work',presentationMeta:unknown={nativeField:'保留'} ,body:()=>Promise<string>=async()=> '实际结果')=>defineTool({name,description:'来源测试工具',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}],presentationMeta:()=>presentationMeta as never},execute:body})
const meta=(result:ToolExecutionResult)=>result.meta as Record<string,unknown>|undefined
async function fixture(t:TestContext,mode:'native'|'both'='native'){
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime,{mode});await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const provenance=getToolResourceProvenance(ctx)
 const create=async(id:string)=>(await ctx.agents.create({sessionId:SessionId(id)})).agent
 const execute=(name='work',agent?:Awaited<ReturnType<typeof create>>,callId='call',args:unknown={})=>ctx.tools.execute({name,arguments:args,callId:ToolCallId(callId),signal:AbortSignal.timeout(5000),...(agent?{agent}:{})})
 return {ctx,provenance,create,execute}
}

test('包装实际注册定义，成功来源与原生meta字段同时返回',{timeout:10000},async t=>{
 const f=await fixture(t),wrapped=f.provenance.wrapContext(f.ctx,source('@fixture/plugin'))
 wrapped.tools.register(tool())
 const result=await f.execute()
 assert.equal(result.isError,false)
 assert.equal(meta(result)?.nativeField,'保留')
 assert.deepEqual(meta(result)?.teloaResourceUse,{schema:'teloa.resource-use/v1',kind:'plugin',providerId:'@fixture/plugin',name:'扩展 @fixture/plugin',toolName:'work',state:'used'})
})

test('读取真实Skill canonical provider，不解析渲染正文或工具名前缀',{timeout:10000},async t=>{
 const f=await fixture(t)
 const definition=defineTool({name:'opaque_loader',description:'真实加载器',parameters:{},output:{schema:{type:'object',properties:{provider:{type:'string',required:true},name:{type:'string',required:true}},additionalProperties:false},render:()=>[{type:'text',text:'正文没有可推断来源'}]},execute:async()=>({provider:'managed-provider',name:'report'})})
 f.ctx.tools.register(f.provenance.wrapDefinition(definition,(_definition,_args,value)=>{const item=value as {provider:string;name:string};return {kind:'skill',providerId:item.provider,name:item.name,state:'read'}}))
 assert.deepEqual(meta(await f.execute('opaque_loader'))?.teloaResourceUse,{schema:'teloa.resource-use/v1',kind:'skill',providerId:'managed-provider',name:'report',toolName:'opaque_loader',state:'read'})
})

test('拒绝、失败、取消与around短路不会宣称工具已使用',{timeout:10000},async t=>{
 const f=await fixture(t);let bodies=0
 f.ctx.tools.register(f.provenance.wrapDefinition(tool('work',{nativeField:true},async()=>{bodies++;return 'actual'}),source('actual')))
 const deny=f.ctx.on('tools/pre-execute',async()=>({kind:'deny',reason:'隔离测试拒绝'}))
 const denied=await f.execute();assert.equal(denied.isError,true);assert.equal(meta(denied)?.teloaResourceUse,undefined);deny()
 const shortcut=f.ctx.on('tools/execute',async()=>({isError:false,value:'合成结果',content:[{type:'text',text:'合成结果'}]}))
 const synthetic=await f.execute();assert.equal(synthetic.isError,false);assert.equal(meta(synthetic)?.teloaResourceUse,undefined);shortcut()
 assert.equal(bodies,0)
 f.ctx.tools.register(f.provenance.wrapDefinition(tool('failed',undefined,async()=>{throw Error('实际失败')}),source('failed')))
 const failed=await f.execute('failed');assert.equal(failed.isError,true);assert.equal(meta(failed)?.teloaResourceUse,undefined)
 const block=f.ctx.on('tools/post-execute',async()=>({kind:'block',feedback:[{type:'text',text:'结果策略阻止'}]}))
 const blocked=await f.execute();assert.equal(blocked.isError,true);assert.equal(meta(blocked)?.teloaResourceUse,undefined);block()
 const controller=new AbortController();controller.abort()
 const cancelled=await f.ctx.tools.execute({name:'work',arguments:{},callId:ToolCallId('cancelled'),signal:controller.signal})
 assert.equal(cancelled.isError,true);assert.equal(meta(cancelled)?.teloaResourceUse,undefined)
})

test('scope shadow和重载均按真实执行定义归属，在途旧定义不变成新provider',{timeout:10000},async t=>{
 const f=await fixture(t),agent=await f.create('scoped-agent')
 let release!:()=>void,entered!:()=>void
 const wait=new Promise<void>(resolve=>{release=resolve}),started=new Promise<void>(resolve=>{entered=resolve})
 const remove=f.ctx.tools.register(f.provenance.wrapDefinition(tool('work',{},async()=>{entered();await wait;return '旧定义结果'}),source('old')))
 agent.ctx.tools.register(f.provenance.wrapDefinition(tool(),source('scoped')))
 assert.deepEqual(meta(await f.execute('work',agent))?.teloaResourceUse,{schema:'teloa.resource-use/v1',kind:'plugin',providerId:'scoped',name:'扩展 scoped',toolName:'work',state:'used'})
 const pending=f.execute();await started;remove()
 f.ctx.tools.register(f.provenance.wrapDefinition(tool(),source('new')))
 release();assert.deepEqual(meta(await pending)?.teloaResourceUse,{schema:'teloa.resource-use/v1',kind:'plugin',providerId:'old',name:'扩展 old',toolName:'work',state:'used'})
 assert.deepEqual(meta(await f.execute())?.teloaResourceUse,{schema:'teloa.resource-use/v1',kind:'plugin',providerId:'new',name:'扩展 new',toolName:'work',state:'used'})
})

test('原生非对象JsonValue meta完整保留，已注册固定模块可显式按对象装配',{timeout:10000},async t=>{
 const f=await fixture(t),definition=tool('existing',['完整',42,false])
 f.ctx.tools.register(definition)
 f.provenance.instrumentExisting(definition,source('fixed-module'))
 const result=await f.execute('existing')
 assert.deepEqual(meta(result)?.teloaNativeMeta,['完整',42,false])
 assert.deepEqual(meta(result)?.teloaResourceUse,{schema:'teloa.resource-use/v1',kind:'plugin',providerId:'fixed-module',name:'扩展 fixed-module',toolName:'existing',state:'used'})
})

test('真实PTC bridge将成功子调用汇入各自outer meta，同callId不同agent不混并发',{timeout:10000},async t=>{
 const f=await fixture(t,'both'),one=await f.create('ptc-one'),two=await f.create('ptc-two')
 const runtime={language:'typescript',isolation:'fixture',resolve:(request:unknown)=>request,run:async(spec:{bindings:Array<{functions:Record<string,(args:Record<string,unknown>)=>Promise<unknown>>}>})=>({logs:[],value:await spec.bindings[0]!.functions.work!({})})}
 f.ctx.provide('ptcRuntime',runtime as never)
 one.ctx.tools.register(f.provenance.wrapDefinition(tool(),source('one')))
 two.ctx.tools.register(f.provenance.wrapDefinition(tool(),source('two')))
 const [first,second]=await Promise.all([f.execute('run_code',one,'same-root',{code:'fixture',description:'并发来源一'}),f.execute('run_code',two,'same-root',{code:'fixture',description:'并发来源二'})])
 assert.equal(first.isError,false,JSON.stringify(first));assert.equal(second.isError,false,JSON.stringify(second))
 const rows=(result:ToolExecutionResult)=>meta(result)?.teloaResourceUses as Array<{providerId:string;callId:string;rootCallId:string}>
 assert.deepEqual(rows(first)?.map(row=>[row.providerId,row.callId,row.rootCallId]),[['one','same-root:ptc:1','same-root']])
 assert.deepEqual(rows(second)?.map(row=>[row.providerId,row.callId,row.rootCallId]),[['two','same-root:ptc:1','same-root']])
 for(const agent of [one,two])assert.equal(agent.session.snapshotEvents().filter(event=>event.type==='tool/ptc-dispatch').length,1,'由真实DSH桥生成结算事件')
})

test('真实PTC成功子调用来源经独立snapshot保存，outer失败或取消不抹掉事实、不改变模型消息',{timeout:10000},async t=>{
 const f=await fixture(t,'both'),controller=new AbortController(),rows:ToolResourceUseSnapshot[]=[]
 f.provenance.onNestedUse(async row=>{rows.push(JSON.parse(JSON.stringify(row)))})
 const runtime={language:'typescript',isolation:'fixture',resolve:(request:unknown)=>request,run:async(spec:{program:string;bindings:Array<{functions:Record<string,(args:Record<string,unknown>)=>Promise<unknown>>}>})=>{
  await spec.bindings[0]!.functions.work!({})
  if(spec.program==='取消'){controller.abort('本人停止');throw new DOMException('本人停止','AbortError')}
  throw new Error('outer 后续执行失败')
 }}
 f.ctx.provide('ptcRuntime',runtime as never)
 for(const mode of ['失败','取消']){
  const agent=await f.create('ptc-snapshot-'+mode)
  agent.ctx.tools.register(f.provenance.wrapDefinition(tool(),source(mode)))
  agent.session.append('tool/call',{turn:1,step:0,callId:ToolCallId('outer'),name:'run_code',arguments:JSON.stringify({code:mode,description:mode})})
  const before=agent.session.deriveMessages()
  const result=await f.ctx.tools.execute({name:'run_code',arguments:{code:mode,description:mode},callId:ToolCallId('outer'),signal:mode==='取消'?controller.signal:AbortSignal.timeout(5000),agent})
  assert.equal(result.isError,true)
  assert.equal(controller.signal.aborted,mode==='取消')
  const row=rows.find(item=>item.sessionId===agent.session.id)
  assert.equal(row?.schema,'teloa.resource-use-snapshot/v1')
  assert.equal(row?.parentCallSeq,0)
  assert.equal(row?.use.providerId,mode)
  const settled=agent.session.snapshotEvents().find(event=>event.type==='tool/ptc-dispatch')
  assert.equal(settled?.data.isError,false)
  assert.deepEqual(settled?.data.content,[{type:'text',text:'实际结果'}])
  assert.deepEqual(agent.session.deriveMessages(),before)
  assert.equal(agent.session.snapshotEvents().some(event=>event.type==='teloa/resource-use' as never),false)
 }
 assert.equal(rows.length,2)
})

test('真实受管MCP注册和成功执行写入稳定server来源，重连后仍保留raw公开工具名',{timeout:10000},async t=>{
 const f=await fixture(t),root=await mkdtemp(join(tmpdir(),'teloa-resource-mcp-'))
 t.after(()=>rm(root,{recursive:true,force:true}))
 const entry:ManagedConnectorEntry={format:'teloa.market-catalog-entry/v1' as const,id:'test.resource-mcp',kind:'connector' as const,delivery:'managed' as const,version:'1.0.0',taxonomy:{functions:['automation'],industries:['general']},upstream:null,connector:{serverName:'resource_fixture',title:{'zh-CN':'真实参考连接',en:'Reference connection'},summary:{'zh-CN':'隔离来源验收',en:'Isolated provenance check'},auth:{kind:'none' as const},recipe:{transport:'stdio' as const,package:'@teloa/mcp-reference',version:'1.0.0',integrity:'sha512-'+'A'.repeat(86)+'==',bin:'lib/main.js',args:[]},tools:[{name:'list_references',description:{'zh-CN':'列出参考资料',en:'List references'},readOnly:true}],upstreamUrl:'https://example.com'},modifications:[],license:{spdx:'MIT',files:['LICENSE']},compatibility:{status:'verified' as const,teloa:'>=0.2.0-alpha.6',dsh:'0.2.0-rc.2',conditions:[]},requires:{tools:[],network:false,runtimes:[]},review:{status:'approved' as const,reviewedAt:'2026-10-07',reviewer:'Teloa'}}
 const {handler}=createManagedMcpConnectionHandler(f.ctx,root,()=>entry,async()=>fileURLToPath(new URL('../../mcp-reference/lib/main.js',import.meta.url)))
 const connection=await handler('mcp-connections/add',{catalogId:entry.id}) as {id:string}
 for(let round=0;round<2;round++){
  await handler('mcp-connections/connect',{id:connection.id})
  const result=await f.execute('mcp__resource_fixture__list_references')
  assert.equal(result.isError,false,JSON.stringify(result))
  assert.deepEqual(meta(result)?.teloaResourceUse,{schema:'teloa.resource-use/v1',kind:'mcp',providerId:'resource_fixture',name:'真实参考连接',toolName:'mcp__resource_fixture__list_references',rawToolName:'list_references',state:'used'})
  await handler('mcp-connections/disconnect',{id:connection.id})
 }
})

test('真实Loader贡献按正在注册的Entry模块来源归属，reload更新来源且无Entry定义不猜插件',{timeout:10000},async t=>{
 const f=await fixture(t),require=createRequire(import.meta.resolve('@deepseek-ai/dsh-app-boot'))
 const {Loader}=await import(require.resolve('@deepseek-ai/cordis-plugin-loader'))
 const modules=new Map<string,unknown>([['@fixture/one',{name:'资料扩展一',inject:['tools'],apply:(ctx:Context)=>{ctx.tools.register(tool())}}],['@fixture/two',{name:'资料扩展二',inject:['tools'],apply:(ctx:Context)=>{ctx.tools.register(tool());ctx.tools.register(f.provenance.wrapDefinition(tool('explicit'),source('explicit-provider')))}}]])
 class FixtureLoader extends Loader{write(){} import(name:string){return modules.get(name)}}
 await f.ctx.plugin(FixtureLoader)
 const id=await f.ctx.loader.create({name:'@fixture/one'})
 await f.ctx.loader.await()
 assert.deepEqual(meta(await f.execute())?.teloaResourceUse,{schema:'teloa.resource-use/v1',kind:'plugin',providerId:'@fixture/one',name:'资料扩展一',toolName:'work',state:'used'})
 const first=f.ctx.loader.resolve(id)
 // Loader 的 options 改名不会重跑 import；延迟注册仍归属于正在执行的旧 fiber。
 await first.update({name:'@fixture/two'})
 first.fiber!.ctx.tools.register(tool('late'))
 assert.equal((meta(await f.execute('late'))?.teloaResourceUse as {providerId:string}).providerId,'@fixture/one')
 await first.fiber!.dispose()
 f.ctx.loader.remove(id)
 await f.ctx.loader.create({name:'@fixture/two'})
 await f.ctx.loader.await()
 assert.deepEqual(meta(await f.execute())?.teloaResourceUse,{schema:'teloa.resource-use/v1',kind:'plugin',providerId:'@fixture/two',name:'资料扩展二',toolName:'work',state:'used'})
 f.ctx.tools.register(tool('unowned'))
 assert.equal(meta(await f.execute('unowned'))?.teloaResourceUse,undefined)
 const agent=await f.create('loader-scoped'),scoped=agent.ctx.isolate('loader')
 await scoped.plugin(FixtureLoader)
 const scopedLoader=scoped.get('loader')!
 await scopedLoader.create({name:'@fixture/one'})
 await scopedLoader.await()
 assert.equal((meta(await f.execute('work',agent))?.teloaResourceUse as {providerId:string}).providerId,'@fixture/one')
 assert.equal((meta(await f.execute())?.teloaResourceUse as {providerId:string}).providerId,'@fixture/two')
 assert.equal((meta(await f.execute('explicit'))?.teloaResourceUse as {providerId:string}).providerId,'explicit-provider','显式注册来源不被Loader通用来源覆盖')
 await f.ctx.plugin(SkillRegistry)
 f.ctx.skills.register({name:'source-skill',description:'真实技能读取',source:'runtime',provider:'actual-skill-provider',content:'实际技能正文'})
 modules.set('@deepseek-ai/dsh-tool-skill',await import('@deepseek-ai/dsh-tool-skill'))
 await f.ctx.loader.create({name:'@deepseek-ai/dsh-tool-skill'})
 await f.ctx.loader.await()
 assert.deepEqual(meta(await f.execute('skill',undefined,'read',{name:'source-skill'}))?.teloaResourceUse,{schema:'teloa.resource-use/v1',kind:'skill',providerId:'actual-skill-provider',name:'source-skill',toolName:'skill',state:'read'})
})

test('公开DI依赖先于首次默认预设资源注册，真实Loader的Skill和Web支持direct、PTC及outer取消',{timeout:10000},async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime,{mode:'both'});await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]});await ctx.plugin(SkillRegistry)
 const require=createRequire(import.meta.url),officialRequire=createRequire(require.resolve('@deepseek-ai/dsh/package.json'))
 const {Loader}=await import(officialRequire.resolve('@deepseek-ai/cordis-plugin-loader'))
 // 使用公开Node解析钩子，与发行安装的包解析相同，不改依赖目录。
 const officialModules=new Map(['@deepseek-ai/dsh-agent-preset-registry','@deepseek-ai/dsh-agent-preset','@deepseek-ai/dsh-web','@deepseek-ai/dsh-tool-skill','@deepseek-ai/dsh-tool-web'].map(name=>[name,pathToFileURL(officialRequire.resolve(name)).href]))
 const resolution=registerHooks({resolve:(specifier,context,next)=>{const url=officialModules.get(specifier);return url?{url,shortCircuit:true}:next(specifier,context)}})
 t.after(()=>resolution.deregister())
 const declaration=parse(await readFile(new URL('../../bundle/agent-presets/teloa-standard/agent.cordis.yml',import.meta.url),'utf8'),{customTags:[{tag:'tag:yaml.org,2002:js',resolve:(value:string)=>({__jsExpr:value})}]})[0].insert[0]
 // 本定向用例只装默认预设中原样的资源贡献行；不以它验收无关预设能力。
 const resourceRows=declaration.config.plugins.filter((row:{id:string})=>row.id==='tool-skill'||row.id==='tool-web')
 assert.deepEqual(resourceRows.map((row:{name:string})=>row.name),['@deepseek-ai/dsh-tool-skill','@deepseek-ai/dsh-tool-web'])
 let release!:()=>void,registryImported!:()=>void
 const sourceReady=new Promise<void>(resolve=>{release=resolve}),registryReady=new Promise<void>(resolve=>{registryImported=resolve})
 class PresetLoader extends Loader{
  write(){}
  async import(name:string){
   if(name==='@teloa/harness-dsh/tool-resource-provenance'){await sourceReady;return resourcePlugin}
   const module=await import(officialRequire.resolve(name))
   if(name==='@deepseek-ai/dsh-agent-preset-registry')registryImported()
   return module
  }
 }
 await ctx.plugin(PresetLoader)
 const {WebRuntime}=await import(officialRequire.resolve('@deepseek-ai/dsh-web'))
 await ctx.plugin(WebRuntime,{searchProvider:'isolated-search'})
 const sources=[{url:'https://example.test/result',title:'实际结果',snippet:'真实来源片段',publishedAt:'2026-10-07'}]
 const searched:string[]=[]
 ctx.get('web').registerSearchProvider({id:'isolated-search',available:()=>true,search:async({query}:{query:string})=>{searched.push(query);return {content:'真实搜索回答',sources,truncated:false}}})
 ctx.skills.register({name:'preset-skill',description:'真实技能',source:'runtime',provider:'actual-skill-provider',content:'实际技能正文'})
 const loading=ctx.loader.root.update([
  {id:'agent-preset-registry',name:'@deepseek-ai/dsh-agent-preset-registry',inject:['loader','sessionProjections','teloaToolResourceProvenance'],config:{default:declaration.config.id}},
  {...declaration,config:{...declaration.config,plugins:resourceRows}},
  {id:'resource-source',name:'@teloa/harness-dsh/tool-resource-provenance'},
 ])
 await registryReady
 assert.equal(ctx.get('agentPresets'),undefined,'registry真实模块已import，缺来源服务时不得构造/预加载')
 release();await loading;await ctx.loader.await()
 assert.ok(ctx.get('teloaToolResourceProvenance'),'来源插件必须发布依赖服务')
 assert.equal(ctx.get('teloaToolResourceProvenance'),getToolResourceProvenance(ctx))
 assert.equal((await ctx.agentPresets.resolve()).broken,undefined)
 const agent=(await ctx.agents.create({sessionId:SessionId('default-resource-preset'),setup:async scoped=>{await ctx.agentPresets.mount(scoped,declaration.config.id)}})).agent
 const execute=(name:string,args:unknown,callId:string,signal=AbortSignal.timeout(5000))=>ctx.tools.execute({name,arguments:args,callId:ToolCallId(callId),agent,signal})
 assert.deepEqual(meta(await execute('skill',{name:'preset-skill'},'skill-read'))?.teloaResourceUse,{schema:'teloa.resource-use/v1',kind:'skill',providerId:'actual-skill-provider',name:'preset-skill',toolName:'skill',state:'read'})
 const direct=await execute('web_search',{queries:['本轮查询']},'search-direct')
 assert.equal(direct.isError,false,JSON.stringify(direct))
 assert.deepEqual(meta(direct)?.teloaResourceUse,{schema:'teloa.resource-use/v1',kind:'web',providerId:'@deepseek-ai/dsh-tool-web',name:'tool-web',toolName:'web_search',state:'used'})
 assert.deepEqual(meta(direct)?.sources,sources)
 const snapshots:ToolResourceUseSnapshot[]=[]
 ctx.teloaToolResourceProvenance.onNestedUse(async row=>{snapshots.push(row)})
 const controller=new AbortController()
 ctx.provide('ptcRuntime',{language:'typescript',isolation:'fixture',resolve:(request:unknown)=>request,run:async(spec:{program:string;bindings:Array<{functions:Record<string,(args:Record<string,unknown>)=>Promise<unknown>>}>})=>{
  const value=await spec.bindings[0]!.functions.web_search!({queries:[spec.program]})
  if(spec.program==='取消后的搜索'){controller.abort('本人停止');throw new DOMException('本人停止','AbortError')}
  return {logs:[],value}
 }} as never)
 for(const description of ['PTC实际查询','取消后的搜索']){
  const callId=ToolCallId(description),args={code:description,description}
  agent.session.append('tool/call',{turn:1,step:0,callId,name:'run_code',arguments:JSON.stringify(args)})
  const before=agent.session.deriveMessages()
  const result=await execute('run_code',args,callId,description==='取消后的搜索'?controller.signal:AbortSignal.timeout(5000))
  assert.equal(result.isError,description==='取消后的搜索',JSON.stringify(result))
  assert.equal(controller.signal.aborted,description==='取消后的搜索')
  const use=snapshots.find(row=>row.parentCallId===callId)?.use
  assert.deepEqual(use?.queries,[description]);assert.deepEqual(use?.sources,sources);assert.equal(use?.answer,'真实搜索回答')
  assert.equal(use?.providerId,'@deepseek-ai/dsh-tool-web');assert.equal(use?.kind,'web')
  if(!result.isError)assert.deepEqual(meta(result)?.teloaResourceUses,[use])
  assert.deepEqual(agent.session.deriveMessages(),before,'来源证据不进入模型surface')
 }
 assert.deepEqual(searched,['本轮查询','PTC实际查询','取消后的搜索'])
 assert.equal(snapshots.length,2)
 await ctx.fiber.dispose()
 assert.equal(ctx.get('teloaToolResourceProvenance'),undefined,'来源服务随真实插件fiber撤回')
})
