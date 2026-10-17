import test from 'node:test'
import assert from 'node:assert/strict'
import {createBusinessEventOriginVerifier} from '../src/business-event-origin.ts'

const owner='local:owner',sessionId='native-session',origin={sessionId,messageId:'original-message',seq:4},db={} as never
const event={seq:4,type:'user/message',surfaceOp:'append',data:{id:origin.messageId,source:{kind:'user',rpcId:'native-request'}}}
const run={id:'3e059a82-0b86-4e20-8e03-3353c0a3a372',ownerId:owner,sessionId,nativeRequestId:'native-request'}
function fixture(){
 const state={binding:{ownerId:owner,sessionId,status:'ready'},events:[event] as unknown[],inherited:0,run:null as typeof run|null,hasRuns:false}
 const verify=createBusinessEventOriginVerifier(owner,{
  conversation:async()=>state.binding,
  session:async()=>({sessionId,events:state.events,isOwnSeq:seq=>seq>=state.inherited}),
  run:async()=>({run:state.run,hasRuns:state.hasRuns}),
 })
 return {state,verify}
}
test('正式普通消息证明不冒Run；精确原生请求匹配才产生任务执行来源',async()=>{
 const {state,verify}=fixture()
 assert.deepEqual(await verify(db,owner,origin),{kind:'ordinary-conversation'})
 state.run=run;state.hasRuns=true
 assert.deepEqual(await verify(db,owner,origin),{kind:'task-run',runId:run.id})
})
test('既有Run但原消息不匹配时不能降级普通会话；外来Run也拒绝',async()=>{
 const {state,verify}=fixture();state.hasRuns=true
 await assert.rejects(()=>verify(db,owner,origin),{code:'teloa/forbidden'})
 state.run={...run,nativeRequestId:'other'}
 await assert.rejects(()=>verify(db,owner,origin),{code:'teloa/forbidden'})
 state.run={...run,ownerId:'local:other'}
 await assert.rejects(()=>verify(db,owner,origin),{code:'teloa/forbidden'})
})
test('跨本人、继承、替换或工具消息不能成为业务事件原生来源',async()=>{
 const {state,verify}=fixture()
 await assert.rejects(()=>verify(db,'local:other',origin),{code:'teloa/forbidden'})
 state.binding={...state.binding,ownerId:'local:other'}
 await assert.rejects(()=>verify(db,owner,origin),{code:'teloa/forbidden'})
 state.binding={...state.binding,ownerId:owner};state.inherited=5
 await assert.rejects(()=>verify(db,owner,origin),{code:'teloa/forbidden'})
 state.inherited=0;state.events=[{...event,surfaceOp:'replace'}]
 await assert.rejects(()=>verify(db,owner,origin),{code:'teloa/forbidden'})
 state.events=[{...event,data:{...event.data,source:{kind:'tool'}}}]
 await assert.rejects(()=>verify(db,owner,origin),{code:'teloa/forbidden'})
 state.events=[{...event,data:{...event.data,id:'other'}}]
 await assert.rejects(()=>verify(db,owner,origin),{code:'teloa/forbidden'})
})
