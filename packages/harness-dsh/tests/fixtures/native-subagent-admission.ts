import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {cp,mkdir,mkdtemp,readFile,readdir,rm,symlink} from 'node:fs/promises'
import {dirname,join} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createRequire} from 'node:module'
import {spawnSync} from 'node:child_process'
import {setTimeout as delay} from 'node:timers/promises'
import {Context} from '@deepseek-ai/cordis'
import {AgentRegistry,type Agent} from '@deepseek-ai/dsh-agent'
import {LlmAdapter,type UserMessage,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {SessionId,type SessionStore} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as SpawnProvider from '@deepseek-ai/dsh-subagent-spawn-in-process'
import {patchedCorePackages} from './native-final-session.ts'

export type AdmissionRequest=Readonly<{agent:Agent;message:UserMessage;sender:Agent;delivery:'queue'|'steer';signal:AbortSignal}>&(Readonly<{kind:'initial';mode:'continuable'|'one-shot'}>|Readonly<{kind:'live'|'resume'}>)
export type Admission=(request:Readonly<AdmissionRequest>,dispatch:()=>void)=>Promise<void>
export type AdmissionOptions={requirePromptAdmission?:boolean;admitPrompt?:Admission}
const require=createRequire(import.meta.url),installed=require.resolve('@deepseek-ai/dsh-subagent')
const compat=fileURLToPath(new URL('../../compat/',import.meta.url)),name='dsh-subagent-0.2.0-rc.2-prompt-admission'
const sha=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex')
type Cleanup={after:(action:()=>unknown)=>void}
export function deferred<T=void>(){let resolve!:(value:T)=>void;let reject!:(error:unknown)=>void;const promise=new Promise<T>((done,fail)=>{resolve=done;reject=fail});return {promise,resolve,reject}}
export async function until(check:()=>boolean|Promise<boolean>){for(let i=0;i<500;i++){if(await check())return;await delay(2)}throw Error('子代理内存验收等待超时。')}

/** 只应用精确 npm 差分到本测试所有的临时完整包；原 vendor 始终只读。 */
export async function patchedSubagent(t:Cleanup,patched=true){
 const source=dirname(dirname(installed)),metadata=JSON.parse(await readFile(join(source,'package.json'),'utf8'))
 const receipt=JSON.parse(await readFile(join(compat,name+'.json'),'utf8')),patch=join(compat,name+'.patch')
 assert.equal(receipt.schema,'teloa.dsh-compat-patch/v1');assert.equal(metadata.name,receipt.package);assert.equal(metadata.version,'0.2.0-rc.2');assert.equal(metadata.version,receipt.version);assert.equal(sha(await readFile(patch)),receipt.patchSha256)
 for(const row of receipt.files)assert.equal(sha(await readFile(join(source,row.path))),row.beforeSha256)
 if(!patched)return import(pathToFileURL(join(source,'lib/index.js')).href)
 const root=await mkdtemp('/private/tmp/teloa-native-subagent-'),copy=join(root,'package')
 t.after(async()=>{for(const row of receipt.files)assert.equal(sha(await readFile(join(source,row.path))),row.beforeSha256);await rm(root,{recursive:true,force:true})})
 await cp(source,copy,{recursive:true,filter:path=>path!==join(source,'node_modules')});await symlink(dirname(dirname(source)),join(copy,'node_modules'),'dir')
 const applied=spawnSync('/usr/bin/patch',['--batch','--fuzz=0','--forward','-p1','-i',patch],{cwd:copy,encoding:'utf8'})
 assert.equal(applied.status,0,applied.stdout+applied.stderr)
 for(const row of receipt.files)assert.equal(sha(await readFile(join(copy,row.path))),row.afterSha256)
 return import(pathToFileURL(join(copy,'lib/index.js')).href)
}

export type SubagentComposition={sessionPackage?:{SessionStore:typeof SessionStore};beforeService?:(candidate:{ctx:Context;parent:Agent;child:Agent})=>void}

/** 真官方 continuable materialization、Slot、AgentLoop/Session/Inbox，初始任务在 pre-step 停住。 */
export async function subagentFixture(t:Cleanup,options:AdmissionOptions={},patched=true,composition:SubagentComposition={}){
 const {sessionPackage,llmPackage,toolsPackage,loopPackage}=await patchedCorePackages(t),subagent=await patchedSubagent(t,patched),ctx=new Context(),stepGate=deferred(),root=await mkdtemp('/private/tmp/teloa-subagent-persistence-')
 let modelCalls=0
 t.after(async()=>{const disposing=ctx.fiber.dispose();stepGate.resolve();await disposing;assert.equal(modelCalls,0);await rm(root,{recursive:true,force:true})})
 for(const plugin of [llmPackage.LlmRuntime,composition.sessionPackage?.SessionStore??sessionPackage.SessionStore,SessionProjectionRegistry,SystemPrompt,toolsPackage.ToolRuntime,AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(Persistence,{root});await ctx.plugin(loopPackage.AgentLoop,{agents:[]})
 // pre-step 是官方 awaitable waterfall：真实 initial Inbox 已受理，模型尚未调用。
 ctx.on('agent/pre-step',async({signal},_next)=>{
  if(!signal.aborted)await Promise.race([stepGate.promise,new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}))])
  return {kind:'reject'}
 })
 class NoModel extends LlmAdapter{async *stream(_options:GenerateOptions):AsyncIterable<StreamChunk>{modelCalls++;throw Error('本夹具禁止任何模型请求。')}}
 ctx.llm.registerAdapter(['test'],new NoModel())
 const {agent:parent}=await ctx.agents.create({sessionId:SessionId('subagent-parent'),agentOptions:{provider:'test',model:'test'}})
 // 此旧夹具专验live输入；初始化沿默认Free先完成，不用初始特例绕过同一holder。
 const service=new subagent.SubagentRuntime(ctx,{maxActiveSubagents:{get:()=>8},maxDepth:{get:()=>2}})
 await ctx.plugin(SpawnProvider,{providerName:'spawn'})
 const signal=new AbortController().signal
 const start=await service.startContinuable({provider:'spawn',childId:SessionId('subagent-child'),label:'fixture initial accepted',request:{parent,prompt:[{type:'text',text:'fixture seed outside live admission scope'}]},signal})
 const child=ctx.agents.get(start.childId)!
 await until(()=>child.status==='running')
 const manager=service.continuations,registry=manager.activations
 composition.beforeService?.({ctx,parent,child})
 if(patched){if(options.requirePromptAdmission)service.requirePromptAdmission();if(options.admitPrompt)service.installPromptAdmission(options.admitPrompt)}
 const prompt=(text:string,delivery:'queue'|'steer'='queue',requestId='rpc-'+text,abort:AbortSignal=signal)=>service.prompt({requestId,parentSessionId:parent.id,childSessionId:child.id,mode:'continuable',delivery,content:[{type:'text',text}]},abort)
 const send=(sender:Agent,target:Agent,text:string,abort:AbortSignal=signal)=>service.sendMessage(sender,target.id,[{type:'text',text}],{signal:abort})
 const ledger=(agent:Agent)=>agent.session.snapshotEvents().filter(event=>event.type==='agent/inbox/spliced').flatMap(event=>event.data.inserted)
 return {ctx,parent,child,service,subagent,manager,registry,prompt,send,ledger,start,modelCalls:()=>modelCalls}
}

