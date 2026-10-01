import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import React from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import ts from 'typescript'
import {createSessionBrowserStopReader,readSessionBrowserStopState,sessionBrowserStopBindingReady} from '../src/client/session-browser-stop.ts'
import {BindingClient,type WorkPort} from '../src/client/binding-client.ts'
import {isNativeChildSession} from '../src/client/main-session.ts'
import {brandString} from '@deepseek-ai/dsh-brand'
import type {SessionId} from '@deepseek-ai/dsh-session'
import type {Conversation} from '@teloa/contract'

const tick=()=>new Promise<void>(resolve=>setImmediate(resolve))

test('浏览器状态门禁要求当前会话及返回绑定身份均ready',()=>{
 const conversation={sessionId:'ordinary',status:'ready'} as Conversation
 const binding={sessionId:'ordinary',status:'ready' as const,conversation}
 assert.equal(sessionBrowserStopBindingReady('ordinary',binding,true,false),true)
 for(const state of ['idle','loading','failed'] as const)assert.equal(sessionBrowserStopBindingReady('ordinary',{...binding,status:state},true,false),false)
 assert.equal(sessionBrowserStopBindingReady('ordinary',{...binding,sessionId:'other'},true,false),false)
 assert.equal(sessionBrowserStopBindingReady('ordinary',{...binding,conversation:{...conversation,sessionId:'other'}},true,false),false)
 assert.equal(sessionBrowserStopBindingReady('ordinary',{...binding,conversation:undefined},true,false),false)
 assert.equal(sessionBrowserStopBindingReady('ordinary',binding,false,false),false)
 assert.equal(sessionBrowserStopBindingReady('ordinary',binding,true,true),false)
})

test('普通会话绑定未就绪不查询；绑定成功后原有提示自动读取',async()=>{
 const id='ordinary',conversation={sessionId:id,status:'ready'} as Conversation
 let finish:(value:Conversation)=>void=()=>{},reads=0
 const work=new BindingClient({isNativeChild:()=>false,block:()=>{},ensure:()=>new Promise(resolve=>{finish=resolve})} as unknown as WorkPort)
 const selecting=work.select(id)
 const reader=createSessionBrowserStopReader(async()=>{reads++;return {state:'unconfirmed'}},work.subscribe,()=>sessionBrowserStopBindingReady(id,work.getSnapshot(),true,false))
 const off=reader.attach();await tick()
 assert.equal(reads,0);assert.equal(reader.getSnapshot().status,'loading')
 finish(conversation);await selecting;await tick()
 assert.equal(reads,1);assert.equal(reader.getSnapshot().status,'unconfirmed')
 off()
})

test('目录稍晚补齐：原生子会话不查询，普通fork可读取，绑定后not-bound仍显示失败',async()=>{
 const id=brandString<SessionId>('fork'),parent=brandString<SessionId>('parent')
 let row:{id:SessionId;parentId?:SessionId;origin?:'subagent'}|undefined,event=()=>{},reads=0,fail=false
 const sessions={subagentAddress:()=>undefined,list:{getSnapshot:()=>({byId:row?{[id]:row}:{}})}} as unknown as Parameters<typeof isNativeChildSession>[0]
 const binding={sessionId:id,status:'ready' as const,conversation:{sessionId:String(id),status:'ready'} as Conversation}
 const reader=createSessionBrowserStopReader(async()=>{reads++;if(fail)throw Error('teloa/not-bound');return {state:'isolated'}},listener=>{event=listener;return()=>{}},()=>sessionBrowserStopBindingReady(id,binding,!!row,isNativeChildSession(sessions,id)))
 const off=reader.attach();await tick();assert.equal(reads,0)
 row={id,origin:'subagent',parentId:parent};event();await tick();assert.equal(reads,0)
 row={id,parentId:parent};event();await tick();assert.equal(reads,1);assert.equal(reader.getSnapshot().status,'isolated')
 fail=true;event();await tick();assert.equal(reader.getSnapshot().status,'failed')
 off()
})

