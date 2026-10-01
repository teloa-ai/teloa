import assert from 'node:assert/strict'
import test from 'node:test'
import {readHomeNativeBlank} from '../src/client/home-native-readiness.ts'

const user={event:{type:'user/message',surfaceOp:'append',data:{source:{kind:'user',rpcId:'accepted'}}}}
function fixture(){
 const state={openState:'open',removed:false,awaitingFirstTurn:false,hasMore:false,pendingSubmissions:[] as unknown[]},events={entries:[] as unknown[],revision:1},calls:string[]=[]
 const binding={ctx:{},session:{getSnapshot:()=>state,loadOlder:async()=>{calls.push('older');events.entries.unshift(user);events.revision++;state.hasMore=false}},eventSource:{getSnapshot:()=>events}}
 let ready:Promise<unknown>=Promise.resolve(binding)
 const sessions={list:{getSnapshot:()=>({byId:{s:{blank:true}}})},using:async(id:string,options:any,operation:any)=>{calls.push(id+':'+options.source);try{return await operation({ready,binding})}finally{calls.push('released')}}}
 return {state,events,calls,binding,sessions:sessions as any,setReady:(value:Promise<unknown>)=>{ready=value}}
}
test('目录blank过期时等待官方reference.ready与晚加载用户消息，不打开任何UI',async()=>{
 const f=fixture();let finish!:(value:unknown)=>void;f.setReady(new Promise(resolve=>{finish=resolve}))
 let settled=false;const result=readHomeNativeBlank(f.sessions,'s' as any,()=>false).then(value=>{settled=true;return value})
 await Promise.resolve();assert.equal(settled,false);f.events.entries=[user];finish(f.binding)
 assert.equal(await result,false);assert.deepEqual(f.calls,['s:controllerOperation','released'])
})
test('历史尾页没有用户消息时读取更早页；已受理inbox或awaitingFirstTurn同样不能复用',async()=>{
 const f=fixture();f.state.hasMore=true
 assert.equal(await readHomeNativeBlank(f.sessions,'s' as any,()=>false),false);assert.ok(f.calls.includes('older'))
 const queued=fixture();assert.equal(await readHomeNativeBlank(queued.sessions,'s' as any,()=>true),false)
 queued.state.awaitingFirstTurn=true;assert.equal(await readHomeNativeBlank(queued.sessions,'s' as any,()=>false),false)
})
test('真正空历史可复用，打开失败或未确定的本地提交不能认作空白',async()=>{
 const f=fixture();assert.equal(await readHomeNativeBlank(f.sessions,'s' as any,()=>false),true)
 f.state.pendingSubmissions=[{requestId:'unknown'}];assert.equal(await readHomeNativeBlank(f.sessions,'s' as any,()=>false),undefined)
 f.state.openState='error';await assert.rejects(readHomeNativeBlank(f.sessions,'s' as any,()=>false),/核对/)
 const stuck=fixture();stuck.state.hasMore=true;stuck.binding.session.loadOlder=async()=>{}
 await assert.rejects(readHomeNativeBlank(stuck.sessions,'s' as any,()=>false),/核对/)
})
