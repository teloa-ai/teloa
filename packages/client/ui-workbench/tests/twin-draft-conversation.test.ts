import test from 'node:test'
import assert from 'node:assert/strict'
import {registerHooks} from 'node:module'
import type {DraftInputPort} from '../src/client/blank-conversation-draft.ts'
const hooks=registerHooks({resolve(specifier,context,next){return next(specifier==='./blank-conversation-draft.js'?'./blank-conversation-draft.ts':specifier,context)}})
const {openTwinDraftConversation}=await import('../src/client/twin-draft-conversation.ts')
hooks.deregister()

const messages={unavailable:'source changed',occupied:'input occupied',rejected:'input rejected'}
function fixture(patch:Record<string,unknown>={}){
 let state={draft:'',attachmentIds:[],phase:'plain',occurrences:[],queue:[],...patch} as ReturnType<DraftInputPort['state']['getSnapshot']>,current=true,writes:string[]=[],sent=0
 const input={state:{getSnapshot:()=>state},setDraft:(text:string)=>{writes.push(text);state={...state,draft:text}},notify:()=>{},submit:()=>{sent++}}
 return {input,writes,sent:()=>sent,setCurrent:(value:boolean)=>{current=value},ports:{open:async()=>true,current:()=>current,input:()=>input,messages}}
}
test('打开来源后仅回填本人空输入，重复打开不重复写入或发送',async()=>{
 const f=fixture();await openTwinDraftConversation('retained reply',f.ports);assert.deepEqual(f.writes,['retained reply']);assert.equal(f.sent(),0)
 await openTwinDraftConversation('retained reply',f.ports);assert.deepEqual(f.writes,['retained reply']);assert.equal(f.sent(),0)
})
for(const patch of [{draft:'existing'},{attachmentIds:['file']},{occurrences:[{}]},{queue:[{}]},{phase:'submitting'}])test('原输入有内容或忙碌时保留两份 '+JSON.stringify(patch),async()=>{
 const f=fixture(patch);await assert.rejects(openTwinDraftConversation('reply',f.ports),{message:'input occupied',code:'teloa/twin-draft-input-occupied'});assert.deepEqual(f.writes,[]);assert.equal(f.sent(),0)
})
test('打开来源期间本人导航变化，不向后来会话写入',async()=>{
 const f=fixture();f.ports.open=async()=>{f.setCurrent(false);return true}
 await assert.rejects(openTwinDraftConversation('reply',f.ports),{message:'source changed',code:'teloa/twin-draft-open-unavailable'});assert.deepEqual(f.writes,[])
})
test('来源未打开或输入不可达时保留原稿',async()=>{
 const f=fixture();await assert.rejects(openTwinDraftConversation('reply',{...f.ports,open:async()=>false}),{message:'source changed',code:'teloa/twin-draft-open-unavailable'})
 await assert.rejects(openTwinDraftConversation('reply',{...f.ports,input:()=>undefined}),{message:'source changed',code:'teloa/twin-draft-open-unavailable'});assert.deepEqual(f.writes,[])
})
test('原生输入拒绝正文时不宣称已回填，也不发送',async()=>{
 const f=fixture();f.input.setDraft=()=>{}
 await assert.rejects(openTwinDraftConversation('reply',f.ports),{message:'input rejected',code:'teloa/twin-draft-input-rejected'});assert.equal(f.sent(),0)
})
