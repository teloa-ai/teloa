import test from 'node:test'
import assert from 'node:assert/strict'
import {createRuntime,official,defineTool,toolResponse,textResponse,createUserMessage} from '../../../tests/native-auto-review-fixture.mjs'
import * as WorkBehavior from '../src/work-behavior.ts'
import {dshTaskRunPorts,restrictRunTools} from '../src/task-run-dsh.ts'
import {leaseEmployeeSystemPrompt} from '../src/employee-system-prompt.ts'

test('真实TaskRun拒绝后的selected core区分缺失权限与已拒绝决策，不替换原生工具或永久撤权',async t=>{
 const {ctx,adapter,create}=await createRuntime(t),agent=await create('denial-behavior-run')
 await agent.ctx.plugin(WorkBehavior,{})
 let bodies=0
 ctx.tools.register(defineTool({name:'authorized_probe',description:'审批后读取合成资料',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},async execute(_args,exec){
  const outcome=await ctx.approval.request({agent,toolName:'authorized_probe',callId:exec.callId})
  if(outcome!=='allowed-once')throw Error('approval rejected')
  bodies++;return 'approved fixture'
 }}))
 ctx.on('approval/request',async()=> 'rejected')
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
 assert.match(system,/Do not proactively suggest reopening or reauthorizing the same operation/)
 assert.match(system,/A later explicit owner request may initiate it through the normal approval flow/)
 assert.match(system,/Continue unrelated, independently authorized help/)
 assert.doesNotMatch(system,/After a permission denial, perform at most one/)
 assert.match(wire,/rejected/);assert.match(wire,/\\"requested\\":1/)
 const events=agent.session.snapshotEvents();assert.equal(events.filter(e=>e.type==='tool/call').length,1);assert.equal(events.filter(e=>e.type==='approval/decided'&&e.data.outcome==='rejected').length,1)
 assert.deepEqual(second.tools.find(tool=>tool.name==='authorized_probe'),before.find(tool=>tool.name==='authorized_probe'),'规则修正不修改真实工具schema')
 assert.ok(ctx.tools.get('authorized_probe',agent),'拒绝未永久撤销工具定义')
})
