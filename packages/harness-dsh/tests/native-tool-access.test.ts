import test from 'node:test'
import assert from 'node:assert/strict'
import {createRuntime,defineTool,ToolCallId} from '../../../tests/native-auto-review-fixture.mjs'
import {registerTaskToolGuard} from '../src/task-tool-guard.ts'
import {nativeBrowserToolNames,nativeComputerToolNames,nativeJobToolNames,nativeToolRules} from '../src/native-tool-access.ts'
import {validateReferenceToolRules} from '../src/role-tool-grants.ts'
import {LocalJobRegistry} from '@deepseek-ai/dsh-jobs-local'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import type {JobOutcome} from '@deepseek-ai/dsh-jobs'
import type {Context} from '@deepseek-ai/cordis'

function tool(ctx:Context,name:string,body:()=>void=()=>{}){
 return ctx.tools.register(defineTool({name,description:name,parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{body();return 'executed'}}))
}

test('受管电脑工具先过岗位规则再进入官方确认，拒绝与取消均不执行动作',async t=>{
 const {ctx,create}=await createRuntime(t),agent=await create('native-action')
 ctx.provide('computerUse',{providerName:'cua-driver-native'})
 const name='cua_driver_native__click'
 let bodies=0,asks=0,allowed=true,seq=0,outcome:'allowed-once'|'rejected'|'cancelled'='rejected'
 ctx.tools.register(defineTool({name,description:'click',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{bodies++;return 'clicked'}}))
 registerTaskToolGuard(ctx,async()=>({allowedTools:allowed?[name]:[],argumentRules:[{name,anyArguments:true,allowed:[]}]}))
 ctx.on('approval/request',async()=>{asks++;assert.equal(bodies,0,'确认前没有动作');return outcome})
 agent.session.append('turn/start',{turn:0})
 const call=()=>ctx.tools.execute({agent,name,arguments:{},callId:ToolCallId('native-action-'+ ++seq),signal:AbortSignal.timeout(5000)})
 allowed=false;assert.equal((await call()).isError,true);assert.equal(asks,0)
 allowed=true;assert.equal((await call()).isError,true);assert.equal(asks,1);assert.equal(bodies,0)
 outcome='cancelled';assert.equal((await call()).isError,true);assert.equal(asks,2);assert.equal(bodies,0)
 outcome='allowed-once';assert.equal((await call()).isError,false);assert.equal(asks,3);assert.equal(bodies,1)
})

test('候选只读已启用 provider 与已注册 scope 的精确交集，不创建 Agent',async t=>{
 const {ctx,create}=await createRuntime(t),first=await create('catalog-first'),second=await create('catalog-second')
 const browser={providerName:undefined as string|undefined},computer={providerName:undefined as string|undefined}
 ctx.provide('browserUse',browser);ctx.provide('computerUse',computer)
 const browserName='mcp__playwright-mcp__browser_click',computerName='cua_driver_native__click'
 tool(first.ctx,browserName);tool(ctx,computerName)
 for(const name of ['mcp__playwright-mcp__browser_run_code_unsafe','mcp__playwright-mcp__browser_file_upload','mcp__playwright-mcp__browser_drop','mcp__playwright-mcp__future_tool','mcp__untrusted__browser_click','cua_driver_native__install_ffmpeg','cua_driver_native__check_permissions','cua_driver_native__page','cua_driver_native__launch_app','cua_driver_native__clipboard_read','cua_driver_native__clipboard_write','bash','read','write'])tool(ctx,name)
 assert.deepEqual(nativeToolRules(ctx),[])
 browser.providerName='foreign-provider';computer.providerName='foreign-provider'
 assert.deepEqual(nativeToolRules(ctx),[])
 browser.providerName='playwright-mcp';computer.providerName='cua-driver-native'
 assert.deepEqual(nativeToolRules(ctx).map(row=>row.name),[browserName,computerName])
 assert.deepEqual(nativeToolRules(ctx,second).map(row=>row.name),[computerName])
 assert.deepEqual(nativeToolRules(ctx,first).map(row=>row.name),[browserName,computerName])
 assert.equal(ctx.agents.list().length,2)
 assert.ok(nativeToolRules(ctx).every(row=>row.anyArguments===true&&row.allowed.length===0))
 assert.doesNotThrow(()=>validateReferenceToolRules(nativeToolRules(ctx),nativeToolRules(ctx)))
 assert.throws(()=>validateReferenceToolRules(nativeToolRules(ctx),[]))
 for(const name of ['mcp__playwright-mcp__browser_run_code_unsafe','mcp__playwright-mcp__browser_file_upload','mcp__playwright-mcp__browser_drop','mcp__playwright-mcp__future_tool','cua_driver_native__page']){
  const rules=[{name,anyArguments:true as const,allowed:[]}]
  assert.throws(()=>validateReferenceToolRules(rules,rules),'行业 MCP 候选不能越过原生拒绝边界')
 }
})