/** 两个补口和原SpawnProvider在同一私有完整npm图；不修改已安装包或provider实现。 */
export async function initialSubagentPackages(t:Cleanup,patched=true){
 const subagentSource=dirname(dirname(installed)),spawnSource=dirname(dirname(require.resolve('@deepseek-ai/dsh-subagent-spawn-in-process')))
 const driverSource=dirname(dirname(createRequire(join(spawnSource,'lib/index.js')).resolve('@deepseek-ai/dsh-subagent-in-process-driver')))
 const root=await mkdtemp('/private/tmp/teloa-subagent-initial-packages-')
 const sources=[subagentSource,driverSource,spawnSource],copies=sources.map((_,i)=>join(root,'package-'+i)),records:Array<{source:string;path:string;sha256:string}>=[]
 t.after(async()=>{for(const row of records)assert.equal(sha(await readFile(join(row.source,row.path))),row.sha256);await rm(root,{recursive:true,force:true})})
 const aliases=new Map<string,string>()
 for(let i=0;i<sources.length;i++){
  const source=sources[i]!,copy=copies[i]!,metadata=JSON.parse(await readFile(join(source,'package.json'),'utf8'))
  assert.equal(metadata.version,'0.2.0-rc.2');aliases.set(metadata.name,copy)
  await cp(source,copy,{recursive:true,filter:path=>path!==join(source,'node_modules')})
  for(const path of ['lib/index.js','lib/types/index.d.ts','package.json'])records.push({source,path,sha256:sha(await readFile(join(source,path)))})
  if(i===2)continue
  const patchName=i===0?name:'dsh-subagent-in-process-driver-0.2.0-rc.2-input-admission',manifest=JSON.parse(await readFile(join(compat,patchName+'.json'),'utf8')),bytes=await readFile(join(compat,patchName+'.patch'))
  assert.equal(manifest.schema,'teloa.dsh-compat-patch/v1');assert.equal(manifest.package,metadata.name);assert.equal(manifest.version,metadata.version);assert.equal(manifest.upstreamCommit,'639ed015397290b3745d163aafe02ffee4aa3f84');assert.equal(manifest.patchSha256,sha(bytes))
  for(const row of manifest.files)assert.equal(sha(await readFile(join(source,row.path))),row.beforeSha256)
  if(patched){const result=spawnSync('/usr/bin/patch',['--batch','--fuzz=0','--forward','-p1'],{cwd:copy,input:bytes,encoding:'utf8'});assert.equal(result.status,0,result.stdout+result.stderr);for(const row of manifest.files)assert.equal(sha(await readFile(join(copy,row.path))),row.afterSha256)}
 }
 for(let i=0;i<sources.length;i++){
  const peers=dirname(dirname(sources[i]!)),modules=join(copies[i]!,'node_modules')
  await mkdir(modules)
  for(const entry of await readdir(peers)){
   if(entry==='@deepseek-ai'){
    const scope=join(modules,entry);await mkdir(scope)
    for(const peer of await readdir(join(peers,entry)))await symlink(aliases.get(entry+'/'+peer)??join(peers,entry,peer),join(scope,peer),'dir')
   }else if(entry!=='.bin')await symlink(join(peers,entry),join(modules,entry),'dir')
  }
 }
 return {roots:copies,subagent:await import(pathToFileURL(join(copies[0]!,'lib/index.js')).href),driver:await import(pathToFileURL(join(copies[1]!,'lib/index.js')).href),spawn:await import(pathToFileURL(join(copies[2]!,'lib/index.js')).href),sourceSubagent:await import(pathToFileURL(installed).href)}
}

