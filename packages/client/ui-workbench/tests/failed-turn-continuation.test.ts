import test from 'node:test'
import assert from 'node:assert/strict'
import {createFailedTurnContinuation,latestContinuableFailure,latestRetryableRequest,type ContinuationFacts,type FailedRequest} from '../src/client/failed-turn-continuation.ts'
import {draftContinuityCopy} from '../src/client/draft-continuity-copy.ts'
const oldId='11111111-1111-4111-8111-111111111111',rpc='22222222-2222-4222-8222-222222222222',newId='33333333-3333-4333-8333-333333333333',newRpc='44444444-4444-4444-8444-444444444444'
const event=(seq:number,type:string,data:unknown)=>({type:'event',event:{seq,time:seq,type,data}} as any)
const originalText='原问题\n@资料与中文原文  内部空白保留'
const message=(text=originalText,source:unknown={kind:'user',rpcId:rpc},content:unknown=[{type:'text',text}])=>({role:'user',id:oldId,source,content})
const failed=()=>[event(0,'turn/start',{turn:1}),event(1,'step/start',{turn:1,step:1}),event(2,'user/message',message()),event(3,'assistant/attempt',{turn:1,step:1,stream:[]}),event(4,'turn/end',{turn:1,reason:{kind:'error',error:{code:'NETWORK',message:'failure'}}})]
function fixture(){
 let facts:ContinuationFacts&{submissions:readonly {requestId:string;text:string}[]}={owner:'owner-A',binding:{},current:true,ready:true,blocked:false,running:false,pending:false,unknown:false,editable:true,empty:true,entries:failed(),submissions:[]}
 const sent:{text:string;request:FailedRequest}[]=[],observed:unknown[]=[],listeners=new Set<()=>void>();let eligibility:()=>Promise<string|undefined>=async()=>JSON.stringify(['owner-A','SOC',null,2])
 // 旧消费者的诊断回调即使残留，也不能再按同文echo推断新事件的因果归属。
 const legacyPorts={read:()=>facts,subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn)}},eligible:()=>eligibility(),send:(text:string,request:FailedRequest)=>{sent.push({text,request})},observed:(row:unknown)=>observed.push(row)}
 const port=createFailedTurnContinuation(legacyPorts)
 return {port,sent,observed,set:(patch:Partial<typeof facts>)=>{facts={...facts,...patch};for(const fn of listeners)fn()},eligible:(value:()=>Promise<string|undefined>)=>{eligibility=value}}
}
test('本人已接受原请求精确关联turn/message/rpc，保留内部空白与引用原文，不注入继续指令',async()=>{
 const entries=failed(),original=JSON.stringify(entries),f=fixture()
 assert.equal(f.port.available(4),true);await f.port.continue(4)
 assert.equal(f.sent.length,1);assert.equal(f.sent[0]!.text,originalText)
 assert.deepEqual(f.sent[0]!.request,{failureSeq:4,turn:1,messageSeq:2,messageId:oldId,requestId:rpc,text:originalText})
 assert.equal(JSON.stringify(entries),original);assert.equal(f.port.available(4),false)
})
test('第一次点击尚在fresh核对及已发但尚无新回执时，双击均不重发',async()=>{
 const f=fixture(),first=f.port.continue(4);await assert.rejects(f.port.continue(4));await first;await assert.rejects(f.port.continue(4));assert.equal(f.sent.length,1)
})
test('已有工具动作、成功、取消、旧错误或缺完整turn/step均不给重试',()=>{
 for(const entries of [
  [...failed().slice(0,3),event(3,'tool/call',{}),...failed().slice(4)],
  [...failed().slice(0,4),event(4,'turn/end',{turn:1,reason:{kind:'completed'}})],
  [...failed().slice(0,4),event(4,'turn/end',{turn:1,reason:{kind:'aborted'}})],
  [...failed(),event(5,'user/message',message())],[...failed(),event(5,'agent/inbox/spliced',{inserted:[{}]})],[...failed(),event(5,'turn/start',{turn:2})],failed().slice(1),failed().filter(row=>row.event.type!=='step/start'),
 ])assert.equal(latestContinuableFailure(entries),undefined)
})
test('File/image/混合文本块不丢内容，多本人输入、无受理rpc、代理principal均不冒充原请求',()=>{
 for(const row of [message('',{kind:'user',rpcId:rpc},[{type:'image',data:'not-read'}]),message('',{kind:'user',rpcId:rpc},[{type:'file',path:'not-read'}]),message('',{kind:'user',rpcId:rpc},[{type:'text',text:'a'},{type:'text',text:'b'}]),message('x',{kind:'user'}),message('x',{kind:'user',rpcId:rpc,principal:{id:'foreign'}}),message('x',{kind:'tool'}),message('/some-command'),message(' 首尾空白'),message('尾部空白 '),message('\n首尾换行\n'),message('',{kind:'user',rpcId:rpc},[{type:'text',text:'x',unknown:true}])]){
  const entries=failed();entries[2]=event(2,'user/message',row);assert.equal(latestRetryableRequest(entries),undefined)
 }
 assert.equal(latestRetryableRequest([...failed().slice(0,3),event(3,'user/message',{...message(),id:newId}),...failed().slice(3)]),undefined)
})
test('切换、离线、身份未知、已有草稿/附件、发送中和unknown均不给动作',async()=>{
 for(const patch of [{owner:null},{current:false},{ready:false},{blocked:true},{running:true},{pending:true},{unknown:true},{editable:false},{empty:false}]){
  const f=fixture();f.set(patch);assert.equal(f.port.available(4),false);await assert.rejects(f.port.continue(4));assert.deepEqual(f.sent,[])
 }
})
test('fresh核对等待期间换owner/binding、编辑、终态或新输入变化均不写入新草稿',async()=>{
 for(const patch of [{owner:'owner-B'},{binding:{}},{empty:false},{entries:[...failed(),event(5,'user/message',message())]}]){
  const f=fixture();let done!:(value:string)=>void,calls=0;f.eligible(()=>++calls===1?new Promise(resolve=>{done=resolve}):Promise.resolve('same-context'))
  const pending=f.port.continue(4);f.set(patch);done('same-context');await assert.rejects(pending);assert.deepEqual(f.sent,[])
 }
})
test('业务scope/role/version或owner fresh指纹变化、资格拒绝不得submit',async()=>{
 for(const next of [undefined,'other-business','other-version','other-owner']){
  const f=fixture();let calls=0;f.eligible(async()=>++calls===1?'original-context':next);await assert.rejects(f.port.continue(4));assert.deepEqual(f.sent,[])
 }
})
test('保留真实新durable事件，但不按同文pending echo推断retryOf关联',async()=>{
 const f=fixture(),off=f.port.subscribe(()=>{});await f.port.continue(4);assert.deepEqual(f.observed,[])
 f.set({entries:[...failed(),event(5,'user/message',message())]});assert.deepEqual(f.observed,[])
 f.set({entries:[...failed(),event(5,'user/message',{...message('其他输入'),id:newId,source:{kind:'user',rpcId:newRpc}})]});assert.deepEqual(f.observed,[])
 f.set({submissions:[{requestId:newRpc,text:originalText}],entries:[...failed(),event(5,'user/message',{...message(),id:newId,source:{kind:'user',rpcId:newRpc}})]})
 assert.deepEqual(f.observed,[]);f.set({});assert.equal(f.observed.length,0);assert.equal(f.port.available(4),false);off()
})
test('发送边界抛错视为可能未知，不再使用该按钮自动重发；其他原输入/失败仍在',async()=>{
 const facts:ContinuationFacts={owner:'a',binding:{},current:true,ready:true,blocked:false,running:false,pending:false,unknown:false,editable:true,empty:true,entries:failed()};let sends=0
 const port=createFailedTurnContinuation({read:()=>facts,subscribe:()=>()=>{},eligible:async()=>'context',send:()=>{sends++;throw Error('unknown')}})
 await assert.rejects(port.continue(4));await assert.rejects(port.continue(4));assert.equal(sends,1);assert.equal(facts.entries.length,5)
})
test('标题事件不改变失败资格，三语言文案明确重新提交原文而非继续prompt',()=>{
 assert.equal(latestContinuableFailure([...failed(),event(5,'session/title',{})]),4)
 for(const locale of ['zh-CN','zh-Hant','en'] as const)assert.ok(draftContinuityCopy(locale,'help').length)
 assert.equal(draftContinuityCopy('zh-CN','continue'),'重试回答')
})

