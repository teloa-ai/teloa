import test from 'node:test'
import assert from 'node:assert/strict'
import type {TestContext} from 'node:test'
import {chmod,mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createRequire} from 'node:module'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {WorkError,mcpToolFullName,type MarketCatalogConnectorEntry} from '@teloa/contract'
import {connectorAuthHeaders,createManagedMcpConnectionHandler,installMcpPackage,managedMcpConnectTimeoutMs,managedMcpInstallTimeoutMs,managedMcpConnectionEndpoints,registerManagedMcpWriteApproval,type InstallFn,type ManagedMcpConnectionRecord} from '../src/managed-mcp-connections.ts'
import {memoryCredentialPort,mcpCredentialKey,type McpCredentialPort} from '../src/managed-mcp-credentials.ts'
import {CredentialStoreLocked} from '../src/credentials/store-state.ts'

const projectRoot=fileURLToPath(new URL('../../../',import.meta.url))

// ─── 测试工厂 ──────────────────────────────────────────────────────────────────

async function tempRoot(t:TestContext):Promise<string>{
 const dir=await mkdtemp(join(tmpdir(),'teloa-mcp-test-'))
 t.after(()=>rm(dir,{recursive:true,force:true}))
 return dir
}

function httpEntry(overrides:{
 serverName?:string
 auth?:MarketCatalogConnectorEntry['connector']['auth']
 id?:string
 instructionsMaxBytes?:number
}={}):MarketCatalogConnectorEntry{
 return{
  format:'teloa.market-catalog-entry/v1',
  id:overrides.id??'test.mcp-conn',
  kind:'connector',
  delivery:'managed',
  version:'1.0.0',
  taxonomy:{functions:['automation'],industries:['general']},
  upstream:null,
  connector:{
   serverName:overrides.serverName??'test_conn',
   title:{'zh-CN':'测试连接','en':'Test connection'},
   summary:{'zh-CN':'测试。','en':'Test.'},
   auth:overrides.auth??{kind:'none'},
   recipe:{transport:'streamable-http',url:'https://example.com/mcp'},
   tools:[{name:'test_tool',description:{'zh-CN':'测试','en':'Test'},readOnly:true}],
   upstreamUrl:'https://example.com',
   ...(overrides.instructionsMaxBytes===undefined?{}:{instructionsMaxBytes:overrides.instructionsMaxBytes}),
  },
  modifications:[],
  license:{spdx:'MIT',files:['LICENSE']},
  compatibility:{status:'verified',teloa:'>=0.2.0-alpha.6',dsh:'0.1.7-rc.1',conditions:[]},
  requires:{tools:[],network:true,runtimes:[]},
  review:{status:'approved',reviewedAt:'2026-09-25',reviewer:'Teloa'},
 }
}

function stdioEntry():MarketCatalogConnectorEntry{
 return{
  format:'teloa.market-catalog-entry/v1',
  id:'test.mcp-stdio',
  kind:'connector',
  delivery:'managed',
  version:'1.0.0',
  taxonomy:{functions:['automation'],industries:['general']},
  upstream:null,
  connector:{
   serverName:'test_stdio',
   title:{'zh-CN':'测试 stdio','en':'Test stdio'},
   summary:{'zh-CN':'测试。','en':'Test.'},
   auth:{kind:'none'},
   recipe:{
    transport:'stdio',
    package:'@teloa/mcp-reference',
    version:'1.0.0',
    integrity:'sha512-'+'A'.repeat(86)+'==',
    bin:'lib/main.js',
    args:[],
   },
   tools:[
    {name:'list_references',description:{'zh-CN':'列出参考资料','en':'List references'},readOnly:true},
    {name:'read_reference',description:{'zh-CN':'读取参考资料','en':'Read reference'},readOnly:true},
   ],
   upstreamUrl:'https://example.com',
  },
  modifications:[],
  license:{spdx:'MIT',files:['LICENSE']},
  compatibility:{status:'verified',teloa:'>=0.2.0-alpha.6',dsh:'0.1.7-rc.1',conditions:[]},
  requires:{tools:[],network:false,runtimes:[]},
  review:{status:'approved',reviewedAt:'2026-09-25',reviewer:'Teloa'},
 }
}

// ─── 模拟 Cordis Context（单元测试用） ─────────────────────────────────────────

function makeMockCtx(opts:{rejectPlugin?:boolean;rejectMessage?:string;delayMs?:number;disposed?:string[];warnMessages?:string[];credentials?:McpCredentialPort}={}){
 const schemas:{name:string}[]=[]

 const ctx={
  plugin(_:unknown,config:{serverName:string;[k:string]:unknown}){
   const {serverName}=config
   const toolName=`mcp__${serverName}__test_tool`
   let disposed=false
   const disposeFn=async()=>{
    if(!disposed){
     disposed=true
     opts.disposed?.push(serverName)
     const idx=schemas.findIndex(s=>s.name===toolName)
     if(idx!==-1)schemas.splice(idx,1)
    }
   }
   if(!opts.rejectPlugin)schemas.push({name:toolName})
   const p=Object.assign(
    opts.rejectPlugin
     ?(()=>{const r=Promise.reject(new Error(opts.rejectMessage??'mock: connection failed'));r.catch(()=>{});return r})()
     :opts.delayMs?new Promise<void>(done=>setTimeout(done,opts.delayMs)):Promise.resolve(),
    {dispose:disposeFn}
   )
   return p
  },
  tools:{schemas:()=>schemas as {name:string}[]},
  logger:{
   warn(msg:string,...args:unknown[]){
    opts.warnMessages?.push([msg,...args.map(String)].join(' '))
   }
  },
  credentials:opts.credentials??memoryCredentialPort(),
 } as unknown as Context

 return{ctx,schemas}
}

// ─── 单元测试 ──────────────────────────────────────────────────────────────────

test('配方外字段拒绝：auth.kind=none 连接提交凭据报 invalid-input',async t=>{
 const root=await tempRoot(t)
 const entry=httpEntry({auth:{kind:'none'}})
 const {ctx}=makeMockCtx()
 const {handler}=createManagedMcpConnectionHandler(ctx,root,()=>entry)

 await assert.rejects(
  handler('mcp-connections/add',{catalogId:'test.mcp-conn',credentials:{SOME_KEY:'secret'}}),
  {code:'teloa/invalid-input'}
 )
})

test('secret auth 未声明凭据字段拒绝，声明字段正常添加',async t=>{
 const root=await tempRoot(t)
 const entry=httpEntry({
  auth:{kind:'secret',vars:[
   {target:'env',envVarName:'API_KEY',label:{'zh-CN':'API 密钥','en':'API Key'},required:true},
  ]}
 })
 const {ctx}=makeMockCtx()
 const {handler}=createManagedMcpConnectionHandler(ctx,root,()=>entry)

 // 未声明字段拒绝
 await assert.rejects(
  handler('mcp-connections/add',{catalogId:'test.mcp-conn',credentials:{UNDECLARED:'val'}}),
  {code:'teloa/invalid-input'}
 )
 // 声明字段正常通过
 const rec=await handler('mcp-connections/add',{catalogId:'test.mcp-conn',credentials:{API_KEY:'mytoken'}})
 assert.equal((rec as {status:string}).status,'saved')
})

test('受管连接把服务端 instructions 上限收窄到 4KB（stdio 与远端配置都带 maxInstructionBytes）',async t=>{
 const configs:Record<string,unknown>[]=[]
 const capture=()=>{
  const {ctx}=makeMockCtx()
  const plugin=(ctx as unknown as {plugin:(p:unknown,c:Record<string,unknown>)=>unknown}).plugin
  Reflect.set(ctx,'plugin',(p:unknown,config:Record<string,unknown>)=>{configs.push(config);return plugin(p,config)})
  return ctx
 }
 const install:InstallFn=async root=>join(root,'fake-bin.js')
 for(const entry of [stdioEntry(),httpEntry()]){
  const {handler}=createManagedMcpConnectionHandler(capture(),await tempRoot(t),()=>entry,install)
  const rec=await handler('mcp-connections/add',{catalogId:entry.id}) as {id:string}
  await handler('mcp-connections/connect',{id:rec.id})
 }
 assert.deepEqual(configs.map(config=>[config.transport,config.maxInstructionBytes]),[['stdio',4096],['streamable-http',4096]])
})

test('integrity 不符时 connect 报 dependency-unavailable（注入假 InstallFn）',async t=>{
 const root=await tempRoot(t)
 const entry=stdioEntry()
 const {ctx}=makeMockCtx()

 const badInstall:InstallFn=async()=>{
  throw new WorkError('teloa/dependency-unavailable','安装包 integrity 核对失败，中止连接。')
 }

 const {handler}=createManagedMcpConnectionHandler(ctx,root,()=>entry,badInstall)
 const rec=await handler('mcp-connections/add',{catalogId:'test.mcp-stdio'}) as {id:string}

 await assert.rejects(
  handler('mcp-connections/connect',{id:rec.id}),
  {code:'teloa/dependency-unavailable'}
 )
})

test('凭据不出现在任何 RPC 回包与 logger warn 调用里',async t=>{
 const root=await tempRoot(t)
 const entry=httpEntry({
  auth:{kind:'secret',vars:[
   {target:'env',envVarName:'API_KEY',label:{'zh-CN':'API 密钥','en':'API Key'},required:true},
  ]}
 })
 const warnMessages:string[]=[]
 const {ctx}=makeMockCtx({warnMessages})
 const {handler}=createManagedMcpConnectionHandler(ctx,root,()=>entry)

 const secret='super-secret-value-12345'
 const addRec=await handler('mcp-connections/add',{catalogId:'test.mcp-conn',credentials:{API_KEY:secret}})
 const addJson=JSON.stringify(addRec)
 assert.ok(!addJson.includes(secret),'add 回包含凭据：'+addJson)
 assert.ok(!addJson.includes('_credentialsStored'),'add 回包含内部字段：'+addJson)

 const id=(addRec as {id:string}).id
 const getJson=JSON.stringify(await handler('mcp-connections/get',{id}))
 assert.ok(!getJson.includes(secret),'get 回包含凭据：'+getJson)

 const listJson=JSON.stringify(await handler('mcp-connections/list',{}))
 assert.ok(!listJson.includes(secret),'list 回包含凭据：'+listJson)

 // 连接失败时的 warn 日志也不应含凭据
 const {handler:h2}=createManagedMcpConnectionHandler(makeMockCtx({rejectPlugin:true,warnMessages}).ctx,root+'2',()=>entry)
 await mkdir(root+'2',{recursive:true})
 const r2=await h2('mcp-connections/add',{catalogId:'test.mcp-conn',credentials:{API_KEY:secret}}) as {id:string}
 await h2('mcp-connections/connect',{id:r2.id}).catch(()=>{})
 for(const msg of warnMessages){
  assert.ok(!msg.includes(secret),'logger warn 含凭据：'+msg)
 }
})

test('断开后工具从 ctx.tools 注销',async t=>{
 const root=await tempRoot(t)
 const entry=httpEntry()
 const {ctx,schemas}=makeMockCtx()
 const {handler}=createManagedMcpConnectionHandler(ctx,root,()=>entry)

 const rec=await handler('mcp-connections/add',{catalogId:'test.mcp-conn'}) as {id:string}
 await handler('mcp-connections/connect',{id:rec.id})

 const toolName='mcp__test_conn__test_tool'
 assert.ok(schemas.some(s=>s.name===toolName),'连接后工具应在 ctx.tools 中')

 await handler('mcp-connections/disconnect',{id:rec.id})
 assert.ok(!schemas.some(s=>s.name===toolName),'断开后工具应从 ctx.tools 移除')
})

