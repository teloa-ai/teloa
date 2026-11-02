import test from 'node:test'
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
import {runContextMode,runContextToolNames,type TaskRun} from '@teloa/backend'
import {WorkError} from '@teloa/contract'
import {registerTaskRunContextTools} from '../src/task-run-context-tools.ts'
import {registerTaskToolGuard} from '../src/task-tool-guard.ts'
const sha=(s:string)=>createHash('sha256').update(s).digest('hex')
const text=(r:{content:Array<{type:string;text?:string}>})=>r.content.flatMap(p=>p.type==='text'?[p.text]:[]).join('\n')

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