test('迟到的真实回执在owner切换后不串入关联',async()=>{
 const f=fixture(),off=f.port.subscribe(()=>{});await f.port.continue(4);f.set({owner:'owner-B',entries:[...failed(),event(5,'user/message',{...message(),id:newId,source:{kind:'user',rpcId:newRpc}})]});assert.deepEqual(f.observed,[]);off()
})

test('beginSubmission前抛错后，本人另发同文新rpc不被误记为retryOf',async()=>{
 let facts:ContinuationFacts&{submissions:readonly {requestId:string;text:string}[]}={owner:'owner-A',binding:{},current:true,ready:true,blocked:false,running:false,pending:false,unknown:false,editable:true,empty:true,entries:failed(),submissions:[]}
 const listeners=new Set<()=>void>(),observed:unknown[]=[];let sends=0
 const legacyPorts={read:()=>facts,subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn)}},eligible:async()=>'context',send:()=>{sends++;throw Error('before SDK beginSubmission')},observed:(row:unknown)=>observed.push(row)}
 const port=createFailedTurnContinuation(legacyPorts),off=port.subscribe(()=>{})
 await assert.rejects(port.continue(4));facts={...facts,pending:true,submissions:[{requestId:newRpc,text:originalText}]};for(const fn of listeners)fn()
 facts={...facts,entries:[...failed(),event(5,'user/message',{...message(),id:newId,source:{kind:'user',rpcId:newRpc}})]};for(const fn of listeners)fn()
 assert.equal(sends,1);assert.deepEqual(observed,[]);assert.equal(port.available(4),false);assert.equal(facts.entries.at(-1)?.type,'event');off()
})
