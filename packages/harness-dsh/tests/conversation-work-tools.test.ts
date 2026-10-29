import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime,defineTool} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId,createUserMessage} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {WorkError,encodeBusinessRecordReference} from '@teloa/contract'
import {ArtifactRevisionRequestService} from '@teloa/backend'
import {registerConversationWorkTools,conversationWorkToolNames,type ConversationWorkToolsPorts} from '../src/conversation-work-tools.ts'
import {loopWorkFixture,loopText,loopTool} from './fixtures/native-loop-work-admission.ts'
import {registerCredentialGuards} from '../src/credential-guards.ts'
const owner='owner',roleId='22222222-2222-4222-8222-222222222222'
const coordinationSummary='当前工作的业务与接手约定'
test('单次交办仅新增可选workTokenLimit，八项既有工具参数协议保持',async t=>{
 const f=await setup();t.after(()=>f.ctx.fiber.dispose())
 const schemas=f.ctx.tools.schemas(f.agent).filter(tool=>(conversationWorkToolNames as readonly string[]).includes(tool.name)).sort((a,b)=>a.name.localeCompare(b.name))
 const withoutDescriptions=(value:unknown):unknown=>Array.isArray(value)?value.map(withoutDescriptions):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>key!=='description'&&key!=='workTokenLimit').sort(([a],[b])=>a.localeCompare(b)).map(([key,child])=>[key,withoutDescriptions(child)])):value
 assert.equal(schemas.length,8)
 assert.match(JSON.stringify(schemas.find(tool=>tool.name==='teloa_work_dispatch')!.parameters),/workTokenLimit/)
 for(const tool of schemas.filter(tool=>tool.name!=='teloa_work_dispatch'))assert.doesNotMatch(JSON.stringify(tool.parameters),/workTokenLimit/)
 assert.equal(createHash('sha256').update(JSON.stringify(withoutDescriptions(schemas))).digest('hex'),'b0d14cbda922ab690b40ee2467f1f436abbafd7ce8b0026c0cf4f76035efed33','除已审阅的可选token上限外，工具名字和原生参数协议逐项保持')
 const check=(value:unknown):void=>{if(Array.isArray(value)){value.forEach(check);return}if(value&&typeof value==='object')for(const [key,child]of Object.entries(value)){if(key==='description'&&typeof child==='string')assert.doesNotMatch(child,/\p{Script=Han}/u);else check(child)}}
 schemas.forEach(check)
})
test('真实Loop多轮只保留当前主会话规则与选择，原本人消息和工具回执不退役', {timeout:10000},async t=>{
 let scopeId='SOC',roleConversation=false
 const base=await setup();t.after(()=>base.ctx.fiber.dispose())
 const f=await loopWorkFixture(t,true)
 registerConversationWorkTools(f.ctx,{...base.ports,freeze:async()=>({sessionId:f.agent.session.id,scopeId,roleId:null,version:1,locked:false}),isRoleConversation:async()=>roleConversation})
 const original=createUserMessage({source:{kind:'user',rpcId:'legacy-user'},content:[{type:'text',text:'原本人指令 {{model}} 保持原文'}]})
 const legacy=createUserMessage({source:{kind:'plugin:teloa.work',form:'notice',summary:coordinationSummary},content:[{type:'text',text:'你是本人主会话助手。原静态规则。当前可信选择：{"context":{"scopeId":"OLD"}}'}]})
 const receipt=createUserMessage({source:{kind:'plugin:teloa.work',form:'notice',summary:'本次结果的名称与状态说明',requestId:'original-request'},content:[{type:'text',text:'原工具回执保留'}]})
 for(const message of [original,legacy,receipt])f.agent.session.append('user/message',message,{surfaceOp:'append'})
 const send=async(text:string,rpcId:string)=>{f.adapter.scripts.push(loopText);f.agent.followup(createUserMessage({source:{kind:'user',rpcId},content:[{type:'text',text}]}));await f.agent.whenIdle()}
 const requestText=(index:number)=>f.adapter.requests[index]!.messages.flatMap(message=>message.content.filter(block=>block.type==='text').map(block=>block.text)).join('\n')
 const activeNotices=()=>f.agent.session.surface.nodes.map(seq=>f.agent.session.eventAt(seq)).filter(event=>event?.type==='user/message'&&event.data.source.kind==='plugin:teloa.work'&&event.data.source.form==='notice'&&event.data.source.summary===coordinationSummary)
 await send('我没睡醒','ordinary-one')
 assert.equal(f.adapter.requests.length,1)
 assert.equal(activeNotices().length,1,'旧宿主投影应退出模型surface，仅保留本轮一份')
 assert.doesNotMatch(requestText(0),/原静态规则|"scopeId":"OLD"/)
 scopeId='CRM';await send('你是谁','ordinary-two')
 assert.equal(activeNotices().length,1,'静态规则不随用户轮次累积')
 const latest=requestText(1)
 assert.ok(latest.includes('"scopeId":"CRM"'));assert.doesNotMatch(latest,/"scopeId":"SOC"/)
 for(const text of ['原本人指令 {{model}} 保持原文','原工具回执保留'])assert.ok(latest.includes(text),text)
 const events=f.agent.session.snapshotEvents()
 for(const message of [original,legacy,receipt])assert.ok(events.some(event=>event.type==='user/message'&&event.data.id===message.id),'原事件保留审计')
 roleConversation=true;await send('继续原岗位工作','role-turn')
 assert.equal(activeNotices().length,0,'失去主会话资格后不留旧可信选择')
 assert.doesNotMatch(requestText(2),/"scopeId":"CRM"/)
 assert.equal(base.dispatched.length,0);assert.equal(base.approvals.length,0)
})
async function setup(overrides:Partial<ConversationWorkToolsPorts>={},origin?:'subagent'){
 const ctx=new Context();await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('work-origin'),...(origin?{meta:{origin,delegationDepth:1}}:{}),agentOptions:{provider:'test',model:'test'}})
 agent.session.append('turn/start',{turn:0} as never)
 agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'请交给调查员'}]}),{surfaceOp:'append'})
 const approvals:string[]=[];let approve=async()=> 'allowed-once';ctx.provide('approval',{request:async(input:{reason:string})=>{approvals.push(input.reason);return approve()}})
 const dispatched:unknown[]=[],ports:ConversationWorkToolsPorts={owner,conversation:async id=>({ownerId:owner,sessionId:id,status:'ready'}),readTaskPolicy:async()=>null,isRoleConversation:async()=>false,context:async()=>null,freeze:async()=>null,roles:async()=>[{id:roleId,ownerId:owner,version:1,name:'调查员',kind:'employee',state:'active',scopes:['SOC'],duty:'调查',skills:[],knowledge:[],dataScope:'业务',executionScope:'业务',createdAt:'2026-09-29T00:00:00Z',updatedAt:'2026-09-29T00:00:00Z'}],scopes:async()=>['general','SOC'],dispatch:async(input)=>{dispatched.push(input);return {accepted:true}},status:async()=>({}),stop:async()=>({}),facts:async()=>({}),data:async()=>{throw new WorkError('teloa/source-unavailable','安全告警来源未配置；没有返回示例数据。')},now:()=>new Date().toISOString(),...overrides}
 registerConversationWorkTools(ctx,ports)
 const call=(name:string,args:Record<string,unknown>={},id='call')=>ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId(id),signal:AbortSignal.timeout(5000)})
 return {ctx,agent,dispatched,call,ports,approvals,approve:(fn:typeof approve)=>approve=fn}
}
test('正式工作回包后提供当前可读执行与验收状态，原始回包保持不变',async t=>{
 const receipt={requestId:'internal-request',sessionId:'work-origin',kind:'task',title:'核对续约资料',scope:'CRM',observedAt:'2026-10-12T00:00:00Z',stoppedAt:null,counts:{received:1,waiting:0,unavailable:0,failed:0,stopped:0},members:[{roleId,name:'调查员',scope:'CRM',status:'received',task:{id:'internal-task',title:'核对续约资料',version:3,state:'waiting'},result:'收到完整材料'}]}
 const f=await setup({status:async()=>receipt});t.after(()=>f.ctx.fiber.dispose())
 const result=await f.call('teloa_work_status')
 assert.equal(result.isError,false);assert.equal(result.value,JSON.stringify(receipt))
 const notice=result.additionalContexts?.at(-1)
 assert.equal(notice?.source.kind,'plugin:teloa.work')
 const text=notice!.content.filter(block=>block.type==='text').map(block=>block.text).join('\n')
 for(const expected of ['核对续约资料','调查员','已收到回复','待验收'])assert.ok(text.includes(expected),expected)
 assert.match(text,/Source-record, artifact, task and configuration versions are independent/)
 assert.match(text,/下一步：从本会话交办卡的工作名称打开原任务核对结果/)
 assert.match(text,/different record types remain distinct even with the same ID/)
 assert.match(text,/not an invented button, page or workflow/)
 for(const hidden of ['internal-request','internal-task',roleId,'收到完整材料'])assert.ok(!text.includes(hidden),hidden)
 const decision=await f.ctx.waterfall('agent/pre-step',{agent:f.agent,messages:[],turn:1,step:2,signal:new AbortController().signal},async()=>({kind:'enter' as const,messages:[]}))
 assert.deepEqual(decision,{kind:'enter',messages:[]},'空步骤不注入提示，允许原生Loop结束')
})
test('结果状态说明同原工具正文一起经过最终凭据脱敏',async t=>{
 const secret='sk-known-presentation-test-abcdefghijklmnopqrstuvwxyz'
 const f=await setup({status:async()=>({title:'核对 '+secret,members:[{name:'调查员',status:'received'}]})});t.after(()=>f.ctx.fiber.dispose())
 registerCredentialGuards(f.ctx,{roots:()=>[],known:()=>[secret]})
 const result=await f.call('teloa_work_status')
 assert.equal(result.isError,false)
 assert.doesNotMatch(JSON.stringify(result.content),new RegExp(secret))
 assert.ok(result.additionalContexts?.length)
 assert.doesNotMatch(JSON.stringify(result.additionalContexts),new RegExp(secret))
})
test('提交未知和已请求停止的waiting不冒充正在执行或已停止',async t=>{
 for(const run of [{state:'prepared',stopRequestedAt:null},{state:'submitting',stopRequestedAt:null},{state:'running',stopRequestedAt:'2026-10-12T00:00:00Z'}]){
  const f=await setup({status:async()=>({title:'核对材料',members:[{name:'调查员',status:'waiting',run}]})});t.after(()=>f.ctx.fiber.dispose())
  const result=await f.call('teloa_work_status')
  const text=result.additionalContexts?.at(-1)?.content.filter(b=>b.type==='text').map(b=>b.text).join('\n')??''
  assert.match(text,/调查员：尚未收到最终回复/)
  assert.doesNotMatch(text,/调查员：正在执行|调查员：已停止/)
 }
})
test('通用资源成功后提示不授予权限，失败/阻断/结束轮次及身份变化不注入',async t=>{
 const f=await setup();t.after(()=>f.ctx.fiber.dispose())
 f.ctx.tools.register(defineTool({name:'teloa_test_resource',description:'资源回包',parameters:{},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},execute:async()=>'{"name":"知识甲","state":"draft","id":"raw-id"}'}))
 const result=await f.call('teloa_test_resource')
 assert.equal(result.isError,false);assert.equal(result.additionalContexts?.length,1)
 assert.match(JSON.stringify(result.additionalContexts),/Saving is not enabling/)
 const existing=createUserMessage({source:{kind:'tool',callId:ToolCallId('existing')},content:[{type:'text',text:'既有上下文'}]})
 const inherit=f.ctx.on('tools/post-execute',async()=>({kind:'accept' as const,additionalContexts:[existing]}))
 const inherited=await f.call('teloa_test_resource');assert.deepEqual(inherited.additionalContexts?.[0],existing);assert.equal(inherited.additionalContexts?.length,2);inherit()
 const blocked=f.ctx.on('tools/post-execute',async()=>({kind:'block' as const,feedback:[{type:'text' as const,text:'不接受'}]}))
 const rejected=await f.call('teloa_test_resource');assert.equal(rejected.isError,true);assert.equal(rejected.additionalContexts?.length??0,0);blocked()
 assert.equal((await f.call('teloa_business_data_query',{scope:'SOC',limit:1})).additionalContexts?.length??0,0)
 for(const change of ['role','task','binding','unavailable']){
  const x=await setup(change==='role'?{isRoleConversation:async()=>true}:change==='task'?{isTaskConversation:async()=>true}:change==='binding'?{conversation:async id=>({sessionId:id,ownerId:'other',status:'ready'})}:{conversation:async()=>{throw Error('offline')}});t.after(()=>x.ctx.fiber.dispose())
  x.ctx.tools.register(defineTool({name:'teloa_test_resource',description:'无副作用资源回读',parameters:{},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},execute:async()=> 'saved'}))
  const r=await x.call('teloa_test_resource');assert.equal(r.isError,false);assert.equal(r.value,'saved');assert.equal(r.additionalContexts?.length??0,0,change)
 }
 f.ctx.tools.register(defineTool({name:'teloa_test_end',description:'结束',parameters:{},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},execute:async(_a,exec)=>{exec.concludeTurn();return 'end'}}))
 assert.equal((await f.call('teloa_test_end')).additionalContexts?.length??0,0)
})
test('官方Loop工具后的下一次模型请求收到提示且正常结束，不生成额外用户轮次', {timeout:10000},async t=>{
 const base=await setup();t.after(()=>base.ctx.fiber.dispose())
 const f=await loopWorkFixture(t,true);registerConversationWorkTools(f.ctx,base.ports)
 const chunks=loopTool.map(chunk=>chunk.type==='tool-call-delta'?{...chunk,name:'teloa_work_status'}:chunk.type==='block-end'&&chunk.block.type==='tool-call'?{...chunk,block:{...chunk.block,name:'teloa_work_status'}}:chunk)
 f.adapter.scripts.push(chunks,loopText);await f.send()
 assert.equal(f.adapter.requests.length,2)
 assert.match(JSON.stringify(f.adapter.requests[1]),/Saving is not enabling/)
 assert.equal(f.events.filter(event=>event.type==='turn/start').length,1)
 assert.equal(f.events.filter(event=>event.type==='turn/end').length,1)
 assert.equal(f.agent.inbox.nextStep.length,0)
})
test('只读目录的真实Loop回包与主会话约定不冒充交办或稍后出现的批准卡', {timeout:10000},async t=>{
 const base=await setup({roles:async()=>[],scopes:async()=>['general']});t.after(()=>base.ctx.fiber.dispose())
 const f=await loopWorkFixture(t,true);registerConversationWorkTools(f.ctx,base.ports)
 const chunks=loopTool.map(chunk=>chunk.type==='tool-call-delta'?{...chunk,name:'teloa_work_directory'}:chunk.type==='block-end'&&chunk.block.type==='tool-call'?{...chunk,block:{...chunk.block,name:'teloa_work_directory'}}:chunk)
 f.adapter.scripts.push(chunks,loopText);await f.send()
 assert.equal(f.adapter.requests.length,2)
 const result=f.events.find(event=>event.type==='tool/result');assert.ok(result)
 const receipt=JSON.parse(result.data.message.content.filter(block=>block.type==='text').map(block=>block.text).join('\n'))
 assert.deepEqual({context:receipt.context,scopes:receipt.scopes,businesses:receipt.businesses,roles:receipt.roles},{context:null,scopes:['general'],businesses:[],roles:[]})
 assert.equal(receipt.approvalState,undefined,'目录读取不能伪造批准状态')
 assert.match(receipt.receiptNotice,/Read-only directory: no delegation, native approval card or execution/)
 assert.match(receipt.receiptNotice,/Explicit delegation next calls teloa_work_dispatch/)
 assert.match(receipt.receiptNotice,/never promise a later card/)
 assert.match(receipt.receiptNotice,/claim submission without its receipt/)
 assert.match(receipt.receiptNotice,/Answer ordinary questions directly/)
 assert.ok(JSON.stringify(f.adapter.requests[1]).includes(receipt.receiptNotice),'实际下一次请求收到目录即时说明')
 const initial=f.events.find(event=>event.type==='user/message'&&event.data.source.kind==='plugin:teloa.work'&&event.data.source.form==='notice'&&event.data.source.summary===coordinationSummary)
 assert.ok(initial&&initial.type==='user/message')
 const initialText=initial.data.content.filter(block=>block.type==='text').map(block=>block.text).join('\n')
 assert.match(initialText,/Directory reads neither dispatch work nor schedule a later card/)
 assert.match(initialText,/No Task\/Run exists before approval; rejection executes nothing/)
 for(const protocol of [
  /including a request for an employee-assigned draft.*teloa_work_dispatch/,
  /Do not first create an unassigned task/,
  /Dispatch cannot reuse an existing task draft and has no save-only mode/,
  /approval creates and starts the work/,
  /business recordRef belongs in dispatch\.reference/,
  /A business record is not a WorkResource/,
  /local recordRef can come from teloa_business_records_read or the current owner message; no separate HTTP query is required/,
  /host independently verifies owner, business scope, object version and snapshot hash/,
  /business_data_query reads only configured security-alert HTTP source snapshots/,
  /does not query local-records/,
  /source argument filters returned snapshot\.source, not a connection ID or local sourceId/,
  /Do not repeat data_query against unsupported scopes/,
  /Candidate\/catalog tools.*are not the employee's current grants/,
  /Read teloa_role_tools_get/,
  /all visible progress and final replies in the current user's language/,
 ]){
  assert.match(initialText,protocol)
  assert.match(JSON.stringify(f.adapter.requests[1]),protocol,'实际工具后模型请求仍保留当前交办协议')
 }
 assert.match(f.ctx.tools.schemas(f.agent).find(schema=>schema.name==='teloa_work_directory')?.description??'',/Read the main conversation/)
 const query=f.ctx.tools.schemas(f.agent).find(schema=>schema.name==='teloa_business_data_query')!
 assert.match(query.description??'',/does not query local-records/)
 assert.match(JSON.stringify(query.parameters),/Filter the returned snapshot\.source field; not a connection ID/)
 assert.doesNotMatch(f.ctx.tools.schemas(f.agent).find(schema=>schema.name==='teloa_work_dispatch')?.description??'',/Investigations also require the fixed reference returned by a real data query/)
 assert.equal(base.approvals.length,0);assert.equal(base.dispatched.length,0)
 assert.equal(f.events.filter(event=>event.type==='turn/start').length,1);assert.equal(f.events.filter(event=>event.type==='turn/end').length,1)
 assert.equal(f.agent.inbox.nextStep.length,0,'普通回答不被强制续发交办')
})
test('真实交办回包明确本次批准已完成，原始回执和等待含义同时保留',async t=>{
 const receipt={requestId:'actual-request',sessionId:'work-origin',title:'调查',scope:'SOC',stoppedAt:null,counts:{waiting:1,received:0},members:[{name:'调查员',status:'waiting'}]}
 const f=await setup({dispatch:async()=>receipt});t.after(()=>f.ctx.fiber.dispose())
 const result=await f.call('teloa_work_dispatch',{scope:'SOC',title:'调查',goal:'调查异常',roleId,expectedRoleVersion:1})
 assert.equal(result.isError,false)
 const actual=JSON.parse(result.content.filter(block=>block.type==='text').map(block=>block.text).join('\n'))
 assert.equal(actual.approvalState,'approved')
 assert.match(actual.receiptNotice,/approval completed through the native card/);assert.match(actual.receiptNotice,/waiting means no final reply, not approval pending/)
 const {approvalState:_approval,receiptNotice:_notice,...original}=actual
 assert.deepEqual(original,receipt);assert.equal(f.approvals.length,1)
})
test('不同工具callId不能重复制造一次发送的交办身份，禁止模型伪造上下文',async t=>{
 const f=await setup();t.after(()=>f.ctx.fiber.dispose())
 const args={scope:'SOC',title:'调查',goal:'调查异常',roleId,expectedRoleVersion:1}
 assert.equal((await f.call('teloa_work_dispatch',args,'a')).isError,false)
 assert.equal((await f.call('teloa_work_dispatch',args,'b')).isError,false)
 const [a,b]=f.dispatched as {requestId:string;sessionId:string}[]
 assert.equal(a!.requestId,b!.requestId);assert.equal(a!.sessionId,'work-origin')
 assert.equal((await f.call('teloa_work_dispatch',{...args,ownerId:'other'})).isError,true)
 assert.equal(f.dispatched.length,2)
})
test('受管/历史运行、子级与同事身份不能执行主助手交办，真实缺源明确失败',async t=>{
 for(const overrides of [{readTaskPolicy:async()=>({allowedTools:[]})},{isRoleConversation:async()=>true},{isTaskConversation:async()=>true}]){const f=await setup(overrides);t.after(()=>f.ctx.fiber.dispose());assert.equal((await f.call('teloa_work_directory')).isError,true)}
 const child=await setup({},'subagent');t.after(()=>child.ctx.fiber.dispose());assert.equal((await child.call('teloa_work_directory')).isError,true)
 const f=await setup();t.after(()=>f.ctx.fiber.dispose())
 const result=await f.call('teloa_business_data_query',{scope:'SOC',limit:100})
 assert.equal(result.isError,true);assert.match(JSON.stringify(result),/来源未配置/)
})
test('图片或文件输入在预约任何Task之前明确拒绝，原始消息仍在日志中',async t=>{
 for(const type of ['image','file']){
  const f=await setup();t.after(()=>f.ctx.fiber.dispose())
  f.agent.session.append('turn/start',{turn:1} as never)
  f.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'请调查附件'},{type,attachment:{id:'attachment'}} as never]}),{surfaceOp:'append'})
  const result=await f.call('teloa_work_dispatch',{scope:'SOC',title:'调查',goal:'核对附件',roleId,expectedRoleVersion:1})
  assert.equal(result.isError,true);assert.match(JSON.stringify(result),/附件或结构化内容/);assert.equal(f.dispatched.length,0)
  assert.ok(f.agent.session.snapshotEvents().some(event=>event.type==='user/message'&&event.data.content.some(block=>block.type===type)))
 }
})

