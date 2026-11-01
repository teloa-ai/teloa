import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {taskReferenceCitationPath} from '@teloa/contract'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {createMcpToolDefinition} from '@deepseek-ai/dsh-mcp-client'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {createPublicReferenceCatalog} from '../../mcp-reference/src/local.ts'
import {registerTaskToolGuard} from '../src/task-tool-guard.ts'
import {getToolResourceProvenance} from '../src/tool-resource-provenance.ts'
import {referenceReadTool} from '../src/role-tool-grants.ts'
const file=new URL('../src/task-reference-reader.ts',import.meta.url),text='合成资料，只读核对。',version=createHash('sha256').update(text).digest('hex'),id='local_material_11111111-1111-4111-8111-111111111111'
const citationPath=taskReferenceCitationPath({taskId:'33333333-3333-4333-8333-333333333333',resourceId:'22222222-2222-4222-8222-222222222222',resourceVersion:1,sourceVersion:version})
const value={citationPath,schema:'teloa.reference/v1',id,title:'本例资料',version,source:id,bytes:Buffer.byteLength(text),text,references:[{id:'22222222-2222-4222-8222-222222222222',version:1}]}
async function setup(t:any,read:(sessionId:string,args:unknown,signal:AbortSignal)=>Promise<unknown>=async()=>value){
 const ctx=new Context();await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 t.after(()=>ctx.fiber.dispose());const {agent}=await ctx.agents.create({sessionId:SessionId('trusted-reference-run'),agentOptions:{provider:'test',model:'test'}})
 const catalog=createPublicReferenceCatalog();let publicReads=0,privateReads=0
 ctx.tools.register(getToolResourceProvenance(ctx).wrapDefinition(createMcpToolDefinition(ctx,{
  name:referenceReadTool,rawName:'read_reference',description:'正式公共参考读取',
  inputSchema:{type:'object',properties:{id:{type:'string'},version:{type:'string'}},required:['id','version'],additionalProperties:false},
  call:async args=>{
   publicReads++
   try{const v=await catalog.read(String(args.id),String(args.version));return {content:[{type:'text',text:JSON.stringify(v)}],structuredContent:v}}
   catch(error){return {isError:true,content:[{type:'text',text:JSON.stringify({code:(error as any).code,message:(error as Error).message})}]}}
  },
 }),{kind:'mcp',providerId:'teloa_reference',name:'teloa_reference',rawToolName:'read_reference'}))
 let allowed=true
 registerTaskToolGuard(ctx,async()=>({allowedTools:allowed?[referenceReadTool]:[],argumentRules:[{name:referenceReadTool,allowed:[{id,version},...(await catalog.list()).references.map(r=>({id:r.id,version:r.version}))]}]}))
 // 未修复时不安装新适配，真实旧公共MCP/ToolRuntime正例会返回reference/not-found，作为行为RED。
 const dispose=existsSync(file)?(await import('../src/task-reference-reader.ts')).registerTaskReferenceReader(ctx,async(s,a,signal)=>{privateReads++;return read(s,a,signal) as never}):()=>{}
 t.after(dispose);let seq=0
 return {ctx,agent,dispose,setAllowed:(v:boolean)=>{allowed=v},counts:()=>({publicReads,privateReads}),publicReference:(await catalog.list()).references[0]!,call:(args:unknown,signal=new AbortController().signal)=>ctx.tools.execute({agent,name:referenceReadTool,arguments:args,callId:ToolCallId('reference-'+ ++seq),signal})}
}
test('可信参考：已选本机知识沿真实MCP ToolRuntime成功且不触公共目录',async t=>{
 const calls:unknown[]=[];const f=await setup(t,async(s,args)=>{calls.push([s,args]);return value});const r=await f.call({id,version})
 assert.equal(r.isError,false,JSON.stringify(r));assert.deepEqual((r as any).value,{content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value});assert.equal((r.meta as any).teloaResourceUse.kind,'plugin');assert.equal((r.meta as any).teloaResourceUse.providerId,'@teloa/harness-dsh');assert.deepEqual(calls,[[f.agent.session.id,{id,version}]]);assert.deepEqual(f.counts(),{publicReads:0,privateReads:1})
})
test('可信参考：公共ID保持原路径，模型自报身份和原任务未授权均不触私有读口',async t=>{
 const f=await setup(t),r=await f.call({id:f.publicReference.id,version:f.publicReference.version});assert.equal(r.isError,false);assert.equal((r.meta as any).teloaResourceUse.kind,'mcp');assert.deepEqual(f.counts(),{publicReads:1,privateReads:0})
 assert.equal((await f.call({id,version,owner:'forged'})).isError,true);f.setAllowed(false);assert.equal((await f.call({id,version})).isError,true);assert.deepEqual(f.counts(),{publicReads:1,privateReads:0})
})
test('可信参考：取消和卸载晚答不能发布私有正文，失败不回退公共reader',async t=>{
 let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r)
 const f=await setup(t,async()=>{enter();await gate;return value}),c=new AbortController(),pending=f.call({id,version},c.signal);await entered;c.abort();release();const r=await pending;assert.equal(r.isError,true);assert.ok(!JSON.stringify(r).includes(text));assert.equal(f.counts().publicReads,0)
 let enter2!:()=>void,release2!:()=>void;const entered2=new Promise<void>(r=>enter2=r),gate2=new Promise<void>(r=>release2=r)
 const g=await setup(t,async()=>{enter2();await gate2;return value}),late=g.call({id,version});await entered2;g.dispose();release2();assert.equal((await late).isError,true);assert.equal(g.counts().publicReads,0)
})

test('真实ToolRuntime拒绝宿主错版引用，不返回正文',async t=>{
 const f=await setup(t,async()=>({...value,citationPath:citationPath.replace('/1/','/2/')}))
 const result=await f.call({id,version});assert.equal(result.isError,true);assert.ok(!JSON.stringify(result).includes(text))
})
