import test from 'node:test'
import assert from 'node:assert/strict'
import {createRuntime,official,defineTool,toolResponse,textResponse,createUserMessage} from '../../../tests/native-auto-review-fixture.mjs'
import * as WorkBehavior from '../src/work-behavior.ts'
import {dshTaskRunPorts,restrictRunTools} from '../src/task-run-dsh.ts'
import {leaseEmployeeSystemPrompt} from '../src/employee-system-prompt.ts'

test('真实TaskRun拒绝后的selected core区分缺失权限与已拒绝决策，不替换原生工具或永久撤权',async t=>{
 const {ctx,adapter,create}=await createRuntime(t),agent=await create('denial-behavior-run')
 await agent.ctx.plugin(WorkBehavior,{})
 let bodies=0,decision='rejected'
 ctx.tools.register(defineTool({name:'authorized_probe',description:'审批后读取合成资料',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},async execute(_args,exec){
  const outcome=await ctx.approval.request({agent:exec.agent,toolName:'authorized_probe',callId:exec.callId})
  if(outcome!=='allowed-once')throw Error('approval rejected')
  bodies++;return 'approved fixture'
 }}))
 ctx.on('approval/request',async()=> decision)
 const before=ctx.tools.schemas(agent),run={id:'denial-run',sessionId:String(agent.session.id),nativeRequestId:'denial-input'}
 const ports=dshTaskRunPorts(ctx,'owner',async()=>({ownerId:'owner',sessionId:run.sessionId,status:'ready'}))
 ports.ensureModels(agent,run)
 t.after(restrictRunTools(agent,['authorized_probe'],{group:false,digest:false}))
 t.after(leaseEmployeeSystemPrompt(agent,'employee'))
 adapter.script.push(toolResponse('authorized_probe','declined-call'),textResponse('fixture final response'))
 agent.followup(createUserMessage({source:{kind:'user',rpcId:run.nativeRequestId},content:[{type:'text',text:'Perform the authorized operation once.'}]}));await agent.whenIdle()
 assert.equal(adapter.requests.length,2);assert.equal(bodies,0)
 const second=adapter.requests[1],system=second.messages.filter(message=>message.role==='system').flatMap(message=>message.content.filter(part=>part.type==='text').map(part=>part.text)).join('\n'),wire=JSON.stringify(second.messages)
 assert.match(system,/If permission is missing or unavailable, rather than an operation having been rejected or cancelled/)
 assert.match(system,/including conditional invitations to make a new request/)
 assert.match(system,/For the stopped operation, report only its actual state unless the user asks for next steps/)
 assert.match(system,/Treat any later explicit owner instruction as new input to assess through the normal approval flow/)
 assert.match(system,/this internal handling rule is not a suggestion to make that input/)
 assert.match(system,/Continue unrelated, independently authorized help/)
 assert.doesNotMatch(system,/After a permission denial, perform at most one/)
 assert.match(wire,/rejected/);assert.match(wire,/\\"requested\\":1/)
 const events=agent.session.snapshotEvents();assert.equal(events.filter(e=>e.type==='tool/call').length,1);assert.equal(events.filter(e=>e.type==='approval/decided'&&e.data.outcome==='rejected').length,1)
 assert.deepEqual(second.tools.find(tool=>tool.name==='authorized_probe'),before.find(tool=>tool.name==='authorized_probe'),'规则修正不修改真实工具schema')
 assert.ok(ctx.tools.get('authorized_probe',agent),'拒绝未永久撤销工具定义')
 // 后来的明确指令走独立新Run的正常审批；不复用被拒调用或篡改工具输出。
 const later=await create('explicit-new-owner-run');await later.ctx.plugin(WorkBehavior,{})
 const laterRun={id:'new-authorized-run',sessionId:String(later.session.id),nativeRequestId:'new-owner-input'};ports.ensureModels(later,laterRun)
 t.after(restrictRunTools(later,['authorized_probe'],{group:false,digest:false}));t.after(leaseEmployeeSystemPrompt(later,'employee'));decision='allowed-once'
 adapter.script.push(toolResponse('authorized_probe','explicit-new-call'),textResponse('new operation fixture response'))
 later.followup(createUserMessage({source:{kind:'user',rpcId:laterRun.nativeRequestId},content:[{type:'text',text:'Perform a new authorized operation.'}]}));await later.whenIdle()
 assert.equal(bodies,1);assert.equal(adapter.requests.length,4)
 const laterEvents=later.session.snapshotEvents();assert.equal(laterEvents.filter(e=>e.type==='approval/decided'&&e.data.outcome==='allowed-once').length,1);assert.equal(laterEvents.filter(e=>e.type==='tool/result'&&!e.data.message.isError).length,1)
 assert.equal(agent.session.snapshotEvents().filter(e=>e.type==='approval/decided'&&e.data.outcome==='rejected').length,1,'原拒绝事实仍保留')
})
