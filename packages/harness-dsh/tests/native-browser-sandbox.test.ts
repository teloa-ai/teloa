import test from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import {createRequire, syncBuiltinESMExports} from 'node:module'
import {mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {createServer} from 'node:http'
import {tmpdir} from 'node:os'
import ts from 'typescript'
import {Context, type Plugin} from '@deepseek-ai/cordis'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionStore, SessionId} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {LlmRuntime, ToolCallId} from '@deepseek-ai/dsh-llm'
import {patchedNativePackage} from './fixtures/native-patched-package.ts'

type Launch = {mode:'launch';headless:boolean;executablePath?:string;chromiumSandbox?:boolean;toolCallTimeoutMs?:number}
type Attach = {mode:'attach';endpoint:string;toolCallTimeoutMs?:number}
type Provider = {Config:((value:unknown)=>Launch|Attach)&NonNullable<Plugin.Object<Launch|Attach>['Config']>;apply:(ctx:Context,config:Launch|Attach)=>void;inject:string[];name:string;chromiumSandboxVersion:1}
const anchor=fileURLToPath(new URL('../../native-browser/package.json',import.meta.url))
const originalProvider=createRequire(anchor).resolve('@deepseek-ai/dsh-experimental-browser-use-playwright-mcp/package.json')
const basename=(kind:string)=>'dsh-experimental-browser-use-'+kind+'-0.2.1-alpha.1-chromium-sandbox'

async function packages(t:Parameters<typeof patchedNativePackage>[0]){
 const runtime=await patchedNativePackage(t,{packageName:'@deepseek-ai/dsh-experimental-browser-use-runtime',compatBasename:basename('runtime'),packageAnchor:originalProvider})
 const provider=await patchedNativePackage<Provider>(t,{packageName:'@deepseek-ai/dsh-experimental-browser-use-playwright-mcp',compatBasename:basename('playwright-mcp'),packageAnchor:anchor,
  overrides:{'@deepseek-ai/dsh-experimental-browser-use-runtime':runtime.root}})
 return {runtime,provider}
}

test('官方共享 Config 校验可选 sandbox；旧配置和 attach 保持原行为',async t=>{
 const {provider}=await packages(t),{Config,chromiumSandboxVersion}=provider.namespace
 assert.equal(chromiumSandboxVersion,1)
 assert.deepEqual(Config({mode:'launch'}),{mode:'launch',headless:true})
 assert.deepEqual(Config({mode:'launch',chromiumSandbox:true}),{mode:'launch',headless:true,chromiumSandbox:true})
 assert.equal((Config({mode:'launch',chromiumSandbox:false}) as Launch).chromiumSandbox,false)
 for(const value of ['true',1,{},[]])assert.throws(()=>Config({mode:'launch',chromiumSandbox:value}))
 assert.notEqual((Config({mode:'launch',chromiumSandbox:null}) as Launch).chromiumSandbox,true,'保留上游可选字段的 null 处理，不能启用 sandbox')
 assert.deepEqual(Config({mode:'attach',endpoint:'http://127.0.0.1:9222'}),{mode:'attach',endpoint:'http://127.0.0.1:9222'})
 const source=join(provider.root,'sandbox-types.mts')
 await writeFile(source,`import {Config,chromiumSandboxVersion} from '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp';\nconst version:1=chromiumSandboxVersion;\nconst launch:Config={mode:'launch',headless:true,chromiumSandbox:true};\n// @ts-expect-error sandbox is a boolean\nconst invalid:Config={mode:'launch',headless:true,chromiumSandbox:'true'};\n// @ts-expect-error an attached browser is externally configured\nconst attach:Config={mode:'attach',endpoint:'http://127.0.0.1:9222',chromiumSandbox:true};\nvoid [version,launch,invalid,attach];\n`)
 const program=ts.createProgram([source],{module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,target:ts.ScriptTarget.ESNext,noEmit:true,strict:true,skipLibCheck:true})
 const diagnostics=ts.getPreEmitDiagnostics(program)
 assert.equal(diagnostics.length,0,ts.formatDiagnostics(diagnostics,{getCanonicalFileName:path=>path,getCurrentDirectory:()=>provider.root,getNewLine:()=> '\n'}))
})

