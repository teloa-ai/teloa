import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId,createUserMessage} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {WorkError,encodeBusinessRecordReference} from '@teloa/contract'
import {registerConversationWorkTools,type ConversationWorkToolsPorts} from '../src/conversation-work-tools.ts'
const owner='owner',roleId='22222222-2222-4222-8222-222222222222'
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
  assert.match(description,/原生确认卡/,name)
  assert.match(description,/批准前不创建/,name)
  assert.match(description,/不要用聊天询问代替/,name)
 }
 const messages=[createUserMessage({source:{kind:'user'},content:[{type:'text',text:'请交给调查员核对，等我批准'}]})]
 const decision=await f.ctx.waterfall('agent/pre-step',{agent:f.agent,messages,turn:1,step:1,signal:new AbortController().signal},async()=>({kind:'enter' as const,messages})) as unknown as {messages:Array<{content:ReadonlyArray<{type:string;text?:string}>}>}
 const notice=decision.messages.at(-1)!.content.map(block=>block.text??'').join('')
 assert.match(notice,/调用.*teloa_work_dispatch.*原生确认卡/)
 assert.match(notice,/不要用聊天询问代替/)
 let entered!:()=>void,release!:()=>void
 const approvalEntered=new Promise<void>(resolve=>{entered=resolve}),approvalReleased=new Promise<void>(resolve=>{release=resolve})
 f.approve(async()=>{entered();await approvalReleased;return 'allowed-once'})
 const pending=f.call('teloa_work_dispatch',{scope:'SOC',title:'核对告警',goal:'只读核对',roleId,expectedRoleVersion:1})
 await approvalEntered
 assert.equal(f.dispatched.length,0)
 release()
 assert.equal((await pending).isError,false)
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
 const result=await f.call('teloa_work_dispatch',{...args,reference});assert.equal(result.isError,true);assert.equal(f.dispatched.length,0);assert.match(f.approvals[0]!,/customer-a/);assert.match(f.approvals[0]!,/aaaaaaaa/)
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
 assert.equal((await f.call('teloa_work_dispatch',args)).isError,false);assert.match(f.approvals[0]!,/"singleOverride":true/);assert.match(f.approvals[0]!,/paused/)
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
