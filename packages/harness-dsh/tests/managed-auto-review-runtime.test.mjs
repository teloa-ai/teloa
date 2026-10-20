import test from 'node:test'
import assert from 'node:assert/strict'
import {createRuntime,autoReview,defineTool,createUserMessage,toolResponse,textResponse} from '../../../tests/native-auto-review-fixture.mjs'
import {registerNativeAutoReviewGuard} from '../src/native-auto-review-guard.ts'
import {registerTaskToolGuard} from '../src/task-tool-guard.ts'
import {registerManagedMcpWriteApproval} from '../src/managed-mcp-connections.ts'
import {registerSkillHttpTool,skillHttpToolName} from '../src/skill-http-tool.ts'

for(const mode of ['danger-full-access','workspace-write'])test(`生产守卫顺序：最后授权读期间切换 ${mode} 不能沿用 Auto 结果`,async t=>{
 const {ctx,adapter,create}=await createRuntime(t),agent=await create('late-permission-change-'+mode)
 await ctx.plugin(autoReview);ctx.permissionPresets.set(agent.session,'auto')
 let reads=0,bodies=0
 const read=async()=>{
  // 岗位前置与派发前复核：最后一次异步岗位读取后只能同步复核原生权限。
  if(++reads===2){await Promise.resolve();ctx.permissionPresets.set(agent.session,mode)}
  return {nativeRequestId:'review-request',allowedTools:['probe']}
 }
 ctx.tools.register(defineTool({name:'probe',description:'Synthetic fixture.',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{bodies++;return 'synthetic'}}))
 registerNativeAutoReviewGuard(ctx,async()=>({nativeRequestId:'review-request',allowedTools:['probe']}))
 registerTaskToolGuard(ctx,read)
 adapter.script.push(toolResponse('probe','late-change'),textResponse(JSON.stringify({risk:'low',decision:'allow'})),textResponse('done'))
 agent.followup(createUserMessage({source:{kind:'user',rpcId:'review-request'},content:[{type:'text',text:'Run the fixture.'}]}));await agent.whenIdle()
 assert.equal(reads,2);assert.equal(bodies,0)
 const result=agent.session.snapshotEvents().find(event=>event.type==='tool/result')
 assert.equal(result.data.message.isError,true)
 assert.match(JSON.stringify(result.data.message),/权限模式已变化/)
})

// 使用官方审核插件、Agent 循环与工具运行器；脚本化模型只验证授权协议，不代表风险识别质量。
for(const scenario of ['allow','confirm','reject','review-failed','scope-denied','arguments-denied','cancel','revoked','permission-changed','permission-lowered','tool-replaced','child','restricted-child-revoked'])test(`受管原生 Auto review 真循环：${scenario}`,async t=>{
 const {ctx,adapter,create}=await createRuntime(t),root=await create('managed-auto-root')
 const agent=scenario.includes('child')?await create('managed-auto-child',{origin:'subagent',parentSession:root.session.id,delegationDepth:1}):root
 await ctx.plugin(autoReview)
 ctx.permissionPresets.set(root.session,'auto')
 if(agent!==root){
  if(scenario==='child'){ctx.permissionPresets.set(agent.session,'auto');agent.session.append('approval/policy',{policy:'never'})}
  root.session.append('turn/start',{turn:0})
  root.session.append('user/message',createUserMessage({source:{kind:'user',rpcId:'review-request'},content:[{type:'text',text:'Write the synthetic fixture result.'}]}),{surfaceOp:'append'})
 }
 let bodies=0,asks=0,revoked=false
 const ids=[]
 const read=async id=>{ids.push(id);return {nativeRequestId:'review-request',allowedTools:scenario==='scope-denied'||revoked?[]:['mcp_write'],argumentRules:[{name:'mcp_write',allowed:[{target:'synthetic'}]}]}}
 const register=()=>ctx.tools.register(defineTool({name:'mcp_write',description:'Write only the synthetic fixture result.',parameters:{target:{type:'string'}},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{bodies++;return 'synthetic'}}))
 const removeTool=register()
 registerManagedMcpWriteApproval(ctx,name=>name==='mcp_write'?'测试连接':undefined)
 registerTaskToolGuard(ctx,read)
 registerNativeAutoReviewGuard(ctx,read)
 ctx.on('approval/request',async()=>{asks++;if(scenario==='cancel')agent.cancel();if(scenario==='revoked'||scenario==='restricted-child-revoked')revoked=true;if(scenario==='permission-changed'||scenario==='permission-lowered')ctx.permissionPresets.set(agent.session,scenario==='permission-lowered'?'workspace-write':'danger-full-access');if(scenario==='tool-replaced'){removeTool();register()}return scenario==='reject'?'rejected':'allowed-once'})
 const response=toolResponse('mcp_write','review-call'),args=JSON.stringify({target:scenario==='arguments-denied'?'outside':'synthetic'})
 response[1].argumentsDelta=args;response[2].block.arguments=args
 const needsApproval=['confirm','reject','cancel','revoked','permission-changed','permission-lowered','tool-replaced'].includes(scenario)
 adapter.script.push(response,...(scenario==='restricted-child-revoked'?[]:[textResponse(scenario==='review-failed'?'invalid review':JSON.stringify({risk:needsApproval?'medium':'low',decision:needsApproval?'deny':'allow'}))]),textResponse('done'))
 agent.followup(createUserMessage({source:{kind:'user',rpcId:'review-request'},content:[{type:'text',text:'Write the synthetic fixture result.'}]}));await agent.whenIdle()
 const results=agent.session.snapshotEvents().filter(event=>event.type==='tool/result')
 const allowed=['allow','confirm','child'].includes(scenario)
 assert.equal(bodies,allowed?1:0)
 assert.equal(asks,needsApproval||scenario==='restricted-child-revoked'?1:0)
 if(scenario!=='cancel'){assert.equal(results.length,1);assert.equal(results[0].data.message.isError,!allowed)}
 assert.ok(ids.length>0);assert.ok(ids.every(id=>id===root.session.id))
})

