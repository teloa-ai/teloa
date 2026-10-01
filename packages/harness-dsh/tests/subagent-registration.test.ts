import test from 'node:test'
import assert from 'node:assert/strict'
import type {Context} from '@deepseek-ai/cordis'
import {registerSubagentRegistration} from '../src/subagent-registration.ts'
import {inject} from '../src/index.ts'

type StartListener=(info:{id:string})=>void
type EndListener=(info:{id:string;stopReason:string})=>void

test('子 Agent 登记与执行闸声明 agents 依赖，避免子会话运行时越过注入边界',()=>{
 assert.ok(inject.includes('agents'))
})

function fixture(header:{parentSession?:string;delegationDepth?:number}={parentSession:'run-session',delegationDepth:1}){
 let start:StartListener|undefined,end:EndListener|undefined
 const warnings:string[]=[]
 const registrations:{name:string;global?:boolean}[]=[]
 const ctx={
  agents:{get:(id:string)=>id==='child-session'?{session:{header}}:undefined},
  logger:{warn:(message:string)=>warnings.push(message)},
  on:(name:string,listener:StartListener|EndListener,options?:{global?:boolean})=>{
   registrations.push({name,...options})
   if(name==='subagent/start')start=listener as StartListener
   if(name==='subagent/end')end=listener as EndListener
   return ()=>{if(name==='subagent/start')start=undefined;else end=undefined}
  },
 } as unknown as Context
 const bind:unknown[]=[],settle:unknown[]=[],abandon:unknown[]=[]
 const registration=registerSubagentRegistration(ctx,{bind:async input=>{bind.push(input)},settle:async input=>{settle.push(input)},abandon:async input=>{abandon.push(input)}})
 return {start:()=>start!({id:'child-session'}),end:(stopReason='completed')=>end!({id:'child-session',stopReason}),bind,settle,abandon,warnings,registrations,registration}
}

test('subagent/start 从子会话头读取父会话与深度；end 结算同一子会话',async()=>{
 const f=fixture()
 f.start();await Promise.resolve()
 assert.deepEqual(f.bind,[{childSessionId:'child-session',parentSessionId:'run-session',depth:1}])
 f.end('completed');await Promise.resolve();await Promise.resolve()
 assert.deepEqual(f.settle,[{childSessionId:'child-session',stopReason:'completed'}])
 assert.deepEqual(f.abandon,[])
 assert.deepEqual(f.registrations,[{name:'subagent/start',global:true},{name:'subagent/end',global:true}])
})

test('bind 失败立即留下 abandoned；end 不把未成功绑定的子会话误结算',async()=>{
 let start:StartListener|undefined,end:EndListener|undefined
 const abandons:unknown[]=[],ctx={agents:{get:()=>({session:{header:{parentSession:'run-session',delegationDepth:1}}})},logger:{warn:()=>{}},on:(name:string,listener:StartListener|EndListener,_options?:{global?:boolean})=>{if(name==='subagent/start')start=listener as StartListener;else end=listener as EndListener;return ()=>{}}} as unknown as Context
 let settles=0
 registerSubagentRegistration(ctx,{bind:async()=>{throw Error('database private detail')},settle:async()=>{settles++},abandon:async input=>{abandons.push(input)}})
 start!({id:'child-session'});await Promise.resolve();await Promise.resolve()
 end!({id:'child-session',stopReason:'completed'});await Promise.resolve();await Promise.resolve()
 assert.deepEqual(abandons,[{childSessionId:'child-session',parentSessionId:'run-session',depth:1,reason:'registration-failed'}])
 assert.equal(settles,0)
})

test('结算失败也收成 abandoned；缺少可信子会话头只告警，不猜测父 Run',async()=>{
 let start:StartListener|undefined,end:EndListener|undefined
 const abandons:unknown[]=[],ctx={agents:{get:()=>({session:{header:{parentSession:'run-session',delegationDepth:1}}})},logger:{warn:()=>{}},on:(name:string,listener:StartListener|EndListener,_options?:{global?:boolean})=>{if(name==='subagent/start')start=listener as StartListener;else end=listener as EndListener;return ()=>{}}} as unknown as Context
 registerSubagentRegistration(ctx,{bind:async()=>{},settle:async()=>{throw Error('database private detail')},abandon:async input=>{abandons.push(input)}})
 start!({id:'child-session'});await Promise.resolve()
 end!({id:'child-session',stopReason:'completed'});await Promise.resolve();await Promise.resolve()
 assert.deepEqual(abandons,[{childSessionId:'child-session',parentSessionId:'run-session',depth:1,reason:'settlement-failed'}])
 const missing=fixture({delegationDepth:1})
 missing.start();await Promise.resolve()
 assert.deepEqual(missing.bind,[]);assert.match(missing.warnings[0]??'',/启动登记未完成/)
})
