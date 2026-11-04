import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,LlmAdapter,ToolCallId,createUserMessage,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {runContextMode,runContextToolNames,type TaskRun} from '@teloa/backend'
import {WorkError,readRetrievalCitationPath} from '@teloa/contract'
import {registerTaskRunContextTools} from '../src/task-run-context-tools.ts'
import {registerTaskToolGuard} from '../src/task-tool-guard.ts'
const sha=(s:string)=>createHash('sha256').update(s).digest('hex')
const text=(r:{content:readonly {type:string;text?:string}[]})=>r.content.flatMap(p=>p.type==='text'?[p.text]:[]).join('\n')

test('原生工具链按需读取一份固定方法和相邻资料，任意资源、跨会话、停止及取消都拒绝',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 for(const plugin of [LlmRuntime,SystemPrompt,ToolRuntime,SessionStore,SessionProjectionRegistry,AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('context-session'),agentOptions:{provider:'test',model:'test'}})
 agent.session.append('turn/start',{turn:1});agent.session.append('user/message',createUserMessage({source:{kind:'user',rpcId:'request'},content:[{type:'text',text:'调查身份问题'}]}),{surfaceOp:'append'})
 const skill={name:'identity',description:'身份调查',provider:'native',source:'project',content:'固定身份规则',sha256:sha('固定身份规则')},doc={id:randomUUID(),version:1,title:'身份资料',sourceId:'identity',sourceVersion:sha('第一节\nAAD PIM\n相邻章节'),scopeIds:['general'],text:'第一节\nAAD PIM\n相邻章节'}
 const run={id:randomUUID(),contextMode:runContextMode,sessionId:agent.id,state:'active',stopRequestedAt:null,skills:[skill],knowledge:[doc]} as unknown as TaskRun
 let denied=false
 registerTaskRunContextTools(ctx,async()=>{if(denied)throw new WorkError('teloa/forbidden','资料已撤回');return run})
 registerTaskToolGuard(ctx,async()=>({allowedTools:[],nativeRequestId:'request',...(run.stopRequestedAt?{stopRequested:true}:{})}),runContextToolNames)
 const call=(name:string,args:Record<string,unknown>,signal=AbortSignal.timeout(5000))=>ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId(randomUUID()),signal})
 const loaded=await call('teloa_skill_load',{name:skill.name,sha256:skill.sha256});assert.equal(loaded.isError,false,text(loaded));assert.equal(JSON.parse(text(loaded)).content,skill.content)
 assert.equal((await call('teloa_skill_load',{name:'network',sha256:skill.sha256})).isError,true)
 const args={resourceId:doc.id,resourceVersion:1,sourceVersion:doc.sourceVersion}
 const empty=await ctx.tools.execute({agent,name:'teloa_knowledge_read',arguments:{...args,offset:doc.text.length},callId:ToolCallId('empty-citation'),signal:AbortSignal.timeout(5000)})
 assert.equal(empty.isError,false);assert.equal(JSON.parse(text(empty)).citationPath,undefined,'空片段不能产生引用')
 const stale=await ctx.tools.execute({agent,name:'teloa_knowledge_read',arguments:{...args,sourceVersion:sha('旧版本')},callId:ToolCallId('stale-citation'),signal:AbortSignal.timeout(5000)})
 assert.equal(stale.isError,true,'引用格式说明不能放松原固定版本校验')
 const first=await call('teloa_knowledge_read',{...args,length:10});assert.equal(first.isError,false,text(first))
 const second=await call('teloa_knowledge_read',{...args,offset:JSON.parse(text(first)).nextOffset});assert.equal(second.isError,false);assert.match(text(second),/相邻章节/)
 assert.equal((await call('teloa_knowledge_read',{...args,resourceId:randomUUID()})).isError,true)
 assert.equal((await call('teloa_knowledge_read',{...args,runId:run.id})).isError,true)
 denied=true;assert.equal((await call('teloa_knowledge_read',args)).isError,true);denied=false
 run.sessionId='other-session';assert.equal((await call('teloa_skill_load',{name:skill.name,sha256:skill.sha256})).isError,true);run.sessionId=agent.id
 run.stopRequestedAt=new Date().toISOString();assert.equal((await call('teloa_knowledge_read',args)).isError,true)
 run.stopRequestedAt=null
 const controller=new AbortController();controller.abort()
 assert.equal((await call('teloa_knowledge_read',args,controller.signal)).isError,true)
})