test('本人主会话指引写明看板设计技能与看板读取工具',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 const messages=[createUserMessage({source:{kind:'user'},content:[{type:'text',text:'做一张告警看板'}]})]
 const decision=await e.ctx.waterfall('agent/pre-step',{agent:e.agent,messages,turn:1,step:1,signal:new AbortController().signal},async()=>({kind:'enter' as const,messages})) as unknown as {messages:Array<{content:ReadonlyArray<{type:string;text?:string}>}>}
 const notice=decision.messages.at(-1)!.content.map(block=>block.text??'').join('')
 assert.match(notice,/teloa-dashboard-designer/)
 assert.match(notice,/teloa_business_dashboard_read/)
})
test('明确交办先走原生批准卡且批准前不建任务，模型可见说明不把聊天追问当批准',async t=>{
 const f=await setup();t.after(()=>f.ctx.fiber.dispose())
 const schemas=f.ctx.tools.schemas(f.agent)
 for(const name of ['teloa_work_dispatch','teloa_work_collect_reports']){
  const description=schemas.find(schema=>schema.name===name)?.description??''
  assert.match(description,/native approval card/,name)
  assert.match(description,/no Task\/Run before approval/,name)
  assert.match(description,/Do not substitute chat questions/,name)
 }
 const messages=[createUserMessage({source:{kind:'user'},content:[{type:'text',text:'请交给调查员核对，等我批准'}]})]
 const decision=await f.ctx.waterfall('agent/pre-step',{agent:f.agent,messages,turn:1,step:1,signal:new AbortController().signal},async()=>({kind:'enter' as const,messages})) as unknown as {messages:Array<{content:ReadonlyArray<{type:string;text?:string}>}>}
 const notice=decision.messages.at(-1)!.content.map(block=>block.text??'').join('')
 assert.match(notice,/teloa_work_dispatch for the native approval card/)
 assert.match(notice,/Do not substitute chat questions/)
 let entered!:()=>void,release!:()=>void
 const approvalEntered=new Promise<void>(resolve=>{entered=resolve}),approvalReleased=new Promise<void>(resolve=>{release=resolve})
 f.approve(async()=>{entered();await approvalReleased;return 'allowed-once'})
 const pending=f.call('teloa_work_dispatch',{scope:'SOC',title:'核对告警',goal:'只读核对',roleId,expectedRoleVersion:1})
 await approvalEntered
 assert.equal(f.dispatched.length,0)
 release()
 assert.equal((await pending).isError,false)
 assert.equal(f.dispatched.length,1)
 const dispatch=schemas.find(schema=>schema.name==='teloa_work_dispatch')!
 assert.match(dispatch.description,/Do not first create an unassigned task/)
 assert.match(dispatch.description,/has no save-only mode/)
 for(const field of ['taskId','draftId','saveOnly']){
  assert.equal((await f.call('teloa_work_dispatch',{scope:'SOC',title:'核对告警',goal:'只读核对',roleId,expectedRoleVersion:1,[field]:'original-draft'})).isError,true,'不能让提示暗示不存在的草稿复用或仅保存参数')
 }
 assert.equal(f.dispatched.length,1)
})