test('等待绑定时的旧响应和切换会话的旧响应都不能恢复警告',async()=>{
 let eligible=true,event=()=>{}
 const pending:Array<(value:unknown)=>void>=[]
 const reader=createSessionBrowserStopReader(()=>new Promise(resolve=>pending.push(resolve)),listener=>{event=listener;return()=>{}},()=>eligible)
 const off=reader.attach()
 eligible=false;event();assert.equal(reader.getSnapshot().checking,false)
 eligible=true;event();assert.equal(pending.length,2)
 pending.shift()!({state:'isolated'});await tick();assert.equal(reader.getSnapshot().status,'loading')
 pending.shift()!({state:'unconfirmed'});await tick();assert.equal(reader.getSnapshot().status,'unconfirmed')
 eligible=false;event();assert.equal(reader.getSnapshot().status,'loading')
 eligible=true;event();eligible=false;event()
 pending.shift()!({state:'isolated'});await tick();assert.equal(reader.getSnapshot().status,'loading')
 off()
})
test('关闭状态严格读取当前状态，畸形响应不能当作已关闭',()=>{
 for(const state of ['ready','unconfirmed','isolated'])assert.equal(readSessionBrowserStopState({state}),state)
 for(const value of [null,{},[],{state:'closed'},{state:'ready',notice:'old'}])assert.throws(()=>readSessionBrowserStopState(value))
})

test('初次读取、原生变化与手动重查；请求失败保留可重试状态',async()=>{
 let event=()=>{},reads=0,reply:unknown={state:'unconfirmed'},fail=false
 const reader=createSessionBrowserStopReader(async()=>{reads++;if(fail)throw Error('offline');return reply},listener=>{event=listener;return()=>{event=()=>{}}})
 const off=reader.attach();await tick()
 assert.equal(reader.getSnapshot().status,'unconfirmed');assert.equal(reads,1)
 reply={state:'isolated'};event();await tick()
 assert.equal(reader.getSnapshot().status,'isolated')
 fail=true;await reader.check();assert.equal(reader.getSnapshot().status,'failed')
 fail=false;reply={state:'ready'};await reader.check();assert.equal(reader.getSnapshot().status,'ready')
 off();event();await tick();assert.equal(reads,4)
})

test('事件突发合并到一次后续读取，卸载后旧请求不污染重新挂载',async()=>{
 let event=()=>{},reads=0
 const pending:Array<(value:unknown)=>void>=[]
 const reader=createSessionBrowserStopReader(()=>{reads++;return new Promise(resolve=>pending.push(resolve))},listener=>{event=listener;return()=>{event=()=>{}}})
 const off=reader.attach();event();event();event()
 assert.equal(reads,1)
 pending.shift()!({state:'unconfirmed'});await tick();assert.equal(reads,2)
 off();const offNext=reader.attach();assert.equal(reads,3)
 pending.shift()!({state:'isolated'});await tick()
 assert.equal(reader.getSnapshot().status,'loading')
 pending.shift()!({state:'ready'});await tick();assert.equal(reader.getSnapshot().status,'ready')
 offNext()
})

test('真实提示组件显示失败边界和只读重查；ready不显示，十语完整',async()=>{
 const rows=await import('../src/client/i18n/locales/session-browser-stop.ts')
 for(const row of rows.SESSION_BROWSER_STOP_MESSAGE_ROWS){assert.equal(row.length,11);assert.ok(row.every(value=>value.length>0))}
 const translations=Object.fromEntries(rows.SESSION_BROWSER_STOP_MESSAGE_ROWS.map(row=>[row[0],row[1]]))
 const i18n={subscribe:()=>()=>{},getSnapshot:()=>({locale:'zh-CN'}),t:(key:string)=>translations[key]??key}
 const filename=new URL('../src/client/SessionBrowserStopNotice.tsx',import.meta.url)
 const source=ts.transpileModule(readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText
 const nodeRequire=createRequire(import.meta.url),exports:Record<string,unknown>={}
 const require=(id:string)=>id.endsWith('.module.css')?{default:{notice:'notice'}}:nodeRequire(id)
 new Function('require','exports',source)(require,exports)
 const Component=exports.SessionBrowserStopNotice as React.ComponentType<any>
 let state:unknown={state:'ready'},eligible=true
 const reader=createSessionBrowserStopReader(async()=>state,()=>()=>{},()=>eligible),off=reader.attach();await tick()
 const render=()=>renderToStaticMarkup(React.createElement(Component,{sessionId:'test-session',reader,i18n}))
 assert.equal(render(),'')
 state={state:'unconfirmed'};await reader.check();assert.match(render(),/页面可能仍在运行/);assert.match(render(),/重新检查/)
 state={state:'isolated'};await reader.check();assert.match(render(),/纯聊天可以继续/);assert.match(render(),/当前会话的浏览器操作已暂停/)
 state={state:'bad'};await reader.check();assert.match(render(),/无法读取浏览器关闭状态/);assert.match(render(),/重新检查/)
 eligible=false;await reader.check();assert.equal(render(),'','失去当前绑定后不残留上一会话的警告')
 off()
})
