import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId,createUserMessage} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import type {DigitalRole,EmployeeKnowledgeContent,EmployeeKnowledgeRevision} from '@teloa/contract'
import type {EmployeeKnowledgeServicePort} from '../src/employee-knowledge.ts'
import {registerEmployeeKnowledgeTools} from '../src/employee-knowledge-tools.ts'

const owner='local:knowledge-receipts',roleId='a0000000-0000-4000-8000-000000000001',resourceId='a0000000-0000-4000-8000-000000000002',knowledgeId='a0000000-0000-4000-8000-000000000003',headId='a0000000-0000-4000-8000-000000000004',requestId='a0000000-0000-4000-8000-000000000005'
const stamp='2026-10-29T00:00:00.000Z',largeMarkdown='知'.repeat(100*1024)
const role:DigitalRole={id:roleId,ownerId:owner,version:1,state:'active',kind:'employee',name:'值班员',scopes:['general'],duty:'核对资料',dataScope:'已授权资料',executionScope:'分析',skills:[],knowledge:[resourceId],createdAt:stamp,updatedAt:stamp}

async function fixture(t:TestContext,markdown:string){
 const ctx=new Context(),contentHash=createHash('sha256').update(markdown).digest('hex')
 t.after(()=>ctx.fiber.dispose())
 for(const plugin of [LlmRuntime,SystemPrompt,ToolRuntime,SessionStore,SessionProjectionRegistry,AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('knowledge-receipts-'+randomUUID()),agentOptions:{provider:'test',model:'test'}})
 agent.session.append('turn/start',{turn:1})
 agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'按我的要求编辑、恢复并核对员工知识资料。'}]}),{surfaceOp:'append'})
 const document:EmployeeKnowledgeContent={
  roleId,resourceId,documentId:'industry_source',knowledgeId,title:'值班手册',bodyVersion:2,contentHash,bytes:Buffer.byteLength(markdown),markdown,
  resource:{id:headId,ownerId:owner,version:1,status:'active',title:'值班手册',sourceId:'knowledge_'+knowledgeId,sourceVersion:contentHash,scopeIds:['general'],createdAt:stamp,updatedAt:stamp},
  origin:{resourceId,sourceId:'industry_source',sourceVersion:'b'.repeat(64)},editing:'employee-copy',indexState:'pending',
 }
 let changes=0
 const receipts=new Map<string,EmployeeKnowledgeRevision>([[requestId,{requestId,operation:'restore',forked:false,document}]])
 const saved=(operation:'revise'|'restore',input:unknown)=>{
  const receipt:EmployeeKnowledgeRevision={requestId:(input as {requestId:string}).requestId,operation,forked:operation==='revise',document}
  receipts.set(receipt.requestId,receipt)
  return receipt
 }
 // 仅替换数据库服务；注册、身份核验、参数与回执验证、输出渲染均运行真实组件。
 const service:EmployeeKnowledgeServicePort={
  list:async()=>[document],read:async()=>document,versions:async()=>[],
  revise:async(_actor,input)=>saved('revise',input),restore:async(_actor,input)=>saved('restore',input),
  status:async(_actor,input)=>receipts.get((input as {requestId:string}).requestId)??null,
 }
 registerEmployeeKnowledgeTools(ctx,{owner,conversation:async sessionId=>({ownerId:owner,sessionId,status:'ready'}),readTaskPolicy:async()=>null,requestedRoleId:async()=>roleId,role:async()=>role,humanActor:async()=>({ownerId:owner,kind:'human',scopeIds:['general']}),service:async()=>service,changed:()=>{changes++}})
 const call=(suffix:string,args:Record<string,unknown>)=>ctx.tools.execute({agent,name:'teloa_employee_knowledge_'+suffix,arguments:args,callId:ToolCallId(randomUUID()),signal:AbortSignal.timeout(5000)})
 const args=(suffix:string)=>suffix==='status'?{requestId}:{roleId,resourceId,expectedBodyVersion:1,expectedContentHash:'b'.repeat(64),...(suffix==='edit'?{markdown}:{restoreVersion:1})}
 return {agent,document,receipts,call,args,changes:()=>changes}
}

type ToolResult=Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['call']>>
const output=(result:ToolResult)=>result.content.filter(item=>item.type==='text').map(item=>item.text).join('\n')
function envelope(result:ToolResult){
 assert.equal(result.isError,false,output(result).slice(0,1000))
 return JSON.parse(output(result))
}

for(const [suffix,operation,forked,changes] of [['status','restore',false,0],['edit','revise',true,1],['restore','restore',false,1]] as const){
 test(`真实工具 ${suffix} 的 300 KiB 正文仅省略模型输出，保留成功回执和变更通知`,async t=>{
  const f=await fixture(t,largeMarkdown),response=await f.call(suffix,f.args(suffix)),value=envelope(response)
  assert.equal(Object.hasOwn(value.result.document,'markdown'),false)
  assert.equal(value.markdownOmitted,true)
  assert.match(value.notice,/已授权.*检索/)
  assert.equal(value.schema,'teloa.employee-knowledge-result/v1')
  assert.equal(value.operation,suffix==='edit'?'revise':suffix)
  assert.equal(value.sourceSession,f.agent.session.id)
  assert.equal(value.result.operation,operation)
  assert.equal(value.result.forked,forked)
  assert.equal(value.result.document.bytes,307200)
  const {markdown:_markdown,...summary}=f.document
  assert.deepEqual(value.result.document,summary)
  assert.ok(Buffer.byteLength(output(response))<4096)
  assert.equal(f.changes(),changes)
  const saved=f.receipts.get(value.result.requestId)
  assert.ok(saved)
  assert.equal(saved.document.markdown,largeMarkdown,'工具投影不得修改服务保存的完整回执')
  if(suffix==='status')assert.equal(value.result.requestId,requestId)
  else{
   assert.equal(value.requestId,value.result.requestId)
   const checked=envelope(await f.call('status',{requestId:value.requestId}))
   assert.deepEqual(checked.result,value.result)
   assert.equal(checked.markdownOmitted,true)
   assert.equal(f.changes(),1,'查询写入回执不能再次通知变更')
  }
 })
}

for(const markdown of ['# 小文档\n\n现有正文。','x'.repeat(256*1024)]){
 test(`真实工具在 ${Buffer.byteLength(markdown)} 字节时保持完整回执与读取行为`,async t=>{
  const f=await fixture(t,markdown)
  for(const suffix of ['status','edit','restore']){
   const value=envelope(await f.call(suffix,f.args(suffix))),saved=f.receipts.get(value.result.requestId)
   assert.deepEqual(value,{schema:'teloa.employee-knowledge-result/v1',operation:suffix==='edit'?'revise':suffix,sourceSession:f.agent.session.id,...(suffix==='status'?{}:{requestId:saved!.requestId}),result:saved})
  }
  assert.deepEqual(envelope(await f.call('read',{roleId,resourceId})),{schema:'teloa.employee-knowledge-result/v1',operation:'read',sourceSession:f.agent.session.id,result:f.document})
  assert.equal(f.changes(),2)
 })
}

test('真实工具 read 仍拒绝 300 KiB 正文且不通知变更',async t=>{
 const f=await fixture(t,largeMarkdown),response=await f.call('read',{roleId,resourceId})
 assert.equal(response.isError,true)
 assert.match(output(response),/256 KiB/)
 assert.equal(output(response).includes(largeMarkdown),false)
 assert.equal(f.changes(),0)
})
