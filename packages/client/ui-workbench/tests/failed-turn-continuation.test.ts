import test from 'node:test'
import assert from 'node:assert/strict'
import {createFailedTurnContinuation,latestContinuableFailure,type ContinuationFacts} from '../src/client/failed-turn-continuation.ts'
import {draftContinuityCopy} from '../src/client/draft-continuity-copy.ts'
const event=(seq:number,type:string,data:unknown)=>({type:'event',event:{seq,time:seq,type,data}} as any)
const failed=()=>[event(0,'turn/start',{turn:1}),event(1,'user/message',{source:{kind:'user'},content:[{type:'text',text:'原问题'}]}),event(2,'turn/end',{turn:1,reason:{kind:'error',error:{code:'NETWORK',message:'failure'}}})]
function fixture(){
 let facts:ContinuationFacts={owner:'owner-A',binding:{},current:true,ready:true,blocked:false,running:false,pending:false,unknown:false,editable:true,empty:true,entries:failed()}
 const sent:string[]=[],listeners=new Set<()=>void>();let eligibility=async()=>true
 const port=createFailedTurnContinuation({read:()=>facts,subscribe:fn=>{listeners.add(fn);return()=>{listeners.delete(fn)}},eligible:()=>eligibility(),send:text=>{sent.push(text);facts={...facts,pending:true}}})
 return {port,sent,set:(patch:Partial<ContinuationFacts>)=>{facts={...facts,...patch};for(const fn of listeners)fn()},eligible:(value:()=>Promise<boolean>)=>{eligibility=value}}
}
test('已知最新失败只追加一条明确续办指令，原问题/失败不重放，快速双击不重复',async()=>{
 const f=fixture(),text=draftContinuityCopy('zh-CN','instruction')
 assert.equal(f.port.available(2),true)
 const first=f.port.continue(2,text)
 await assert.rejects(f.port.continue(2,text));await first
 assert.deepEqual(f.sent,[text]);assert.ok(!text.includes('原问题'));assert.equal(f.port.available(2),false)
})
test('已有工具动作、成功/取消、旧错误、截断历史均不能自动续办',()=>{
 for(const entries of [
  [event(0,'turn/start',{turn:1}),event(1,'tool/call',{}),...failed().slice(2)],
  [event(0,'turn/start',{turn:1}),event(2,'turn/end',{turn:1,reason:{kind:'completed'}})],
  [event(0,'turn/start',{turn:1}),event(2,'turn/end',{turn:1,reason:{kind:'aborted'}})],
  [...failed(),event(3,'user/message',{source:{kind:'user'}})],
  [...failed(),event(3,'agent/inbox/spliced',{inserted:[{}]})],
  [...failed(),event(3,'turn/start',{turn:2})],failed().slice(1),
 ])assert.equal(latestContinuableFailure(entries),undefined)
})
test('切换、离线、身份未知、已有草稿/附件、发送中及unknown都拒绝',async()=>{
 for(const patch of [{owner:null},{current:false},{ready:false},{blocked:true},{running:true},{pending:true},{unknown:true},{editable:false},{empty:false}]){
  const f=fixture();f.set(patch);assert.equal(f.port.available(2),false);await assert.rejects(f.port.continue(2,'continue'));assert.deepEqual(f.sent,[])
 }
})
test('身份核对迟到后，换owner/binding或编辑、出现新输入都不向新会话发送',async()=>{
 for(const patch of [{owner:'owner-B'},{binding:{}},{empty:false},{entries:[...failed(),event(3,'user/message',{})]}]){
  const f=fixture();let done!:(value:boolean)=>void;f.eligible(()=>new Promise(resolve=>{done=resolve}))
  const pending=f.port.continue(2,'continue');f.set(patch);done(true);await assert.rejects(pending);assert.deepEqual(f.sent,[])
 }
})
test('真实普通会话资格拒绝不发送；本地标题事件不改变原失败身份',async()=>{
 const f=fixture();f.eligible(async()=>false);await assert.rejects(f.port.continue(2,'continue'));assert.deepEqual(f.sent,[])
 assert.equal(latestContinuableFailure([...failed(),event(3,'session/title',{})]),2)
 for(const locale of ['zh-CN','zh-Hant','en'] as const)assert.ok(draftContinuityCopy(locale,'help').length)
})
