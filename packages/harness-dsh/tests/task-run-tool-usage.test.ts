import test from 'node:test'
import assert from 'node:assert/strict'
import type {SessionEvent} from '@deepseek-ai/dsh-session'
import {defineTool} from '@deepseek-ai/dsh-tools'
import {ToolCallId,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {projectTaskRunToolUsage,leaseTaskRunToolUsage} from '../src/task-run-tool-usage.ts'
import {loopWorkFixture,loopText} from './fixtures/native-loop-work-admission.ts'

const prefix='mcp__soc-live-alerts__',names=['get_current_time','get_security_knowledge_base','splunk_get_alert','splunk_search','list_assets'].map(name=>prefix+name)
const binding={nativeRequestId:'fixed-request',allowedTools:names}
function trace(){
 const events:SessionEvent[]=[]
 const push=(type:string,data:unknown,extra:Record<string,unknown>={})=>{const event={seq:events.length,time:Date.parse('2026-10-28T14:24:00Z')+events.length*1000,type,data,...extra} as SessionEvent;events.push(event);return event}
 const start=(turn=1,source:unknown={kind:'user',rpcId:binding.nativeRequestId})=>{push('turn/start',{turn});push('user/message',{id:'input-'+turn,source,content:[{type:'text',text:'执行同一任务'}]},{surfaceOp:'append'})}
 const call=(name:string,id='call-'+events.length,turn=1,step=1)=>push('tool/call',{turn,step,callId:id,name,arguments:'{}'}) as Extract<SessionEvent,{type:'tool/call'}>
 const result=(call:Extract<SessionEvent,{type:'tool/call'}>,isError=false,error?:{name:string;code:string})=>push('tool/result',{turn:call.data.turn,step:call.data.step,message:{toolCallId:call.data.callId,isError,content:[{type:'text',text:isError?'failed':'ok'}]},...(error?{error}:{})},{sourceEventSeqs:[call.seq],surfaceOp:'append'})
 const end=(turn=1,kind='completed')=>push('turn/end',{turn,reason:{kind}})
 const ptc=(parent:Extract<SessionEvent,{type:'tool/call'}>,subCallId:string,name=names[3]!,isError=false,settle=true)=>{const data={rootCallId:parent.data.callId,parentCallId:parent.data.callId,subCallId,name,arguments:{}};push('tool/ptc-dispatch-start',data);if(settle)push('tool/ptc-dispatch',{...data,isError,content:[{type:'text',text:'ok'}]})}
 return {events,push,start,call,result,end,ptc,read:()=>projectTaskRunToolUsage(binding,events)}
}

test('真实十三项分布精确为元数据2、规则2、Splunk8、资产1；本地工具不计MCP',()=>{
 const f=trace();f.start()
 const distribution=[names[0]!,names[1]!,names[2]!,names[2]!,...Array(8).fill(names[3]!),names[4]!]
 for(const name of [...distribution,'teloa_knowledge_search','teloa_knowledge_search','teloa_business_object_result_record','mcp__teloa_reference__read_reference','mcp__playwright-mcp__browser_close'])f.result(f.call(name))
 f.end()
 const {usage}=f.read()
 assert.equal(usage.coverage,'complete');assert.deepEqual(usage.counts,{requested:13,returned:13,succeeded:13,failed:0,pending:0})
 assert.deepEqual(Object.fromEntries(usage.byTool!.map(row=>[row.name,row.requested])),{[names[0]!]:1,[names[1]!]:1,[names[2]!]:2,[names[3]!]:8,[names[4]!]:1})
 assert.deepEqual(usage.observedWindow,{firstEventAt:'2026-10-28T14:24:01.000Z',lastEventAt:'2026-10-28T14:24:38.000Z'})
})

test('失败、原生拒绝、派发前取消都属于工具请求和错误返回；重试是新请求',()=>{
 const f=trace();f.start()
 for(const error of [undefined,{name:'ToolArgsError',code:'INVALID_ARGUMENTS'},{name:'Error',code:'UNKNOWN'},{name:'AbortError',code:'ABORTED_BEFORE_DISPATCH'}])f.result(f.call(names[3]!),true,error)
 f.result(f.call(names[3]!));f.end()
 assert.deepEqual(f.read().usage.counts,{requested:5,returned:5,succeeded:1,failed:4,pending:0})
})

test('业务payload超时或空结果的原生非错误返回不被投影器猜成业务成功或失败',()=>{
 const f=trace();f.start()
 for(const payload of [{status:'timeout'},{status:'invalid_request'},{status:'success',total:0,results:[]}]){
  const call=f.call(names[3]!)
  f.push('tool/result',{turn:call.data.turn,step:call.data.step,message:{toolCallId:call.data.callId,isError:false,content:[{type:'text',text:JSON.stringify(payload)}]}},{sourceEventSeqs:[call.seq],surfaceOp:'append'})
 }
 assert.deepEqual(f.read().usage.counts,{requested:3,returned:3,succeeded:3,failed:0,pending:0},'succeeded仅原生isError:false，不解释工具正文')
})

test('固定完整公开名独立计数，不按raw名去重或拆分经过缩短的别名',()=>{
 const f=trace();f.start()
 const aliases=['mcp__soc-live-alerts__splunk_search','mcp__soc_live_alerts__splunk_search_7c54a55d']
 for(const name of aliases)f.result(f.call(name))
 const value=projectTaskRunToolUsage({...binding,allowedTools:aliases},f.events).usage
 assert.equal(value.coverage,'complete');assert.equal(value.counts!.requested,2);assert.equal(value.byTool!.length,2)
 f.result(f.call('mcp__not_frozen__query'))
 const unknown=projectTaskRunToolUsage({...binding,allowedTools:aliases},f.events).usage
 assert.equal(unknown.coverage,'partial');assert.ok(unknown.reasons.includes('unverified-mcp-name'));assert.equal(unknown.counts!.requested,2)
})

test('当前Run前后其他会话轮次不计入，原生合法后台续轮保留原累计',()=>{
 const f=trace();f.start(0,{kind:'user',rpcId:'older-request'});f.result(f.call(names[3]!,'same-id',0));f.end(0)
 f.start(1);f.result(f.call(names[3]!,'same-id',1));f.end(1)
 f.start(2,{kind:'tool-jobs',form:'notice',summary:'原工作已完成'});f.result(f.call(names[3]!,'same-id',2));f.end(2)
 assert.equal(f.read().usage.counts!.requested,2,'跨合法续轮复用callId由call.seq与sourceEventSeqs区分')
 f.start(3,{kind:'user',rpcId:'different-request'});f.result(f.call(names[3]!,'same-id',3));f.end(3)
 assert.equal(f.read().usage.counts!.requested,2,'其他本人请求不归入旧Run')
 assert.equal(f.read().authorized,false)
})

test('缺回执保持pending；终态取消不推算工具失败或外部是否派发',()=>{
 const f=trace();f.start();f.call(names[3]!)
 assert.equal(f.read().usage.coverage,'complete');assert.equal(f.read().usage.counts!.pending,1)
 f.end(1,'cancelled')
 assert.equal(f.read().usage.coverage,'partial');assert.equal(f.read().usage.counts!.pending,1);assert.equal(f.read().usage.counts!.failed,0)
 assert.ok(f.read().usage.reasons.includes('unreturned-at-end'))
})

test('配对必须同callSeq/turn/step，重复或伪造返回不多计完成',()=>{
 const f=trace();f.start();const call=f.call(names[3]!)
 f.push('tool/result',{turn:2,step:1,message:{toolCallId:call.data.callId,isError:false}},{sourceEventSeqs:[call.seq]})
 assert.equal(f.read().usage.coverage,'partial');assert.equal(f.read().usage.counts!.returned,0)
 f.result(call);f.result(call)
 assert.equal(f.read().usage.counts!.returned,1);assert.equal(f.read().usage.counts!.requested,1)
})

test('PTC子调用按真实start/settle计数，outer失败不覆盖子成功',()=>{
 const f=trace();f.start();const parent=f.call('run_code','outer')
 f.ptc(parent,'outer:ptc:1');f.ptc(parent,'outer:ptc:2',names[3]!,true);f.result(parent,true);f.end()
 assert.deepEqual(f.read().usage.counts,{requested:2,returned:2,succeeded:1,failed:1,pending:0});assert.equal(f.read().usage.coverage,'complete')
})

test('PTC跨续轮同subCallId不吞并；已关闭父窗口的迟到settle不能认领下一次调用',()=>{
 const f=trace();f.start();const first=f.call('run_code','outer');f.ptc(first,'outer:ptc:1');f.result(first);f.end()
 f.start(2,{kind:'tool-jobs',form:'notice',summary:'原工作续轮'});const second=f.call('run_code','outer',2);f.ptc(second,'outer:ptc:1');f.result(second);f.end(2)
 assert.equal(f.read().usage.counts!.requested,2);assert.equal(f.read().usage.counts!.returned,2)
 const late=trace();late.start();const parent=late.call('run_code','outer');late.ptc(parent,'outer:ptc:1',names[3]!,false,false);late.result(parent,true)
 late.push('tool/ptc-dispatch',{rootCallId:'outer',parentCallId:'outer',subCallId:'outer:ptc:1',name:names[3],arguments:{},isError:false,content:[]});late.end()
 assert.equal(late.read().usage.coverage,'partial');assert.equal(late.read().usage.counts!.pending,1);assert.equal(late.read().usage.counts!.returned,0)
})

test('孤立/歧义PTC与子Agent目录标明partial，不伪称整个Run总量',()=>{
 const f=trace();f.start();const a=f.call('run_code','outer');f.call('run_code','outer');f.ptc(a,'outer:ptc:1')
 f.push('subagent/catalog',{childId:'registered-child'});f.end()
 const value=f.read().usage;assert.equal(value.coverage,'partial');assert.equal(value.counts!.requested,0)
 assert.ok(value.reasons.includes('unproven-ptc'));assert.ok(value.reasons.includes('child-sessions-excluded'))
})

test('宿主日志时间只给原生观测范围；缺失、倒退或超界时间不猜补',()=>{
 for(const invalid of [undefined,NaN,-1,8640000000000001,Date.parse('2026-10-28T00:00:00Z')]){
  const f=trace();f.start();f.result(f.call(names[0]!));f.end()
  Reflect.set(f.events[2]!,'time',invalid)
  assert.equal(f.read().usage.observedWindow,undefined)
  assert.equal(f.read().usage.counts!.requested,1)
 }
 const bad=trace();bad.start();Reflect.set(bad.events[1]!,'seq',4)
 assert.equal(bad.read().usage.coverage,'unavailable');assert.equal(bad.read().usage.counts,undefined)
})

const toolChunks=(names:readonly string[]):StreamChunk[]=>[...names.flatMap((name,index):StreamChunk[]=>[
 {type:'block-start',index,blockType:'tool-call'},
 {type:'tool-call-delta',index,id:ToolCallId('native-'+index),name,argumentsDelta:'{}'},
 {type:'block-end',index,block:{type:'tool-call',id:ToolCallId('native-'+index),name,arguments:'{}'}},
]),{type:'finish',reason:{kind:'tool-calls'}}]

test('真实Loop下一请求收到同Run可信计数与宿主采时范围，拒绝/取消仍计错且不增步',{timeout:10000},async t=>{
 const f=await loopWorkFixture(t,true),actual=[prefix+'ok',prefix+'denied',prefix+'cancelled'];let bodies=0
 for(const name of actual)f.ctx.tools.register(defineTool({name,description:'隔离计数夹具',parameters:{},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},execute:async()=>{bodies++;return 'ok'}}))
 f.ctx.on('tools/pre-execute',async(exec,next)=>exec.name===actual[1]?{kind:'deny',reason:'原生拒绝'}:exec.name===actual[2]?{kind:'cancel'}:next())
 const dispose=leaseTaskRunToolUsage(f.agent,{id:'fixed-run',sessionId:f.agent.session.id,nativeRequestId:'loop-input',allowedTools:actual});t.after(dispose)
 f.adapter.scripts.push(toolChunks(actual),loopText);await f.send()
 assert.equal(f.adapter.requests.length,2);assert.equal(bodies,1)
 const text=JSON.stringify(f.adapter.requests[1])
 assert.match(text,/Host-verified MCP tool usage/);assert.match(text,/not external HTTP calls/)
 assert.match(text,/does not prove business-payload success/);assert.match(text,/do not call all evidence collection successful/)
 assert.match(text,/\\"requested\\":3,\\"returned\\":3,\\"succeeded\\":1,\\"failed\\":2,\\"pending\\":0/)
 assert.match(text,/firstEventAt/);assert.match(text,/never estimate individual collection times/)
 assert.match(text,/not replace their verified figures/);assert.match(text,/do not apply this range to historical evidence/)
 assert.equal(f.events.filter(event=>event.type==='turn/start').length,1);assert.equal(f.events.filter(event=>event.type==='turn/end').length,1)
 assert.ok(f.events.some(event=>event.type==='user/message'&&event.data.source.kind==='runtime-context'&&event.data.content.some(part=>part.type==='text'&&part.text.includes('hostVerified'))))
 assert.equal(f.events.some(event=>event.type==='user/message'&&String(event.data.source.kind).includes('tool-usage')),false,'不自行伪造用户或工具事件')
})

