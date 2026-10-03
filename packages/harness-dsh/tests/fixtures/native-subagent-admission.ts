import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {cp,mkdtemp,readFile,rm,symlink} from 'node:fs/promises'
import {dirname,join} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createRequire} from 'node:module'
import {spawnSync} from 'node:child_process'
import {setTimeout as delay} from 'node:timers/promises'
import {Context} from '@deepseek-ai/cordis'
import {AgentRegistry,type Agent} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {LlmRuntime,LlmAdapter,type UserMessage,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as SpawnProvider from '@deepseek-ai/dsh-subagent-spawn-in-process'

export type AdmissionRequest={agent:Agent;message:UserMessage;sender:Agent;delivery:'queue'|'steer'}
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
 const subagent=await patchedSubagent(t,patched),ctx=new Context(),stepGate=deferred(),root=await mkdtemp('/private/tmp/teloa-subagent-persistence-')
 let modelCalls=0
 t.after(async()=>{const disposing=ctx.fiber.dispose();stepGate.resolve();await disposing;assert.equal(modelCalls,0);await rm(root,{recursive:true,force:true})})
 for(const plugin of [LlmRuntime,composition.sessionPackage?.SessionStore??SessionStore,SessionProjectionRegistry,SystemPrompt,ToolRuntime,AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(Persistence,{root});await ctx.plugin(AgentLoop,{agents:[]})
 // pre-step 是官方 awaitable waterfall：真实 initial Inbox 已受理，模型尚未调用。
 ctx.on('agent/pre-step',async({signal},_next)=>{
  if(!signal.aborted)await Promise.race([stepGate.promise,new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}))])
  return {kind:'reject'}
 })
 class NoModel extends LlmAdapter{async *stream(_options:GenerateOptions):AsyncIterable<StreamChunk>{modelCalls++;throw Error('本夹具禁止任何模型请求。')}}
 ctx.llm.registerAdapter(['test'],new NoModel())
 const {agent:parent}=await ctx.agents.create({sessionId:SessionId('subagent-parent'),agentOptions:{provider:'test',model:'test'}})
 const service=new subagent.SubagentRuntime(ctx,{maxActiveSubagents:{get:()=>8},maxDepth:{get:()=>2}},options)
 await ctx.plugin(SpawnProvider,{providerName:'spawn'})
 const signal=new AbortController().signal
 const start=await service.startContinuable({provider:'spawn',childId:SessionId('subagent-child'),label:'fixture initial accepted',request:{parent,prompt:[{type:'text',text:'fixture seed outside live admission scope'}]},signal})
 const child=ctx.agents.get(start.childId)!
 await until(()=>child.status==='running')
 const manager=service.continuations,registry=manager.activations
 composition.beforeService?.({ctx,parent,child})
 const prompt=(text:string,delivery:'queue'|'steer'='queue',requestId='rpc-'+text,abort:AbortSignal=signal)=>service.prompt({requestId,parentSessionId:parent.id,childSessionId:child.id,mode:'continuable',delivery,content:[{type:'text',text}]},abort)
 const send=(sender:Agent,target:Agent,text:string,abort:AbortSignal=signal)=>service.sendMessage(sender,target.id,[{type:'text',text}],{signal:abort})
 const ledger=(agent:Agent)=>agent.session.snapshotEvents().filter(event=>event.type==='agent/inbox/spliced').flatMap(event=>event.data.inserted)
 return {ctx,parent,child,service,subagent,manager,registry,prompt,send,ledger,start,modelCalls:()=>modelCalls}
}