test('预约未 bind 与完整 builder 均拒绝正式工作工具，不注入 daily 指引且保留 next',async t=>{
 for(const isBuilder of [async()=>true,async()=>{throw new WorkError('teloa/host-unavailable','绑定不可读')}]){
  const f=await setup({isBuilder});t.after(()=>f.ctx.fiber.dispose())
  for(const name of ['teloa_work_directory','teloa_work_dispatch','teloa_work_collect_reports'])assert.equal((await f.call(name,name==='teloa_work_directory'?{}:{scope:'SOC',title:'调查',goal:'核对',...(name==='teloa_work_dispatch'?{roleId,expectedRoleVersion:1}:{})})).isError,true)
  assert.equal(f.dispatched.length,0)
  const messages=[createUserMessage({source:{kind:'user'},content:[]})],input={agent:f.agent,messages,turn:1,step:1,signal:new AbortController().signal}
  let next=0
  try{const decision=await f.ctx.waterfall('agent/pre-step',input,async()=>{next++;return {kind:'enter' as const,messages}});assert.deepEqual(decision,{kind:'enter',messages})}catch(error){assert.match(String(error),/绑定不可读/)}
  assert.equal(next,1)
 }
})
test('pending daily在工具与本人消息消费两门拒绝，完成绑定后原会话可继续',async t=>{
 let pending=true,freezes=0
 const f=await setup({isPendingDaily:async()=>pending,freeze:async()=>{freezes++;return null}});t.after(()=>f.ctx.fiber.dispose())
 assert.equal((await f.call('teloa_work_directory')).isError,true)
 const messages=[createUserMessage({source:{kind:'user'},content:[{type:'text',text:'继续'}]})],input={agent:f.agent,messages,turn:1,step:1,signal:new AbortController().signal}
 await assert.rejects(f.ctx.waterfall('agent/pre-step',input,async()=>({kind:'enter' as const,messages})),{code:'teloa/binding-pending'})
 assert.equal(freezes,0);pending=false
 assert.equal((await f.call('teloa_work_directory')).isError,false)
 assert.equal((await f.ctx.waterfall('agent/pre-step',input,async()=>({kind:'enter' as const,messages}))).kind,'enter');assert.equal(freezes,1)
})

