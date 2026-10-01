import test from 'node:test'
import assert from 'node:assert/strict'
import {createRuntime,defineTool,ToolCallId} from '../../../tests/native-auto-review-fixture.mjs'
import {registerTaskToolGuard} from '../src/task-tool-guard.ts'

for(const name of ['workflow','ralph'])test(`${name} 岗位授权不能代替逐次确认，本人会话也要确认`,async t=>{
 const {ctx,create}=await createRuntime(t),agent=await create('orchestration-'+name)
 let bodies=0,asks=0,managed=true,granted=false,outcome:'allowed-once'|'rejected'='rejected'
 ctx.tools.register(defineTool({name,description:name,parameters:{},output:{schema:{type:'string'},render:(_args,v)=>[{type:'text',text:v}]},execute:async()=>{bodies++;return 'ok'}}))
 const orchestration={authorizeChild:async()=>false,ownsStructuredOutput:()=>false}
 registerTaskToolGuard(ctx,async()=>managed?{allowedTools:granted?[name]:[]}:null,[],undefined,undefined,undefined,undefined,undefined,orchestration)
 ctx.on('approval/request',async()=>{asks++;return outcome})
 agent.session.append('turn/start',{turn:0})
 let seq=0
 const call=()=>ctx.tools.execute({agent,name,arguments:{},callId:ToolCallId(name+ ++seq),signal:AbortSignal.timeout(5000)})
 assert.equal((await call()).isError,true);assert.equal(asks,0)
 granted=true;assert.equal((await call()).isError,true);assert.equal(asks,1);assert.equal(bodies,0)
 outcome='allowed-once';assert.equal((await call()).isError,false);assert.equal(bodies,1);assert.equal(asks,2)
 managed=false;assert.equal((await call()).isError,false);assert.equal(bodies,2);assert.equal(asks,3)
})

for(const change of ['stop','revoke','unmanage','replace'] as const)test(`编排确认期间 ${change} 后不执行动作`,async t=>{
 const {ctx,create}=await createRuntime(t),agent=await create('pending-orchestration-'+change)
 let bodies=0,managed=true,granted=true,stop=false
 const register=()=>ctx.tools.register(defineTool({name:'workflow',description:'workflow',parameters:{},output:{schema:{type:'string'},render:(_args,v)=>[{type:'text',text:v}]},execute:async()=>{bodies++;return 'ok'}}))
 const remove=register()
 registerTaskToolGuard(ctx,async()=>managed?{allowedTools:granted?['workflow']:[],stopRequested:stop}:null,[],undefined,undefined,undefined,undefined,undefined,{authorizeChild:async()=>false,ownsStructuredOutput:()=>false})
 let answer!:(v:'allowed-once')=>void,asked!:()=>void
 const ready=new Promise<void>(resolve=>{asked=resolve})
 ctx.on('approval/request',async()=>{asked();return new Promise<'allowed-once'>(resolve=>{answer=resolve})})
 agent.session.append('turn/start',{turn:0})
 const pending=ctx.tools.execute({agent,name:'workflow',arguments:{},callId:ToolCallId('pending'),signal:AbortSignal.timeout(5000)})
 await ready
 if(change==='stop')stop=true
 if(change==='revoke')granted=false
 if(change==='unmanage')managed=false
 if(change==='replace'){remove();register()}
 answer('allowed-once');assert.equal((await pending).isError,true);assert.equal(bodies,0)
})

test('受管执行不能借伪造授权修改宿主插件；workflow 无适配器不得执行',async t=>{
 const {ctx,create}=await createRuntime(t),agent=await create('managed-plugin-denied')
 let bodies=0
 for(const name of ['plugin_manager','workflow'])ctx.tools.register(defineTool({name,description:name,parameters:{},output:{schema:{type:'string'},render:(_args,v)=>[{type:'text',text:v}]},execute:async()=>{bodies++;return 'ok'}}))
 registerTaskToolGuard(ctx,async()=>({allowedTools:['plugin_manager','workflow']}))
 ctx.on('approval/request',async()=> 'allowed-once')
 agent.session.append('turn/start',{turn:0})
 for(const name of ['plugin_manager','workflow'])assert.equal((await ctx.tools.execute({agent,name,arguments:{},callId:ToolCallId(name),signal:AbortSignal.timeout(5000)})).isError,true)
 assert.equal(bodies,0)
})
