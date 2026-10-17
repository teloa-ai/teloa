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
import {WorkError,groupWorkLinksChangeInput,type Group,type GroupWorkLink,type GroupWorkLinkItem,type GroupWorkLinks} from '@teloa/contract'
import {createGroupWorkLinkHandler} from '../src/group-work-links.ts'
import {registerGroupWorkLinkTools,groupWorkLinkToolNames,type GroupWorkLinkToolsPorts} from '../src/group-work-link-tools.ts'
type Ports=GroupWorkLinkToolsPorts
const owner='owner',id='11111111-1111-4111-8111-111111111111',now='2026-10-12T00:00:00.000Z'
const group:Group={id,ownerId:owner,version:3,name:'联合处置群',scope:'general',announcement:'跟进原工作',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},pinned:false,archived:false,createdAt:now,updatedAt:now}
const labels={items:[{scope:'general',title:'通用工作',kind:'builtin',loads:0,activeLoads:0,tasks:1,groups:1},{scope:'SOC',title:'安全运营',kind:'builtin',loads:0,activeLoads:0,tasks:1,groups:0}]}
const links:GroupWorkLink[]=[{kind:'business',scope:'SOC',type:'case',id:'INC-101'},{kind:'project',scope:'general',id:'22222222-2222-4222-8222-222222222222'},{kind:'task',scope:'SOC',id:'33333333-3333-4333-8333-333333333333'}]
const item=(link:GroupWorkLink):GroupWorkLinkItem=>({...link,available:true,title:link.kind==='business'?'案件 INC-101':link.kind==='project'?'发布项目':'证据核对',state:'ready',objectVersion:2})
async function setup(overrides:Partial<Ports>={},options:{instructions?:number;subagent?:boolean}={}){
 const ctx=new Context();for(const plugin of [LlmRuntime,SystemPrompt,ToolRuntime,SessionStore,SessionProjectionRegistry,AgentRegistry])await ctx.plugin(plugin);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('group-work-session'),...(options.subagent?{meta:{origin:'subagent' as const,delegationDepth:1}}:{}),agentOptions:{provider:'test',model:'test'}})
 agent.session.append('turn/start',{turn:1});for(let i=0;i<(options.instructions??1);i++)agent.session.append('user/message',createUserMessage({source:{kind:'user',rpcId:'original'},content:[{type:'text',text:'把案件、项目和证据核对关联到联合处置群'}]}),{surfaceOp:'append'})
 let current:GroupWorkLinks={groupId:id,groupVersion:3,version:0,items:[]}
 const writes:any[]=[],receipts=new Map<string,{request:string;result:GroupWorkLinks}>()
 const service={get:async()=>current,candidates:async(_owner:string,input:any)=>links.filter(link=>link.scope===input.scope&&link.kind===input.kind).map(item),change:async(_owner:string,input:unknown,signal?:AbortSignal,revalidate?:()=>Promise<void>)=>{
  assert.equal(_owner,owner);const row=groupWorkLinksChangeInput(input);await revalidate?.();signal?.throwIfAborted()
  const prior=receipts.get(row.requestId);if(prior){if(prior.request!==JSON.stringify(row))throw new WorkError('teloa/conflict','请求内容已变化');return prior.result}
  if(row.expectedGroupVersion!==3||row.expectedVersion!==current.version)throw new WorkError('teloa/version-conflict','原群或关联版本已变化')
  writes.push(row);current={groupId:id,groupVersion:3,version:current.version+1,items:row.links.map(item)};receipts.set(row.requestId,{request:JSON.stringify(row),result:current});return current
 }}
 const route=createGroupWorkLinkHandler(owner,async()=>service)
 const ports:Ports={owner,conversation:async sessionId=>({ownerId:owner,sessionId,status:'ready'}),readTaskPolicy:async()=>null,groups:async()=>[group],scopes:async()=>labels,admitText:()=>{},route,...overrides}
 registerGroupWorkLinkTools(ctx,ports)
 const call=(name:string,args:Record<string,unknown>={},callId='call',signal=AbortSignal.timeout(5000))=>ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId(callId),signal})
 return {ctx,agent,call,ports,writes,receipts,current:()=>current,setCurrent:(value:GroupWorkLinks)=>{current=value}}
}
const json=(result:any)=>JSON.parse(result.content.filter((item:any)=>item.type==='text').map((item:any)=>item.text).join('\n'))
const save={groupId:id,expectedGroupVersion:3,expectedVersion:0,links}