const args={scope:'SOC',title:'核对客户',goal:'核对客户信息，给出依据和待确认事项',roleId,expectedRoleVersion:1}
const responsibility={scope:'SOC',version:2,roleId:null,selectedRoleVersion:null,availability:'none' as const,currentRoleVersion:null}
test('采用业务的真实负责人投影与完整一次确认，普通读取不交办，拒绝不预约',async t=>{
 const f=await setup({business:async()=>({title:'客户业务',responsibility})});t.after(()=>f.ctx.fiber.dispose())
 const directory=await f.call('teloa_work_directory');assert.match(JSON.stringify(directory),/responsibility/);assert.equal(f.dispatched.length,0)
 f.approve(async()=> 'rejected');assert.equal((await f.call('teloa_work_dispatch',args)).isError,true);assert.equal(f.dispatched.length,0)
 f.approve(async()=> 'allowed-once');assert.equal((await f.call('teloa_work_dispatch',args)).isError,false)
 assert.deepEqual((f.dispatched[0] as {responsibility:unknown}).responsibility,{version:2,roleId:null})
 assert.match(f.approvals.at(-1)!,/客户业务/);assert.match(f.approvals.at(-1)!,/调查员/);assert.match(f.approvals.at(-1)!,/请交给调查员/);assert.match(f.approvals.at(-1)!,/待确认事项/)
})
test('原生批准展示已核验对象标题与完整工作目标，内部快照身份不进入默认说明',async t=>{
 const reference={scope:'SOC',type:'customer',id:'customer-a',version:2,snapshotHash:'a'.repeat(64)},marker=encodeBusinessRecordReference(reference)
 const f=await setup({business:async()=>({title:'客户业务',responsibility}),reference:async value=>{assert.deepEqual(value,reference);return {title:'客户甲·续约核对'}}});t.after(()=>f.ctx.fiber.dispose())
 f.agent.session.append('turn/start',{turn:1} as never)
 f.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'请调查续约 '+marker}]}),{surfaceOp:'append'})
 assert.equal((await f.call('teloa_work_dispatch',{...args,reference})).isError,false)
 const reason=f.approvals[0]!
 for(const text of ['客户业务','调查员','客户甲·续约核对','v2',args.title,args.goal,'请调查续约','持久业务负责人不变'])assert.ok(reason.includes(text),text)
 for(const hidden of [reference.snapshotHash,roleId,'snapshotHash','contextVersion','singleOverride','[[teloa-business-record:'])assert.ok(!reason.includes(hidden),hidden)
 assert.deepEqual((f.dispatched[0] as {reference:unknown}).reference,reference,'可读投影不得更改实际交办的固定版本与摘要')
})
test('审批期间已核验固定对象标题变化仍拒绝，执行回执和任务验收状态向模型明确区分',async t=>{
 const reference={scope:'SOC',type:'customer',id:'customer-a',version:2,snapshotHash:'a'.repeat(64)}
 let title='客户甲'
 const f=await setup({reference:async()=>({title})});t.after(()=>f.ctx.fiber.dispose())
 f.approve(async()=>{title='另一对象';return 'allowed-once'})
 assert.equal((await f.call('teloa_work_dispatch',{...args,reference})).isError,true);assert.equal(f.dispatched.length,0)
 const schemas=f.ctx.tools.schemas(f.agent)
 for(const name of ['teloa_work_dispatch','teloa_work_status']){
  const description=schemas.find(schema=>schema.name===name)!.description??''
  assert.match(description,/members\.status/);assert.match(description,/task\.state/);assert.match(description,/received/);assert.match(description,/Approval already completed/)
 }
})
test('数字短对象ID不改写目标里的数量，生成的对象标题不再作标识替换',async t=>{
 const reference={scope:'SOC',type:'customer',id:'1',version:2,snapshotHash:'a'.repeat(64)}
 const f=await setup({reference:async()=>({title:'客户1号'})});t.after(()=>f.ctx.fiber.dispose())
 const goal='核对10条记录，使用第1份附件，逐条核对并列出依据。'
 assert.equal((await f.call('teloa_work_dispatch',{...args,goal,reference})).isError,false)
 assert.ok(f.approvals[0]!.includes(goal));assert.ok(f.approvals[0]!.includes('工作对象：客户1号（v2）'))
 assert.equal((f.dispatched[0] as {goal:string}).goal,goal)
})
test('跨业务汇报审批逐员显示真实责任范围，批准期间范围名称变更拒绝',async t=>{
 for(const changed of [false,true]){
  let suffix=''
  const f=await setup({business:async scope=>({title:(scope==='SOC'?'安全业务':'客户业务')+suffix,responsibility:{...responsibility,scope}}),scopes:async()=>['general','SOC','CRM']});t.after(()=>f.ctx.fiber.dispose())
  const base=f.ports.roles
  f.ports.roles=async()=>[...(await base()),{...(await base())[0]!,id:'33333333-3333-4333-8333-333333333333',name:'客户专员',scopes:['CRM']}]
  f.approve(async()=>{if(changed)suffix='已更改';return 'allowed-once'})
  assert.equal((await f.call('teloa_work_collect_reports',{scope:'general',allBusinesses:true,title:'跨业务汇报',goal:'汇总两项业务真实进展'})).isError,changed)
  assert.match(f.approvals[0]!,/跨业务范围：安全业务、客户业务|跨业务范围：客户业务、安全业务/)
  assert.match(f.approvals[0]!,/调查员（在岗 · 安全业务）/);assert.match(f.approvals[0]!,/客户专员（在岗 · 客户业务）/)
  assert.equal(f.dispatched.length,changed?0:1)
 }
})
test('审批期间变更指令、scope权限、岗位或负责人时零预约',async t=>{
 for(const change of ['instruction','access','role','responsibility','context']){
  const f=await setup({business:async()=>({title:'客户业务',responsibility})});t.after(()=>f.ctx.fiber.dispose())
  f.approve(async()=>{if(change==='instruction')f.agent.session.append('turn/start',{turn:2} as never);if(change==='access')f.ports.scopes=async()=>[];if(change==='role'){const original=f.ports.roles;f.ports.roles=async()=> (await original()).map(role=>({...role,version:2}))}if(change==='responsibility')f.ports.business=async()=>({title:'客户业务',responsibility:{...responsibility,version:3}});if(change==='context')f.ports.context=async()=>({sessionId:'work-origin',scopeId:'general',roleId:null,version:1,locked:true});return 'allowed-once'})
  assert.equal((await f.call('teloa_work_dispatch',args)).isError,true,change);assert.equal(f.dispatched.length,0,change)
 }
})
test('完整确认含下游理由超过128KiB拒绝而不截断',async t=>{
 const f=await setup();t.after(()=>f.ctx.fiber.dispose());f.ctx.on('tools/pre-execute',async()=>({kind:'ask' as const,reason:'原'.repeat(44000)}))
 assert.equal((await f.call('teloa_work_dispatch',args)).isError,true);assert.equal(f.approvals.length,0);assert.equal(f.dispatched.length,0)
})
test('对象固定引用完整确认且批准后再核历史；读取等待中的context变化不预约',async t=>{
 const reference={scope:'SOC',type:'customer',id:'customer-a',version:2,snapshotHash:'a'.repeat(64)}
 const f=await setup({business:async()=>({title:'客户业务',responsibility}),reference:async value=>{assert.deepEqual(value,reference)}});t.after(()=>f.ctx.fiber.dispose())
 f.approve(async()=>{f.ports.reference=async()=>{f.ports.context=async()=>({sessionId:'work-origin',scopeId:'general',roleId:null,version:1,locked:true})};return 'allowed-once'})
 const result=await f.call('teloa_work_dispatch',{...args,reference});assert.equal(result.isError,true);assert.equal(f.dispatched.length,0);assert.match(f.approvals[0]!,/customer-a/);assert.match(f.approvals[0]!,/v2/);assert.doesNotMatch(f.approvals[0]!,/aaaaaaaa/)
})
test('原生消息中的固定记录引用必须与交办参数一致，历史授权仍单独复核',async t=>{
 const reference={scope:'SOC',type:'customer',id:'customer-a',version:2,snapshotHash:'a'.repeat(64)}
 const marker=encodeBusinessRecordReference(reference)
 for(const input of [
  {text:'请调查 '+marker,reference,allowed:true},
  {text:'请调查 '+marker,reference:{...reference,version:3},allowed:false},
  {text:'请调查 '+marker,reference:undefined,allowed:false},
  {text:'请调查 '+marker+' '+marker,reference,allowed:false},
 ]){
  let reads=0
  const f=await setup({reference:async value=>{reads++;assert.deepEqual(value,reference)}});t.after(()=>f.ctx.fiber.dispose())
  f.agent.session.append('turn/start',{turn:1} as never)
  f.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:input.text}]}),{surfaceOp:'append'})
  const result=await f.call('teloa_work_dispatch',{...args,...(input.reference?{reference:input.reference}:{})})
  assert.equal(result.isError,!input.allowed,input.text)
  assert.equal(f.dispatched.length,input.allowed?1:0)
  assert.equal(f.approvals.length,input.allowed?1:0)
  assert.equal(reads,input.allowed?2:0,'不匹配标记必须在历史读取前拒绝；匹配后审批前后复核')
 }
})
test('单次覆盖不改持久负责人，失效状态保留在完整确认',async t=>{
 const leader='33333333-3333-4333-8333-333333333333'
 const f=await setup({business:async()=>({title:'客户业务',responsibility:{...responsibility,roleId:leader,selectedRoleVersion:1,currentRoleVersion:2,availability:'paused'}})});t.after(()=>f.ctx.fiber.dispose())
 assert.equal((await f.call('teloa_work_dispatch',args)).isError,false);assert.match(f.approvals[0]!,/仅本次由指定员工接手/);assert.match(f.approvals[0]!,/持久业务负责人不变/);assert.match(f.approvals[0]!,/暂停/)
 assert.deepEqual((f.dispatched[0] as {responsibility:unknown}).responsibility,{version:2,roleId:leader})
})
test('已替换的本人消息不可再作交办来源；下游cancel不批准不预约',async t=>{
 const f=await setup();t.after(()=>f.ctx.fiber.dispose())
 const off=f.ctx.on('tools/pre-execute',async()=>({kind:'cancel' as const}));await f.call('teloa_work_dispatch',args);assert.equal(f.approvals.length,0);assert.equal(f.dispatched.length,0);off()
 f.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[]}),{surfaceOp:{op:'replace',startSeq:1,endSeq:1},sourceEventSeqs:[1]} as never)
 assert.equal((await f.call('teloa_work_dispatch',args)).isError,true);assert.equal(f.approvals.length,0)
})
test('交办回调在prepare等待后仍固定原本人指令，不复用当时已通过的批准',async t=>{
 const f=await setup();t.after(()=>f.ctx.fiber.dispose());let finalChecked=false
 f.ports.dispatch=async(_input,_signal,revalidate)=>{f.agent.session.append('turn/start',{turn:3} as never);await revalidate!();finalChecked=true;return {}}
 assert.equal((await f.call('teloa_work_dispatch',args)).isError,true);assert.equal(finalChecked,false)
})
test('汇报批准把精确名单作为reserve输入；全部业务只选当前有权scope且稳定排序',async t=>{
 const f=await setup();t.after(()=>f.ctx.fiber.dispose());const role=(await f.ports.roles())[0]!
 f.ports.scopes=async()=>['general','SOC']
 f.ports.roles=async()=>[{...role,id:'33333333-3333-4333-8333-333333333333',name:'另一位',scopes:['AppSec','SOC']},{...role,scopes:['AppSec']}, {...role,id:'11111111-1111-4111-8111-111111111111',scopes:['SOC'],state:'paused'}]
 assert.equal((await f.call('teloa_work_collect_reports',{scope:'general',allBusinesses:true,title:'汇报',goal:'提供真实进展'})).isError,false)
 assert.deepEqual((f.dispatched[0] as {expectedReportTargets:unknown}).expectedReportTargets,[{roleId:'11111111-1111-4111-8111-111111111111',roleVersion:1,name:'调查员',scope:'SOC',unavailable:'paused'},{roleId:'33333333-3333-4333-8333-333333333333',roleVersion:1,name:'另一位',scope:'SOC',unavailable:null}])
})