export type InitialSubagentComposition={sessionPackage?:{SessionStore:typeof SessionStore};beforeService?:(candidate:{ctx:Context;parent:Agent})=>void;service?:'patched'|'original'|'none';patched?:boolean}

/** 策略在首次子Agent创建前固定；真官方Session/Inbox/JSONL/Query，禁止任何模型调用。 */
export async function initialSubagentFixture(t:Cleanup,options:AdmissionOptions={},composition:InitialSubagentComposition={}){
 const {sessionPackage,llmPackage,toolsPackage,loopPackage}=await patchedCorePackages(t),packages=await initialSubagentPackages(t,composition.patched!==false),ctx=new Context(),stepGate=deferred(),root=await mkdtemp('/private/tmp/teloa-subagent-initial-persistence-')
 let modelCalls=0,holdSteps=true
 t.after(async()=>{holdSteps=false;stepGate.resolve();await ctx.fiber.dispose();assert.equal(modelCalls,0);await rm(root,{recursive:true,force:true})})
 for(const plugin of [llmPackage.LlmRuntime,composition.sessionPackage?.SessionStore??sessionPackage.SessionStore,SessionProjectionRegistry,SystemPrompt,toolsPackage.ToolRuntime,AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(Persistence,{root});await ctx.plugin(loopPackage.AgentLoop,{agents:[]})
 ctx.on('agent/pre-step',async({signal},_next)=>{if(holdSteps&&!signal.aborted)await Promise.race([stepGate.promise,new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}))]);return {kind:'reject'}})
 class NoModel extends LlmAdapter{async *stream(_options:GenerateOptions):AsyncIterable<StreamChunk>{modelCalls++;throw Error('本夹具禁止任何模型请求。')}}
 ctx.llm.registerAdapter(['test'],new NoModel())
 const query=await import(pathToFileURL(createRequire(installed).resolve('@deepseek-ai/dsh-session-query')).href)
 class PointQuery extends query.SessionQueryEngine{searchSessions():Promise<never>{return Promise.reject(Error('本夹具不提供搜索。'))}searchEvents():Promise<never>{return Promise.reject(Error('本夹具不提供搜索。'))}}
 await ctx.plugin(PointQuery)
 const {agent:parent}=await ctx.agents.create({sessionId:SessionId('initial-parent'),agentOptions:{provider:'test',model:'test'}})
 composition.beforeService?.({ctx,parent})
 const SDK=composition.service==='original'?packages.sourceSubagent:packages.subagent
 const service=composition.service==='none'?undefined:new SDK.SubagentRuntime(ctx,{maxActiveSubagents:{get:()=>8},maxDepth:{get:()=>2}},options)
 if(service)await ctx.plugin(packages.spawn,{providerName:'spawn'})
 const startContinuable=(id='initial-child',signal=new AbortController().signal)=>service.startContinuable({provider:'spawn',childId:SessionId(id),label:'initial fixture',request:{parent,prompt:[{type:'text',text:'真实首次输入'}]},signal})
 const startOneShot=(signal=new AbortController().signal)=>service.start('spawn',{label:'initial one-shot',prompt:[{type:'text',text:'真实一次性首次输入'}],parent,signal})
 const startDirect=(signal=new AbortController().signal)=>packages.driver.startInProcessRun({label:'direct',prompt:[{type:'text',text:'真实直接首次输入'}],parent,signal,descriptor:packages.subagent.snapshotSubagentDescriptor({mode:'one-shot',provider:'spawn',label:'direct'})},{})
 const ledger=(agent:Agent)=>agent.session.snapshotEvents().filter(event=>event.type==='agent/inbox/spliced').flatMap(event=>event.data.inserted)
 return {ctx,parent,service,packages,startContinuable,startOneShot,startDirect,ledger,releaseSteps(){holdSteps=false;stepGate.resolve()},modelCalls:()=>modelCalls}
}