test('群目录提供真实群名与业务显示名，读取关联和候选均复用原群，跨业务关联无隐含授权',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 assert.deepEqual(e.ctx.tools.schemas(e.agent).filter(row=>row.name.startsWith('teloa_group_work_')).map(row=>row.name),[...groupWorkLinkToolNames])
 const directory=await e.call('teloa_group_work_directory');assert.equal(directory.isError,false);assert.equal(json(directory).groups[0].name,group.name);assert.equal(json(directory).scopes[1].title,'安全运营')
 const initial=await e.call('teloa_group_work_get',{groupId:id});assert.equal(initial.isError,false);assert.equal(json(initial).workLinks.version,0)
 for(const link of links){const result=await e.call('teloa_group_work_candidates',{groupId:id,scope:link.scope,kind:link.kind,query:link.kind==='business'?'INC-101':''});assert.equal(result.isError,false);assert.equal(json(result).items[0].id,link.id)}
 const saved=await e.call('teloa_group_work_change',save);assert.equal(saved.isError,false,JSON.stringify(saved));assert.equal(json(saved).schema,'teloa.group-result/v1');assert.equal(json(saved).groupId,id);assert.equal(json(saved).group.ownerId,owner);assert.equal(json(saved).sessionId,e.agent.session.id);assert.equal(json(saved).workLinks.items.length,3)
 assert.equal('ownerId' in e.writes[0],false);assert.equal('sessionId' in e.writes[0],false);assert.equal('grant' in e.writes[0],false)
 for(const name of ['teloa_group_work_send','teloa_group_work_execute','teloa_group_work_grant'])assert.equal((await e.call(name)).isError,true)
})

test('原请求重放复用持久回执；完整集合保存可追加与解除原关联，不动原对象',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 for(let i=0;i<2;i++)assert.equal((await e.call('teloa_group_work_change',{...save,links:[links[0]]},'first')).isError,false)
 assert.equal(e.writes.length,1);assert.equal(e.current().version,1)
 assert.equal((await e.call('teloa_group_work_change',{...save,expectedVersion:1},'append')).isError,false)
 assert.equal((await e.call('teloa_group_work_change',{...save,expectedVersion:2,links:[links[1]]},'remove')).isError,false)
 assert.equal(e.current().items.length,1);const remaining=e.current().items[0];assert.ok(remaining);assert.equal(remaining.kind,'project')
 assert.equal((await e.call('teloa_group_work_change',{...save,links:[links[0]]},'first')).isError,false)
 assert.equal(e.current().version,3)
 assert.equal((await e.call('teloa_group_work_change',save,'first')).isError,true)
})

test('严守归属与参数：外本人群、未登记业务、未知或重复关系、身份注入不写',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 for(const args of [{...save,ownerId:'other'},{...save,sessionId:'other'},{...save,requestId:id},{...save,expectedVersion:-1},{...save,links:[links[0],links[0]]},{...save,links:[{...links[0],scope:'Unknown'}]},{...save,links:[{kind:'task',scope:'SOC',id:'INC-101'}]},{...save,links:[{...links[0],canRead:true}]}])assert.equal((await e.call('teloa_group_work_change',args)).isError,true)
 assert.equal(e.writes.length,0)
 const foreign=await setup({groups:async()=>[{...group,ownerId:'other'}]});t.after(()=>foreign.ctx.fiber.dispose());assert.equal((await foreign.call('teloa_group_work_get',{groupId:id})).isError,true)
 const leaked=await setup({route:async()=>[item({...links[0],scope:'Other'} as GroupWorkLink)]});t.after(()=>leaked.ctx.fiber.dispose());assert.equal((await leaked.call('teloa_group_work_candidates',{groupId:id,scope:'SOC',kind:'business',query:''})).isError,true)
})