test('成果续改批准卡逐字显示持久反馈，不采纳模型凭旧上下文重写的目标',async t=>{
 const saved='本人明确把小林截止改为2026-10-22，其他段落和预算保持。'
 const f=await setup({roles:async()=>[],revisionGoal:async source=>{assert.match(source.sourceText??'',/teloa-revision/);return saved}});t.after(()=>f.ctx.fiber.dispose())
 f.agent.session.append('turn/start',{turn:1} as never)
 f.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'请按固定反馈续改 [teloa-revision:11111111-1111-4111-8111-111111111111]'}]}),{surfaceOp:'append'})
 const result=await f.call('teloa_work_dispatch',{executor:'general',scope:'general',title:'修订原稿',goal:'旧上下文：截止仍为10月20日'})
 assert.equal(result.isError,false,JSON.stringify(result));assert.match(f.approvals[0]!,/2026-10-22/);assert.ok(!f.approvals[0]!.includes('旧上下文'))
 assert.equal((f.dispatched[0] as {goal:string}).goal,saved)
})

test('成果续改由宿主在本轮目录给出已核反馈，general schema 不要求业务 reference',async t=>{
 const marker='[teloa-revision:11111111-1111-4111-8111-111111111111]',saved='修订《合成行动清单》的「行动」段落，基准版本 v1。\n本人反馈：小林截止改为2026-10-22，预算保持12000元。'
 const f=await setup({roles:async()=>[],revisionGoal:async source=>{assert.equal(source.sessionId,'work-origin');assert.equal(source.sourceText,'请续改 '+marker);return saved}});t.after(()=>f.ctx.fiber.dispose())
 f.agent.session.append('turn/start',{turn:1} as never)
 const message=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'请续改 '+marker}]})
 f.agent.session.append('user/message',message,{surfaceOp:'append'})
 const result=await f.call('teloa_work_directory')
 assert.equal(result.isError,false,JSON.stringify(result))
 const receipt=JSON.parse(result.value as string)
 assert.equal(receipt.artifactRevision.goal,saved)
 assert.deepEqual({executor:receipt.artifactRevision.executor,scope:receipt.artifactRevision.scope},{executor:'general',scope:'general'})
 assert.equal(receipt.artifactRevision.reference,undefined)
 assert.match(receipt.artifactRevision.receiptNotice,/omit reference/)
 const schema=f.ctx.tools.schemas(f.agent).find(value=>value.name==='teloa_work_dispatch')!
 assert.match(schema.description,/Artifact revisions.*omit reference/)
 assert.match(JSON.stringify(schema),/Business-employee work only: exact record reference/)
 assert.equal(f.dispatched.length,0);assert.equal(f.approvals.length,0)
})