test('删除连接时凭据记录被删除',async t=>{
 const root=await tempRoot(t)
 const entry=httpEntry({
  auth:{kind:'secret',vars:[
   {target:'env',envVarName:'API_KEY',label:{'zh-CN':'API 密钥','en':'API Key'},required:true},
  ]}
 })
 const {ctx}=makeMockCtx()
 const {handler}=createManagedMcpConnectionHandler(ctx,root,()=>entry)

 const addRec=await handler('mcp-connections/add',{catalogId:'test.mcp-conn',credentials:{API_KEY:'secret'}}) as {id:string}
 const credentials=(ctx as unknown as {credentials:McpCredentialPort}).credentials
 assert.deepEqual(await credentials.readRecord(mcpCredentialKey('test_conn')),{kind:'grant',payload:{API_KEY:'secret'}})
 assert.ok(!existsSync(join(root,'mcp','credentials')),'不再写一期 0600 凭据文件')

 await handler('mcp-connections/delete',{id:addRec.id})
 assert.equal(await credentials.readRecord(mcpCredentialKey('test_conn')),undefined,'删除后凭据记录应被清除')
})

test('同名 serverName 冲突，第二次 add 报 conflict',async t=>{
 const root=await tempRoot(t)
 const entry=httpEntry()
 const {ctx}=makeMockCtx()
 const {handler}=createManagedMcpConnectionHandler(ctx,root,()=>entry)

 await handler('mcp-connections/add',{catalogId:'test.mcp-conn'})
 await assert.rejects(
  handler('mcp-connections/add',{catalogId:'test.mcp-conn'}),
  {code:'teloa/conflict'}
 )
})

test('重启恢复：status=connected 的连接在 restoreConnections 后重新 live',async t=>{
 const root=await tempRoot(t)
 const entry=httpEntry()
 const getEntry=()=>entry

 // 第一个宿主：add + connect
 const {ctx:ctx1}=makeMockCtx()
 const {handler:h1}=createManagedMcpConnectionHandler(ctx1,root,getEntry)
 const rec=await h1('mcp-connections/add',{catalogId:'test.mcp-conn'}) as {id:string}
 await h1('mcp-connections/connect',{id:rec.id})

 // 核验状态文件已持久化为 connected
 const stateRaw=await readFile(join(root,'mcp','connections.json'),'utf8')
 const state=JSON.parse(stateRaw) as {connections:{status:string}[]}
 assert.equal(state.connections[0]!.status,'connected')

 // 第二个宿主：模拟重启，restoreConnections
 const {ctx:ctx2,schemas:schemas2}=makeMockCtx()
 const {restoreConnections}=createManagedMcpConnectionHandler(ctx2,root,getEntry)
 await restoreConnections()

 assert.ok(schemas2.some(s=>s.name==='mcp__test_conn__test_tool'),'恢复后工具应在新 ctx 中')
})

// ─── installMcpPackage：随附 lock + npm ci ─────────────────────────────────────

const mcpIntegrity='sha512-'+'A'.repeat(86)+'=='
const mcpDepIntegrity='sha512-'+'C'.repeat(86)+'=='
const mcpRecipe=(pkg='teloa-mcp-test')=>({transport:'stdio' as const,package:pkg,version:'1.0.0',integrity:mcpIntegrity,bin:'lib/main.js',args:[]})
/** 夹具 lock：顶层包 + 一个传递依赖，逐条带 sha512 integrity。 */
const mcpLock=(pkg='teloa-mcp-test')=>({name:'teloa-managed-install',version:'1.0.0',lockfileVersion:3,requires:true,packages:{
 '':{name:'teloa-managed-install',version:'1.0.0',dependencies:{[pkg]:'1.0.0'}},
 [`node_modules/${pkg}`]:{version:'1.0.0',resolved:`https://registry.npmjs.org/${pkg}/-/${pkg}-1.0.0.tgz`,integrity:mcpIntegrity,dependencies:{dep:'^2.0.0'}},
 'node_modules/dep':{version:'2.1.0',resolved:'https://registry.npmjs.org/dep/-/dep-2.1.0.tgz',integrity:mcpDepIntegrity},
}})

/** 假 npm ci：记录 argv 与所见 lock，按 lock 铺 node_modules（顶层包带 bin），写 .package-lock.json；tamper 可改写已装条目。 */
async function fakeCiNpm(root:string,{tamper,withBin=true,delayMs=0}:{tamper?:Record<string,Record<string,unknown>>;withBin?:boolean;delayMs?:number}={}){
 const path=join(root,'fake-npm.mjs'),log=join(root,'npm-log.jsonl')
 await writeFile(path,[
  '#!/usr/bin/env node',
  "import {appendFileSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs'",
  "import {join} from 'node:path'",
  "const lock=JSON.parse(readFileSync(join(process.cwd(),'package-lock.json'),'utf8'))",
  `appendFileSync(${JSON.stringify(log)},JSON.stringify({args:process.argv.slice(2),lock})+'\\n')`,
  `await new Promise(done=>setTimeout(done,${delayMs}))`,
  'const installed={}',
  "for(const [key,entry] of Object.entries(lock.packages)){if(!key)continue;mkdirSync(join(process.cwd(),key),{recursive:true});installed[key]={...entry}}",
  `const top=Object.keys(lock.packages[''].dependencies)[0]`,
  withBin?"mkdirSync(join(process.cwd(),'node_modules',top,'lib'),{recursive:true});writeFileSync(join(process.cwd(),'node_modules',top,'lib','main.js'),'// fake bin')":'',
  `for(const [key,patch] of Object.entries(${JSON.stringify(tamper??{})}))installed[key]={...installed[key],...patch}`,
  "writeFileSync(join(process.cwd(),'node_modules','.package-lock.json'),JSON.stringify({name:lock.name,version:lock.version,lockfileVersion:3,requires:true,packages:installed}))",
 ].join('\n'),{encoding:'utf8'})
 await chmod(path,0o755)
 return {path,runs:async()=>existsSync(log)?(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line) as {args:string[];lock:unknown}):[]}
}

test('installMcpPackage 用随附 lock 执行 npm ci --ignore-scripts，参数不含任意用户输入，逐条核对后返回 bin 路径',{timeout:20000},async t=>{
 const root=await tempRoot(t)
 const npm=await fakeCiNpm(root)
 const bin=await installMcpPackage(root,mcpRecipe(),mcpLock(),npm.path)
 assert.equal(bin,join(root,'mcp','packages','teloa-mcp-test@1.0.0','node_modules','teloa-mcp-test','lib','main.js'))
 assert.ok(existsSync(bin))
 const [run]=await npm.runs()
 assert.deepEqual(run!.args,['ci','--ignore-scripts','--no-audit','--no-fund'])
 assert.deepEqual(run!.lock,mcpLock(),'npm ci 用的就是随附 lock')
 assert.equal(await installMcpPackage(root,mcpRecipe(),mcpLock(),npm.path),bin)
 assert.equal((await npm.runs()).length,1,'已装且逐条核对通过不再执行 npm')
})

test('installMcpPackage：随附 lock 缺失或与配方声明不一致 → teloa/forbidden，不执行 npm',{timeout:20000},async t=>{
 const root=await tempRoot(t)
 const npm=await fakeCiNpm(root)
 const otherTop=mcpLock();otherTop.packages['node_modules/teloa-mcp-test']!.integrity='sha512-'+'B'.repeat(86)+'=='
 const otherRoot=mcpLock();otherRoot.packages['']!.dependencies={'teloa-mcp-test':'1.0.0',evil:'1.0.0'}
 const noIntegrity=mcpLock();delete (noIntegrity.packages['node_modules/dep'] as {integrity?:string}).integrity
 for(const lock of [undefined,otherTop,otherRoot,noIntegrity]){
  await assert.rejects(installMcpPackage(root,mcpRecipe(),lock,npm.path),{code:'teloa/forbidden'})
 }
 assert.equal((await npm.runs()).length,0)
})

test('installMcpPackage：装出的传递依赖 integrity 与 lock 不符 → dependency-unavailable，不留安装目录',{timeout:20000},async t=>{
 const root=await tempRoot(t)
 const npm=await fakeCiNpm(root,{tamper:{'node_modules/dep':{integrity:'sha512-'+'B'.repeat(86)+'=='}}})
 await assert.rejects(installMcpPackage(root,mcpRecipe(),mcpLock(),npm.path),{code:'teloa/dependency-unavailable'})
 assert.deepEqual(existsSync(join(root,'mcp','packages'))?(await readdir(join(root,'mcp','packages'))):[],[])
})

test('installMcpPackage：bin 不存在 → dependency-unavailable',{timeout:20000},async t=>{
 const root=await tempRoot(t)
 const npm=await fakeCiNpm(root,{withBin:false})
 await assert.rejects(installMcpPackage(root,mcpRecipe(),mcpLock(),npm.path),{code:'teloa/dependency-unavailable'})
})

test('installMcpPackage npm 卡住时按上限超时终止并抛出 dependency-unavailable',{timeout:20000},async t=>{
 const root=await tempRoot(t)
 const fakeNpmPath=join(root,'fake-npm-hang.mjs')
 await writeFile(fakeNpmPath,'#!/usr/bin/env node\nsetTimeout(()=>{},60_000)\n',{encoding:'utf8'})
 await chmod(fakeNpmPath,0o755)
 const started=Date.now()
 await assert.rejects(
  installMcpPackage(root,mcpRecipe('teloa-mcp-hang'),mcpLock('teloa-mcp-hang'),fakeNpmPath,300),
  {code:'teloa/dependency-unavailable'}
 )
 assert.ok(Date.now()-started<10_000)
})

// ─── 安装超时与「正在安装」状态 ────────────────────────────────────────────────

test('安装与建连超时分开：首次安装上限 180 秒，建连仍 30 秒',()=>{
 assert.equal(managedMcpInstallTimeoutMs,180_000)
 assert.equal(managedMcpConnectTimeoutMs,30_000)
})

test('首次安装进行中记录为 installing（界面显示正在安装），装完建连成功转 connected；已装后再连不再进入 installing',{timeout:20000},async t=>{
 const root=await tempRoot(t)
 const npm=await fakeCiNpm(root,{delayMs:800})
 const entry={...stdioEntry(),packageLock:mcpLock('@teloa/mcp-reference')}
 const {ctx}=makeMockCtx()
 const install:InstallFn=(r,recipe,lock,onInstall)=>installMcpPackage(r,recipe,lock,npm.path,5_000,onInstall)
 const {handler}=createManagedMcpConnectionHandler(ctx,root,()=>entry,install)
 const rec=await handler('mcp-connections/add',{catalogId:entry.id}) as {id:string}
 const pending=handler('mcp-connections/connect',{id:rec.id}) as Promise<ManagedMcpConnectionRecord>
 const seen=new Set<string>()
 for(let i=0;i<40&&seen.size<1;i++){
  await new Promise(done=>setTimeout(done,50))
  const got=await handler('mcp-connections/get',{id:rec.id}) as ManagedMcpConnectionRecord
  if(got.status==='installing')seen.add(got.status)
 }
 assert.deepEqual([...seen],['installing'],'安装期间 get 回 installing，且不被连接锁阻塞')
 await assert.rejects(handler('mcp-connections/connect',{id:rec.id}),{code:'teloa/conflict'},'安装中重复连接给冲突而非第二次安装')
 assert.equal((await pending).status,'connected')
 const after=await handler('mcp-connections/get',{id:rec.id}) as ManagedMcpConnectionRecord
 assert.equal(after.status,'connected')
 assert.equal(after.errorCode,undefined)
 await handler('mcp-connections/disconnect',{id:rec.id})
 const statuses:string[]=[]
 const spy:InstallFn=(r,recipe,lock,onInstall)=>installMcpPackage(r,recipe,lock,npm.path,5_000,async()=>{statuses.push('installing');await onInstall?.()})
 const again=createManagedMcpConnectionHandler(makeMockCtx().ctx,root,()=>entry,spy)
 assert.equal((await again.handler('mcp-connections/connect',{id:rec.id}) as ManagedMcpConnectionRecord).status,'connected')
 assert.deepEqual(statuses,[],'已装且核对通过不再进入安装态')
 assert.equal((await npm.runs()).length,1)
})