test('宿主续轮读口失败只给unavailable，不用零次或旧次数替代',{timeout:10000},async t=>{
 const f=await loopWorkFixture(t,true),name=names[0]!
 f.ctx.tools.register(defineTool({name,description:'隔离夹具',parameters:{},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},execute:async()=> 'ok'}))
 const dispose=leaseTaskRunToolUsage(f.agent,{id:'fixed-run',sessionId:f.agent.session.id,nativeRequestId:'loop-input',allowedTools:[name]},{continuations:async()=>{throw Error('unavailable')}});t.after(dispose)
 f.adapter.scripts.push(toolChunks([name]),loopText);await f.send()
 const latest=f.events.filter(event=>event.type==='user/message'&&event.data.source.kind==='runtime-context').at(-1)
 assert.ok(latest?.type==='user/message');assert.match(JSON.stringify(latest.data),/unavailable/)
 assert.doesNotMatch(JSON.stringify(latest.data),/requested|firstEventAt/)
})

test('计数租约不污染其他用户轮，dispose后官方上下文不残留当前可信快照',{timeout:10000},async t=>{
 const f=await loopWorkFixture(t,true),name=names[0]!
 f.ctx.tools.register(defineTool({name,description:'隔离夹具',parameters:{},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},execute:async()=> 'ok'}))
 const dispose=leaseTaskRunToolUsage(f.agent,{id:'fixed-run',sessionId:f.agent.session.id,nativeRequestId:'loop-input',allowedTools:[name]})
 f.adapter.scripts.push(toolChunks([name]),loopText);await f.send()
 f.adapter.scripts.push(loopText);await f.send('another-owner-request')
 const latest=f.events.filter(event=>event.type==='user/message'&&event.data.source.kind==='runtime-context').at(-1)
 assert.ok(latest?.type==='user/message');assert.match(JSON.stringify(latest.data),/outside-active-run/);assert.doesNotMatch(JSON.stringify(latest.data),/\\"requested\\":1/)
 dispose()
 const assembled=await f.ctx.systemPrompt.assemble({agent:f.agent})
 assert.equal(assembled.contexts.some(row=>row.name==='teloa:run-mcp-tool-usage'),false)
})