test('官方Loop首次pre-step在本人消息持久化前从真实claimed输入投影完整反馈', {timeout:10000},async t=>{
 const marker='[teloa-revision:11111111-1111-4111-8111-111111111111]',text='请按已保存反馈继续修改原成果。'+marker,saved='修订《行动单》的固定 v1。\n本人反馈逐字保留：小林2026-10-22；阿文2026-10-21；总预算12000，已支出4500，剩余7500。'
 const base=await setup();t.after(()=>base.ctx.fiber.dispose())
 const f=await loopWorkFixture(t,true);let reads=0,currentUserWasDurable=false
 registerConversationWorkTools(f.ctx,{...base.ports,revisionGoal:async source=>{reads++;assert.deepEqual(source,{sessionId:f.agent.session.id,sourceText:text});const start=f.events.filter(event=>event.type==='turn/start').at(-1)!;currentUserWasDurable=f.events.some(event=>event.seq>start.seq&&event.type==='user/message'&&event.data.source.kind==='user');return saved}})
 f.adapter.scripts.push(loopText)
 const input=createUserMessage({source:{kind:'user',rpcId:'real-pending-revision'},content:[{type:'text',text}]})
 f.agent.followup(input);await f.agent.whenIdle()
 assert.equal(f.adapter.requests.length,1)
 assert.equal(reads,1,'首个真实请求已有已核反馈；不能依赖后续directory工具才读取')
 assert.equal(currentUserWasDurable,false,'官方Loop确实先pre-step、后user/message持久化')
 assert.ok(JSON.stringify(f.adapter.requests[0]).includes('小林2026-10-22；阿文2026-10-21；总预算12000，已支出4500，剩余7500。'))
 assert.ok(JSON.stringify(f.adapter.requests[0]).includes('omit reference'))
 assert.equal(f.events.filter(event=>event.type==='user/message'&&event.data.source.kind==='user').length,1,'投影不伪造或提前写入用户消息')
 assert.equal(base.dispatched.length,0);assert.equal(base.approvals.length,0)
})

test('claimed修订投影等待读取时消息身份变化不把反馈交给替换输入',async t=>{
 const text='继续修订 [teloa-revision:11111111-1111-4111-8111-111111111111]',messages=[createUserMessage({source:{kind:'user'},content:[{type:'text',text}]})]
 const f=await setup({revisionGoal:async()=>{messages.splice(0,1,createUserMessage({source:{kind:'user'},content:[{type:'text',text}]}));return '不得进入替换输入的反馈'}});t.after(()=>f.ctx.fiber.dispose())
 f.agent.session.append('turn/start',{turn:1} as never)
 await assert.rejects(f.ctx.waterfall('agent/pre-step',{agent:f.agent,messages,turn:1,step:1,signal:new AbortController().signal},async()=>({kind:'enter' as const,messages})),{code:'teloa/conflict'})
 assert.equal(f.dispatched.length,0);assert.equal(f.approvals.length,0)
})