test('默认安装：PATH 上的 npm 以 npm ci 按随附 lock 安装，经 onInstall 记为 installing 后连上（默认参数接线）',{timeout:20000},async t=>{
 const root=await tempRoot(t)
 const npm=await fakeCiNpm(root,{delayMs:300})
 const bin=join(root,'bin')
 await mkdir(bin)
 await writeFile(join(bin,'npm'),`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(npm.path)} "$@"\n`)
 await chmod(join(bin,'npm'),0o755)
 const path=process.env.PATH
 process.env.PATH=bin+':'+path
 t.after(()=>{process.env.PATH=path})
 const entry={...stdioEntry(),packageLock:mcpLock('@teloa/mcp-reference')}
 const {handler}=createManagedMcpConnectionHandler(makeMockCtx().ctx,root,()=>entry)
 const rec=await handler('mcp-connections/add',{catalogId:entry.id}) as {id:string}
 const pending=handler('mcp-connections/connect',{id:rec.id}) as Promise<ManagedMcpConnectionRecord>
 let installing=false
 for(let i=0;i<40&&!installing;i++){await new Promise(done=>setTimeout(done,25));installing=(await handler('mcp-connections/get',{id:rec.id}) as ManagedMcpConnectionRecord).status==='installing'}
 assert.ok(installing)
 assert.equal((await pending).status,'connected')
 assert.deepEqual((await npm.runs())[0]!.args,['ci','--ignore-scripts','--no-audit','--no-fund'])
})

test('安装超时：明确错误码 install-timeout（可重试），记录置 error 附可重试提示，半装目录清理；恢复网络后重试成功',{timeout:20000},async t=>{
 const root=await tempRoot(t)
 // 桩 npm：先铺一半 node_modules 再挂住，模拟慢网络下的半装状态
 const hang=join(root,'fake-npm-slow.mjs')
 await writeFile(hang,[
  '#!/usr/bin/env node',
  "import {mkdirSync,writeFileSync} from 'node:fs'",
  "import {join} from 'node:path'",
  "mkdirSync(join(process.cwd(),'node_modules','half'),{recursive:true})",
  "writeFileSync(join(process.cwd(),'node_modules','half','index.js'),'// partial')",
  'setTimeout(()=>{},60_000)',
 ].join('\n'),{encoding:'utf8'})
 await chmod(hang,0o755)
 const entry={...stdioEntry(),packageLock:mcpLock('@teloa/mcp-reference')}
 let npmBin=hang,timeoutMs=300
 const install:InstallFn=(r,recipe,lock,onInstall)=>installMcpPackage(r,recipe,lock,npmBin,timeoutMs,onInstall)
 const {handler}=createManagedMcpConnectionHandler(makeMockCtx().ctx,root,()=>entry,install)
 const rec=await handler('mcp-connections/add',{catalogId:entry.id}) as {id:string}
 const started=Date.now()
 const error=await (handler('mcp-connections/connect',{id:rec.id}) as Promise<unknown>).then(()=>undefined,(e:unknown)=>e) as WorkError
 assert.ok(Date.now()-started<10_000)
 assert.ok(error instanceof WorkError)
 assert.equal(error.code,'teloa/dependency-unavailable')
 assert.deepEqual(error.details,{errorCode:'install-timeout',retryable:true})
 assert.match(error.message,/重试/)
 const failed=await handler('mcp-connections/get',{id:rec.id}) as ManagedMcpConnectionRecord
 assert.equal(failed.status,'error')
 assert.equal(failed.errorCode,'install-timeout')
 assert.match(String(failed.errorMessage),/安装超时.*重试/)
 assert.deepEqual(await readdir(join(root,'mcp','packages')),[],'半装的临时目录已清理，不留正式目录')
 npmBin=(await fakeCiNpm(root)).path;timeoutMs=5_000
 const retried=await handler('mcp-connections/connect',{id:rec.id}) as ManagedMcpConnectionRecord
 assert.equal(retried.status,'connected')
 const ok=await handler('mcp-connections/get',{id:rec.id}) as ManagedMcpConnectionRecord
 assert.equal(ok.errorCode,undefined)
 assert.equal(ok.errorMessage,undefined)
})

test('安装失败（非超时，例如装完缺 bin）：记录置 error 附 install-failed，不停留在 installing',{timeout:20000},async t=>{
 const root=await tempRoot(t)
 const npm=await fakeCiNpm(root,{withBin:false})
 const entry={...stdioEntry(),packageLock:mcpLock('@teloa/mcp-reference')}
 const install:InstallFn=(r,recipe,lock,onInstall)=>installMcpPackage(r,recipe,lock,npm.path,5_000,onInstall)
 const {handler}=createManagedMcpConnectionHandler(makeMockCtx().ctx,root,()=>entry,install)
 const rec=await handler('mcp-connections/add',{catalogId:entry.id}) as {id:string}
 await assert.rejects(handler('mcp-connections/connect',{id:rec.id}),{code:'teloa/dependency-unavailable'})
 const failed=await handler('mcp-connections/get',{id:rec.id}) as ManagedMcpConnectionRecord
 assert.equal(failed.status,'error')
 assert.equal(failed.errorCode,'install-failed')
})

test('宿主重启：上次进程中断时停留在 installing 的记录恢复为 error（install-failed，可重试），不永久显示正在安装',async t=>{
 const root=await tempRoot(t)
 await mkdir(join(root,'mcp'),{recursive:true})
 const now='2026-09-26T00:00:00.000Z'
 await writeFile(join(root,'mcp','connections.json'),JSON.stringify({connections:[{id:'11111111-1111-4111-8111-111111111111',catalogId:'test.mcp-stdio',serverName:'test_stdio',status:'installing',createdAt:now,updatedAt:now,_credentialsStored:false}]}))
 const {handler,restoreConnections}=createManagedMcpConnectionHandler(makeMockCtx().ctx,root,()=>stdioEntry())
 await restoreConnections()
 const got=await handler('mcp-connections/get',{id:'11111111-1111-4111-8111-111111111111'}) as ManagedMcpConnectionRecord
 assert.equal(got.status,'error')
 assert.equal(got.errorCode,'install-failed')
 assert.match(String(got.errorMessage),/重试/)
})

test('connect 把条目随附的 packageLock 与 stdio 配方交给安装；条目没有随附 lock 时默认安装拒绝（teloa/forbidden）',async t=>{
 const entry={...stdioEntry(),packageLock:mcpLock('@teloa/mcp-reference')}
 const calls:unknown[][]=[]
 const install:InstallFn=async(...args)=>{calls.push(args);return join(projectRoot,'packages/mcp-reference/lib/main.js')}
 const {ctx}=makeMockCtx()
 const {handler}=createManagedMcpConnectionHandler(ctx,await tempRoot(t),()=>entry,install)
 const rec=await handler('mcp-connections/add',{catalogId:entry.id}) as {id:string}
 await handler('mcp-connections/connect',{id:rec.id})
 assert.equal(calls.length,1)
 assert.deepEqual(calls[0]!.slice(1,3),[entry.connector.recipe,entry.packageLock])
 assert.equal(typeof calls[0]![3],'function','安装开始回调随调用传入')
 const bare=stdioEntry()
 const {handler:defaultHandler}=createManagedMcpConnectionHandler(makeMockCtx().ctx,await tempRoot(t),()=>bare)
 const bareRec=await defaultHandler('mcp-connections/add',{catalogId:bare.id}) as {id:string}
 await assert.rejects(defaultHandler('mcp-connections/connect',{id:bareRec.id}),{code:'teloa/forbidden'})
})

// ─── 真实 stdio 连接（mcp-reference）─────────────────────────────────────────

test('streamable-http-template：url_path 凭据正常替换进 URL，非法字符拒绝',async t=>{
 const root=await tempRoot(t)
 const templateEntry:MarketCatalogConnectorEntry={
  format:'teloa.market-catalog-entry/v1',
  id:'test.mcp-tmpl',
  kind:'connector',
  delivery:'managed',
  version:'1.0.0',
  taxonomy:{functions:['automation'],industries:['general']},
  upstream:null,
  connector:{
   serverName:'tmpl_conn',
   title:{'zh-CN':'模板测试','en':'Template test'},
   summary:{'zh-CN':'测试。','en':'Test.'},
   auth:{kind:'secret',vars:[{target:'url-path',label:{'zh-CN':'令牌','en':'Token'},required:true}]},
   recipe:{transport:'streamable-http-template',urlTemplate:'https://mcp.example.com/s/{secret}/mcp'},
   tools:[{name:'test_tool',description:{'zh-CN':'测试','en':'Test'},readOnly:true}],
   upstreamUrl:'https://example.com',
  },
  modifications:[],
  license:{spdx:'MIT',files:['LICENSE']},
  compatibility:{status:'needs-configuration',teloa:'>=0.2.0-alpha.6',dsh:'0.1.7-rc.1',conditions:[]},
  requires:{tools:[],network:true,runtimes:[]},
  review:{status:'approved',reviewedAt:'2026-09-25',reviewer:'Teloa'},
 }
 const {ctx}=makeMockCtx()
 const {handler}=createManagedMcpConnectionHandler(ctx,root,()=>templateEntry)

 // 正常添加 url-path 凭据
 const rec=await handler('mcp-connections/add',{
  catalogId:'test.mcp-tmpl',
  credentials:{url_path_tmpl_conn:'abc123XYZ'}
 }) as {id:string;status:string}
 assert.equal(rec.status,'saved')

 // 非法字符（路径遍历）应在 connect 时拒绝
 const root2=await tempRoot(t)
 const {handler:h2}=createManagedMcpConnectionHandler(makeMockCtx().ctx,root2,()=>templateEntry)
 const rec2=await h2('mcp-connections/add',{
  catalogId:'test.mcp-tmpl',
  credentials:{url_path_tmpl_conn:'../etc/passwd'}
 }) as {id:string}
 await assert.rejects(
  h2('mcp-connections/connect',{id:rec2.id}),
  {code:'teloa/invalid-input'}
 )
})