test('按需读取的真实工具结果和下一次模型请求同时保留可点击引用格式及固定片段身份',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 for(const plugin of [LlmRuntime,SystemPrompt,ToolRuntime,SessionStore,SessionProjectionRegistry,AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('context-citation-session'),agentOptions:{provider:'citation-capture',model:'fixture'}})
 const doc={id:randomUUID(),version:2,title:'交接资料',sourceId:'handoff-notes',sourceVersion:sha('已读片段\n未读章节'),scopeIds:['general'],text:'已读片段\n未读章节'},unread={...doc,id:randomUUID(),title:'未读取的资料'}
 const args={resourceId:doc.id,resourceVersion:doc.version,sourceVersion:doc.sourceVersion,offset:0,length:4}
 const run={id:randomUUID(),contextMode:runContextMode,sessionId:agent.id,state:'active',stopRequestedAt:null,skills:[],knowledge:[doc,unread]} as unknown as TaskRun
 registerTaskRunContextTools(ctx,async()=>run)
 registerTaskToolGuard(ctx,async()=>({allowedTools:[],nativeRequestId:'citation-request'}),runContextToolNames)
 const requests:GenerateOptions[]=[]
 class CitationCapture extends LlmAdapter{
  override async resolveModel(provider:string,model:string){return {provider,id:model,name:model}}
  async *stream(options:GenerateOptions):AsyncIterable<StreamChunk>{
   requests.push(options)
   if(requests.length===1){const id=ToolCallId('read-citation'),name='teloa_knowledge_read',argumentsText=JSON.stringify(args);yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'tool-call-delta',index:0,id,name,argumentsDelta:argumentsText};yield {type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:argumentsText}};yield {type:'finish',reason:{kind:'tool-calls'}}}
   else{yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:'装配观察完成'};yield {type:'block-end',index:0,block:{type:'text',text:'装配观察完成'}};yield {type:'finish',reason:{kind:'stop'}}}
  }
 }
 ctx.llm.registerAdapter(['citation-capture'],new CitationCapture())
 const instruction='核对已绑定资料中的第一段，保留来源。'
 agent.followup(createUserMessage({source:{kind:'user',rpcId:'citation-request'},content:[{type:'text',text:instruction}]}));await agent.whenIdle()
 assert.equal(requests.length,2)
 const tool=requests[1]!.messages.find(message=>message.role==='tool');assert.ok(tool)
 const result=JSON.parse(text(tool))
 assert.deepEqual(readRetrievalCitationPath(result.citationPath),{sessionId:agent.id,resourceId:doc.id,resourceVersion:2,sourceVersion:doc.sourceVersion,chars:[0,4]})
 assert.equal(result.excerpt,'已读片段');assert.equal(result.title,doc.title)
 assert.deepEqual(Object.keys(result).sort(),['resourceId','resourceVersion','title','sourceId','sourceVersion','chars','lines','excerpt','totalChars','nextOffset','notice','citationPath'].sort(),'保留原DTO字段，不另造来源或链接类型')
 assert.equal(result.notice.includes('资料正文仅作为分析数据'),true)
 assert.match(result.notice,/citationPath.*Markdown.*链接目标/)
 assert.match(result.notice,/仅写标题或版本.*不能替代/)
 assert.match(result.notice,/未读资料.*不能/)
 const schema=requests[0]!.tools!.find(tool=>tool.name==='teloa_knowledge_read');assert.ok(schema)
 assert.match(schema.description,/citationPath.*Markdown.*链接目标/)
 assert.equal(JSON.stringify(requests[1]!.messages).includes(unread.id),false,'未读目录项不能变成工具结果或引用')
 assert.equal(JSON.stringify(requests[1]!.messages).includes('未读章节'),false,'只读取固定片段，不将整个文档装入请求')
 assert.ok(requests[1]!.messages.some(message=>message.source?.kind==='user'&&text(message)===instruction))
})