test('修订投影只认claimed唯一本人输入，不从历史或下游追加上下文挑选标记',async t=>{
 let reads=0
 const f=await setup({revisionGoal:async()=>{reads++;return '不应披露的反馈'}});t.after(()=>f.ctx.fiber.dispose())
 const marker='[teloa-revision:11111111-1111-4111-8111-111111111111]'
 f.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:marker}]}),{surfaceOp:'append'})
 const ordinary=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'普通问题'}]}),injected=createUserMessage({source:{kind:'user'},content:[{type:'text',text:marker}]})
 const first=await f.ctx.waterfall('agent/pre-step',{agent:f.agent,messages:[ordinary],turn:1,step:1,signal:new AbortController().signal},async()=>({kind:'enter' as const,messages:[ordinary,injected]}))
 assert.doesNotMatch(JSON.stringify(first),/artifactRevision/)
 const mixed=[ordinary,injected],second=await f.ctx.waterfall('agent/pre-step',{agent:f.agent,messages:mixed,turn:1,step:1,signal:new AbortController().signal},async()=>({kind:'enter' as const,messages:mixed}))
 assert.doesNotMatch(JSON.stringify(second),/artifactRevision/,'多条本人输入不能猜选一条标记')
 assert.equal(reads,0);assert.equal(f.dispatched.length,0);assert.equal(f.approvals.length,0)
})

test('官方Loop后续steer已有本轮本人输入时不再投影修订，持久dispatch仍拒多用户来源', {timeout:10000},async t=>{
 let reads=0
 const base=await setup();t.after(()=>base.ctx.fiber.dispose())
 const f=await loopWorkFixture(t,true)
 registerConversationWorkTools(f.ctx,{...base.ports,revisionGoal:async()=>{reads++;return '不能投影到steer的反馈'}})
 f.ctx.on('llm/stream',async function*(_request,next){if(f.adapter.requests.length===0)f.agent.inject(createUserMessage({source:{kind:'user',rpcId:'steer'},content:[{type:'text',text:'续改 [teloa-revision:11111111-1111-4111-8111-111111111111]'}]}));yield*next()})
 f.adapter.scripts.push(loopText,loopText)
 await f.send()
 assert.equal(f.adapter.requests.length,2);assert.equal(f.events.filter(event=>event.type==='turn/start').length,1)
 assert.equal(f.events.filter(event=>event.type==='user/message'&&event.data.source.kind==='user').length,2)
 assert.equal(reads,0,'本轮已持久1条加claimed1条不符合交办来源，不读取反馈')
 assert.doesNotMatch(JSON.stringify(f.adapter.requests[1]),/不能投影到steer的反馈|artifactRevision/)
 const result=await f.ctx.tools.execute({agent:f.agent,name:'teloa_work_dispatch',arguments:{scope:'general',executor:'general',title:'修订',goal:'按反馈修订'},callId:ToolCallId('multi-user-dispatch'),signal:AbortSignal.timeout(5000)})
 assert.equal(result.isError,true);assert.equal(base.approvals.length,0);assert.equal(base.dispatched.length,0)
})

test('继承历史的turn不能给claimed修订投影本人来源',async t=>{
 let reads=0
 const f=await setup({revisionGoal:async()=>{reads++;return '不能从继承轮次投影的反馈'}});t.after(()=>f.ctx.fiber.dispose())
 const seed=f.agent.session.snapshotEvents(),{agent}=await f.ctx.agents.create({sessionId:SessionId('inherited-review'),meta:{isSeeded:true,parentSession:f.agent.session.id},seed,inheritedEventCount:seed.length as never,agentOptions:{provider:'test',model:'test'}})
 assert.ok(agent.session.inheritedEventCount>0)
 const messages=[createUserMessage({source:{kind:'user'},content:[{type:'text',text:'续改 [teloa-revision:11111111-1111-4111-8111-111111111111]'}]})]
 const decision=await f.ctx.waterfall('agent/pre-step',{agent,messages,turn:1,step:1,signal:new AbortController().signal},async()=>({kind:'enter' as const,messages}))
 assert.equal(reads,0);assert.doesNotMatch(JSON.stringify(decision),/artifactRevision/)
 assert.equal(f.approvals.length,0);assert.equal(f.dispatched.length,0)
})

test('坏或重复修订标记的正式读端invalid-input仅省略预览，普通Loop结束且dispatch仍拒绝', {timeout:10000},async t=>{
 for(const text of ['续改 [teloa-revision:11111111-1111-4111-8111-111111111111] [teloa-revision:22222222-2222-4222-8222-222222222222]','续改 [teloa-revision:00000000-0000-0000-0000-000000000000]'])await t.test(text,async sub=>{
  let queries=0
  const service=new ArtifactRevisionRequestService({query:async()=>{queries++;throw Error('坏标记不能查询数据库')}} as never,()=> '2026-10-17T00:00:00Z'),base=await setup();sub.after(()=>base.ctx.fiber.dispose())
  const f=await loopWorkFixture(sub,true);registerConversationWorkTools(f.ctx,{...base.ports,revisionGoal:source=>service.goalForSource(owner,source)})
  f.adapter.scripts.push(loopText);f.agent.followup(createUserMessage({source:{kind:'user',rpcId:'bad-marker'},content:[{type:'text',text}]}));await f.agent.whenIdle()
  assert.equal(f.adapter.requests.length,1,'只读预览失败不能杀掉普通本人消息')
  assert.doesNotMatch(JSON.stringify(f.adapter.requests[0]),/artifactRevision/)
  assert.equal(f.events.filter(event=>event.type==='turn/end'&&event.data.reason.kind==='completed').length,1)
  const result=await f.ctx.tools.execute({agent:f.agent,name:'teloa_work_dispatch',arguments:{scope:'general',executor:'general',title:'修订',goal:'按反馈修订'},callId:ToolCallId('bad-marker-dispatch'),signal:AbortSignal.timeout(5000)})
  assert.equal(result.isError,true);assert.equal(queries,0);assert.equal(base.approvals.length,0);assert.equal(base.dispatched.length,0)
 })
})

test('general 的错误业务 reference 仍拒绝且说明修订由宿主绑定，真实业务校验保持',async t=>{
 const f=await setup({roles:async()=>[],revisionGoal:async()=> '真实已存反馈'});t.after(()=>f.ctx.fiber.dispose())
 f.agent.session.append('turn/start',{turn:1} as never)
 f.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'请续改 [teloa-revision:11111111-1111-4111-8111-111111111111]'}]}),{surfaceOp:'append'})
 for(const reference of [{scope:'general',type:'artifact-revision',id:'11111111-1111-4111-8111-111111111111',version:1,snapshotHash:'11111111-1111-4111-8111-111111111111'},{scope:'general',type:'record',id:'real-looking',version:1,snapshotHash:'a'.repeat(64)}]){
  const result=await f.call('teloa_work_dispatch',{executor:'general',scope:'general',title:'修订',goal:'请修订',reference})
  assert.equal(result.isError,true);assert.match(JSON.stringify(result),/omit reference/)
 }
 assert.equal(f.approvals.length,0);assert.equal(f.dispatched.length,0)
})