test('连接器工具名带点号时按 DSH 公开名核对并列入已连接工具（飞书官方 MCP 形态）',async t=>{
 const root=await tempRoot(t)
 const {ctx,schemas}=makeMockCtx()
 const entry=httpEntry({serverName:'lark'})
 entry.connector.tools=[{name:'im.v1.message.list',description:{'zh-CN':'列出消息','en':'List messages'},readOnly:true}]
 const publicName=mcpToolFullName('lark','im.v1.message.list')
 // DSH 只会以归一化后的公开名登记该工具；简单拼接名不会出现在注册表。
 schemas.push({name:publicName})
 const {handler}=createManagedMcpConnectionHandler(ctx,root,()=>entry)
 const rec=await handler('mcp-connections/add',{catalogId:'test.mcp-conn'}) as {id:string}
 const conn=await handler('mcp-connections/connect',{id:rec.id}) as {tools:{name:string;fullName:string}[]}
 assert.deepEqual(conn.tools.map(tool=>[tool.name,tool.fullName]),[['im.v1.message.list',publicName]])
})

test('真实 stdio 连接 mcp-reference：列出工具并核验工具注销',{timeout:30000},async t=>{
 const root=await tempRoot(t)
 const ctx=new Context()
 t.after(()=>ctx.fiber.dispose())

 await ctx.plugin(SystemPrompt)
 await ctx.plugin(ToolRuntime)

 const entry=stdioEntry()

 // 注入 InstallFn，直接返回仓库内 mcp-reference 可执行路径，跳过真实 npm install
 const fakeInstall:InstallFn=async()=>join(projectRoot,'packages/mcp-reference/lib/main.js')

 const {handler}=createManagedMcpConnectionHandler(ctx,root,()=>entry,fakeInstall)

 // add
 const addRec=await handler('mcp-connections/add',{catalogId:'test.mcp-stdio'}) as {id:string;status:string}
 assert.equal(addRec.status,'saved')

 // connect
 const connRec=await handler('mcp-connections/connect',{id:addRec.id}) as {
  status:string;tools:{name:string;fullName:string;readOnly:boolean}[]
 }
 assert.equal(connRec.status,'connected')

 // 工具列表应包含 list_references 和 read_reference
 assert.ok(connRec.tools.some(t=>t.fullName==='mcp__test_stdio__list_references'),'缺少 list_references')
 assert.ok(connRec.tools.some(t=>t.fullName==='mcp__test_stdio__read_reference'),'缺少 read_reference')
 assert.ok(connRec.tools.every(t=>t.readOnly),'所有工具应标记为 readOnly')

 // ctx.tools.schemas() 里也应有这些工具
 const liveNames=ctx.tools.schemas().map(s=>s.name)
 assert.ok(liveNames.includes('mcp__test_stdio__list_references'),'ctx.tools 缺少 list_references')
 assert.ok(liveNames.includes('mcp__test_stdio__read_reference'),'ctx.tools 缺少 read_reference')

 // disconnect 后工具应从 ctx.tools 注销
 await handler('mcp-connections/disconnect',{id:addRec.id})
 const namesAfter=ctx.tools.schemas().map(s=>s.name)
 assert.ok(!namesAfter.includes('mcp__test_stdio__list_references'),'断开后 list_references 应注销')
 assert.ok(!namesAfter.includes('mcp__test_stdio__read_reference'),'断开后 read_reference 应注销')
})

test('真实 stdio 连接：服务器列出的工具多于目录声明时，只注册目录声明的工具（重连后同样）',{timeout:30000},async t=>{
 const root=await tempRoot(t)
 const ctx=new Context()
 t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(SystemPrompt)
 await ctx.plugin(ToolRuntime)
 // mcp-reference 实际列出 list_references 与 read_reference；目录只声明前者
 const entry=stdioEntry()
 entry.connector.tools=entry.connector.tools.filter(tool=>tool.name==='list_references')
 const fakeInstall:InstallFn=async()=>join(projectRoot,'packages/mcp-reference/lib/main.js')
 const {handler}=createManagedMcpConnectionHandler(ctx,root,()=>entry,fakeInstall)
 const rec=await handler('mcp-connections/add',{catalogId:'test.mcp-stdio'}) as {id:string}
 const declared=entry.connector.tools.map(tool=>mcpToolFullName('test_stdio',tool.name))
 const registered=()=>ctx.tools.schemas().map(s=>s.name).filter(name=>name.startsWith('mcp__test_stdio__')).sort()
 for(let round=0;round<2;round++){
  const conn=await handler('mcp-connections/connect',{id:rec.id}) as {tools:{fullName:string}[]}
  assert.deepEqual(registered(),declared,'实际注册集合应等于目录声明集合')
  assert.deepEqual(conn.tools.map(tool=>tool.fullName),declared)
  assert.equal(ctx.tools.get('mcp__test_stdio__read_reference'),undefined,'未声明工具不可见、不可执行')
  await handler('mcp-connections/disconnect',{id:rec.id})
  assert.deepEqual(registered(),[])
 }
})

test('受管 MCP 写工具：目录声明 readOnly:false 的工具每次调用先征询确认，拒绝即不执行；只读工具照常执行',{timeout:30000},async t=>{
 const {createRuntime,ToolCallId}=await import('../../../tests/native-auto-review-fixture.mjs')
 const {ctx,create}=await createRuntime(t)
 const entry=stdioEntry()
 entry.connector.tools=entry.connector.tools.map(tool=>tool.name==='read_reference'?{...tool,readOnly:false}:tool)
 const managed=createManagedMcpConnectionHandler(ctx,await tempRoot(t),()=>entry,async()=>join(projectRoot,'packages/mcp-reference/lib/main.js'))
 t.after(()=>managed.dispose())
 registerManagedMcpWriteApproval(ctx,managed.writeToolLabel)
 const rec=await managed.handler('mcp-connections/add',{catalogId:'test.mcp-stdio'}) as {id:string}
 await managed.handler('mcp-connections/connect',{id:rec.id})
 const agent=await create('personal-session')
 agent.session.append('turn/start',{turn:0})
 const reasons:string[]=[]
 let answer='rejected'
 ctx.on('approval/request' as never,(async(input:{reason?:string})=>{reasons.push(input.reason??'');return answer}) as never)
 let seq=0
 const call=(name:string,args:Record<string,unknown>)=>ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId('mcp-write-'+ ++seq),signal:AbortSignal.timeout(10_000)})
 const listed=await call('mcp__test_stdio__list_references',{})
 assert.equal(listed.isError,false,'只读工具不征询')
 assert.equal(reasons.length,0)
 const first=(JSON.parse(JSON.stringify(listed)).value?.structuredContent?.references??[])[0] as {id:string;version:string}|undefined
 const args=first?{id:first.id,version:first.version}:{id:'missing',version:'a'.repeat(64)}
 const rejected=await call('mcp__test_stdio__read_reference',args)
 assert.equal(rejected.isError,true,'拒绝后不执行')
 assert.equal(reasons.length,1)
 assert.match(reasons[0]!,/test_stdio/);assert.match(reasons[0]!,/read_reference/)
 answer='allowed-once'
 const allowed=await call('mcp__test_stdio__read_reference',args)
 assert.equal(reasons.length,2,'每次调用都重新征询，一次同意不延续')
 assert.doesNotMatch(JSON.stringify(allowed),/rejected|拒绝/)
 const audit=agent.session.snapshotEvents().filter(event=>(event.type as string)==='approval/decided').map(event=>(event.data as {outcome:string}).outcome)
 assert.deepEqual(audit,['rejected','allowed-once'])
 assert.equal(managed.writeToolLabel('mcp__test_stdio__list_references'),undefined)
 await managed.handler('mcp-connections/disconnect',{id:rec.id})
 assert.equal(managed.writeToolLabel('mcp__test_stdio__read_reference'),undefined,'断开后不再认作受管写工具')
})

/** 首次 tools/list 只列只读的 reveal；调用 reveal 后才注册写工具 write_later（SDK 自动发 tools/list_changed），unlisted 永不在目录声明里 */
async function lateWriteServer(t:TestContext):Promise<{root:string;entry:MarketCatalogConnectorEntry;install:InstallFn}>{
 const root=await tempRoot(t)
 const sdk=createRequire(join(projectRoot,'packages/mcp-reference/package.json'))
 const script=join(root,'late-write-server.cjs')
 await writeFile(script,[
  `const {McpServer}=require(${JSON.stringify(sdk.resolve('@modelcontextprotocol/sdk/server/mcp.js'))})`,
  `const {StdioServerTransport}=require(${JSON.stringify(sdk.resolve('@modelcontextprotocol/sdk/server/stdio.js'))})`,
  `const server=new McpServer({name:'late-write',version:'0.0.1'})`,
  `let revealed=false`,
  `server.registerTool('reveal',{description:'reveal',annotations:{readOnlyHint:true}},async()=>{`,
  ` if(!revealed){revealed=true`,
  `  server.registerTool('write_later',{description:'write'},async()=>({content:[{type:'text',text:'written'}]}))`,
  `  server.registerTool('unlisted',{description:'undeclared'},async()=>({content:[{type:'text',text:'unlisted'}]}))}`,
  ` return {content:[{type:'text',text:'revealed'}]}`,
  `})`,
  `server.connect(new StdioServerTransport())`,
 ].join('\n'))
 const entry=stdioEntry()
 entry.connector.serverName='late_srv'
 entry.connector.tools=[
  {name:'reveal',description:{'zh-CN':'揭示','en':'Reveal'},readOnly:true},
  {name:'write_later',description:{'zh-CN':'延后公布的写工具','en':'Late write'},readOnly:false},
 ]
 return {root,entry,install:async()=>script}
}

async function waitForTool(ctx:Context,name:string):Promise<void>{
 for(let i=0;i<200&&!ctx.tools.get(name);i++)await new Promise(done=>setTimeout(done,25))
 assert.ok(ctx.tools.get(name),`${name} 未在 list_changed 后注册`)
}

test('受管 MCP 写工具：建连后经 list_changed 才公布的已声明写工具同样逐次征询；未声明工具仍不注册',{timeout:30000},async t=>{
 const {createRuntime,ToolCallId}=await import('../../../tests/native-auto-review-fixture.mjs')
 const {ctx,create}=await createRuntime(t)
 const {root,entry,install}=await lateWriteServer(t)
 const managed=createManagedMcpConnectionHandler(ctx,root,()=>entry,install)
 t.after(()=>managed.dispose())
 registerManagedMcpWriteApproval(ctx,managed.writeToolLabel)
 // 建连前就按目录声明登记，规范化后的公开名也认得
 assert.equal(managed.writeToolLabel(mcpToolFullName('late_srv','write_later')),undefined,'尚未建连时不登记')
 const rec=await managed.handler('mcp-connections/add',{catalogId:'test.mcp-stdio'}) as {id:string}
 const conn=await managed.handler('mcp-connections/connect',{id:rec.id}) as {tools:{name:string}[]}
 assert.deepEqual(conn.tools.map(tool=>tool.name),['reveal'],'首次同步时写工具还没公布')
 assert.match(managed.writeToolLabel(mcpToolFullName('late_srv','write_later'))??'',/write_later/)
 const agent=await create('late-personal')
 agent.session.append('turn/start',{turn:0})
 const reasons:string[]=[]
 ctx.on('approval/request' as never,(async(input:{reason?:string})=>{reasons.push(input.reason??'');return 'rejected'}) as never)
 let seq=0
 const call=(name:string)=>ctx.tools.execute({agent,name,arguments:{},callId:ToolCallId('late-'+ ++seq),signal:AbortSignal.timeout(10_000)})
 assert.equal((await call('mcp__late_srv__reveal')).isError,false)
 assert.equal(reasons.length,0)
 await waitForTool(ctx,'mcp__late_srv__write_later')
 assert.equal(ctx.tools.get('mcp__late_srv__unlisted'),undefined,'未声明工具仍不注册')
 const rejected=await call('mcp__late_srv__write_later')
 assert.equal(rejected.isError,true,'拒绝后不执行')
 assert.doesNotMatch(JSON.stringify(rejected),/written/)
 assert.equal(reasons.length,1);assert.match(reasons[0]!,/write_later/)
 await managed.handler('mcp-connections/disconnect',{id:rec.id})
 assert.equal(managed.writeToolLabel(mcpToolFullName('late_srv','write_later')),undefined,'断开后不再登记')
})

