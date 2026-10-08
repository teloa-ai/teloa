import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn,spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {cp,mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises'
import {dirname,join} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath,pathToFileURL} from 'node:url'
import ts from 'typescript'
import {patchedNativePackage} from './fixtures/native-patched-package.ts'

type Cleanup=Parameters<typeof patchedNativePackage>[0]
type Mode='read-only'|'workspace-write'|'danger-full-access'
type Confined={argv:string[];enforcement:'full'|'partial';denialSignatures:string[];runnerFailureRules:Array<{allowedExitCodes?:number[];fatalSignatures:string[];informationalLines?:string[]}>}
type Reply={ok:true;value:Confined}|{ok:false;name:string;code:string|undefined;message:string}
type Peer={request<T>(method:string,params:unknown,schema:{parse:(value:unknown)=>T},signal?:AbortSignal):Promise<T>;close(error?:Error):void}
type Hello={protocol:number;platform:string;workspace:string;root:string}

const compatBasename='dsh-ssh-0.2.1-alpha.1-helper-sandbox-tier'
const compat=fileURLToPath(new URL('../compat/',import.meta.url))
const anchor=fileURLToPath(new URL('../../native-remote/package.json',import.meta.url))
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
const argv=['/bin/echo','teloa','helper sandbox']
const passthrough=(input:readonly string[]):Confined=>({argv:[...input],enforcement:'partial',denialSignatures:[],runnerFailureRules:[]})
const upstreamRoot=async()=>dirname(await realpath(createRequire(anchor).resolve('@deepseek-ai/dsh-ssh/package.json')))

function isRecord(value:unknown):value is Record<string,unknown>{return typeof value==='object'&&value!==null&&!Array.isArray(value)}
const strings=(value:unknown):value is string[]=>Array.isArray(value)&&value.every(item=>typeof item==='string')
/** 与官方 dsh-sandbox-ssh 客户端相同的严格回执形状；多余或缺失字段都拒绝。 */
const confinedSchema={parse(value:unknown):Confined{
 assert.ok(isRecord(value),'sandbox 回执必须是对象')
 assert.deepEqual(Object.keys(value).sort(),['argv','denialSignatures','enforcement','runnerFailureRules'])
 assert.ok(strings(value.argv)&&value.argv.length>0,'argv 必须是非空字符串数组')
 assert.ok(value.enforcement==='full'||value.enforcement==='partial','enforcement 只能是 full 或 partial')
 assert.ok(strings(value.denialSignatures))
 assert.ok(Array.isArray(value.runnerFailureRules))
 for(const rule of value.runnerFailureRules as unknown[]){
  assert.ok(isRecord(rule)&&strings(rule.fatalSignatures))
  for(const key of Object.keys(rule))assert.ok(['allowedExitCodes','fatalSignatures','informationalLines'].includes(key))
 }
 return value as Confined
}}
const helloSchema={parse(value:unknown):Hello{
 assert.ok(isRecord(value)&&value.protocol===1&&typeof value.platform==='string'&&typeof value.workspace==='string'&&typeof value.root==='string')
 return value as Hello
}}
const nullSchema={parse(value:unknown):null{assert.equal(value,null);return null}}

async function workspaceDir(t:Cleanup){
 const dir=await realpath(await mkdtemp(join(tmpdir(),'teloa-ssh-helper-sandbox-')))
 t.after(()=>rm(dir,{recursive:true,force:true}))
 return dir
}