test('实际官方 provider 经原 MCP 生命周期启动：仅 launch true 传递 --sandbox',{timeout:30000},async t=>{
 const {provider}=await packages(t),ctx=new Context(),calls:Array<{command:string;args:string[]}>=[]
 const spawn=childProcess.spawn
 // 仅观察真正的子进程调用；不替换 server、stdio、握手或 tools 实现。
 childProcess.spawn=((command,...rest:unknown[])=>{
  if(Array.isArray(rest[0]))calls.push({command:String(command),args:[...rest[0]] as string[]})
  return Reflect.apply(spawn,childProcess,[command,...rest])
 }) as typeof spawn
 syncBuiltinESMExports()
 t.after(()=>{childProcess.spawn=spawn;syncBuiltinESMExports()})
 t.after(()=>ctx.fiber.dispose())
 const workspace=await realpath(await mkdtemp(join(tmpdir(),'teloa-browser-compat-')))
 t.after(()=>rm(workspace,{recursive:true,force:true}))
 const browser=await import(pathToFileURL(createRequire(anchor).resolve('@deepseek-ai/dsh-browser-use')).href)
 for(const plugin of [LlmRuntime,SessionStore,SessionProjectionRegistry,SystemPrompt,ToolRuntime,AgentRegistry,browser.default])await ctx.plugin(plugin)
 await ctx.plugin(AgentLoop,{agents:[]})
 const cli=join(dirname(createRequire(originalProvider).resolve('@playwright/mcp/package.json')),'cli.js')
 const mcp=JSON.parse(await readFile(join(dirname(cli),'package.json'),'utf8'))
 assert.equal(mcp.version,'0.0.80')
 for(const choice of [undefined,false,true]){
  const before=calls.length,config=provider.namespace.Config({mode:'launch',...(choice===undefined?{}:{chromiumSandbox:choice})})
  const fiber=await ctx.plugin(provider.namespace,config),handle=await ctx.agents.create({sessionId:SessionId('sandbox-'+String(choice)),meta:{cwd:workspace}})
  const actual=calls.slice(before).filter(row=>row.args[0]===cli)
  assert.ok(actual.length>0,'Agent 创建确实启动官方 MCP stdio server')
  for(const call of actual){
   assert.equal(call.command,process.execPath)
   assert.deepEqual(call.args,[cli,'--browser','chromium','--isolated','--headless',...(choice===true?['--sandbox']:[])])
  }
  assert.ok(ctx.tools.schemas(handle.agent).some(tool=>tool.name==='mcp__playwright-mcp__browser_navigate'),'实际 MCP 握手提供原工具')
  await handle.dispose();await fiber.dispose()
 }
 // attach 的配置不由本提供方启动浏览器；在登记阶段观察原参数，不连接外部浏览器。
 const attach=provider.namespace.Config({mode:'attach',endpoint:'http://127.0.0.1:9222',chromiumSandbox:true})
 const before=calls.length,fiber=await ctx.plugin(provider.namespace,attach)
 assert.equal(calls.length,before);await fiber.dispose()
})

const executable=process.env.TELOA_BROWSER_COMPAT_EXECUTABLE??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
test('sandbox true 的实际官方 MCP 能启动已安装 Chromium 并读取隔离本机页面',{timeout:30000,skip:!existsSync(executable)&&'设置 TELOA_BROWSER_COMPAT_EXECUTABLE 为已安装 Chromium'},async t=>{
 const {provider}=await packages(t),ctx=new Context()
 t.after(()=>ctx.fiber.dispose())
 const workspace=await realpath(await mkdtemp(join(tmpdir(),'teloa-browser-compat-')))
 t.after(()=>rm(workspace,{recursive:true,force:true}))
 const server=createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end('<!doctype html><title>Sandbox compat</title><p>isolated sandbox page</p>')})
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 t.after(()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())))
 const address=server.address();assert.ok(address&&typeof address==='object')
 const browser=await import(pathToFileURL(createRequire(anchor).resolve('@deepseek-ai/dsh-browser-use')).href)
 for(const plugin of [LlmRuntime,SessionStore,SessionProjectionRegistry,SystemPrompt,ToolRuntime,AgentRegistry,browser.default])await ctx.plugin(plugin)
 await ctx.plugin(AgentLoop,{agents:[]})
 await ctx.plugin(provider.namespace,provider.namespace.Config({mode:'launch',headless:true,executablePath:executable,chromiumSandbox:true}))
 const handle=await ctx.agents.create({sessionId:SessionId('sandbox-live'),meta:{cwd:workspace}})
 const result=await ctx.tools.execute({agent:handle.agent,callId:ToolCallId('sandbox-page'),name:'mcp__playwright-mcp__browser_navigate',arguments:{url:'http://127.0.0.1:'+address.port},signal:AbortSignal.timeout(15000)})
 assert.equal(result.isError,false,JSON.stringify(result.content))
 const snapshot=await ctx.tools.execute({agent:handle.agent,callId:ToolCallId('sandbox-snapshot'),name:'mcp__playwright-mcp__browser_snapshot',arguments:{},signal:AbortSignal.timeout(15000)})
 assert.equal(snapshot.isError,false,JSON.stringify(snapshot.content))
 assert.ok(snapshot.content.some(block=>block.type==='text'&&block.text.includes('isolated sandbox page')),JSON.stringify({navigation:result.content,snapshot:snapshot.content}))
 await handle.dispose()
 // 真实无头启动只证明当前平台的官方链可用；Linux 内核隔离须在该部署另行验收。
})