test('受管 MCP 写工具（执行态）：岗位授权清单含写工具时仍逐次征询；清单不含时由任务闸先拒、不弹卡',{timeout:30000},async t=>{
 const {createRuntime,ToolCallId}=await import('../../../tests/native-auto-review-fixture.mjs')
 const {registerTaskToolGuard}=await import('../src/task-tool-guard.ts')
 const {ctx,create}=await createRuntime(t)
 const {root,entry,install}=await lateWriteServer(t)
 const managed=createManagedMcpConnectionHandler(ctx,root,()=>entry,install)
 t.after(()=>managed.dispose())
 const write='mcp__late_srv__write_later',reveal='mcp__late_srv__reveal'
 const policies:Record<string,{allowedTools:string[]}>={'task-granted':{allowedTools:[reveal,write]},'task-ungranted':{allowedTools:[reveal]}}
 registerTaskToolGuard(ctx,async sessionId=>policies[sessionId]??null)
 registerManagedMcpWriteApproval(ctx,managed.writeToolLabel)
 const rec=await managed.handler('mcp-connections/add',{catalogId:'test.mcp-stdio'}) as {id:string}
 await managed.handler('mcp-connections/connect',{id:rec.id})
 const reasons:string[]=[]
 ctx.on('approval/request' as never,(async(input:{reason?:string})=>{reasons.push(input.reason??'');return 'allowed-once'}) as never)
 let seq=0
 const call=(agent:Awaited<ReturnType<typeof create>>,name:string)=>ctx.tools.execute({agent,name,arguments:{},callId:ToolCallId('task-'+ ++seq),signal:AbortSignal.timeout(10_000)})
 const granted=await create('task-granted'),ungranted=await create('task-ungranted')
 granted.session.append('turn/start',{turn:0});ungranted.session.append('turn/start',{turn:0})
 assert.equal((await call(granted,reveal)).isError,false)
 await waitForTool(ctx,write)
 const denied=await call(ungranted,write)
 assert.match(JSON.stringify(denied),/当前任务未授权使用此工具/)
 assert.equal(reasons.length,0,'岗位未授权时不弹卡')
 const first=await call(granted,write),second=await call(granted,write)
 assert.equal(first.isError,false);assert.equal(second.isError,false)
 assert.equal(reasons.length,2,'岗位已授权仍逐次征询')
})

test('第三方客户端报错里带出凭据时：记录与恢复日志只给固定说明，失败实例被释放',async t=>{
 const {connectFailureReason,createManagedMcpConnectionHandler:create}=await import('../src/managed-mcp-connections.ts')
 const secret='sk-leak-9f8e7d6c5b4a'
 const fixed=['密钥或授权被拒绝：请检查密钥是否正确、授权是否已过期或权限不足。','无法连接到服务：请检查网络或服务是否可用。','服务返回错误，连接未建立；请稍后重试。']
 for(const raw of [`401 Unauthorized: Authorization: Bearer ${secret}`,`getaddrinfo ENOTFOUND host?key=${secret}`,`upstream said ${secret}`]){
  const reason=connectFailureReason(new Error(raw))
  assert.ok(fixed.includes(reason),reason);assert.ok(!reason.includes(secret))
 }
 const root=await tempRoot(t)
 const entry=httpEntry({auth:{kind:'secret',vars:[{target:'env',envVarName:'API_KEY',label:{'zh-CN':'API 密钥','en':'API Key'},required:true}]}})
 const warnMessages:string[]=[],disposed:string[]=[]
 const {ctx}=makeMockCtx({rejectPlugin:true,rejectMessage:`401 Unauthorized: Bearer ${secret}`,warnMessages,disposed})
 const {handler,restoreConnections}=create(ctx,root,()=>entry)
 const added=await handler('mcp-connections/add',{catalogId:'test.mcp-conn',credentials:{API_KEY:secret}}) as {id:string;serverName:string}
 await assert.rejects(handler('mcp-connections/connect',{id:added.id}),(error:Error)=>!error.message.includes(secret))
 assert.ok(disposed.includes(added.serverName),'失败的客户端实例应被释放')
 const record=await handler('mcp-connections/get',{id:added.id}) as {status:string;errorMessage?:string}
 assert.equal(record.status,'error');assert.equal(record.errorMessage,fixed[0])
 assert.ok(!JSON.stringify(record).includes(secret))
 const state=await readFile(join(root,'mcp','connections.json'),'utf8').catch(()=>'')
 assert.ok(!state.includes(secret),'状态文件不应含原始报错里的凭据')
 await restoreConnections?.()
 for(const message of warnMessages)assert.ok(!message.includes(secret),'恢复日志含凭据：'+message)
})

test('同一连接并发建立：第二个请求报冲突；大小写混用的环境变量名可提交',async t=>{
 const root=await tempRoot(t)
 const entry=httpEntry({auth:{kind:'none'}})
 const {ctx}=makeMockCtx({delayMs:80})
 const {handler}=createManagedMcpConnectionHandler(ctx,root,()=>entry)
 const added=await handler('mcp-connections/add',{catalogId:'test.mcp-conn'}) as {id:string}
 // 两个请求在拿「进行中」占位前都要先 await loadState 读文件，完成顺序不保证与调用顺序一致；
 // 契约只要求「恰好一个成功、另一个报冲突」，不要求先调用的那个赢
 const settled=await Promise.allSettled([handler('mcp-connections/connect',{id:added.id}),handler('mcp-connections/connect',{id:added.id})])
 const rejected=settled.filter((r):r is PromiseRejectedResult=>r.status==='rejected')
 const fulfilled=settled.filter((r):r is PromiseFulfilledResult<unknown>=>r.status==='fulfilled')
 assert.equal(rejected.length,1,'并发建立应恰好一个报冲突')
 assert.equal((rejected[0]!.reason as WorkError).code,'teloa/conflict')
 assert.equal((fulfilled[0]!.value as {status:string}).status,'connected')
 // 占位随建立结束释放：再连一次不应再报冲突
 assert.equal(((await handler('mcp-connections/connect',{id:added.id})) as {status:string}).status,'connected')
 // 与契约一致：本地进程配方允许大小写混用的环境变量名（如钉钉配方）
 const stdio={...stdioEntry(),connector:{...stdioEntry().connector,auth:{kind:'secret' as const,vars:[{target:'env' as const,envVarName:'DingTalk_AppKey',label:{'zh-CN':'应用 Key','en':'App key'},required:true}]}}}
 const {handler:stdioHandler}=createManagedMcpConnectionHandler(makeMockCtx().ctx,root+'-stdio',()=>stdio as never)
 await mkdir(root+'-stdio',{recursive:true})
 const saved=await stdioHandler('mcp-connections/add',{catalogId:'test.mcp-stdio',credentials:{DingTalk_AppKey:'k'}}) as {status:string}
 assert.equal(saved.status,'saved')
})

// ─── OAuth 二期：契约扩展（任务 1） ─────────────────────────────────────────────

test('oauth 连接器 requiresAllowlist:true 且 compatibility 为 unsupported 时 add 报 dependency-unavailable',async t=>{
 const root=await tempRoot(t)
 const entry=httpEntry({auth:{kind:'oauth',supported:true,scopes:['read'],requiresAllowlist:true}})
 entry.compatibility={...entry.compatibility,status:'unsupported',conditions:[{'zh-CN':'等待厂商白名单审批','en':'Awaiting vendor allowlist'}]}
 const {ctx}=makeMockCtx()
 const {handler}=createManagedMcpConnectionHandler(ctx,root,()=>entry)
 await assert.rejects(handler('mcp-connections/add',{catalogId:'test.mcp-conn'}),(err:any)=>err?.code==='teloa/dependency-unavailable'&&/等待厂商白名单审批/.test(err.message))
 // supported:false 的旧式不支持条目仍以 reason 作为拒绝说明
 const legacy=httpEntry({auth:{kind:'oauth',supported:false,reason:'需要 OAuth 授权，Teloa 下一版本支持'}})
 legacy.compatibility={...legacy.compatibility,status:'unsupported'}
 const {handler:legacyHandler}=createManagedMcpConnectionHandler(ctx,root,()=>legacy)
 await assert.rejects(legacyHandler('mcp-connections/add',{catalogId:'test.mcp-conn'}),(err:any)=>err?.code==='teloa/dependency-unavailable'&&/下一版本支持/.test(err.message))
})

test('宿主端点数组含 oauth-start / oauth-status，记录状态接受 pending-oauth',()=>{
 assert.ok((managedMcpConnectionEndpoints as readonly string[]).includes('mcp-connections/oauth-start'))
 assert.ok((managedMcpConnectionEndpoints as readonly string[]).includes('mcp-connections/oauth-status'))
 const stamp='2026-09-25T00:00:00.000Z'
 // 编译期检查：status 联合必须接受 'pending-oauth'
 const rec:ManagedMcpConnectionRecord={id:'12345678-1234-4234-8234-123456789012',catalogId:'test.mcp-conn',serverName:'test_conn',status:'pending-oauth',createdAt:stamp,updatedAt:stamp}
 assert.equal(rec.status,'pending-oauth')
})

// ─── 安全审查修复轮 1：状态文件锁与建连上限 ─────────────────────────────────────

function twoEntries(){
 const a=httpEntry({id:'test.mcp-a',serverName:'conn_a'}),b=httpEntry({id:'test.mcp-b',serverName:'conn_b'})
 return (id:string)=>id==='test.mcp-a'?a:id==='test.mcp-b'?b:undefined
}
const statusById=async(handler:(e:string,p:unknown)=>Promise<unknown>)=>new Map(((await handler('mcp-connections/list',{})) as {items:ManagedMcpConnectionRecord[]}).items.map(r=>[r.serverName,r.status]))

test('并发：两个不同 serverName 同时 add / connect → 两条记录都在且各自 connected，不互相覆盖',async t=>{
 const root=await tempRoot(t)
 const {ctx}=makeMockCtx({delayMs:20})
 const {handler}=createManagedMcpConnectionHandler(ctx,root,twoEntries())
 const [a,b]=await Promise.all([handler('mcp-connections/add',{catalogId:'test.mcp-a'}),handler('mcp-connections/add',{catalogId:'test.mcp-b'})]) as {id:string}[]
 assert.deepEqual([...(await statusById(handler)).entries()].sort(),[['conn_a','saved'],['conn_b','saved']])
 await Promise.all([handler('mcp-connections/connect',{id:a!.id}),handler('mcp-connections/connect',{id:b!.id})])
 assert.deepEqual([...(await statusById(handler)).entries()].sort(),[['conn_a','connected'],['conn_b','connected']])
})