test('所有可授权原生工具均需真实候选；后台控制也不能靠固定名自动获得候选',async t=>{
 const {ctx,create}=await createRuntime(t);await create('all-native')
 ctx.provide('browserUse',{providerName:'playwright-mcp'});ctx.provide('computerUse',{providerName:'cua-driver-native'})
 await ctx.plugin(LocalJobRegistry,{})
 const names=[...nativeBrowserToolNames,...nativeComputerToolNames,...nativeJobToolNames]
 assert.deepEqual(nativeToolRules(ctx),[])
 const remove=names.map(name=>tool(ctx,name))
 const rules=nativeToolRules(ctx)
 assert.deepEqual(rules.map(row=>row.name),names)
 assert.doesNotThrow(()=>validateReferenceToolRules(rules,rules))
 for(const dispose of remove)dispose()
 assert.deepEqual(nativeToolRules(ctx),[])
})

test('受管原生调用拒绝未知工具、断开 provider 与本机写出参数，普通会话保持原生行为',async t=>{
 const {ctx,create}=await createRuntime(t),agent=await create('native-boundary')
 const browser={providerName:'playwright-mcp' as string|undefined},computer={providerName:'cua-driver-native' as string|undefined}
 ctx.provide('browserUse',browser);ctx.provide('computerUse',computer)
 const browserName='mcp__playwright-mcp__browser_snapshot',computerName='cua_driver_native__get_window_state'
 const names=[browserName,computerName,'cua_driver_native__click','cua_driver_native__page','mcp__playwright-mcp__browser_run_code_unsafe']
 let bodies=0,asks=0,seq=0,managed=true,nativeDeny=false
 for(const name of names)tool(ctx,name,()=>{bodies++})
 registerTaskToolGuard(ctx,async()=>managed?{allowedTools:names,argumentRules:names.map(name=>({name,anyArguments:true,allowed:[]}))}:null)
 ctx.on('tools/pre-execute',async(_exec,next)=>nativeDeny?{kind:'deny',reason:'原生下游拒绝'}:next())
 ctx.on('approval/request',async()=>{asks++;return 'allowed-once'})
 agent.session.append('turn/start',{turn:0})
 const call=(name:string,args:Record<string,unknown>={})=>ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId('boundary-'+ ++seq),signal:AbortSignal.timeout(5000)})
 for(const [name,args] of [[browserName,{filename:'/tmp/out'}],[computerName,{screenshot_out_file:'/tmp/out'}],['cua_driver_native__click',{debug_image_out:'/tmp/out'}]] as const)assert.match(JSON.stringify(await call(name,args)),/不包含写出本机文件/)
 for(const name of ['cua_driver_native__page','mcp__playwright-mcp__browser_run_code_unsafe'])assert.equal((await call(name)).isError,true)
 browser.providerName=undefined;computer.providerName=undefined
 assert.equal((await call(browserName)).isError,true);assert.equal((await call(computerName)).isError,true)
 assert.equal(bodies,0);assert.equal(asks,0)
 browser.providerName='playwright-mcp';computer.providerName='cua-driver-native'
 nativeDeny=true;assert.match(JSON.stringify(await call(browserName)),/原生下游拒绝/);assert.equal(asks,0)
 nativeDeny=false;assert.equal((await call(browserName)).isError,false);assert.equal(bodies,1);assert.equal(asks,1)
 managed=false;assert.equal((await call(browserName,{filename:'/tmp/ordinary'})).isError,false);assert.equal(bodies,2);assert.equal(asks,1)
 assert.throws(()=>registerTaskToolGuard(ctx,async()=>null,[computerName]),/自授权/)
})

