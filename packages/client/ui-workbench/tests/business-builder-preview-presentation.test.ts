import test from 'node:test'
import assert from 'node:assert/strict'
import {readBusinessBuilderPreviewMessage as read,type BusinessPreviewEvent} from '../src/client/business-builder-preview-presentation.ts'
const sessionId='builder-one',draftId='draft-one',requestId='request-one',owner='owner-one'
const node={seq:5,turn:1,step:1,messageId:'answer-one' as never}
export function events(state='saved'){
 const rows:BusinessPreviewEvent[]=[
  {type:'plugin:teloa/business-builder-preview',seq:0,ignorable:true,data:{kind:'mode',sessionId,draftId,owner,requestId:'mode-one',revision:1,mode:'preview'}},
  {type:'turn/start',seq:1,data:{turn:1}},
  {type:'plugin:teloa/business-builder-preview',seq:2,ignorable:true,data:{kind:'prepared',sessionId,draftId,owner,requestId,messageId:'input-one',modeRequestId:'mode-one',revision:1,turn:1,step:1,draftHash:'a'.repeat(64),fingerprint:'b'.repeat(64)}},
  {type:'step/start',seq:3,data:{turn:1,step:1}},
  {type:'user/message',seq:4,data:{id:'input-one',source:{kind:'user'}}},
  {type:'assistant/message',seq:5,data:{turn:1,step:1,message:{id:'answer-one'}}},
  {type:'plugin:teloa/business-builder-preview',seq:6,ignorable:true,data:{kind:'settled',sessionId,draftId,owner,requestId,revision:state==='saved'?2:1,state,...state==='saved'?{hash:'c'.repeat(64)}:{}}},
  {type:'turn/end',seq:7,data:{turn:1,reason:{kind:state==='saved'?'completed':'error'}}},
 ];return rows.map(event=>({event}))
}
test('仅确切host保存回执显示成功；failed和unknown如实，取消或无回执不能冒充成功',()=>{
 for(const state of ['saved','failed','unknown'])assert.equal(read(sessionId,node,events(state))?.state,state)
 const noReceipt=events().filter(row=>row.event.seq!==6);assert.equal(read(sessionId,node,noReceipt)?.state,'unknown')
 noReceipt.at(-1)!.event.data.reason.kind='aborted';assert.equal(read(sessionId,node,noReceipt)?.state,'cancelled')
 assert.equal(read(sessionId,{seq:5,turn:1,step:1},events().slice(0,6))?.state,'generating')
})
test('普通JSON或代码/assisted/跨session turn owner request draft message及伪record均走原renderer',()=>{
 assert.equal(read(sessionId,node,[]),null);assert.equal(read('other-session',node,events()),null)
 for(const [index,key,value] of [[0,'mode','assisted'],[2,'turn',2],[2,'step',2],[2,'owner','foreign'],[2,'draftId','other'],[2,'modeRequestId','other'],[4,'id','other'],[6,'owner','foreign'],[6,'draftId','other']] as const){const rows=events();rows[index]!.event.data[key]=value;assert.equal(read(sessionId,node,rows),null,key)}
 const fake=events();fake[2]!.event.ignorable=false;assert.equal(read(sessionId,node,fake),null)
 const badHash=events();badHash[6]!.event.data.hash='bad';assert.equal(read(sessionId,node,badHash),null)
 assert.equal(read(sessionId,{...node,turn:2},events()),null);assert.equal(read(sessionId,{...node,messageId:'other' as never},events()),null)
})