test('并发：一个 serverName 建连进行中删除另一个 → 删除的记录不被建连写回复活',async t=>{
 const root=await tempRoot(t)
 const {ctx}=makeMockCtx({delayMs:80})
 const {handler}=createManagedMcpConnectionHandler(ctx,root,twoEntries())
 const a=await handler('mcp-connections/add',{catalogId:'test.mcp-a'}) as {id:string}
 const b=await handler('mcp-connections/add',{catalogId:'test.mcp-b'}) as {id:string}
 const connecting=handler('mcp-connections/connect',{id:a.id})
 await new Promise(done=>setTimeout(done,20))
 await handler('mcp-connections/delete',{id:b.id})
 await connecting
 assert.deepEqual([...(await statusById(handler)).entries()],[['conn_a','connected']])
})

test('建连挂起：超过上限后释放客户端、置 error 并释放连接锁',{timeout:10_000},async t=>{
 const root=await tempRoot(t)
 const disposed:string[]=[]
 let pluginCalled!:()=>void
 const called=new Promise<void>(done=>{pluginCalled=done})
 const ctx={
  plugin(_:unknown,config:{serverName:string}){pluginCalled();return Object.assign(new Promise<void>(()=>{}),{dispose:async()=>{disposed.push(config.serverName)}})},
  tools:{schemas:()=>[]},
  logger:{warn(){}},
 } as unknown as Context
 const {handler}=createManagedMcpConnectionHandler(ctx,root,()=>httpEntry())
 const rec=await handler('mcp-connections/add',{catalogId:'test.mcp-conn'}) as {id:string}
 t.mock.timers.enable({apis:['setTimeout']})
 const connecting=handler('mcp-connections/connect',{id:rec.id})
 await called
 t.mock.timers.tick(30_000)
 await assert.rejects(connecting,{code:'teloa/dependency-unavailable'})
 t.mock.timers.reset()
 assert.deepEqual(disposed,['test_conn'])
 const got=await handler('mcp-connections/get',{id:rec.id}) as ManagedMcpConnectionRecord
 assert.equal(got.status,'error')
 // 锁已释放：同一 serverName 的断开能完成
 assert.equal((await handler('mcp-connections/disconnect',{id:rec.id}) as ManagedMcpConnectionRecord).status,'saved')
})

test('凭据存储锁定：restoreConnections 与 refreshOAuthConnections 只跳过，连接状态与 updatedAt 不变，旧凭据文件保留',async t=>{
 const locked=()=>{throw new CredentialStoreLocked('key-unavailable')}
 const port:McpCredentialPort={readRecord:async()=>locked(),describeRecord:async()=>({configured:false,writable:false}),modifyRecord:async()=>locked(),deleteRecord:async()=>locked()}
 const warnMessages:string[]=[]
 const {ctx,schemas}=makeMockCtx({credentials:port,warnMessages}),root=await tempRoot(t)
 const oauth=httpEntry({id:'test.mcp-oauth',serverName:'oauth_conn',auth:{kind:'oauth',supported:true,scopes:['read']}})
 const bearer=httpEntry({auth:{kind:'secret',vars:[{target:'bearer',label:{'zh-CN':'令牌','en':'Token'},required:true}]}})
 const entries=new Map([[oauth.id,oauth],[bearer.id,bearer]])
 const stamp='2026-09-25T00:00:00.000Z'
 await mkdir(join(root,'mcp','credentials'),{recursive:true,mode:0o700})
 await writeFile(join(root,'mcp','credentials','test_conn'),JSON.stringify({bearer_test_conn:'legacy-bearer-123'}),{mode:0o600})
 const statePath=join(root,'mcp','connections.json')
 await writeFile(statePath,JSON.stringify({connections:[
  {id:'11111111-1111-4111-8111-111111111111',catalogId:oauth.id,serverName:'oauth_conn',status:'connected',createdAt:stamp,updatedAt:stamp,_credentialsStored:false},
  {id:'22222222-2222-4222-8222-222222222222',catalogId:bearer.id,serverName:'test_conn',status:'connected',createdAt:stamp,updatedAt:stamp,_credentialsStored:true},
 ]},null,2))
 const before=await readFile(statePath,'utf8')
 const managed=createManagedMcpConnectionHandler(ctx,root,id=>entries.get(id))
 t.after(()=>managed.dispose())
 await managed.restoreConnections();await managed.refreshOAuthConnections()
 assert.equal(await readFile(statePath,'utf8'),before)
 assert.deepEqual(schemas,[],'锁定时不建连')
 assert.equal(await readFile(join(root,'mcp','credentials','test_conn'),'utf8'),JSON.stringify({bearer_test_conn:'legacy-bearer-123'}))
 assert.equal(warnMessages.filter(message=>message.startsWith('凭据存储锁定，受管 MCP 连接暂不恢复')).length,1)
 assert.ok(!warnMessages.some(message=>message.includes('legacy-bearer-123')))
})

test('重启恢复：一期旧凭据文件迁入凭据记录后删除，并以迁入的 Bearer 重连',async t=>{
 const root=await tempRoot(t),port=memoryCredentialPort()
 const bearer=httpEntry({auth:{kind:'secret',vars:[{target:'bearer',label:{'zh-CN':'令牌','en':'Token'},required:true}]}})
 const stamp='2026-09-25T00:00:00.000Z'
 await mkdir(join(root,'mcp','credentials'),{recursive:true,mode:0o700})
 await writeFile(join(root,'mcp','credentials','test_conn'),JSON.stringify({bearer_test_conn:'legacy-bearer-123'}),{mode:0o600})
 await writeFile(join(root,'mcp','connections.json'),JSON.stringify({connections:[{id:'22222222-2222-4222-8222-222222222222',catalogId:bearer.id,serverName:'test_conn',status:'connected',createdAt:stamp,updatedAt:stamp,_credentialsStored:true}]}))
 const headers:unknown[]=[]
 const {ctx,schemas}=makeMockCtx({credentials:port})
 const plugin=(ctx as unknown as {plugin:(p:unknown,c:{serverName:string;headers?:unknown})=>unknown}).plugin
 Object.assign(ctx,{plugin:(p:unknown,c:{serverName:string;headers?:unknown})=>{headers.push(c.headers);return plugin(p,c)}})
 const managed=createManagedMcpConnectionHandler(ctx,root,()=>bearer)
 t.after(()=>managed.dispose())
 await managed.restoreConnections()
 assert.deepEqual(await port.readRecord(mcpCredentialKey('test_conn')),{kind:'grant',payload:{bearer_test_conn:'legacy-bearer-123'}})
 assert.equal(existsSync(join(root,'mcp','credentials','test_conn')),false)
 assert.deepEqual(headers,[{Authorization:'Bearer legacy-bearer-123'}])
 assert.ok(schemas.some(s=>s.name==='mcp__test_conn__test_tool'))
})

/** 可切换锁定的凭据端口：先在未锁定时登记一条 bearer 连接，再锁定 */
async function lockableConnection(t:TestContext){
 const root=await tempRoot(t),inner=memoryCredentialPort(),state={locked:false}
 const guard=<T>(run:()=>Promise<T>)=>state.locked?Promise.reject(new CredentialStoreLocked('key-unavailable')):run()
 const port:McpCredentialPort={readRecord:key=>guard(()=>inner.readRecord(key)),describeRecord:async key=>state.locked?{configured:false,writable:false}:inner.describeRecord(key),modifyRecord:(key,mutate)=>guard(()=>inner.modifyRecord(key,mutate)),deleteRecord:key=>guard(()=>inner.deleteRecord(key))}
 const entry=httpEntry({auth:{kind:'secret',vars:[{target:'bearer',label:{'zh-CN':'令牌','en':'Token'},required:true}]}})
 const managed=createManagedMcpConnectionHandler(makeMockCtx({credentials:port}).ctx,root,()=>entry)
 t.after(()=>managed.dispose())
 const rec=await managed.handler('mcp-connections/add',{catalogId:'test.mcp-conn',credentials:{bearer_test_conn:'bearer-value-123'}}) as ManagedMcpConnectionRecord
 state.locked=true
 return {managed,rec,inner,state}
}
const lockedError=(error:unknown)=>error instanceof WorkError&&error.code==='teloa/storage-unavailable'&&error.message==='密钥存储已锁定，请到设置页处理后重试'

test('凭据存储锁定：add 报 teloa/storage-unavailable 固定文案，不登记连接',async t=>{
 const other=httpEntry({id:'test.mcp-other',serverName:'other_conn',auth:{kind:'secret',vars:[{target:'bearer',label:{'zh-CN':'令牌','en':'Token'},required:true}]}})
 const locked=()=>{throw new CredentialStoreLocked('key-unavailable')}
 const fresh=createManagedMcpConnectionHandler(makeMockCtx({credentials:{readRecord:async()=>locked(),describeRecord:async()=>({configured:false,writable:false}),modifyRecord:async()=>locked(),deleteRecord:async()=>locked()}}).ctx,await tempRoot(t),()=>other)
 t.after(()=>fresh.dispose())
 await assert.rejects(fresh.handler('mcp-connections/add',{catalogId:'test.mcp-other',credentials:{bearer_other_conn:'bearer-value-123'}}),lockedError)
 assert.deepEqual(await fresh.handler('mcp-connections/list',{}),{items:[]})
})

test('凭据存储锁定：connect 报 teloa/storage-unavailable 固定文案，状态不变',async t=>{
 const {managed,rec}=await lockableConnection(t)
 await assert.rejects(managed.handler('mcp-connections/connect',{id:rec.id}),lockedError)
 assert.equal((await managed.handler('mcp-connections/get',{id:rec.id}) as ManagedMcpConnectionRecord).status,'saved')
})

test('凭据存储锁定：delete 被拒绝（teloa/storage-unavailable 固定文案），连接记录与凭据记录都保留',async t=>{
 const {managed,rec,inner,state}=await lockableConnection(t)
 await assert.rejects(managed.handler('mcp-connections/delete',{id:rec.id}),lockedError)
 assert.equal((await managed.handler('mcp-connections/list',{}) as {items:unknown[]}).items.length,1)
 state.locked=false
 assert.deepEqual(await inner.readRecord(mcpCredentialKey('test_conn')),{kind:'grant',payload:{bearer_test_conn:'bearer-value-123'}})
})

test('凭据存储锁定：已连接的无凭据连接器照常删除（不碰存储），客户端释放、记录删除',async t=>{
 const root=await tempRoot(t)
 const locked=()=>{throw new CredentialStoreLocked('key-unavailable')}
 const touched:string[]=[]
 const port:McpCredentialPort={
  readRecord:async()=>{touched.push('read');return locked()},
  describeRecord:async()=>{touched.push('describe');return {configured:false,writable:false}},
  modifyRecord:async()=>{touched.push('modify');return locked()},
  deleteRecord:async()=>{touched.push('delete');return locked()},
 }
 const disposed:string[]=[]
 const {ctx,schemas}=makeMockCtx({credentials:port,disposed})
 const managed=createManagedMcpConnectionHandler(ctx,root,()=>httpEntry())
 t.after(()=>managed.dispose())
 const rec=await managed.handler('mcp-connections/add',{catalogId:'test.mcp-conn'}) as ManagedMcpConnectionRecord
 assert.equal((await managed.handler('mcp-connections/connect',{id:rec.id}) as ManagedMcpConnectionRecord).status,'connected')
 assert.deepEqual(await managed.handler('mcp-connections/delete',{id:rec.id}),{})
 assert.deepEqual(await managed.handler('mcp-connections/list',{}),{items:[]})
 assert.deepEqual(disposed,['test_conn'])
 assert.deepEqual(schemas,[])
 assert.deepEqual(touched,[])
})

