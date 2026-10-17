import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile,access,symlink,mkdir} from 'node:fs/promises'
import {join} from 'node:path'
import {defineTool} from '@deepseek-ai/dsh-tools'
import {nativePtcToolPath} from './fixtures/native-ptc-tool-path.ts'
import {registerTaskToolGuard,type TaskToolPolicy} from '../src/task-tool-guard.ts'

const text=(message:{content:readonly {type:string;text?:string}[]})=>message.content.flatMap(block=>block.type==='text'?[block.text]:[]).join('\n')
test('原 run_code 按预设绑定 Node/per-call、Node/内存与 Python；并发同名 SDK 不串运行时',{timeout:30000},async t=>{
 const f=await nativePtcToolPath(t),fresh=await f.create('ptc'),persistent=await f.create('ptc-persistent'),python=await f.create('ptc-python')
 f.ctx.tools.register(defineTool({name:'same_name',description:'同名SDK隔离',parameters:{},output:{schema:{type:'integer'},render:(_a,v)=>[{type:'text',text:String(v)}]},execute:async()=>42}))
 const wires=await Promise.all([fresh,persistent,python].map(agent=>f.ctx.systemPrompt.assemble({scope:agent})))
 for(const wire of wires)assert.deepEqual(wire.tools.map(row=>row.name),['run_code'])
 assert.match(wires[1]!.sections.find(row=>row.name==='tools:sdk')!.text,/declare const tools/)
 assert.match(wires[2]!.sections.find(row=>row.name==='tools:sdk')!.text,/async def same_name/)
 assert.match(wires[2]!.tools[0]!.description,/Python/)
 assert.match(text(await f.run(fresh,'globalThis.ephemeralValue=17; return ephemeralValue')),/17/)
 assert.match(text(await f.run(fresh,'return typeof ephemeralValue')),/undefined/)
 assert.match(text(await f.run(persistent,'let retainedValue=41; retainedValue')),/41/)
 const results=await Promise.all([f.run(persistent,'++retainedValue; console.log(await tools.same_name({}))'),f.run(python,'print(await tools.same_name({}))')])
 for(const result of results){assert.notEqual(result.isError,true,text(result));assert.match(text(result),/42/)}
 const other=await f.create('ptc-persistent');assert.match(text(await f.run(other,'typeof retainedValue')),/undefined/)
 assert.equal(f.ctx.ptcRuntime.language,'typescript','宿主 provider 不变')
})

test('Python 原工具执行沿同一 sandbox：允许根内写，越界/符号链接/read-only 均无文件',{timeout:30000},async t=>{
 const f=await nativePtcToolPath(t),agent=await f.create('ptc-python'),outside=join(f.root,'outside');await mkdir(outside);await symlink(outside,join(f.workspace,'escape'),'dir')
 const program=(path:string)=>`from pathlib import Path\nPath(${JSON.stringify(path)}).write_text('actual-python-tool')\n17`
 const inside=join(f.workspace,'inside.txt');assert.notEqual((await f.run(agent,program(inside))).isError,true);assert.equal(await readFile(inside,'utf8'),'actual-python-tool')
 for(const path of [join(outside,'forbidden.txt'),join(f.workspace,'escape','forbidden.txt')]){const denied=await f.run(agent,program(path));assert.match(text(denied),/denied|not permitted|PermissionError/,JSON.stringify(denied));await assert.rejects(access(join(outside,'forbidden.txt')))}
 f.ctx.permissionPresets.set(agent.session,'read-only')
 const readonly=join(f.workspace,'readonly.txt');const denied=await f.run(agent,program(readonly));assert.match(text(denied),/denied|not permitted|PermissionError/,JSON.stringify(denied));await assert.rejects(access(readonly))
})

test('原脚本逐次审批、内层授权与等待期间撤权保持：拒绝后没有实际工具或文件副作用',{timeout:30000},async t=>{
 const f=await nativePtcToolPath(t),agent=await f.create('ptc-persistent');let policy:TaskToolPolicy|null=null,approved=true,asks=0,bodies=0,revoke=false
 registerTaskToolGuard(f.ctx,async()=>policy)
 f.ctx.tools.register(defineTool({name:'approved_inner',description:'实际内层工具',parameters:{},output:{schema:{type:'integer'},render:(_a,v)=>[{type:'text',text:String(v)}]},execute:async()=>++bodies}))
 f.ctx.on('approval/request',async()=>{asks++;if(revoke)policy={allowedTools:[]};return approved?'allowed-once':'rejected'})
 const first=await f.run(agent,'console.log(await tools.approved_inner({}))');assert.notEqual(first.isError,true,text(first))
 assert.equal(asks,1);assert.equal(bodies,1)
 approved=false;assert.equal((await f.run(agent,'console.log(await tools.approved_inner({}))')).isError,true)
 assert.equal(asks,2);assert.equal(bodies,1)
 approved=true;policy={allowedTools:['run_code']}
 assert.equal((await f.run(agent,'console.log(await tools.approved_inner({}))')).isError,true,'脚本确认不授予内层工具')
 assert.equal(asks,3);assert.equal(bodies,1)
 policy={allowedTools:['run_code','approved_inner']};revoke=true
 assert.equal((await f.run(agent,'console.log(await tools.approved_inner({}))')).isError,true)
 assert.equal(asks,4);assert.equal(bodies,1)
})

test('真实取消清空 Node 内存，权限策略变化不可复用旧worker，release与新Agent保持隔离',{timeout:30000},async t=>{
 const f=await nativePtcToolPath(t),agent=await f.create('ptc-persistent')
 let entered!:()=>void;const entry=new Promise<void>(resolve=>entered=resolve)
 f.ctx.tools.register(defineTool({name:'worker_entered',description:'只确认实际worker已进入',parameters:{},output:{schema:{type:'boolean'},render:()=>[]},execute:async()=>{entered();return true}}))
 const controller=new AbortController(),running=f.run(agent,'let cancelValue=9; await tools.worker_entered({}); await new Promise(()=>{})',controller.signal)
 await entry;controller.abort(Error('本次取消'));await running
 assert.match(text(await f.run(agent,'typeof cancelValue')),/undefined/)
 assert.notEqual((await f.run(agent,'let permissionValue=7; permissionValue')).isError,true)
 f.ctx.permissionPresets.set(agent.session,'read-only')
 assert.equal((await f.run(agent,'permissionValue')).isError,true,'策略不能带旧环境继续')
 const runtime=f.ctx.agentPresets.serviceFor(agent,'ptcRuntime');assert.ok(runtime)
 await runtime.release(agent)
 assert.match(text(await f.run(agent,'typeof permissionValue')),/undefined/)
 const previous=await f.create('ptc-persistent','u4-reopened-session')
 assert.match(text(await f.run(previous,'let privateOwnerValue=91; privateOwnerValue')),/91/)
 await f.dispose(previous)
 const reopened=await f.create('ptc-persistent','u4-reopened-session')
 assert.notEqual(reopened,previous);assert.match(text(await f.run(reopened,'typeof privateOwnerValue')),/undefined/,'相同会话ID不等于原运行主体')
})
