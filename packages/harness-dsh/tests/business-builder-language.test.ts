import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {LlmAdapter,LlmRuntime,createUserMessage,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {SessionId,SessionStore} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {readBusinessConfigurationCandidateVersioned} from '@teloa/contract'
import type {BusinessConfigurationDraft} from '@teloa/backend'
import {registerBusinessBuilderTools} from '../src/business-builder-tools.ts'
import * as workBehavior from '../src/work-behavior.ts'
import {productIdentityText} from '../src/work-prompts/product-identity.ts'

class Capture extends LlmAdapter{
 requests:GenerateOptions[]=[]
 override async resolveModel(provider:string,model:string){return {provider,id:model,name:model,inputModalities:['text'] as const}}
 async *stream(options:GenerateOptions):AsyncGenerator<StreamChunk>{this.requests.push(options);yield {type:'finish',reason:{kind:'stop'}}}
}
test('真实builder Loop在complete persona后保留唯一语言规则和本轮中文进度提醒，不改用户/权限/工具范围',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 for(const plugin of [LlmRuntime,SessionStore,SessionProjectionRegistry,SystemPrompt,ToolRuntime,AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(AgentLoop,{agents:[]});await ctx.plugin(workBehavior,{productOnly:true})
 const adapter=new Capture();ctx.llm.registerAdapter(['minimax-fixture'],adapter)
 const {agent}=await ctx.agents.create({sessionId:SessionId('builder-language-'+randomUUID()),agentOptions:{provider:'minimax-fixture',model:'MiniMax-M3'}})
 agent.ctx.systemPrompt.section({name:'business-builder-system-prompt',order:1,complete:true,interpolate:false,text:'Build the existing business draft using its tools.'})
 const permission='本人权限：仅保存当前业务草案，采用和持续运行须另行确认。'
 agent.ctx.systemPrompt.context({name:'fixture:permission',order:110,text:permission,required:true,interpolate:false})
 const owner='local:builder-language',now='2026-10-28T00:00:00.000Z',scope='business_0123456789abcdef0123456789abcdef'
 const draft:BusinessConfigurationDraft={id:randomUUID(),ownerId:owner,scope,revision:1,baseVersion:0,hash:'a'.repeat(64),status:'draft',createdAt:now,updatedAt:now,candidate:readBusinessConfigurationCandidateVersioned({format:'teloa.business-configuration/v2',scope,title:'现有业务',sources:[{sourceId:'records',kind:'local-records'}],definitions:[],pages:[]})}
 const unused=async()=>{throw Error('本用例不能发出写入')}
 registerBusinessBuilderTools(ctx,{owner,conversation:async sessionId=>({ownerId:owner,sessionId,status:'ready'}),readTaskPolicy:async()=>null,isRoleConversation:async()=>false,isTaskConversation:async()=>false,binding:async sessionId=>({requestId:randomUUID(),kind:'builder',title:'现有业务',draftId:draft.id,sessionId,createdAt:now,updatedAt:now}),draft:async()=>draft,revise:unused,reviseReceipt:unused,upgradeFormat:unused})
 const input='请沿用原业务，读取附件中的成果映射，只保存新增映射；所有可见进度用中文。'
 agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:input}]}));await agent.whenIdle()
 assert.equal(adapter.requests.length,1)
 const request=adapter.requests[0]!,texts=request.messages.flatMap(message=>message.content.flatMap(block=>block.type==='text'?[block.text]:[])),text=texts.join('\n')
 assert.equal(text.split(productIdentityText).length-1,1);assert.equal(text.split('# Reply language\n').length-1,1)
 assert.ok(text.includes(permission));assert.ok(text.includes(input))
 const notice=request.messages.find(message=>message.source?.kind==='plugin:teloa.business-builder')
 assert.ok(notice)
 const noticeText=notice.content.flatMap(block=>block.type==='text'?[block.text]:[]).join('\n')
 assert.match(noticeText,/正文进度、错误恢复说明和最终回复.*# Reply language/)
 assert.match(noticeText,/本人用中文描述时，全部使用中文/);assert.match(noticeText,/原始报错保持原文，不隐藏错误/)
 assert.match(noticeText,/sourceMappingProtocol/);assert.match(noticeText,/不搜索平台源码/)
 assert.ok(noticeText.length<2048)
 assert.deepEqual(request.tools?.map(tool=>tool.name).sort(),['teloa_business_builder_plan_revise','teloa_business_builder_read','teloa_business_builder_revise','teloa_business_builder_upgrade'])
})