/** 以官方 helper 入口方式启动（node <entry>，无其他参数），并用官方 SshRpcPeer 完成 hello 握手。 */
async function startHelper(t:Cleanup,entry:string,cwd:string,tier:string|undefined){
 const env={...process.env};delete env.DSH_SSH_SANDBOX
 if(tier!==undefined)env.DSH_SSH_SANDBOX=tier
 const child=spawn(process.execPath,[entry],{cwd,env,stdio:['pipe','pipe','pipe']})
 const stderr:string[]=[];child.stderr.setEncoding('utf8');child.stderr.on('data',chunk=>stderr.push(String(chunk)))
 const exited=new Promise<number|null>(resolve=>child.once('exit',code=>resolve(code)))
 const {SshRpcPeer}=await import(pathToFileURL(join(await upstreamRoot(),'lib/protocol.js')).href) as {SshRpcPeer:new(input:NodeJS.ReadableStream,output:NodeJS.WritableStream,maxFrameBytes:number,maxPending:number)=>Peer}
 const peer=new SshRpcPeer(child.stdout,child.stdin,64*1024*1024,8)
 let closed=false
 const close=async()=>{
  if(closed)return;closed=true
  await peer.request('close',{},nullSchema).catch(()=>{})
  peer.close()
  const timer=setTimeout(()=>child.kill('SIGKILL'),5000)
  await exited;clearTimeout(timer)
  assert.equal(stderr.join(''),'','helper 不应向 stderr 输出')
 }
 t.after(close)
 const hello=await peer.request('hello',{protocol:1,workspace:cwd,leaseMs:30000},helloSchema)
 assert.equal(hello.workspace,cwd)
 return {peer,hello,close}
}

async function sandbox(peer:Peer,mode:Mode,workspaceRoot:string):Promise<Reply>{
 try{
  return {ok:true,value:await peer.request('sandbox',{argv,policy:{mode,workspaceRoot}},confinedSchema)}
 }catch(error){
  assert.ok(error instanceof Error&&error.name==='RemoteOperationError','只接受 helper 自己回报的操作错误：'+String(error))
  return {ok:false,name:error.name,code:(error as {code?:string}).code,message:error.message}
 }
}

