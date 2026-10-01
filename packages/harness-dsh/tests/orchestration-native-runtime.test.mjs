import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createRuntime,official,autoReview,defineTool,createUserMessage,toolResponse,textResponse} from '../../../tests/native-auto-review-fixture.mjs'
import {registerTaskToolGuard} from '../src/task-tool-guard.ts'
import {createTaskRunOrchestration} from '../src/task-run-orchestration.ts'

async function mountPtc(ctx){
 for(const name of ['dsh-subprocess-local','dsh-sandbox-local','dsh-fs-sandbox','dsh-ptc-runtime-node']){
  const module=await official(name)
  await ctx.plugin(module.default??module,{})
 }
}
function response(name,args={}){
 const chunks=toolResponse(name,'review-call'),serialized=JSON.stringify(args)
 chunks[1].argumentsDelta=serialized;chunks[2].block.arguments=serialized
 return chunks
}
const input=()=>createUserMessage({source:{kind:'user',rpcId:'review-request'},content:[{type:'text',text:'Read the synthetic review value.'}]})

for(const managed of [false,true])test(`官方 Node PTC 真循环：${managed?'受管':'本人'}脚本经逐次审批后调用获准工具`,async t=>{
 const {ctx,adapter,create}=await createRuntime(t)
 await mountPtc(ctx)
 const agent=await create('review-ptc-'+managed);agent.ctx.tools.presentAs('ptc')
 assert.ok(ctx.tools.get('run_code',agent),'PTC reserved transport 必须能从当前 agent 视图取得')
 let asks=0,bodies=0
 ctx.tools.register(defineTool({name:'read_allowed',description:'Read only a synthetic review value.',parameters:{key:{type:'string'}},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{bodies++;return 'synthetic'}}))
 registerTaskToolGuard(ctx,async()=>managed?{nativeRequestId:'review-request',allowedTools:['run_code','read_allowed'],argumentRules:[{name:'run_code',anyArguments:true,allowed:[]},{name:'read_allowed',allowed:[{key:'yes'}]}]}:null)
 ctx.on('approval/request',async()=>{asks++;return 'allowed-once'})
 adapter.script.push(response('run_code',{code:'return await tools.read_allowed({key:"yes"})',description:'synthetic PTC review'}),textResponse('done'))
 agent.followup(input());await agent.whenIdle()
 const results=agent.session.snapshotEvents().filter(event=>event.type==='tool/result')
 assert.equal(asks,1);assert.equal(bodies,1)
 assert.equal(results.length,1);assert.equal(results[0].data.message.isError,false)
 assert.match(JSON.stringify(results[0]),/synthetic/)
})

for(const deniedBy of ['tool','arguments'])test(`获准 PTC 脚本内部仍执行岗位 ${deniedBy} 范围校验`,async t=>{
 const {ctx,adapter,create}=await createRuntime(t)
 await mountPtc(ctx)
 const agent=await create('review-ptc-denied-'+deniedBy);agent.ctx.tools.presentAs('ptc')
 let asks=0,bodies=0
 ctx.tools.register(defineTool({name:'read_allowed',description:'Read only a synthetic review value.',parameters:{key:{type:'string'}},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{bodies++;return 'synthetic'}}))
 registerTaskToolGuard(ctx,async()=>({nativeRequestId:'review-request',allowedTools:deniedBy==='tool'?['run_code']:['run_code','read_allowed'],argumentRules:[{name:'run_code',anyArguments:true,allowed:[]},{name:'read_allowed',allowed:[{key:'yes'}]}]}))
 ctx.on('approval/request',async()=>{asks++;return 'allowed-once'})
 adapter.script.push(response('run_code',{code:'return await tools.read_allowed({key:"no"})',description:'synthetic denied PTC review'}),textResponse('done'))
 agent.followup(input());await agent.whenIdle()
 assert.equal(asks,1);assert.equal(bodies,0)
 assert.match(JSON.stringify(agent.session.snapshotEvents().filter(event=>event.type==='tool/result')),deniedBy==='tool'?/未授权/:/超出/)
})