for(const [label,prepare] of [
 ['损坏',async(statePath:string)=>{await writeFile(statePath,'{not json')}],
 ['读不到（EACCES）',async(statePath:string)=>{await writeFile(statePath,JSON.stringify({connections:[]}));await chmod(statePath,0o000)}],
 ['缺失',async()=>{}],
] as const){
 test(`connections.json ${label}时不判孤儿：一期旧凭据导入记录，不被擦掉`,{skip:label.startsWith('读不到')&&process.getuid?.()===0},async t=>{
  const root=await tempRoot(t),port=memoryCredentialPort(),dir=join(root,'mcp','credentials'),statePath=join(root,'mcp','connections.json')
  await mkdir(dir,{recursive:true,mode:0o700})
  await writeFile(join(dir,'gh'),JSON.stringify({bearer_gh:'legacy-bearer-123'}),{mode:0o600})
  await prepare(statePath)
  t.after(()=>chmod(statePath,0o600).catch(()=>{}))
  const managed=createManagedMcpConnectionHandler(makeMockCtx({credentials:port}).ctx,root,()=>httpEntry())
  t.after(()=>managed.dispose())
  await managed.restoreConnections()
  assert.deepEqual(await port.readRecord(mcpCredentialKey('gh')),{kind:'grant',payload:{bearer_gh:'legacy-bearer-123'}})
 })
}

test('connections.json 完整且没有对应连接：旧凭据按孤儿擦除，不导入',async t=>{
 const root=await tempRoot(t),port=memoryCredentialPort(),dir=join(root,'mcp','credentials')
 await mkdir(dir,{recursive:true,mode:0o700})
 await writeFile(join(dir,'gh'),JSON.stringify({bearer_gh:'legacy-bearer-123'}),{mode:0o600})
 await writeFile(join(root,'mcp','connections.json'),JSON.stringify({connections:[]}))
 const managed=createManagedMcpConnectionHandler(makeMockCtx({credentials:port}).ctx,root,()=>httpEntry())
 t.after(()=>managed.dispose())
 await managed.restoreConnections()
 assert.equal(existsSync(join(dir,'gh')),false)
 assert.equal(await port.readRecord(mcpCredentialKey('gh')),undefined)
})

// ─── 规格 2026-09-27 §7：header / basic 鉴权、instructions 按条目上限、stdio 参数引用 ───────────────

const label={'zh-CN':'凭据','en':'Credential'}
const secretAuth=(...vars:Extract<MarketCatalogConnectorEntry['connector']['auth'],{kind:'secret'}>['vars'])=>({kind:'secret' as const,vars})

test('connectorAuthHeaders：header 无 scheme / scheme 以 = 结尾直接拼接 / 普通 scheme 空格拼接；basic 为 Basic base64(u:p)；bearer 不变',()=>{
 const key='k-'+'a1b2c3d4e5'
 assert.deepEqual(connectorAuthHeaders(secretAuth({target:'header',name:'X-Api-Key',label,required:true}),'svc',{'header_svc__x-api-key':key}),{'X-Api-Key':key})
 assert.deepEqual(connectorAuthHeaders(secretAuth({target:'header',name:'Authorization',scheme:'Token token=',label,required:true}),'svc',{header_svc__authorization:'abc'}),{Authorization:'Token token=abc'})
 assert.deepEqual(connectorAuthHeaders(secretAuth({target:'header',name:'Authorization',scheme:'Sentry-Bearer',label,required:true}),'svc',{header_svc__authorization:'abc'}),{Authorization:'Sentry-Bearer abc'})
 assert.deepEqual(connectorAuthHeaders(secretAuth({target:'basic',userLabel:label,label,required:true}),'svc',{basic_user_svc:'alice',basic_pass_svc:'p@ss-w0rd'}),{Authorization:'Basic '+Buffer.from('alice:p@ss-w0rd').toString('base64')})
 assert.deepEqual(connectorAuthHeaders(secretAuth({target:'bearer',label,required:true}),'svc',{bearer_svc:'tok-12345678'}),{Authorization:'Bearer tok-12345678'})
 // 两个 header 变量同时生效；非必填且未填写的不产生头
 assert.deepEqual(connectorAuthHeaders(secretAuth({target:'header',name:'X-Org',label,required:false},{target:'header',name:'X-Api-Key',label,required:true}),'svc',{'header_svc__x-api-key':key}),{'X-Api-Key':key})
 assert.deepEqual(connectorAuthHeaders(secretAuth({target:'basic',userLabel:label,label,required:false}),'svc',{}),{})
 assert.deepEqual(connectorAuthHeaders({kind:'none'},'svc',{}),{})
})

test('connectorAuthHeaders：必填缺失报 teloa/invalid-input（与 bearer 同式）；用户名含冒号、值含控制字符拒绝，报错不带值',()=>{
 const missing=(auth:Parameters<typeof connectorAuthHeaders>[0],slots:Record<string,string>)=>{try{connectorAuthHeaders(auth,'svc',slots)}catch(error){return error}assert.fail('应当报错')}
 const bearer=missing(secretAuth({target:'bearer',label,required:true}),{}) as WorkError
 assert.equal(bearer.code,'teloa/invalid-input');assert.equal(bearer.message,'受管连接 svc 缺少必填 Bearer Token。')
 const header=missing(secretAuth({target:'header',name:'X-Api-Key',label,required:true}),{}) as WorkError
 assert.equal(header.code,'teloa/invalid-input');assert.equal(header.message,'受管连接 svc 缺少必填请求头 X-Api-Key。')
 for(const slots of [{},{basic_user_svc:'alice'},{basic_pass_svc:'p@ss-w0rd'}]){
  const basic=missing(secretAuth({target:'basic',userLabel:label,label,required:true}),slots) as WorkError
  assert.equal(basic.code,'teloa/invalid-input');assert.equal(basic.message,'受管连接 svc 缺少必填用户名或密码。')
 }
 const colon=missing(secretAuth({target:'basic',userLabel:label,label,required:true}),{basic_user_svc:'ali:ce',basic_pass_svc:'p@ss-w0rd'}) as WorkError
 assert.equal(colon.code,'teloa/invalid-input');assert.doesNotMatch(colon.message,/ali:ce|p@ss-w0rd/)
 const crlf=missing(secretAuth({target:'header',name:'X-Api-Key',label,required:true}),{'header_svc__x-api-key':'abc\r\nX-Evil: 1'}) as WorkError
 assert.equal(crlf.code,'teloa/invalid-input');assert.doesNotMatch(crlf.message,/abc|X-Evil/)
})

function headerBasicEntry(){
 return httpEntry({auth:secretAuth({target:'header',name:'X-Api-Key',label,required:true},{target:'basic',userLabel:label,label,required:true})})
}

test('保存端点：声明 header / basic 时只接受对应槽键，值校验长度与字符集，回包不含值',async t=>{
 const entry=headerBasicEntry()
 const good={'header_test_conn__x-api-key':'key-'+'z9y8x7w6v5','basic_user_test_conn':'alice@example.com','basic_pass_test_conn':'atl-'+'q1w2e3r4t5'}
 const bad:[Record<string,string>,RegExp][]=[
  [{...good,bearer_test_conn:'tok-12345678'},/bearer_test_conn/],
  [{...good,'header_test_conn__x-other':'v-12345678'},/header_test_conn__x-other/],
  [{...good,'header_test_conn__X-Api-Key':'v-12345678'},/header_test_conn__X-Api-Key/],
  [{...good,'header_test_conn__x-api-key':'   '},/请求头/],
  [{...good,'header_test_conn__x-api-key':'non-ascii-值-1234'},/请求头/],
  [{...good,'header_test_conn__x-api-key':'a\nb'},/请求头/],
  [{...good,'header_test_conn__x-api-key':'x'.repeat(4097)},/请求头/],
  [{...good,basic_user_test_conn:'ali:ce'},/用户名/],
  [{...good,basic_user_test_conn:'u'.repeat(257)},/用户名/],
  [{...good,basic_pass_test_conn:'short'},/密码/],
  [{...good,basic_pass_test_conn:'p'.repeat(4097)},/密码/],
  [{...good,basic_pass_test_conn:'pass word1'},/密码/],
  [{'header_test_conn__x-api-key':good['header_test_conn__x-api-key'],basic_user_test_conn:'alice'},/用户名与密码/],
 ]
 for(const [credentials,message] of bad){
  const {ctx}=makeMockCtx()
  const {handler}=createManagedMcpConnectionHandler(ctx,await tempRoot(t),()=>entry)
  await assert.rejects(handler('mcp-connections/add',{catalogId:'test.mcp-conn',credentials}),(error:WorkError)=>{
   assert.equal(error.code,'teloa/invalid-input');assert.match(error.message,message)
   for(const value of Object.values(credentials))if(value.length>=8)assert.ok(!error.message.includes(value),'报错不带值')
   return true
  },JSON.stringify(Object.keys(credentials)))
 }
 const port=memoryCredentialPort(),{ctx}=makeMockCtx({credentials:port})
 const {handler}=createManagedMcpConnectionHandler(ctx,await tempRoot(t),()=>entry)
 const rec=await handler('mcp-connections/add',{catalogId:'test.mcp-conn',credentials:good})
 assert.equal((rec as {status:string}).status,'saved')
 for(const value of Object.values(good))assert.ok(!JSON.stringify(rec).includes(value),'回包不含值')
 assert.deepEqual(await port.readRecord(mcpCredentialKey('test_conn')),{kind:'grant',payload:good})
})

test('建连：header / basic 槽按声明拼进远端请求头，每次建连现读；OAuth 路径不受影响',async t=>{
 const configs:Record<string,unknown>[]=[]
 const {ctx}=makeMockCtx()
 const plugin=(ctx as unknown as {plugin:(p:unknown,c:Record<string,unknown>)=>unknown}).plugin
 Reflect.set(ctx,'plugin',(p:unknown,config:Record<string,unknown>)=>{configs.push(config);return plugin(p,config)})
 const {handler}=createManagedMcpConnectionHandler(ctx,await tempRoot(t),()=>headerBasicEntry())
 const rec=await handler('mcp-connections/add',{catalogId:'test.mcp-conn',credentials:{'header_test_conn__x-api-key':'key-'+'z9y8x7w6v5',basic_user_test_conn:'alice',basic_pass_test_conn:'atl-'+'q1w2e3r4t5'}}) as {id:string}
 await handler('mcp-connections/connect',{id:rec.id})
 assert.deepEqual(configs[0]!.headers,{'X-Api-Key':'key-z9y8x7w6v5',Authorization:'Basic '+Buffer.from('alice:atl-q1w2e3r4t5').toString('base64')})
})

test('instructions 上限按条目声明：instructionsMaxBytes 8192 → 传给 DSH 8192；缺省 4096；超过全局最高值 32768 按 32768',async t=>{
 const configs:Record<string,unknown>[]=[]
 for(const instructionsMaxBytes of [8192,undefined,65536]){
  const {ctx}=makeMockCtx()
  const plugin=(ctx as unknown as {plugin:(p:unknown,c:Record<string,unknown>)=>unknown}).plugin
  Reflect.set(ctx,'plugin',(p:unknown,config:Record<string,unknown>)=>{configs.push(config);return plugin(p,config)})
  const {handler}=createManagedMcpConnectionHandler(ctx,await tempRoot(t),()=>httpEntry(instructionsMaxBytes===undefined?{}:{instructionsMaxBytes}))
  const rec=await handler('mcp-connections/add',{catalogId:'test.mcp-conn'}) as {id:string}
  await handler('mcp-connections/connect',{id:rec.id})
 }
 assert.deepEqual(configs.map(config=>config.maxInstructionBytes),[8192,4096,32768])
})