test('异主或过期修订不披露反馈，完成后仍可汇报，非本轮标记和模型文字不激活修订读取',async t=>{
 for(const code of ['teloa/forbidden','teloa/version-conflict'] as const){
  const f=await setup({revisionGoal:async()=>{throw new WorkError(code,'当前修订不可交办。')}});t.after(()=>f.ctx.fiber.dispose())
  f.agent.session.append('turn/start',{turn:1} as never)
  const message=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'续改 [teloa-revision:11111111-1111-4111-8111-111111111111]'}]})
  f.agent.session.append('user/message',message,{surfaceOp:'append'})
  const result=await f.call('teloa_work_directory')
  assert.equal(result.isError,true)
  const decision=await f.ctx.waterfall('agent/pre-step',{agent:f.agent,messages:[message],turn:1,step:1,signal:new AbortController().signal},async()=>({kind:'enter' as const,messages:[message]}))
  assert.equal(decision.kind,'enter','已完成或失效修订不阻断普通状态汇报')
  assert.doesNotMatch(JSON.stringify(decision),/artifactRevision/,'没有可执行修订投影或旧反馈')
  assert.equal(f.approvals.length,0);assert.equal(f.dispatched.length,0)
 }
 let reads=0
 const f=await setup({revisionGoal:async()=>{reads++;return '不得泄露的旧反馈'}});t.after(()=>f.ctx.fiber.dispose())
 f.agent.session.append('assistant/message',{id:'model-marker',content:[{type:'text',text:'[teloa-revision:11111111-1111-4111-8111-111111111111]'}]} as never,{surfaceOp:'append'})
 assert.equal((await f.call('teloa_work_directory')).isError,false)
 f.agent.session.append('turn/start',{turn:1} as never)
 f.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'[teloa-revision:11111111-1111-4111-8111-111111111111]'}]}),{surfaceOp:'append'})
 f.agent.session.append('turn/start',{turn:2} as never)
 f.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'普通问题'}]}),{surfaceOp:'append'})
 assert.equal((await f.call('teloa_work_directory')).isError,false)
 assert.equal(reads,0)
})

test('修订目录等待期间本人指令变化不能把旧反馈注入新轮次',async t=>{
 const f=await setup({revisionGoal:async()=>{f.agent.session.append('turn/start',{turn:2} as never);f.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'新的普通问题'}]}),{surfaceOp:'append'});return '不应进入新轮次的反馈'}});t.after(()=>f.ctx.fiber.dispose())
 f.agent.session.append('turn/start',{turn:1} as never)
 f.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'[teloa-revision:11111111-1111-4111-8111-111111111111]'}]}),{surfaceOp:'append'})
 const result=await f.call('teloa_work_directory')
 assert.equal(result.isError,true);assert.ok(!JSON.stringify(result).includes('不应进入新轮次的反馈'))
})

test('成果续改不能恢复旧任务，错误恢复给出原生派发指引且没有执行副作用',async t=>{
 const marker='[teloa-revision:11111111-1111-4111-8111-111111111111]'
 let resumed=0,checked=0
 const f=await setup({resume:async()=>{resumed++;return {}},revisionGoal:async source=>{checked++;assert.match(source.sourceText??'',/teloa-revision/);return '固定反馈私有正文'}});t.after(()=>f.ctx.fiber.dispose())
 f.agent.session.append('turn/start',{turn:1} as never)
 f.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'请按固定反馈续改 '+marker}]}),{surfaceOp:'append'})
 for(const requestId of ['teloa-revision:11111111-1111-4111-8111-111111111111','old-request']){
  const result=await f.call('teloa_work_resume',{requestId})
  assert.equal(result.isError,true,JSON.stringify(result));assert.equal(resumed,0)
  assert.match(JSON.stringify(result),/teloa_work_dispatch/)
  assert.ok(!JSON.stringify(result).includes('固定反馈私有正文'))
 }
 assert.ok(checked>0);assert.equal(f.dispatched.length,0);assert.equal(f.approvals.length,0)
})

test('成果续改的缺失或异主反馈不能落入旧任务恢复，普通重试保持原路径',async t=>{
 for(const revisionGoal of [undefined,async()=>undefined,async()=>{throw new WorkError('teloa/forbidden','无法核对当前本人固定反馈。')}]){
  let resumed=0
  const f=await setup({resume:async()=>{resumed++;return {}},...(revisionGoal?{revisionGoal}:{})});t.after(()=>f.ctx.fiber.dispose())
  f.agent.session.append('turn/start',{turn:1} as never)
  f.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'续改 [teloa-revision:22222222-2222-4222-8222-222222222222]'}]}),{surfaceOp:'append'})
  assert.equal((await f.call('teloa_work_resume',{requestId:'old-request'})).isError,true)
  assert.equal(resumed,0);assert.equal(f.dispatched.length,0)
 }
 let resumed=0
 const normal=await setup({revisionGoal:async()=>{throw new Error('普通重试不应读取成果反馈')},resume:async(_session,requestId)=>{resumed++;return {requestId}}});t.after(()=>normal.ctx.fiber.dispose())
 assert.equal((await normal.call('teloa_work_resume',{requestId:'original-request'})).isError,false)
 assert.equal(resumed,1)
})

test('模型可见的恢复说明与主会话指引明确区分成果续改与原交办重试',async t=>{
 const f=await setup();t.after(()=>f.ctx.fiber.dispose())
 const description=f.ctx.tools.schemas(f.agent).find(schema=>schema.name==='teloa_work_resume')?.description??''
 assert.match(description,/teloa-revision/);assert.match(description,/teloa_work_dispatch/)
 const messages=[createUserMessage({source:{kind:'user'},content:[{type:'text',text:'请核对原工作'}]})]
 const decision=await f.ctx.waterfall('agent/pre-step',{agent:f.agent,messages,turn:1,step:1,signal:new AbortController().signal},async()=>({kind:'enter' as const,messages})) as unknown as {messages:Array<{content:ReadonlyArray<{type:string;text?:string}>}>}
 const notice=decision.messages.at(-1)!.content.map(block=>block.text??'').join('')
 assert.match(notice,/new linked artifact revision/);assert.match(notice,/teloa-revision/);assert.match(notice,/not a requestId or retry/)
})


test('原生交办卡明示token上限且传递原值；非法、额外policy和汇报提额在审批前拒绝',async t=>{
 const f=await setup();t.after(()=>f.ctx.fiber.dispose())
 const input={scope:'SOC',title:'独立新轮',goal:'仅本次核对，不变更其他边界',roleId,expectedRoleVersion:1}
 for(const workTokenLimit of [0,-1,1.1,Number.MAX_SAFE_INTEGER+1,'6000000',null])assert.equal((await f.call('teloa_work_dispatch',{...input,workTokenLimit})).isError,true)
 for(const extra of [{budgetPolicy:{maxTokens:6_000_000}},{maxTokens:6_000_000},{workTokenLimit:6_000_000,ownerTokenLimit:10_000_000}])assert.equal((await f.call('teloa_work_dispatch',{...input,...extra})).isError,true)
 assert.equal((await f.call('teloa_work_collect_reports',{scope:'SOC',title:'汇报',goal:'读取回报',workTokenLimit:6_000_000})).isError,true)
 assert.equal(f.approvals.length,0);assert.equal(f.dispatched.length,0)
 assert.equal((await f.call('teloa_work_dispatch',{...input,workTokenLimit:6_000_000})).isError,false)
 assert.equal((f.dispatched[0] as {workTokenLimit:number}).workTokenLimit,6_000_000)
 assert.match(f.approvals[0]!,/6,000,000/);assert.match(f.approvals[0]!,/本人累计总额度仍然约束/)
 assert.equal((await f.call('teloa_work_dispatch',input)).isError,false)
 assert.equal(Object.hasOwn(f.dispatched[1] as object,'workTokenLimit'),false,'旧省略请求保持旧规范，不偷偷补字段')
 assert.match(f.approvals[1]!,/2,000,000/)
})