test('受管任务、搭建、pending、子代理及非唯一当前指令不能保存；审批期间关联变化不覆盖',async t=>{
 const cases:Array<{ports?:Partial<Ports>;options?:Parameters<typeof setup>[1]}>=
  [{options:{subagent:true}},{options:{instructions:0}},{options:{instructions:2}},{ports:{conversation:async sessionId=>({ownerId:'other',sessionId,status:'ready'})}},{ports:{readTaskPolicy:async()=>({allowedTools:[]})}},{ports:{isTaskConversation:async()=>true}},{ports:{isBuilder:async()=>true}},{ports:{isPendingDaily:async()=>true}}]
 for(const c of cases){const e=await setup(c.ports,c.options);t.after(()=>e.ctx.fiber.dispose());assert.equal((await e.call('teloa_group_work_change',save)).isError,true);assert.equal(e.writes.length,0)}
 const race=await setup();t.after(()=>race.ctx.fiber.dispose());race.ctx.on('tools/pre-execute',async(exec,next)=>{if(exec.name==='teloa_group_work_change')race.setCurrent({groupId:id,groupVersion:3,version:1,items:[item(links[1]!)]});return next()});assert.equal((await race.call('teloa_group_work_change',save)).isError,true);assert.equal(race.writes.length,0)
})

for(const reason of ['instruction','cancel'] as const)test(`最终保存等待期间${reason}，提交前复核仍拒绝写入`,async t=>{
 let entered!:()=>void,release!:()=>void,writes=0
 const waiting=new Promise<void>(resolve=>{entered=resolve}),released=new Promise<void>(resolve=>{release=resolve})
 let e:Awaited<ReturnType<typeof setup>>
 e=await setup({route:async(endpoint,payload,signal,revalidate)=>{if(endpoint!=='groups/work/change')return {groupId:id,groupVersion:3,version:0,items:[]};entered();await released;await revalidate?.();signal?.throwIfAborted();writes++;return {groupId:id,groupVersion:3,version:1,items:links.map(item)}}});t.after(()=>e.ctx.fiber.dispose())
 const cancel=new AbortController(),pending=e.call('teloa_group_work_change',save,'waiting',cancel.signal);await waiting
 if(reason==='cancel')cancel.abort();else{e.agent.session.append('turn/start',{turn:2});e.agent.session.append('user/message',createUserMessage({source:{kind:'user',rpcId:'new'},content:[{type:'text',text:'先停止保存'}]}),{surfaceOp:'append'})}
 release();assert.equal((await pending).isError,true);assert.equal(writes,0)
})

for(const phase of ['review','approval'])test(`原生 Auto ${phase} 等待期间换指令，群关联旧参数不写`,async t=>{
 const fixture=await import('../../../tests/native-auto-review-fixture.mjs') as any
 const {ctx,adapter,create}=await fixture.createRuntime(t),agent=await create('group-work-auto-'+phase)
 await ctx.plugin(fixture.autoReview);ctx.permissionPresets.set(agent.session,'auto')
 let entered!:()=>void,release!:()=>void,writes=0
 const waiting=new Promise<void>(resolve=>{entered=resolve}),released=new Promise<void>(resolve=>{release=resolve})
 registerGroupWorkLinkTools(ctx,{owner,conversation:async sessionId=>({ownerId:owner,sessionId,status:'ready'}),readTaskPolicy:async()=>null,groups:async()=>[group],scopes:async()=>labels,admitText:()=>{},route:async(endpoint)=>{if(endpoint==='groups/work/change')writes++;return {groupId:id,groupVersion:3,version:0,items:[]}}})
 const call=fixture.toolResponse('teloa_group_work_change','old-call'),body=JSON.stringify(save);call[1].argumentsDelta=body;call[2].block.arguments=body
 if(phase==='approval')ctx.on('approval/request',async()=>{entered();await released;return 'allowed-once'})
 const review=phase==='review'?(async function*(){entered();await released;yield* fixture.textResponse(JSON.stringify({risk:'low',decision:'allow'}))})():fixture.textResponse(JSON.stringify({risk:'medium',decision:'deny'}))
 adapter.script.push(call,review,fixture.textResponse('done'))
 agent.followup(fixture.createUserMessage({source:{kind:'user',rpcId:'old-turn'},content:[{type:'text',text:'关联联合处置群的工作'}]}))
 const idle=agent.whenIdle();await waiting
 agent.session.append('turn/start',{turn:2});agent.session.append('user/message',fixture.createUserMessage({source:{kind:'user',rpcId:'new-turn'},content:[{type:'text',text:'先停止关联修改'}]}),{surfaceOp:'append'})
 release();await idle
 assert.equal(writes,0)
 const result=agent.session.snapshotEvents().find((event:any)=>event.type==='tool/result');assert.equal(result?.data.message.isError,true)
})