for(const change of ['disconnect','unregister','replace','abort'] as const)test(`原生确认等待期间 ${change} 不执行已捕获动作`,async t=>{
 const {ctx,create}=await createRuntime(t),agent=await create('native-pending-'+change),provider={providerName:'cua-driver-native' as string|undefined}
 ctx.provide('computerUse',provider)
 const name='cua_driver_native__click';let bodies=0
 const remove=tool(ctx,name,()=>{bodies++})
 registerTaskToolGuard(ctx,async()=>({allowedTools:[name]}))
 let answer!:(value:'allowed-once')=>void,asked!:()=>void
 const ready=new Promise<void>(resolve=>{asked=resolve})
 ctx.on('approval/request',async()=>{asked();return new Promise<'allowed-once'>(resolve=>{answer=resolve})})
 agent.session.append('turn/start',{turn:0})
 const abort=new AbortController()
 const pending=ctx.tools.execute({agent,name,arguments:{},callId:ToolCallId('pending'),signal:abort.signal})
 await ready;assert.equal(bodies,0)
 if(change==='disconnect')provider.providerName=undefined
 if(change==='unregister'||change==='replace')remove()
 if(change==='replace')tool(ctx,name,()=>{bodies++})
 if(change==='abort')abort.abort()
 answer('allowed-once')
 assert.equal((await pending).isError,true);assert.equal(bodies,0)
})

test('官方后台工具保持 owner 隔离，显式岗位授权不扩大到另一会话或启动工具',async t=>{
 const {ctx,create}=await createRuntime(t),owner=await create('jobs-owner'),foreign=await create('jobs-foreign')
 await ctx.plugin(LocalJobRegistry,{})
 await ctx.plugin(ToolJobs,ToolJobs.Config({completionDelivery:'quiet'}))
 const finishes:Array<(outcome:JobOutcome)=>void>=[];let cancels=0,seq=0,allowed=true
 t.after(()=>{for(const finish of finishes)finish({status:'killed'})})
 const start=(agent:typeof owner)=>ctx.jobs.start({kind:'bash',label:'test controlled job',owner:agent.session.id,run:()=>{
  let finish!:(outcome:JobOutcome)=>void
  const done=new Promise<JobOutcome>(resolve=>{finish=resolve;finishes.push(resolve)})
  return {done,cancel:()=>{cancels++;finish({status:'killed'})}}
 }})
 const ownId=start(owner),foreignId=start(foreign)
 registerTaskToolGuard(ctx,async()=>({allowedTools:allowed?[...nativeJobToolNames]:[],argumentRules:nativeJobToolNames.map(name=>({name,anyArguments:true,allowed:[]}))}))
 assert.deepEqual(nativeToolRules(ctx,owner).map(row=>row.name),[...nativeJobToolNames])
 const call=(name:string,args:Record<string,unknown>={})=>ctx.tools.execute({agent:owner,name,arguments:args,callId:ToolCallId('jobs-'+ ++seq),signal:AbortSignal.timeout(5000)})
 allowed=false;assert.equal((await call('job_list')).isError,true);allowed=true
 const listed=await call('job_list');assert.equal(listed.isError,false)
 assert.match(JSON.stringify(listed),new RegExp(ownId));assert.doesNotMatch(JSON.stringify(listed),new RegExp(foreignId))
 assert.equal((await call('job_output',{job_id:foreignId})).isError,true)
 assert.equal((await call('job_kill',{job_id:foreignId})).isError,true);assert.equal(cancels,0)
 assert.equal((await call('job_output',{job_id:ownId})).isError,false)
 assert.equal((await call('job_kill',{job_id:ownId})).isError,false);assert.equal(cancels,1)
 assert.equal(ctx.jobs.get(foreignId,foreign.session.id).status,'running')
})
