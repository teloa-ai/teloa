import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {LlmAdapter,LlmRuntime,ToolCallId,createUserMessage,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {SessionId,SessionStore} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime,defineTool} from '@deepseek-ai/dsh-tools'
import {encodeEmployeeMention,type DigitalRole} from '@teloa/contract'
import {resolveConversationEmployeeMention} from '../../backend/src/work/conversation-work-employee-mention.ts'
import {registerEmployeeMentionContext,employeeMentionToolAllowed,type EmployeeMentionSelection,type EmployeeMentionMaterial} from '../src/employee-mention-context.ts'
import {readSessionEvents} from '../src/session-events.ts'

class Adapter extends LlmAdapter{
 requests:GenerateOptions[]=[]
 override async resolveModel(provider:string,model:string){return {provider,id:model,name:model,inputModalities:['text'] as const}}
 async *stream(input:GenerateOptions){this.requests.push(input);yield* [{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text:'合成答复'},{type:'block-end',index:0,block:{type:'text',text:'合成答复'}},{type:'finish',reason:{kind:'stop'}}] as StreamChunk[]}
}
async function fixture(t:TestContext){
 const ctx=new Context();t.after(()=>ctx.fiber.dispose());await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const adapter=new Adapter();ctx.llm.registerAdapter(['local-stub'],adapter)
 const {agent}=await ctx.agents.create({sessionId:SessionId('mention-parent'),agentOptions:{provider:'local-stub',model:'local-stub'}})
 let role={id:'11111111-1111-4111-8111-111111111111',ownerId:'owner',name:'告警研判员',version:1,state:'active',kind:'employee',scopes:['security'],duty:'逐项核对告警',dataScope:'本业务已授权资料',executionScope:'先核对再交回确认',skills:[],knowledge:['fixed-evidence']} as unknown as DigitalRole,bodies=0
 for(const name of ['read_evidence','write_action','teloa_work_status'])ctx.tools.register(defineTool({name,description:name,parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{bodies++;return 'local fixture'}}))
 let materialRev=1,withdrawn=false
 const bridge=registerEmployeeMentionContext(ctx,{applies:async()=>true,resolve:(id,text)=>resolveConversationEmployeeMention({owner:'owner',role:async()=>role,context:async sessionId=>({sessionId,scopeId:'security',eligible:true,fingerprint:JSON.stringify([sessionId,'security',1])})},id,text),material:async selection=>{assert.deepEqual(selection.role.knowledge,['fixed-evidence']);const revision=materialRev;return {knowledge:withdrawn?'':'经本业务资料许可核对的固定原件'+selection.role.name,experience:withdrawn?'':'适用且未撤回的岗位经验'+selection.role.name,allowedTools:['read_evidence'],argumentRules:[{name:'read_evidence',allowed:[{}]}],assertCurrent:async()=>{assert.equal(materialRev,revision,'原材料已撤回')}}}})
 const marker=encodeEmployeeMention({roleId:role.id,roleVersion:1}),send=async(text:string)=>{agent.followup(createUserMessage({source:{kind:'user',rpcId:'mention-'+adapter.requests.length},content:[{type:'text',text}]}));await agent.whenIdle()}
 return {ctx,agent,adapter,bridge,marker,send,bodies:()=>bodies,change:()=>{role={...role,version:2}},selectB:()=>{role={...role,id:'22222222-2222-4222-8222-222222222222',name:'另一位员工',duty:'另一岗位职责'};return encodeEmployeeMention({roleId:role.id,roleVersion:role.version})},withdraw:()=>{withdrawn=true;materialRev++}}
}
test('实际SDK本地桩请求使用真实员工来源/指定资料经验，父工具面仅正常交接，后轮不继承历史@',async t=>{
 const f=await fixture(t);await f.send(f.marker+' 请解释这条合成告警')
 assert.equal(f.adapter.requests.length,1);const request=f.adapter.requests[0]!
 assert.match(JSON.stringify(request.messages),/告警研判员/);assert.match(JSON.stringify(request.messages),/固定原件/);assert.match(JSON.stringify(request.messages),/岗位经验/)
 assert.deepEqual(request.tools?.map(tool=>tool.name),['teloa_work_status']);assert.equal(f.bodies(),0)
 await f.send('这条是给主助手的新问题')
 const assembly=await f.ctx.systemPrompt.assemble({agent:f.agent,scope:f.agent});assert.match(assembly.contexts.find(row=>row.name==='teloa/employee-mention')!.text,/no selected employee/)
 assert.equal(await f.bridge.current(f.agent.session.id),null)
 assert.doesNotMatch(JSON.stringify(f.adapter.requests.at(-1)!.messages),/固定原件|岗位经验|逐项核对告警/)
 assert.ok(readSessionEvents(f.agent.session).some(event=>event.type==='user/message'&&JSON.stringify(event.data).includes('固定原件')),'原始审计字节仍在')
})
test('实际SDK跨轮@A→@B不重发A私有runtime材料，审计与已显示答复保留',async t=>{
 const f=await fixture(t);await f.send(f.marker+' 核对这条合成信息')
 const before=readSessionEvents(f.agent.session),privateEvent=before.find(event=>event.type==='user/message'&&JSON.stringify(event.data).includes('固定原件告警研判员'));assert.ok(privateEvent)
 const markerB=f.selectB();await f.send(markerB+' 这是另一轮合成问题')
 const messages=JSON.stringify(f.adapter.requests.at(-1)!.messages)
 assert.doesNotMatch(messages,/固定原件告警研判员|岗位经验告警研判员|逐项核对告警/)
 assert.match(messages,/固定原件另一位员工|岗位经验另一位员工/)
 assert.deepEqual(readSessionEvents(f.agent.session).find(event=>event.seq===privateEvent.seq),privateEvent)
 assert.ok(readSessionEvents(f.agent.session).some(event=>event.type==='assistant/message'))
 assert.ok(readSessionEvents(f.agent.session).some(event=>event.type==='user/message'&&event.surfaceOp!== 'append'&&event.sourceEventSeqs?.includes(privateEvent.seq)))
})
test('新轮资料/经验撤回后不重发旧正文，同轮发送前撤回则拒绝外发',async t=>{
 const f=await fixture(t);await f.send(f.marker+' 第一轮合成问题');f.withdraw();await f.send(f.marker+' 第二轮合成问题')
 assert.equal(f.adapter.requests.length,2)
 assert.doesNotMatch(JSON.stringify(f.adapter.requests.at(-1)!.messages),/固定原件|岗位经验/)
 // 真实 stream middleware 的检查在 adapter 前运行；无外部模型调用。
 f.ctx.on('system-prompt/assemble',async(_value,_context,next)=>{const result=await next();f.withdraw();return result},{prepend:true})
 await f.send(f.marker+' 第三轮不应发出')
 assert.equal(f.adapter.requests.length,2)
})
test('真正tools/execute前再核：pre-execute之后员工改版不能沿用先前许可',async t=>{
 const f=await fixture(t);await f.send(f.marker+' 仅核对合成证据')
 f.agent.session.append('turn/start',{turn:1})
 f.ctx.on('tools/pre-execute',async(_exec,next)=>{const outcome=await next();f.change();return outcome})
 const result=await f.ctx.tools.execute({agent:f.agent,name:'teloa_work_status',arguments:{},callId:ToolCallId('mention-stale-role'),signal:AbortSignal.timeout(5000)})
 assert.equal(result.isError,true);assert.equal(f.bodies(),0)
})
test('同一实际claimed turn的多员工不取最后一位，下一turn不继承上一批引用',async t=>{
 const f=await fixture(t)
 const claim=(text:string,turn:number)=>f.ctx.emit('agent/inbox/claimed',{agent:f.agent,message:createUserMessage({source:{kind:'user'},content:[{type:'text',text}]}),turn})
 claim(f.marker,100);claim(encodeEmployeeMention({roleId:'22222222-2222-4222-8222-222222222222',roleVersion:1}),100)
 await assert.rejects(()=>f.bridge.current(f.agent.session.id),/一位员工/)
 claim('下一轮给主助手的普通问题',101);assert.equal(await f.bridge.current(f.agent.session.id),null);assert.equal(f.adapter.requests.length,0)
})
test('父会话不从@取得跨业务/任意编排权限；正式工作只走Task/Run派发',()=>{
 const selection={role:{id:'employee',version:1,state:'active',skills:['bound-method']},scopeId:'security'} as unknown as EmployeeMentionSelection
 const material={allowedTools:['spawn_teammate','subagent','subagent_task','run_code','read_evidence'],argumentRules:[{name:'read_evidence',allowed:[{id:'fixed'}]}]} as unknown as EmployeeMentionMaterial
 for(const name of ['spawn_teammate','subagent','subagent_task','run_code','read','write','edit','teloa_skill_http','mcp__connector__query','native_browser','native_computer','web_search','http_request'])assert.equal(employeeMentionToolAllowed(selection,material,name,{}),false)
 assert.equal(employeeMentionToolAllowed(selection,material,'read_evidence',{id:'fixed'}),false)
 assert.equal(employeeMentionToolAllowed(selection,material,'read_evidence',{id:'outside'}),false)
 assert.equal(employeeMentionToolAllowed(selection,material,'teloa_business_data_query',{scope:'sales'}),false)
 assert.equal(employeeMentionToolAllowed(selection,material,'teloa_business_data_query',{}),false)
 assert.equal(employeeMentionToolAllowed(selection,material,'teloa_work_directory',{}),false)
 const withScopedRead={...material,allowedTools:[...material.allowedTools,'teloa_business_data_query'],argumentRules:[...material.argumentRules,{name:'teloa_business_data_query',allowed:[{scope:'security',limit:1}]}]}
 assert.equal(employeeMentionToolAllowed(selection,withScopedRead,'teloa_business_data_query',{scope:'security',limit:1}),false)
 assert.equal(employeeMentionToolAllowed(selection,withScopedRead,'teloa_business_data_query',{limit:1}),false,'父会话不冒用角色grant直接执行业务查询')
 assert.equal(employeeMentionToolAllowed(selection,material,'teloa_work_facts',{allBusinesses:true}),false)
 assert.equal(employeeMentionToolAllowed(selection,material,'teloa_work_dispatch',{roleId:'other'}),false)
 assert.equal(employeeMentionToolAllowed(selection,material,'skill',{name:'bound-method'}),true)
 assert.equal(employeeMentionToolAllowed(selection,material,'skill',{name:'other-method'}),false)
 assert.equal(employeeMentionToolAllowed(selection,material,'teloa_tools_load',{}),true)
 assert.equal(employeeMentionToolAllowed(selection,material,'teloa_work_status',{}),true)
 selection.role.state='paused';assert.equal(employeeMentionToolAllowed(selection,material,'read_evidence',{id:'fixed'}),false);assert.equal(employeeMentionToolAllowed(selection,material,'teloa_work_dispatch',{roleId:'employee'}),false)
})