test('官方 Ralph 真循环使用受管 fresh child 并接收专属结构化报告',async t=>{
 const {ctx,adapter,create}=await createRuntime(t),directory=await mkdtemp(join(tmpdir(),'teloa-review-ralph-'))
 t.after(()=>rm(directory,{recursive:true,force:true}))
 for(const [name,config] of [
  ['dsh-session-persistence-jsonl',{root:directory,compression:'none'}],['dsh-jobs-local',{}],
  ['dsh-subagent',{maxDepth:1,maxActiveSubagents:6}],['dsh-subagent-spawn-in-process',{providerName:'spawn'}],
 ]){const module=await official(name);await ctx.plugin(module.default??module,config)}
 await mountPtc(ctx)
 await ctx.plugin((await official('dsh-workflow-ptc')).default,{provider:'teloa-workflow-spawn'})
 ctx.jobs.attachController('review')
 const agent=await create('review-ralph'),rows=new Map(),calls=[]
 const links={list:async input=>[...rows.values()].filter(row=>row.runId===input.runId&&(!input.kind||input.kind===row.kind)),put:async row=>{rows.set(row.kind+':'+row.nativeId,structuredClone(row))}}
 const delegation={limits:{maxDepth:1,maxPerRun:6},runId:async()=> 'review-run',...Object.fromEntries(['reserve','release','bind','settle','abandon'].map(name=>[name,async input=>{calls.push({name,input})}]))}
 const read=async()=>({nativeRequestId:'review-request',allowedTools:['ralph'],argumentRules:[{name:'ralph',anyArguments:true,allowed:[]}]})
 const orchestration=createTaskRunOrchestration(ctx,delegation,read,links);t.after(()=>orchestration.dispose())
 registerTaskToolGuard(ctx,read,[],undefined,delegation,undefined,undefined,undefined,orchestration)
 await ctx.plugin(await official('dsh-tool-ralph'),{subagentProvider:'teloa-workflow-spawn',maxRounds:6})
 let asks=0;ctx.on('approval/request',async()=>{asks++;return 'allowed-once'})
 adapter.script.push(response('ralph',{objective:'Direct human explicitly asks for a synthetic Ralph test.',maxRounds:1}),response('structured_output',{status:'complete',summary:'Review complete',evidence:['Synthetic evidence'],nextSteps:[],blocker:''}),textResponse('done'))
 agent.followup(createUserMessage({source:{kind:'user',rpcId:'review-request'},content:[{type:'text',text:'Use Ralph to report synthetic review evidence.'}]}));await agent.whenIdle()
 const results=agent.session.snapshotEvents().filter(event=>event.type==='tool/result')
 assert.equal(asks,1);assert.equal(results.length,1);assert.equal(results[0].data.message.isError,false)
 assert.match(JSON.stringify(results[0]),/reported completion after 1 round/)
 assert.equal(calls.filter(call=>call.name==='bind').length,1);assert.equal(calls.filter(call=>call.name==='settle').length,1)
 assert.deepEqual(calls.find(call=>call.name==='reserve').input.limit,6)
 assert.deepEqual(calls.find(call=>call.name==='bind').input.depth,1)
})

for(const permission of ['auto','danger-full-access'])for(const name of ['run_code','workflow','ralph'])test(`本人 ${permission} 的 ${name} 明确提示人工确认模式，不误报本人拒绝`,async t=>{
 const {ctx,adapter,create}=await createRuntime(t),agent=await create('review-'+permission+'-'+name)
 let bodies=0,asks=0
 if(name==='run_code'){await mountPtc(ctx);agent.ctx.tools.presentAs('ptc')}
 else ctx.tools.register(defineTool({name,description:'Run a synthetic review action.',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{bodies++;return 'synthetic'}}))
 registerTaskToolGuard(ctx,async()=>null)
 await ctx.plugin(autoReview)
 ctx.permissionPresets.set(agent.session,permission)
 assert.equal(ctx.approval.overrideOf(agent.session)??ctx.approval.config.policy??'ask','never','只使用官方公开审批读口')
 ctx.on('approval/request',async()=>{asks++;return 'allowed-once'})
 adapter.script.push(response(name,name==='run_code'?{code:'return 42',description:'synthetic PTC review'}:{}),...(permission==='auto'&&name!=='run_code'?[textResponse('{"risk":"low","decision":"allow"}')]:[]),textResponse('done'))
 agent.followup(input());await agent.whenIdle()
 const results=agent.session.snapshotEvents().filter(event=>event.type==='tool/result')
 assert.equal(asks,0);assert.equal(bodies,0)
 assert.equal(results.length,1);assert.equal(results[0].data.message.isError,true)
 assert.match(JSON.stringify(results[0]),/切换.*人工确认/)
 assert.doesNotMatch(JSON.stringify(results[0]),/user rejected/)
})
