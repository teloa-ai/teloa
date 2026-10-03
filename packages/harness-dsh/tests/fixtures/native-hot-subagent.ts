import type {TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {LlmAdapter,ToolCallId,createUserMessage,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import type {Session,SessionEvent} from '@deepseek-ai/dsh-session'
import {defineTool,type ToolRunContext} from '@deepseek-ai/dsh-tools'
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import {WorkAccess,type WorkAccessRequest} from '@teloa/backend'
import {WorkError} from '@teloa/contract'
import {createNativeWorkInput} from '../../src/native-work-input.ts'
import {createNativeProducerAdmissions} from '../../src/native-producer-admission.ts'
import {nativeHotKernel,textAnswer,hotGate,type HotGate} from './native-hot-causality.ts'
import {initialSubagentPackages,type AdmissionRequest,type Admission} from './native-subagent-admission.ts'

const denied=()=>new WorkError('teloa/forbidden','子任务许可已失效。')
export type ChildMode='one-shot'|'continuable'
const parentAnswer:readonly StreamChunk[]=[
 {type:'block-start',index:0,blockType:'tool-call'},
 {type:'tool-call-delta',index:0,id:ToolCallId('delegate-call'),name:'hot_delegate',argumentsDelta:'{}'},
 {type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId('delegate-call'),name:'hot_delegate',arguments:'{}'}},
 {type:'finish',reason:{kind:'tool-calls'}},
]

/** 模型只提供确定性输出；parent/child 均实际经过同一官方 Loop 和适配器派发。 */
class ChildAdapter extends LlmAdapter{
 readonly requests:GenerateOptions[]=[]
 readonly childScripts:Array<readonly StreamChunk[]>=[]
 parentId=''
 parentCalls=0
 prepares=0
 childPrepareGate:HotGate|undefined
 override async resolveModel(provider:string,model:string,signal?:AbortSignal){
  if(++this.prepares===2&&this.childPrepareGate)await this.childPrepareGate.wait(signal)
  return {provider,id:model,name:model,inputModalities:['text'] as const}
 }
 async *stream(options:GenerateOptions):AsyncIterable<StreamChunk>{
  this.requests.push(options)
  if(options.sessionId===this.parentId){
   const script=this.parentCalls++===0?parentAnswer:textAnswer
   for(const chunk of script)yield chunk
  }else{
   for(const chunk of this.childScripts.shift()??textAnswer)yield chunk
  }
 }
}

/** 官方发布者、in-process driver、Loop、Tools 与最终 Session 在同一真实私有补口图。 */
export async function nativeHotSubagentFixture(t:TestContext,mode:ChildMode='one-shot'){
 const f=await nativeHotKernel(t),{ctx}=f,packages=await initialSubagentPackages(t)
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-hot-child-jsonl-')))
 t.after(()=>rm(root,{recursive:true,force:true}))
 await ctx.plugin(Persistence,{root})
 const require=createRequire(import.meta.url),subagentEntry=require.resolve('@deepseek-ai/dsh-subagent')
 const query=await import(pathToFileURL(createRequire(subagentEntry).resolve('@deepseek-ai/dsh-session-query')).href)
 class PointQuery extends query.SessionQueryEngine{
  searchSessions():Promise<never>{return Promise.reject(Error('热因果夹具不提供搜索。'))}
  searchEvents():Promise<never>{return Promise.reject(Error('热因果夹具不提供搜索。'))}
 }
 await ctx.plugin(PointQuery)
 const observed=new Map<Session,SessionEvent[]>()
 ctx.on('session/event',(session,event)=>{const rows=observed.get(session)??[];rows.push(event);observed.set(session,rows)},{global:true})
 const rights={valid:true,revoked:false,generation:0},counts={fresh:0,strict:0,continuation:0,tools:0}
 const authorizations:Readonly<WorkAccessRequest>[]=[]
 const access=new WorkAccess();access.requirePolicy();access.installPolicy(async request=>{
  authorizations.push(request);counts.fresh++;const generation=rights.generation
  return Object.freeze({
   assertCurrent(){counts.strict++;if(!rights.valid||rights.revoked||generation!==rights.generation)throw denied()},
   assertContinuationCurrent(){counts.continuation++;if(rights.revoked||generation!==rights.generation)throw denied()},
  })
 })
 const work=createNativeWorkInput(ctx,access),admissions=createNativeProducerAdmissions(work)
 t.after(()=>work.close())
 const candidates:AdmissionRequest[]=[],starts:unknown[]=[],runs:Array<{dispose:()=>Promise<void>}>=[],detached:Array<Promise<unknown>>=[]
 let beforeAdmission:Admission=async(candidate,dispatch)=>admissions.subagent(candidate,dispatch)
 const service=new packages.subagent.SubagentRuntime(ctx,{maxActiveSubagents:{get:()=>8},maxDepth:{get:()=>2}},{requirePromptAdmission:true,admitPrompt:async(candidate:AdmissionRequest,dispatch:()=>void)=>{candidates.push(candidate);await beforeAdmission(candidate,dispatch)}})
 await ctx.plugin(packages.spawn,{providerName:'spawn'})
 let parent:Agent
 const events=(agent:Agent=parent)=>observed.get(agent.session)??[]
 const outputText=(content:readonly {type:string;text?:string}[])=>content.filter(block=>block.type==='text').map(block=>block.text??'').join('\n')
 let toolAction:(exec:ToolRunContext,start:()=>Promise<string>)=>Promise<string|void>=async(_exec,start)=>start()
 const start=async(signal=new AbortController().signal):Promise<string>=>{
  if(mode==='one-shot'){
   const run=await service.start('spawn',{parent,prompt:[{type:'text',text:'执行真实子任务'}],label:'hot child',signal});runs.push(run);starts.push(run)
   return outputText((await run.result).output)
  }
  const initial=await service.startContinuable({provider:'spawn',childId:f.sessionPackage.SessionId('hot-continuable-child'),label:'hot child',request:{parent,prompt:[{type:'text',text:'执行真实子任务'}]},signal});starts.push(initial)
  const child=candidates.at(-1)!.agent;await child.whenIdle()
  const answer=events(child).filter(event=>event.type==='assistant/message').at(-1)
  return answer?.type==='assistant/message'?outputText(answer.data.message.content):''
 }
 ctx.tools.register(defineTool({
  name:'hot_delegate',description:'官方子任务真执行夹具',parameters:{},
  output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
  // 延后子任务的专项允许工具先返回；占位只表示工具结束，不冒充子任务输出。
  async execute(_args,exec){counts.tools++;return await toolAction(exec,()=>start(exec.signal))??'delegation-finished'},
 }))
 await ctx.plugin(f.loopPackage.namespace.AgentLoop,{agents:[]})
 parent=(await ctx.agents.create({sessionId:f.sessionPackage.SessionId('hot-child-parent'),agentOptions:{provider:'child-test',model:'child-model'}})).agent
 const adapter=new ChildAdapter();adapter.parentId=parent.id;ctx.llm.registerAdapter(['child-test'],adapter)
 const gates:HotGate[]=[]
 t.after(async()=>{for(const gate of gates)gate.release();await Promise.allSettled(detached);for(const run of runs)await run.dispose()})
 return {
  ...f,parent,mode,work,access,service,candidates,starts,rights,counts,authorizations,adapter,events,start,detached,
  setToolAction(action:typeof toolAction){toolAction=action},
  setAdmission(action:Admission){beforeAdmission=action},
  defaultAdmission:admissions.subagent,
  async send(rpcId='hot-child-input'){
   const message=createUserMessage({source:{kind:'user',rpcId},content:[{type:'text',text:'调用真实子任务'}]})
   await work.withNewInput(parent,message,{producer:'prompt',identity:rpcId},()=>parent.followup(message))
   await parent.whenIdle();return message
  },
  inserted(agent:Agent){return events(agent).filter(event=>event.type==='agent/inbox/spliced').flatMap(event=>event.data.inserted)},
  childRequests(){return adapter.requests.filter(request=>request.sessionId!==parent.id)},
  gate(){const gate=hotGate();gates.push(gate);return gate},
  assertChildResultInParent(){
   const child=candidates.find(candidate=>candidate.kind==='initial')!.agent
   const answer=events(child).filter(event=>event.type==='assistant/message').at(-1)
   assert.ok(answer?.type==='assistant/message')
   const expected=[{type:'text',text:outputText(answer.data.message.content)}]
   const result=events().find(event=>event.type==='tool/result')
   assert.ok(result?.type==='tool/result');assert.notEqual(result.data.message.isError,true)
   assert.deepEqual(result.data.message.content,expected)
   const next=adapter.requests.filter(request=>request.sessionId===parent.id)[1]
   assert.ok(next,'父模型应收到真实下一步请求')
   assert.ok(next.messages.some(message=>message.role==='tool'&&message.toolCallId===result.data.message.toolCallId&&JSON.stringify(message.content)===JSON.stringify(expected)),'子任务实际输出必须进入父下一步模型上下文')
  },
 }
}