for(const review of ['allow','reject'])test(`受管 Auto 的技能写请求遵循原生 ${review} 审核，凭据与地址检查仍执行`,async t=>{
 const {ctx,adapter,create}=await createRuntime(t),agent=await create('managed-auto-skill-'+review)
 await ctx.plugin(autoReview);ctx.permissionPresets.set(agent.session,'auto')
 let bodies=0,asks=0
 const audit=[]
 registerSkillHttpTool(ctx,{
  skillVisible:async()=>true,readForUse:async()=>({secrets:[{envVarName:'SYNTHETIC_API_KEY',label:{'zh-CN':'合成密钥',en:'Synthetic key'},required:true,target:'bearer',endpoints:[{origin:'https://fixture.example',pathPrefixes:['/v1/']}],methods:['POST']}],values:{SYNTHETIC_API_KEY:'synthetic-key'},stale:false}),
  allow:()=>true,webPolicy:async()=>({version:1,enabled:true,blocked:[]}),audit:event=>audit.push(event),authorize:async exec=>({sessionId:exec.agent.session.id,runId:'synthetic-run',roleId:'synthetic-role'}),approvalPolicy:exec=>ctx.approval.overrideOf(exec.agent.session),
  resolve:async()=>[{address:'104.18.32.1',family:4}],request:async(_url,init)=>{assert.equal(init.headers.authorization,'Bearer synthetic-key');bodies++;return new Response('{"synthetic":true}',{status:200,headers:{'content-type':'application/json'}})},
 })
 const read=async()=>({nativeRequestId:'review-request',allowedTools:[skillHttpToolName],argumentRules:[{name:skillHttpToolName,allowed:[{skill:'synthetic-skill'}]}]})
 registerTaskToolGuard(ctx,read);registerNativeAutoReviewGuard(ctx,read)
 ctx.on('approval/request',async()=>{asks++;return 'rejected'})
 const response=toolResponse(skillHttpToolName,'skill-call'),args=JSON.stringify({skill:'synthetic-skill',method:'POST',url:'https://fixture.example/v1/result',body:'{}'})
 response[1].argumentsDelta=args;response[2].block.arguments=args
 adapter.script.push(response,textResponse(JSON.stringify({risk:review==='allow'?'low':'medium',decision:review==='allow'?'allow':'deny'})),textResponse('done'))
 agent.followup(createUserMessage({source:{kind:'user',rpcId:'review-request'},content:[{type:'text',text:'Write the synthetic result through the declared fixture endpoint.'}]}));await agent.whenIdle()
 assert.equal(bodies,review==='allow'?1:0);assert.equal(asks,review==='allow'?0:1)
 assert.ok(audit.some(event=>event.event===(review==='allow'?'skill-secret.use':'skill-secret.deny')))
 assert.doesNotMatch(JSON.stringify(audit),/synthetic-key/)
})