test('stdio 参数引用已声明 env：args 逐字含 ${API_TOKEN}（宿主不替换），env.API_TOKEN 为槽值，argv 不含槽值',async t=>{
 const entry=stdioEntry()
 entry.connector.auth=secretAuth({target:'env',envVarName:'API_TOKEN',label,required:true})
 if(entry.connector.recipe.transport!=='stdio')assert.fail()
 entry.connector.recipe.args=['--header','Authorization:${API_TOKEN}']
 const configs:Record<string,unknown>[]=[]
 const {ctx}=makeMockCtx()
 const plugin=(ctx as unknown as {plugin:(p:unknown,c:Record<string,unknown>)=>unknown}).plugin
 Reflect.set(ctx,'plugin',(p:unknown,config:Record<string,unknown>)=>{configs.push(config);return plugin(p,config)})
 const token='tok-'+'m4n5b6v7c8x9'
 const install:InstallFn=async root=>join(root,'fake-bin.js')
 const {handler}=createManagedMcpConnectionHandler(ctx,await tempRoot(t),()=>entry,install)
 const rec=await handler('mcp-connections/add',{catalogId:entry.id,credentials:{API_TOKEN:token}}) as {id:string}
 await handler('mcp-connections/connect',{id:rec.id})
 const config=configs[0] as {args:string[];env:Record<string,string>}
 assert.deepEqual(config.args.slice(1),['--header','Authorization:${API_TOKEN}'])
 assert.equal(config.env.API_TOKEN,token)
 assert.ok(!JSON.stringify(config.args).includes(token),'argv 不含槽值')
})

// ─── 审查修复（L-4、L-6、设计约束：header 值允许内部 SP/HTAB、L-2 宿主侧） ───────────────

test('审查修复：header 值按 field-value 口径允许内部空格与制表符（首尾须为可见字符），保存与建连一致',async t=>{
 const value='Tok '+'a1b2\tc3d4'
 assert.deepEqual(connectorAuthHeaders(secretAuth({target:'header',name:'X-Api-Key',label,required:true}),'svc',{'header_svc__x-api-key':value}),{'X-Api-Key':value})
 const port=memoryCredentialPort(),{ctx}=makeMockCtx({credentials:port})
 const {handler}=createManagedMcpConnectionHandler(ctx,await tempRoot(t),()=>headerBasicEntry())
 await handler('mcp-connections/add',{catalogId:'test.mcp-conn',credentials:{'header_test_conn__x-api-key':value,basic_user_test_conn:'alice',basic_pass_test_conn:'atl-'+'q1w2e3r4t5'}})
 for(const bad of [' x-1234',"x-1234 ",'x\u00a0y'])assert.throws(()=>connectorAuthHeaders(secretAuth({target:'header',name:'X-Api-Key',label,required:true}),'svc',{'header_svc__x-api-key':bad}),{code:'teloa/invalid-input'},JSON.stringify(bad))
})

test('审查修复 L-4：connectorAuthHeaders 自校头名文法、禁用集与 scheme 文法（纵深防御，不依赖契约解析）',()=>{
 const slotsFor=(name:string)=>({[`header_svc__${name.toLowerCase()}`]:'v-12345678'})
 for(const name of ['X-Real-IP','Host','Cookie','X-Forwarded-For','Proxy-Authorization','Mcp-Session-Id','Via','X-HTTP-Method-Override','x_api_key','X Api','','X-Api-Key\r\nX'])
  assert.throws(()=>connectorAuthHeaders(secretAuth({target:'header',name,label,required:true}),'svc',slotsFor(name)),(error:WorkError)=>error.code==='teloa/invalid-input'&&!error.message.includes('v-12345678'),JSON.stringify(name))
 for(const scheme of ['Bad Scheme x','Bearer\r\n','',' Bearer'])
  assert.throws(()=>connectorAuthHeaders(secretAuth({target:'header',name:'Authorization',scheme,label,required:true}),'svc',{header_svc__authorization:'v-12345678'}),{code:'teloa/invalid-input'},JSON.stringify(scheme))
})

test('审查修复 L-6：bearer 值在保存与建连时同样校验字符集（可见 ASCII、无空白），报错不含值',async t=>{
 for(const bad of ['tok\r\nX-Evil: 1','tok en-1234','tok-值-12345678',''.padEnd(4097,'a')]){
  assert.throws(()=>connectorAuthHeaders(secretAuth({target:'bearer',label,required:true}),'svc',{bearer_svc:bad}),(error:WorkError)=>error.code==='teloa/invalid-input'&&!error.message.includes(bad),JSON.stringify(bad.slice(0,20)))
  const {ctx}=makeMockCtx()
  const {handler}=createManagedMcpConnectionHandler(ctx,await tempRoot(t),()=>httpEntry({auth:secretAuth({target:'bearer',label,required:true})}))
  await assert.rejects(handler('mcp-connections/add',{catalogId:'test.mcp-conn',credentials:{bearer_test_conn:bad}}),(error:WorkError)=>error.code==='teloa/invalid-input'&&!error.message.includes(bad))
 }
})

test('审查修复 L-2（宿主侧）：args 引用的非必填 env 变量未填时显式设为空串，不继承宿主同名变量；未被引用的未填变量不设',async t=>{
 const entry=stdioEntry()
 entry.connector.auth=secretAuth({target:'env',envVarName:'API_TOKEN',label,required:false},{target:'env',envVarName:'OTHER_KEY',label,required:false})
 if(entry.connector.recipe.transport!=='stdio')assert.fail()
 entry.connector.recipe.args=['--header','Authorization:${API_TOKEN}']
 const configs:Record<string,unknown>[]=[]
 const {ctx}=makeMockCtx()
 const plugin=(ctx as unknown as {plugin:(p:unknown,c:Record<string,unknown>)=>unknown}).plugin
 Reflect.set(ctx,'plugin',(p:unknown,config:Record<string,unknown>)=>{configs.push(config);return plugin(p,config)})
 const install:InstallFn=async root=>join(root,'fake-bin.js')
 const {handler}=createManagedMcpConnectionHandler(ctx,await tempRoot(t),()=>entry,install)
 const rec=await handler('mcp-connections/add',{catalogId:entry.id}) as {id:string}
 await handler('mcp-connections/connect',{id:rec.id})
 const env=(configs[0] as {env:Record<string,string>}).env
 assert.equal(Object.hasOwn(env,'API_TOKEN'),true,'被引用的变量显式存在');assert.equal(env.API_TOKEN,'')
 assert.equal(Object.hasOwn(env,'OTHER_KEY'),false,'未被引用的未填变量不设')
})

// ─── 保存时归一：bearer 去误粘的 `Bearer ` 前缀与首尾空白，header / basic 去首尾空白 ───────────

test('保存端点：bearer 值去掉误粘的前导 Bearer（不区分大小写）与首尾空白后再校验，建连头只有一层 Bearer',async t=>{
 const entry=httpEntry({auth:secretAuth({target:'bearer',label,required:true})})
 for(const pasted of ['Bearer tok-'+'a1b2c3d4','  bearer   tok-'+'a1b2c3d4\n','BEARER\ttok-'+'a1b2c3d4 ','tok-'+'a1b2c3d4\r\n']){
  const configs:Record<string,unknown>[]=[]
  const port=memoryCredentialPort(),{ctx}=makeMockCtx({credentials:port})
  const plugin=(ctx as unknown as {plugin:(p:unknown,c:Record<string,unknown>)=>unknown}).plugin
  Reflect.set(ctx,'plugin',(p:unknown,config:Record<string,unknown>)=>{configs.push(config);return plugin(p,config)})
  const {handler}=createManagedMcpConnectionHandler(ctx,await tempRoot(t),()=>entry)
  const rec=await handler('mcp-connections/add',{catalogId:entry.id,credentials:{bearer_test_conn:pasted}}) as {id:string}
  assert.deepEqual(await port.readRecord(mcpCredentialKey('test_conn')),{kind:'grant',payload:{bearer_test_conn:'tok-a1b2c3d4'}},JSON.stringify(pasted))
  await handler('mcp-connections/connect',{id:rec.id})
  assert.deepEqual(configs[0]!.headers,{Authorization:'Bearer tok-a1b2c3d4'},JSON.stringify(pasted))
 }
 for(const bad of ['Bearer ','Bearer tok en-1234','   ']){
  const {ctx}=makeMockCtx()
  const {handler}=createManagedMcpConnectionHandler(ctx,await tempRoot(t),()=>entry)
  await assert.rejects(handler('mcp-connections/add',{catalogId:entry.id,credentials:{bearer_test_conn:bad}}),{code:'teloa/invalid-input'},JSON.stringify(bad))
 }
})

test('保存端点：header 与 basic 值去首尾空白后再校验并按去空白后的值存储',async t=>{
 const port=memoryCredentialPort(),{ctx}=makeMockCtx({credentials:port})
 const {handler}=createManagedMcpConnectionHandler(ctx,await tempRoot(t),()=>headerBasicEntry())
 await handler('mcp-connections/add',{catalogId:'test.mcp-conn',credentials:{'header_test_conn__x-api-key':' \tkey-'+'z9y8 x7w6\n','basic_user_test_conn':'  alice ','basic_pass_test_conn':'\tatl-'+'q1w2e3r4t5\r\n'}})
 assert.deepEqual(await port.readRecord(mcpCredentialKey('test_conn')),{kind:'grant',payload:{'header_test_conn__x-api-key':'key-z9y8 x7w6','basic_user_test_conn':'alice','basic_pass_test_conn':'atl-q1w2e3r4t5'}})
})

test('审查 L2：只剩字面量 bearer、或 Bearer:tok 这类带冒号的前缀一律拒收，并提示只填令牌本身',async t=>{
 const entry=httpEntry({auth:secretAuth({target:'bearer',label,required:true})})
 for(const bad of ['bearer','  BEARER\n','Bearer:tok-'+'a1b2c3d4','bearer=tok-'+'a1b2c3d4','Bearer: tok-'+'a1b2c3d4']){
  const {ctx}=makeMockCtx()
  const {handler}=createManagedMcpConnectionHandler(ctx,await tempRoot(t),()=>entry)
  await assert.rejects(handler('mcp-connections/add',{catalogId:entry.id,credentials:{bearer_test_conn:bad}}),(error:WorkError)=>error.code==='teloa/invalid-input'&&error.message.includes('只填令牌本身')&&!error.message.includes('a1b2c3d4'),JSON.stringify(bad))
 }
 // 只是恰好以 bearer 开头、后面没有分隔符的令牌不受影响。
 const port=memoryCredentialPort(),{ctx}=makeMockCtx({credentials:port})
 const {handler}=createManagedMcpConnectionHandler(ctx,await tempRoot(t),()=>entry)
 await handler('mcp-connections/add',{catalogId:entry.id,credentials:{bearer_test_conn:'bearertok-'+'a1b2c3d4'}})
 assert.deepEqual(await port.readRecord(mcpCredentialKey('test_conn')),{kind:'grant',payload:{bearer_test_conn:'bearertok-a1b2c3d4'}})
})
