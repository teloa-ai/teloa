import test from 'node:test'
import assert from 'node:assert/strict'
import {insertBusinessReassignmentInput} from '../src/client/business-reassignment-input.ts'
import {createBusinessReassignmentApi,verifyBusinessReassignmentReceipt} from '../src/client/business-reassignment-api.ts'
const old='11111111-1111-4111-8111-111111111111',role='22222222-2222-4222-8222-222222222222',next='33333333-3333-4333-8333-333333333333'
const workContext=(roleId:string|null=null)=>({sessionId:'daily',scopeId:'sales',version:1,roleId,locked:roleId!==null})
const selection={oldRequestId:old,newRoleId:role,expectedNewRoleVersion:2,scope:'sales',newRoleName:'Mina',expectedContext:{version:1,roleId:null as string|null}}
function fixture(){
 let input:any={draft:'',draftRev:1,phase:'plain',attachmentIds:[],occurrences:[],queue:[]},main='daily',binding='daily',current=true,unknown=false,pending:any[]=[]
 const listeners=new Set<()=>void>(),writes:any[]=[]
 const port:any={switching:{read:()=>({mainSessionId:main,bindingSessionId:binding,bindingReady:true,input,pendingSubmissions:pending,monitor:{getSnapshot:()=>unknown,check:async()=>{}}})},isCurrent:()=>current,verify:async()=>({...selection,context:workContext()}),state:{getSnapshot:()=>input,subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>listeners.delete(fn)}},insertText:(request:any)=>{writes.push(request);input={...input,draft:request.text,draftRev:input.draftRev+1};for(const fn of listeners)fn();return true}}
 return {port,writes,listeners,get input(){return input},setInput:(patch:any)=>{input={...input,...patch}},switch:()=>{main='other';binding='other'},leave:()=>{current=false},unknown:()=>{unknown=true},pending:()=>{pending=[{requestId:'pending'}]}}
}
test('明确选择新同事只在空原生输入CAS插入短文本，双击不重复插入',async()=>{
 const f=fixture();await Promise.allSettled([insertBusinessReassignmentInput(selection,'daily',f.port),insertBusinessReassignmentInput(selection,'daily',f.port)])
 assert.equal(f.writes.length,1);assert.deepEqual(f.writes[0].span,{start:0,end:0,draftRev:1});assert.match(f.input.draft,/Mina/);assert.match(f.input.draft,new RegExp(old));assert.match(f.input.draft,new RegExp(role));assert.match(f.input.draft,/2/);assert.equal(f.input.occurrences.length,0);assert.equal(f.listeners.size,0)
})
test('草稿、附件、引用、队列、claim、发送阶段和unknown均保留原稿零插入',async()=>{
 for(const patch of [{draft:'原稿'},{attachmentIds:['file']},{occurrences:[{ref:'old'}]},{queue:[{id:'q'}]},{claim:{}},{phase:'submitting'},{phase:'adjudicating'}]){const f=fixture();f.setInput(patch);const before=f.input;await assert.rejects(insertBusinessReassignmentInput(selection,'daily',f.port));assert.equal(f.input,before);assert.equal(f.writes.length,0)}
 for(const flag of ['unknown','pending'] as const){const f=fixture();f[flag]();await assert.rejects(insertBusinessReassignmentInput(selection,'daily',f.port));assert.equal(f.writes.length,0)}
})
test('核对期间切业务、会话、revision或同事版本/name/scope变化均零插入',async()=>{
 for(const change of ['business','session','revision','version','name','scope','role','request','context']){const f=fixture();f.port.verify=async()=>{if(change==='business')f.leave();if(change==='session')f.switch();if(change==='revision')f.setInput({draftRev:2});return {...selection,context:workContext(change==='context'?old:null),...(change==='version'?{expectedNewRoleVersion:3}:{}),...(change==='name'?{newRoleName:'Other'}:{}),...(change==='scope'?{scope:'support'}:{}),...(change==='role'?{newRoleId:old}:{}),...(change==='request'?{oldRequestId:next}:{})}};await assert.rejects(insertBusinessReassignmentInput(selection,'daily',f.port));assert.equal(f.writes.length,0)}
})
test('插入拒收、不同正文/revision和超时不清稿、不重试；迟到通知不复活',async t=>{
 const f=fixture();f.port.insertText=()=>undefined;await assert.rejects(insertBusinessReassignmentInput(selection,'daily',f.port));assert.equal(f.input.draft,'')
 for(const patch of [{draft:'新稿',draftRev:2},{draftRev:3},{attachmentIds:['late'],draftRev:2},{queue:[{}],draftRev:2},{phase:'submitting',draftRev:2}]){const g=fixture();g.port.insertText=(r:any)=>{g.writes.push(r);g.setInput({draft:r.text,...patch});return true};await assert.rejects(insertBusinessReassignmentInput(selection,'daily',g.port));assert.equal(g.writes.length,1);assert.equal(g.listeners.size,0)}
 t.mock.timers.enable({apis:['setTimeout']});const g=fixture();g.port.insertText=(r:any)=>{g.writes.push(r);return true};const wait=insertBusinessReassignmentInput(selection,'daily',g.port);await new Promise<void>(resolve=>setImmediate(resolve));t.mock.timers.tick(3001);await assert.rejects(wait);assert.equal(g.listeners.size,0);g.setInput({draft:'迟到原生稿',draftRev:2});for(const fn of g.listeners)fn();assert.equal(g.input.draft,'迟到原生稿');assert.equal(g.writes.length,1)
})
const original={requestId:old,sessionId:'daily',kind:'task',title:'订单跟进',scope:'sales',observedAt:'2026-09-30T00:00:00.000Z',stoppedAt:'2026-09-30T00:00:00.000Z',counts:{},members:[{roleId:role,name:'Mina',scope:'sales',status:'stopped'}]}
test('只查询指定原session授权单人task定位，report不进入；重复/跨session/scope回包拒绝',async()=>{
 const calls:any[]=[];let rows:any[]=[original,{...original,kind:'report'}];const api=createBusinessReassignmentApi(async(endpoint:string,payload:any)=>{calls.push([endpoint,payload]);return rows},'sales')
 const found=await api.listOriginalRequests('daily');assert.equal(found.length,1);assert.equal(found[0]!.oldRequestId,old);assert.equal(found[0]!.stopSubmitted,true);assert.deepEqual(calls,[['work-requests/list',{sessionId:'daily'}]])
 for(const row of [{...original,sessionId:'other'},{...original,scope:'support'},{...original,members:[{...original.members[0],scope:'support'}]},{...original,requestId:'bad'}]){rows=[row];await assert.rejects(api.listOriginalRequests('daily'))}
 rows=[original,original];await assert.rejects(api.listOriginalRequests('daily'))
})
test('后继回执核对全部固定身份/hash，不能用另一次回包展示成功',()=>{
 const receipt={oldRequestId:old,newRequestId:next,oldSessionId:'old-daily',newSessionId:'daily',scope:'sales',snapshotHash:'a'.repeat(64),createdAt:'2026-09-30T00:00:00.000Z'},expected={...receipt};assert.equal(verifyBusinessReassignmentReceipt(receipt,expected).newRequestId,next)
 for(const key of ['oldRequestId','newRequestId','oldSessionId','newSessionId','scope','snapshotHash'])assert.throws(()=>verifyBusinessReassignmentReceipt({...receipt,[key]:key.endsWith('Id')?(key.includes('Session')?'wrong':role):key==='scope'?'support':'b'.repeat(64)},expected))
})

// 只改变真实context身份，不改变scope/session/input；旧实现会接受兼容但陈旧的核对。
test('同session核对屏障后的context版本或兼容role变化均零插入并保留原输入对象',async()=>{
 for(const context of [{sessionId:'daily',scopeId:'sales',version:2,roleId:null,locked:true},{sessionId:'daily',scopeId:'sales',version:2,roleId:role,locked:true},{sessionId:'daily',scopeId:'sales',version:1,roleId:role,locked:true}]){
  const f=fixture(),before=f.input;let release!:()=>void,started!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve}),entered=new Promise<void>(resolve=>{started=resolve})
  f.port.verify=async()=>{started();await barrier;return {...selection,context}}
  const pending=insertBusinessReassignmentInput(selection,'daily',f.port);await entered;release();await assert.rejects(pending);assert.equal(f.writes.length,0);assert.equal(f.input,before);assert.equal(f.listeners.size,0)
 }
})
