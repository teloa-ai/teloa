import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync} from 'node:fs'
const file=new URL('../src/client/business-record-input.ts',import.meta.url)
const reference={scope:'sales',type:'order',id:'one',version:2,snapshotHash:'a'.repeat(64)}
async function load(){assert.ok(existsSync(file),'缺少记录引用的原生输入保护');return import('../src/client/business-record-input.ts')}
function fixture(){
 let input:any={draft:'',draftRev:1,phase:'plain',attachmentIds:[],occurrences:[],queue:[]},current=true,unknown=false,pending:any[]=[],writes:any[]=[]
 const listeners=new Set<()=>void>()
 const port={switching:{read:()=>({mainSessionId:'daily',bindingSessionId:'daily',bindingReady:true,input,pendingSubmissions:pending,monitor:{getSnapshot:()=>unknown,check:async()=>{}}})},isCurrent:()=>current,verify:async()=>({...reference,title:'订单'}),state:{getSnapshot:()=>input,subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn)}}},insert:(request:any)=>{writes.push(request);input={...input,draft:'￼',draftRev:input.draftRev+1,occurrences:[{...request.reference,invalid:false}]};for(const fn of listeners)fn();return true as const}}
 return {port,writes,setInput:(patch:any)=>{input={...input,...patch}},setCurrent:()=>{current=false},setUnknown:()=>{unknown=true},setPending:()=>{pending=[{requestId:'pending'}]}}
}
test('同本人同daily空输入核对固定历史快照后仅CAS插入chip，不发送',async()=>{
 const {insertBusinessRecordInput}=await load(),f=fixture();await insertBusinessRecordInput(reference,'daily',f.port)
 assert.equal(f.writes.length,1);assert.equal(f.writes[0].span.draftRev,1);assert.match(f.writes[0].reference.ref,/\|2\|/)
})
test('草稿/附件/引用/队列/unknown/pending均拒绝且不修改原输入',async()=>{
 const {insertBusinessRecordInput}=await load()
 for(const patch of [{draft:'已有稿'},{attachmentIds:['image']},{occurrences:[{ref:'old'}]},{queue:[{id:'q'}]},{phase:'submitting'}]){const f=fixture();f.setInput(patch);await assert.rejects(()=>insertBusinessRecordInput(reference,'daily',f.port));assert.equal(f.writes.length,0)}
 for(const kind of ['unknown','pending']){const f=fixture();if(kind==='unknown')f.setUnknown();else f.setPending();await assert.rejects(()=>insertBusinessRecordInput(reference,'daily',f.port));assert.equal(f.writes.length,0)}
})
test('异步历史核对中编辑/换本人或scope/hash不一致均零插入',async()=>{
 const {insertBusinessRecordInput}=await load()
 for(const kind of ['edit','owner','scope','hash']){const f=fixture();f.port.verify=async()=>{if(kind==='edit')f.setInput({draft:'新稿',draftRev:2});if(kind==='owner')f.setCurrent();return {...reference,title:'订单',...(kind==='scope'?{scope:'other'}:{}),...(kind==='hash'?{snapshotHash:'b'.repeat(64)}:{})}};await assert.rejects(()=>insertBusinessRecordInput(reference,'daily',f.port));assert.equal(f.writes.length,0)}
})
test('原生未接收不伪称成功，结果不一致保留已出现输入且拒绝重放',async()=>{
 const {insertBusinessRecordInput}=await load(),f=fixture();f.port.insert=()=>undefined as any;await assert.rejects(()=>insertBusinessRecordInput(reference,'daily',f.port))
 const g=fixture();g.port.insert=()=>{g.setInput({draft:'其他输入',draftRev:2});return true};await assert.rejects(()=>insertBusinessRecordInput(reference,'daily',g.port));assert.equal(g.writes.length,0)
})
