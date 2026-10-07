import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {cp,mkdtemp,readFile,realpath,rm,symlink} from 'node:fs/promises'
import {dirname,join} from 'node:path'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'
import {fileURLToPath,pathToFileURL} from 'node:url'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {UserMessage} from '@deepseek-ai/dsh-session'
import type {SessionController,SessionPromptRequest,SessionUpdateQueueRequest} from '@deepseek-ai/dsh-api-session-controller'
import {patchedSessionFixture} from './native-final-session.ts'

export type ControllerInputCandidate=
 |Readonly<{kind:'prompt';agent:Agent;message:UserMessage;requestId:string;mode:'queue'|'steer'}>
 |Readonly<{kind:'queue-edit';agent:Agent;message:UserMessage;itemId:string;target:'next-turn'|'next-step';previousMessage:UserMessage}>
export type ControllerInputAdmission=(candidate:ControllerInputCandidate,dispatch:()=>void)=>Promise<void>
export type AdmittingSessionController=SessionController&{
 requireInputAdmission:()=>void
 installInputAdmission:(policy:ControllerInputAdmission)=>void
}
type Cleanup={after:(action:()=>unknown)=>void}
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
const compat=fileURLToPath(new URL('../../compat/',import.meta.url))

export async function patchedControllerPackage(t:Cleanup){
 const source=dirname(await realpath(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-api-session-controller/package.json')))
 const filename='dsh-session-controller-0.2.1-alpha.1-input-admission'
 const receipt=JSON.parse(await readFile(join(compat,filename+'.json'),'utf8')) as {
  schema:string;package:string;version:string;patchSha256:string;files:Array<{path:string;beforeSha256:string;afterSha256:string}>
 }
 const metadata=JSON.parse(await readFile(join(source,'package.json'),'utf8')) as {name:string;version:string}
 assert.equal(receipt.schema,'teloa.dsh-compat-patch/v1');assert.equal(metadata.name,receipt.package);assert.equal(metadata.version,receipt.version)
 const patch=await readFile(join(compat,filename+'.patch'));assert.equal(hash(patch),receipt.patchSha256)
 for(const file of receipt.files)assert.equal(hash(await readFile(join(source,file.path))),file.beforeSha256)
 const temporary=await mkdtemp(join(tmpdir(),'teloa-controller-admission-'));t.after(()=>rm(temporary,{recursive:true,force:true}))
 const copied=join(temporary,'controller');await cp(source,copied,{recursive:true,dereference:true})
 await symlink(dirname(dirname(source)),join(temporary,'node_modules'),'dir')
 const result=spawnSync('patch',['--batch','--fuzz=0','-p1'],{cwd:copied,input:patch,encoding:'utf8'})
 assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout)
 for(const file of receipt.files){
  assert.equal(hash(await readFile(join(copied,file.path))),file.afterSha256)
  assert.equal(hash(await readFile(join(source,file.path))),file.beforeSha256)
 }
 return await import(pathToFileURL(join(copied,'lib/index.js')).href) as typeof import('@deepseek-ai/dsh-api-session-controller')&{
  SessionController:new(...args:ConstructorParameters<typeof SessionController>)=>AdmittingSessionController
 }
}

/** 真 Controller 与 AgentLoop/Inbox；maintenance 只阻止模型启动，不替换 Agent 或 send。 */
export async function controllerAdmissionFixture(t:Cleanup){
 const session=await patchedSessionFixture(t),{ctx,agent,other}=session,controllerPackage=await patchedControllerPackage(t)
 const maintain=(target:Agent)=>target.runMaintenance(signal=>new Promise<void>(done=>{
  signal.addEventListener('abort',()=>done(),{once:true})
 }))
 void maintain(agent);void maintain(other)
 const state={attachmentCalls:0,bindCalls:0,commits:0,rollbacks:0,retired:[] as string[]}
 const intake={admit:async(content:readonly unknown[])=>structuredClone(content) as unknown[],commit:()=>{}}
 const noop=()=>()=>{}
 // 和固定官方 controller.host 测试一样，仅提供本批不会执行外部 IO 的宿主集成。
 ctx.provide('typert',{lookups:{register:noop,configure:noop},contexts:{configureHost:noop}} as never)
 ctx.provide('agentDefaultModel',{currentSelection:()=>({provider:'test',model:'test'}),saveSelection:async()=>{}} as never)
 ctx.provide('workspaceRegistry',{get:()=>undefined,list:()=>[],archivedSessionIds:[]} as never)
 ctx.provide('attachments',{
  imageLimits:{maxImageBytes:1000,maxImagePixels:1000,maxImageDimension:100},
  admitPromptContent:async(content:readonly unknown[])=>{state.attachmentCalls++;return await intake.admit(content)},
 } as never)
 ctx.provide('fileUploads',{
  registerAgentResolver:noop,resolve:()=>undefined,
  bindPrompt:()=>{
   state.bindCalls++;let committed=false
   return {commit(){intake.commit();committed=true;state.commits++},[Symbol.dispose](){if(!committed)state.rollbacks++}}
  },
  retirePrompt:(_target:unknown,rpcId:string)=>{state.retired.push(rpcId)},
 } as never)
 const controller=new controllerPackage.SessionController(ctx,{nativeOpen:false}) as AdmittingSessionController
 // Cordis 可返回 scoped Service receiver；受管 holder 与真实命令仍是同一份。
 assert.equal(Reflect.get(Reflect.get(ctx,'sessionController'),'inputAdmission'),Reflect.get(controller,'inputAdmission'))
 return {...session,controller,state,intake}
}

export const promptRequest=(agent:Agent,rpcId='request',text='固定输入',mode:'queue'|'steer'='queue'):SessionPromptRequest=>({
 sessionId:agent.id,requestId:rpcId as SessionPromptRequest['requestId'],mode,content:[{type:'text',text}],
})
export const queueRequest=(agent:Agent,itemId:UserMessage['id'],text='编辑输入'):SessionUpdateQueueRequest=>({sessionId:agent.id,itemId,action:{kind:'edit',content:[{type:'text',text}]}})