/** 替身：沿用上游 LocalSandboxProvider 的代码与 Config，只把平台链固定成没有 bwrap、没有 Landlock 的 Linux。 */
async function sandboxLocalStandIn(t:Cleanup){
 const upstream=await realpath(createRequire(join(await upstreamRoot(),'package.json')).resolve('@deepseek-ai/dsh-sandbox-local'))
 const dir=await mkdtemp(join(tmpdir(),'teloa-sandbox-local-stand-in-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 await mkdir(join(dir,'lib'))
 await writeFile(join(dir,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh-sandbox-local',version:'0.2.1-alpha.1',type:'module',exports:{'.':'./lib/index.js','./package.json':'./package.json'}}))
 await writeFile(join(dir,'lib/index.js'),`import {LocalSandboxProvider as Upstream} from ${JSON.stringify(pathToFileURL(upstream).href)};
export class LocalSandboxProvider extends Upstream{
 constructor(ctx,config){super(ctx,config);this.internals={platform:'linux',probeBwrap:()=>false,probeLandlock:()=>'unusable',landlockLauncher:'/nonexistent/landlock-run'}}
}
export default LocalSandboxProvider
`)
 return dir
}

test('未设 DSH_SSH_SANDBOX 或取其他值时 helper 装配 LocalSandboxProvider',{timeout:120000},async t=>{
 const [{root},source,workspace]=await Promise.all([patchedNativePackage(t,{packageName:'@deepseek-ai/dsh-ssh',compatBasename,packageAnchor:anchor}),upstreamRoot(),workspaceDir(t)])
 for(const tier of [undefined,'','local','CONTAINER','true','container ']){
  const upstream=await startHelper(t,join(source,'lib/helper.js'),workspace,tier)
  const patched=await startHelper(t,join(root,'lib/helper.js'),workspace,tier)
  for(const mode of ['read-only','workspace-write','danger-full-access'] as const){
   const expected=await sandbox(upstream.peer,mode,workspace),actual=await sandbox(patched.peer,mode,workspace)
   assert.deepEqual(actual,expected,`DSH_SSH_SANDBOX=${JSON.stringify(tier)} 下 ${mode} 的 sandbox 回执必须与上游 helper 逐字节一致`)
   if(expected.ok)assert.notDeepEqual(expected.value,passthrough(argv),'上游本机提供方要么包裹 argv 要么拒绝，不会原样放行')
  }
  await Promise.all([upstream.close(),patched.close()])
 }
})

test('container 档位下 workspace-write 原样放行且 enforcement 为 partial',{timeout:60000},async t=>{
 const [{root},source,workspace]=await Promise.all([patchedNativePackage(t,{packageName:'@deepseek-ai/dsh-ssh',compatBasename,packageAnchor:anchor}),upstreamRoot(),workspaceDir(t)])
 const upstream=await startHelper(t,join(source,'lib/helper.js'),workspace,undefined)
 const container=await startHelper(t,join(root,'lib/helper.js'),workspace,'container')
 assert.deepEqual(await sandbox(container.peer,'workspace-write',workspace),{ok:true,value:passthrough(argv)})
 assert.deepEqual(await sandbox(container.peer,'read-only',workspace),await sandbox(upstream.peer,'read-only',workspace),'read-only 仍交给上游本机提供方')
 assert.deepEqual(await sandbox(container.peer,'danger-full-access',workspace),await sandbox(upstream.peer,'danger-full-access',workspace),'danger-full-access 仍由 helper 拒绝')
 await Promise.all([upstream.close(),container.close()])
})

test('container 档位下上游提供方不可用（替身模拟无 Landlock、无 bwrap）时 read-only 被拒',{timeout:60000},async t=>{
 const standIn=await sandboxLocalStandIn(t)
 const [{root},workspace]=await Promise.all([patchedNativePackage(t,{packageName:'@deepseek-ai/dsh-ssh',compatBasename,packageAnchor:anchor,overrides:{'@deepseek-ai/dsh-sandbox-local':standIn}}),workspaceDir(t)])
 const container=await startHelper(t,join(root,'lib/helper.js'),workspace,'container')
 // 协议只传 message 与 code；客户端侧统一是 RemoteOperationError，以 code 判定上游 fail-closed。
 const refused=await sandbox(container.peer,'read-only',workspace)
 assert.ok(!refused.ok&&refused.code==='SANDBOX_UNAVAILABLE'&&/no sandbox backend is usable/.test(refused.message),JSON.stringify(refused))
 assert.deepEqual(await sandbox(container.peer,'workspace-write',workspace),{ok:true,value:passthrough(argv)},'容器档位的 workspace-write 不依赖上游提供方')
 await container.close()
 const local=await startHelper(t,join(root,'lib/helper.js'),workspace,undefined)
 for(const mode of ['read-only','workspace-write'] as const){
  const reply=await sandbox(local.peer,mode,workspace)
  assert.ok(!reply.ok&&reply.code==='SANDBOX_UNAVAILABLE',`默认档位沿用上游 fail-closed：${mode} ${JSON.stringify(reply)}`)
 }
 await local.close()
})

test('清单 patchSha256 与前后文件摘要一致、无 fuzz',{timeout:60000},async t=>{
 const source=await upstreamRoot()
 const receipt=JSON.parse(await readFile(join(compat,compatBasename+'.json'),'utf8')) as {
  schema:string;package:string;version:string;api:string[];patchSha256:string;files:Array<{path:string;beforeSha256:string;afterSha256:string}>;scope:Record<string,unknown>
 }
 const patch=await readFile(join(compat,compatBasename+'.patch'))
 assert.equal(receipt.schema,'teloa.dsh-compat-patch/v1');assert.equal(receipt.package,'@deepseek-ai/dsh-ssh');assert.equal(receipt.version,'0.2.1-alpha.1')
 assert.equal(hash(patch),receipt.patchSha256)
 assert.deepEqual(receipt.api,['resolveHelperSandboxTier','ContainerTierSandboxProvider'])
 assert.deepEqual(receipt.files.map(file=>file.path),['lib/helper.js','lib/types/helper-entry.d.ts'])
 for(const file of receipt.files)assert.equal(hash(await readFile(join(source,file.path))),file.beforeSha256,file.path+' 的前摘要必须对应固定的 alpha.1 文件')
 assert.ok(typeof receipt.scope.default==='string'&&/upstream/i.test(receipt.scope.default),'scope.default 必须说明未设或其他取值时与上游一致')
 assert.ok(typeof receipt.scope.boundary==='string'&&/partial/.test(receipt.scope.boundary)&&/container/i.test(receipt.scope.boundary),'scope.boundary 必须说明 partial 表示由容器负责')
 // 在新副本上零 fuzz 干跑：既不能 fuzz，也不能靠行偏移。
 const scratch=await mkdtemp(join(tmpdir(),'teloa-ssh-patch-dry-run-'));t.after(()=>rm(scratch,{recursive:true,force:true}))
 await cp(source,scratch,{recursive:true,dereference:true})
 const applied=spawnSync('patch',['--batch','--fuzz=0','--dry-run','-p1'],{cwd:scratch,input:patch,encoding:'utf8'})
 assert.equal(applied.status,0,applied.stderr||applied.stdout)
 assert.doesNotMatch(applied.stdout+applied.stderr,/fuzz|offset/i,applied.stdout)
 // 实际应用并核对后摘要由夹具完成；再核对实际导出与清单 api 一致。
 const {root}=await patchedNativePackage(t,{packageName:'@deepseek-ai/dsh-ssh',compatBasename,packageAnchor:anchor})
 for(const file of receipt.files)assert.equal(hash(await readFile(join(root,file.path))),file.afterSha256)
 const probe=spawnSync(process.execPath,['--input-type=module','-e',`const ns=await import(${JSON.stringify(pathToFileURL(join(root,'lib/helper.js')).href)});process.exitCode=0;process.stdout.write(JSON.stringify({keys:Object.keys(ns).sort(),tiers:[{},{DSH_SSH_SANDBOX:'container'},{DSH_SSH_SANDBOX:'CONTAINER'},{DSH_SSH_SANDBOX:'local'},{DSH_SSH_SANDBOX:''}].map(env=>ns.resolveHelperSandboxTier(env)),parent:Object.getPrototypeOf(ns.ContainerTierSandboxProvider).name,confineOwn:Object.hasOwn(ns.ContainerTierSandboxProvider.prototype,'confine')}))`],{encoding:'utf8',cwd:root})
 assert.equal(probe.status,0,probe.stderr)
 assert.equal(probe.stderr,'dsh-ssh-sandbox: SSH helper accepts no command arguments\n','入口对非法参数的拒绝行为与上游相同')
 assert.deepEqual(JSON.parse(probe.stdout),{keys:[...receipt.api].sort(),tiers:['local','container','local','local','local'],parent:'LocalSandboxProvider',confineOwn:true})
 // 类型声明与运行时导出一致。
 const snippet=join(root,'sandbox-tier-types.mts')
 await writeFile(snippet,`import {ContainerTierSandboxProvider,resolveHelperSandboxTier} from '@deepseek-ai/dsh-ssh/helper';\nimport {LocalSandboxProvider} from '@deepseek-ai/dsh-sandbox-local';\nconst tier:'local'|'container'=resolveHelperSandboxTier({DSH_SSH_SANDBOX:'container'});\nconst provider:typeof LocalSandboxProvider=ContainerTierSandboxProvider;\n// @ts-expect-error env must be a string record\nresolveHelperSandboxTier('container');\nvoid [tier,provider];\n`)
 const program=ts.createProgram([snippet],{module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,target:ts.ScriptTarget.ESNext,noEmit:true,strict:true,skipLibCheck:true})
 const diagnostics=ts.getPreEmitDiagnostics(program)
 assert.equal(diagnostics.length,0,ts.formatDiagnostics(diagnostics,{getCanonicalFileName:path=>path,getCurrentDirectory:()=>root,getNewLine:()=>'\n'}))
})
