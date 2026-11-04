import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import type {StreamChunk} from '@deepseek-ai/dsh-llm'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {nativeRunContinuationKey} from '../src/task-run-team-records.ts'
import type {SessionEvent} from '@deepseek-ai/dsh-session'
import {defineTool} from '@deepseek-ai/dsh-tools'
import {createReviewSourceCatalog,deliveryRepairProtocol,deliveryReviewProtocol,deliveryReviewSource,deliveryReviewToolName,deliveryRoundData,draftSha256,leaseTaskDeliveryReview,splitReviewUnits,type DeliveryReviewTrace,type ReviewMaterial,type ReviewRound} from '../src/task-delivery-review.ts'
import {readTaskRunGroupResult} from '../src/task-run-group-result.ts'
import {registerTaskToolGuard} from '../src/task-tool-guard.ts'
import {readDeliveryReviewCheckpoint} from '../src/task-delivery-review.ts'
import {loopWorkFixture} from './fixtures/native-loop-work-admission.ts'

type Reply=readonly StreamChunk[]
const text=(value:string):Reply=>[{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text:value},{type:'block-end',index:0,block:{type:'text',text:value}},{type:'finish',reason:{kind:'stop'}}]
let serial=0
const call=(args:unknown,name=deliveryReviewToolName):Reply=>[
 {type:'block-start',index:0,blockType:'tool-call'},
 {type:'block-end',index:0,block:{type:'tool-call',id:'repair-call-'+(++serial),name,arguments:name==='investigation_probe'?JSON.stringify(args):args}},
 {type:'finish',reason:{kind:'tool-calls'}},
] as unknown as Reply
const goal='只有独立付款凭据可标A级；口述且无凭据为待核。当前甲店仅口述付款，资料未提供凭据。'
const catalog=createReviewSourceCatalog([{id:'goal',kind:'goal',title:'原目标',text:goal,origin:{field:'inputText',pointer:'/task/goal'}}])
const passage=catalog.passages.find(row=>row.sourceId==='goal');assert.ok(passage)
const basis=[{sourceId:'goal',passageId:passage.id}]
const material:ReviewMaterial={goal,inputs:{knowledge:0,group:false,context:false},methods:[],catalog}
const draft='甲店：A级。',middle='甲店：已付款（口述），A级。',fixed='甲店：待核；仅口述付款，未提供独立付款凭据。'
const checks=(state:'pass'|'fail'|'unknown'='pass')=>(['goal',1,2,3,4,5,6,7,8] as const).map(id=>({id,status:id===1?state:'pass'}))
const revise=(after?:string)=>({phase:'revise',issues:after===undefined?[]:[{problem:'按原资料修正分类及其依据。',basis:basis.map(ref=>({...ref})),affectedBlockIds:[1],coverage:{change:[1],retain:[],unrelated:[],unknown:[]},edits:[{blockId:1,after}]}]})
const findings=[{problem:'A级缺少独立付款凭据，按冻结规则应为待核。',basis,blockIds:[1]}]
const verify=(ids:readonly string[]=[],verdict:'accept'|'reject'='accept',state:'pass'|'fail'|'unknown'='pass',withFinding=false)=>({phase:'verify',verdict,checks:checks(state),changeChecks:ids.map(issueId=>({issueId,status:'verified',reviewedBlockIds:[1]})),findings:withFinding?structuredClone(findings):[]})
const r2Reject=()=>verify([],'reject','fail',true)
// 合法回执按模型自己的顺序列依赖，冷读不能把顺序差异误认作缺项。
const r4Accept=(first=false)=>verify(first?['r3:u1:i1','r2:u1:f1','r1:u1:i1']:['r2:u1:f1','r3:u1:i1'])
const ends=(events:readonly SessionEvent[])=>events.flatMap(event=>event.type==='turn/end'?[event.data.reason.kind]:[])
const clone=(events:readonly SessionEvent[])=>JSON.parse(JSON.stringify(events)) as SessionEvent[]
const delivered=(events:readonly SessionEvent[])=>events.filter((event):event is Extract<SessionEvent,{type:'user/message'}>=>event.type==='user/message'&&event.surfaceOp==='append'&&event.data.source.kind===deliveryReviewSource&&Reflect.get(event.data.source,'summary')==='复核后交付')

/** 原版官方 Loop/ToolRuntime，只替换模型流；每个场景固定输入队列，实际额外调用会使测试失败。 */
async function runtime(t:TestContext,scripts:Reply[],investigation=false,patched=false){
 const f=await loopWorkFixture(t,!patched),traces:DeliveryReviewTrace[]=[]
 f.adapter.scripts.push(...scripts)
 let probes=0
 const allowedTools=investigation?['investigation_probe']:[]
 if(investigation)f.ctx.tools.register(defineTool({name:'investigation_probe',description:'本机合成调查取证',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{probes++;return '原资料不建立独立付款凭据。'}}))
 const nativeContinuations=new Set<string>()
 registerTaskToolGuard(f.ctx,async()=>({allowedTools,nativeRequestId:'loop-input'}),[],undefined,undefined,undefined,patched?{authorizeMember:async()=>false,continuations:async()=>nativeContinuations}:undefined)
 leaseTaskDeliveryReview(f.agent,{runId:'repair-run',requestId:'loop-input',material,trace:entry=>{traces.push(entry)},publish:async message=>{f.agent.inject(message)},...(investigation?{requireReview:true,readExecution:async()=>({runId:'repair-run',sessionId:f.agent.id,requestId:'loop-input',allowedTools,continuationMessageIds:new Set<string>(),runtimeLinks:[],jobs:[],pendingJobCompletion:false,pendingInput:false,children:'none' as const,flow:'none' as const})}:{})})
 return {...f,traces,nativeContinuations,probes:()=>probes}
}
const result=(events:readonly SessionEvent[])=>readTaskRunGroupResult(events,'loop-input',undefined,undefined,{requireReview:true,runId:'repair-run'})
const successScripts=(first=false)=>{
 const rejection=first?verify(['r1:u1:i1'],'reject','fail',true):r2Reject(),repair=revise(fixed)
 // 同一片段重复引用是既有合法输入，宿主去重后的真实回执须仍可冷读。
 if(!first){rejection.findings[0]!.basis.push({...basis[0]!});repair.issues[0]!.basis.push({...basis[0]!})}
 return [text(draft),call(revise(first?middle:undefined)),call(rejection),call(repair),call(r4Accept(first))]
}

test('真实Loop：R1漏检后R2有据拒绝，同Run唯一R3修正与R4独立验收才交付，冷读全文相同',async t=>{
 for(const first of [false,true])await t.test(first?'保留R1问题依赖':'R1空问题实际失败形态',async sub=>{
  const f=await runtime(sub,successScripts(first));await f.send()
  assert.deepEqual(ends(f.events),['completed'])
  assert.equal(f.adapter.requests.length,5,'草稿及四轮复核，无新Run或额外R5')
  assert.equal(result(f.events),fixed)
  assert.equal(result(clone(f.events)),fixed)
  const output=delivered(f.events);assert.equal(output.length,1)
  const source=output[0]!.data.source,rounds=Reflect.get(source,'rounds') as {round:number;protocol:string;verdict:string;units:{changeChecks?:{issueId:string}[]}[]}[]
  assert.equal(Reflect.get(source,'protocol'),deliveryRepairProtocol)
  assert.equal(Reflect.get(source,'deliverySha256'),draftSha256(fixed))
  assert.deepEqual(rounds.map(row=>[row.round,row.protocol,row.verdict]),[[1,deliveryReviewProtocol,'pending'],[2,deliveryReviewProtocol,'rejected'],[3,deliveryRepairProtocol,'pending'],[4,deliveryRepairProtocol,'accepted']])
  if(first)assert.deepEqual(rounds[3]!.units[0]!.changeChecks!.map(row=>row.issueId),['r3:u1:i1','r2:u1:f1','r1:u1:i1'],'同一完整依赖集可按不同顺序提交')
  assert.ok(f.events.filter(event=>event.type==='tool/result').every(event=>event.type==='tool/result'&&!event.data.message.isError),'有据reject是合法回执，不能改写成工具错误')
  assert.equal(f.events.filter(event=>event.type==='turn/start').length,1)
  assert.ok(f.adapter.requests.slice(1).every(request=>request.tools?.length===1&&request.tools[0]!.name===deliveryReviewToolName),'修订不扩大岗位工具许可')
  assert.equal(f.events.filter(event=>event.type==='user/message'&&event.data.source.kind==='user').length,1,'不以新增用户指令触发修复')
 })
})

test('持久复核冷状态接原Run：各轮成功回执先折叠，R4已受理零额外模型，冷热同文',{timeout:20000},async t=>{
 for(const cut of [1,2,3,4])await t.test('R'+cut,async sub=>{
  const f=await runtime(sub,successScripts(),false,true)
  let saved:ReturnType<typeof readDeliveryReviewCheckpoint>=null
  f.agent.ctx.on('session/event',(session,event)=>{
   if(session!==f.agent.session||event.type!=='step/end'||saved)return
   const c=readDeliveryReviewCheckpoint(f.agent);if(!c)return
   const state=JSON.parse(c.json)
   if(state.current.round!==cut||!state.submission)return
   saved=structuredClone(c);f.agent.cancel({kind:'disposed'})
  })
  await f.send();assert.ok(saved);const oldPrefix=[...f.events],before=f.adapter.requests.length
  assert.deepEqual(ends(f.events),['aborted'])
  leaseTaskDeliveryReview(f.agent,{runId:'repair-run',requestId:'loop-input',material,restore:saved,trace:entry=>f.traces.push(entry),publish:async message=>{f.agent.inject(message)}})
  const id='resume-r'+cut,message=createUserMessage({source:{kind:'plugin:teloa.session-continuation',continuationId:id,form:'notice',summary:'继续原执行'},content:[{type:'text',text:'继续原工作'}]})
  f.nativeContinuations.add(nativeRunContinuationKey(id))
  f.agent.followup(message);await f.agent.whenIdle()
  assert.deepEqual(f.events.slice(0,oldPrefix.length),oldPrefix)
  assert.equal(f.adapter.requests.length,5,'草稿及原四轮调用总额不重置 '+JSON.stringify({ends:ends(f.events),traces:f.traces.slice(-4),errors:f.events.filter(e=>e.type==='tool/result'&&e.data.message.isError)}))
  if(cut===4)assert.equal(f.adapter.requests.length,before,'已成功R4只做宿主正式交付')
  const trusted=new Set([nativeRunContinuationKey(id)])
  assert.equal(readTaskRunGroupResult(f.events,'loop-input',trusted,undefined,{requireReview:true,runId:'repair-run'}),fixed,JSON.stringify({ends:ends(f.events),traces:f.traces.slice(-4),delivered:delivered(f.events).length}))
  assert.equal(readTaskRunGroupResult(clone(f.events),'loop-input',trusted,undefined,{requireReview:true,runId:'repair-run'}),fixed)
  assert.equal(readTaskRunGroupResult(f.events,'loop-input',undefined,undefined,{requireReview:true,runId:'repair-run'}),undefined,'source标记没有持久受理票据时不能跨轮')
  assert.equal(delivered(f.events).length,1)
 })
})

test('真实Loop：R4仍拒绝或未知不交付，R2无有据finding不启动repair，普通R2接受维持三步',async t=>{
 for(const kind of ['r4-reject','r4-unknown','r2-unknown','r2-accept'] as const)await t.test(kind,async sub=>{
  const scripts=kind==='r2-accept'?[text(draft),call(revise()),call(verify())]
   :kind==='r2-unknown'?[text(draft),call(revise()),call(verify([],'reject','unknown'))]
   :[text(draft),call(revise()),call(r2Reject()),call(revise(fixed)),call(verify(['r2:u1:f1','r3:u1:i1'],'reject',kind==='r4-reject'?'fail':'unknown',kind==='r4-reject'))]
  const f=await runtime(sub,scripts);await f.send()
  assert.equal(f.adapter.requests.length,kind.startsWith('r4')?5:3)
  assert.deepEqual(ends(f.events),[kind==='r2-accept'?'completed':'error'])
  assert.equal(result(f.events),kind==='r2-accept'?draft:undefined)
  assert.equal(delivered(f.events).length,kind==='r2-accept'?1:0)
  if(kind==='r2-accept')assert.equal(Reflect.get(delivered(f.events)[0]!.data.source,'protocol'),deliveryReviewProtocol)
  else assert.equal(f.traces.at(-1)!.reason,'review-unresolved')
 })
})

test('真实Loop的R4隔离全部旧AI意见，只保留当前稿、原事实和R1/R2/R3数值依赖，调用数不变',async t=>{
 const scripts=successScripts(true),first=scripts[1]!,rejection=scripts[2]!,repair=scripts[3]!
 const markers=['UNTRUSTED_R1_SUGGESTION','UNTRUSTED_R2_FINDING','UNTRUSTED_R3_SUGGESTION']
 for(const [reply,marker] of [[first,markers[0]],[rejection,markers[1]],[repair,markers[2]]] as const){
  const block=reply.find(chunk=>chunk.type==='block-end');assert.ok(block?.type==='block-end'&&block.block.type==='tool-call')
  const args=block.block.arguments as {issues?:{problem:string}[];findings?:{problem:string}[]}
  ;(args.issues??args.findings)![0]!.problem=marker!
 }
 const f=await runtime(t,scripts);await f.send();assert.equal(result(f.events),fixed)
 assert.equal(f.adapter.requests.length,5,'修订与验收仍为原五次请求')
 const r2=JSON.stringify(f.adapter.requests[2]),r4=JSON.stringify(f.adapter.requests[4])
 assert.ok(!r2.includes(markers[0]!))
 for(const marker of markers)assert.ok(!r4.includes(marker),'R4实际请求不能预装旧AI意见')
 assert.ok(r4.includes(goal)&&r4.includes(fixed));for(const id of ['r1:u1:i1','r2:u1:f1','r3:u1:i1'])assert.ok(r4.includes(id),'全部依赖身份仍在')
 assert.ok(r4.includes('blockMaps')&&r4.includes('newBlockIds'))
 const audit=JSON.stringify(f.events);for(const marker of markers)assert.ok(audit.includes(marker),'完整意见保留原生审计')
 assert.equal(result(clone(f.events)),fixed)
 // 旧四轮已有明确的数据格式，保留它而不是用新投影重新解释旧回执。
 const legacy=clone(f.events),host=delivered(legacy)[0]!,rounds=Reflect.get(host.data.source,'rounds') as ReviewRound[]
 const firstIssues=rounds[0]!.units.flatMap(unit=>unit.issues??[]),firstMap=rounds[0]!.blockMap!,lastIssues=rounds[2]!.units.flatMap(unit=>unit.issues??[]),lastMap=rounds[2]!.blockMap!
 const repairFindings=rounds[1]!.units.flatMap(unit=>(unit.findings??[]).map((finding,index)=>({...finding,id:`r2:u${unit.unit+1}:f${index+1}`})))
 for(const round of [2,4]){
  const data=legacy.find(event=>event.type==='user/message'&&event.data.content.some(part=>part.type==='text'&&part.text.startsWith(`验收输入投影 current-draft/v1（第 ${round} 轮`)));assert.ok(data?.type==='user/message')
  const part=data.data.content[0];assert.ok(part?.type==='text')
  const requirements=JSON.parse(part.text.split('宿主依赖映射（仅身份、摘要与块号，不含旧AI意见）：\n')[1]!).requirements
  const oldData=round===2?deliveryRoundData(middle,2,firstIssues,firstMap):deliveryRoundData(fixed,4,lastIssues,lastMap)+'\n所有未确认依赖（原修订、拒绝意见及额外修订分别绑定其输入块映射；不得只验证新改字）：\n'+JSON.stringify({firstIssues,firstMap,repairFindings,requirements})
  Reflect.set(data.data,'content',[{type:'text',text:oldData}]);Reflect.deleteProperty(rounds[round-1]!,'verificationProjection')
 }
 assert.equal(result(legacy),fixed,'旧v4四轮冷读继续核全部旧意见和真实依赖')
})

test('真实Loop：长稿四轮各四单元加一次纠参，完整17步复核不被起草步数挤占',async t=>{
 const section=(n:number)=>`## 第${n}节\n\n`+Array.from({length:140},(_,j)=>`第${n}节第${j}句内容。`).join('')+'\n'
 const longDraft=Array.from({length:9},(_,i)=>section(i+1)).join('\n')
 assert.equal(splitReviewUnits(longDraft).length,4,'实际单元划分产生已消费的模型步骤')
 const heading='## 第1节（待核）',repaired=longDraft.replace('## 第1节',heading).trim()
 const repair={phase:'revise',issues:[{problem:'按原资料修正分类及其依据。',basis:basis.map(ref=>({...ref})),affectedBlockIds:[1],coverage:{change:[1],retain:[],unrelated:Array.from({length:17},(_,i)=>i+2),unknown:[]},edits:[{blockId:1,after:heading}]}]}
 // R2 最后一单元有据拒绝，四轮各四单元与唯一一次纠参恰好用满17步。
 const f=await runtime(t,[text(longDraft),call({phase:'revise',issues:''}),...Array.from({length:4},()=>call(revise())),...Array.from({length:3},()=>call(verify())),call(r2Reject()),call(repair),...Array.from({length:3},()=>call(revise())),call(verify(['r2:u4:f1','r3:u1:i1'])),...Array.from({length:3},()=>call(verify()))]);await f.send()
 assert.equal(f.adapter.requests.length,18,JSON.stringify(f.traces))
 assert.ok(!f.traces.some(entry=>entry.reason==='review-repair-budget'),'不在repair开始前因起草步数挤占而停止')
 assert.deepEqual(f.traces.filter(entry=>entry.state==='planned').map(entry=>[entry.round,entry.unit]),[1,2,3,4].flatMap(round=>[0,1,2,3].map(unit=>[round,unit])),'四轮各四单元都实际取得合法回执')
 assert.deepEqual(ends(f.events),['completed'])
 assert.equal(result(f.events),repaired)
 assert.equal(result(clone(f.events)),repaired)
 assert.equal(delivered(f.events).length,1)
})

test('私有复核检查点保留原轮次、真实步数与整次纠参名额，读取本身不多调用模型',async t=>{
 const scripts=successScripts();scripts.splice(1,0,call({phase:'revise',issues:''}))
 const f=await runtime(t,scripts),states:{current:{round:number};corrected:boolean;reviewStepsUsed:number;requestId:string;phase:string}[]=[]
 f.agent.ctx.on('llm/stream',async function*(_request,next){
  const snapshot=readDeliveryReviewCheckpoint(f.agent)
  if(snapshot){assert.equal(snapshot.sha256,draftSha256(snapshot.json));states.push(JSON.parse(snapshot.json))}
  yield* next()
 })
 await f.send()
 assert.equal(f.adapter.requests.length,6);assert.equal(result(f.events),fixed)
 assert.deepEqual(states.map(state=>state.current.round),[1,1,2,3,4])
 assert.deepEqual(states.map(state=>state.corrected),[false,true,true,true,true])
 assert.deepEqual(states.map(state=>state.reviewStepsUsed),[1,2,3,4,5])
 assert.ok(states.every(state=>state.requestId==='loop-input'&&state.phase==='rewrite'))
 assert.equal(readDeliveryReviewCheckpoint(f.agent),null,'正式轮次结束后不把旧复核租约带入追问')
})

test('真实Loop：长调查超十步后完成四轮复核，正式报告冷读仅核复核步数',async t=>{
 const f=await runtime(t,[...Array.from({length:30},()=>call({},'investigation_probe')),...successScripts()],true);await f.send()
 assert.equal(f.adapter.requests.length,35,JSON.stringify({traces:f.traces,probes:f.probes(),last:f.events.filter(event=>event.type==='turn/end').at(-1)}))
 assert.equal(f.probes(),30)
 const calls=new Set(f.events.flatMap(event=>event.type==='tool/call'&&event.data.name==='investigation_probe'?[event.data.callId]:[]))
 assert.equal(f.events.filter(event=>event.type==='tool/result'&&calls.has(event.data.message.toolCallId)&&!event.data.message.isError).length,30,'已完成工具原回执保留，不挤占复核预算')
 assert.deepEqual(ends(f.events),['completed'])
 assert.equal(result(f.events),fixed)
 assert.equal(result(clone(f.events)),fixed)
 assert.equal(delivered(f.events).length,1)
 assert.ok(!f.traces.some(entry=>entry.reason==='review-model-step-limit'))
})

test('真实Loop：R2之后取消或原来源许可失效，R3仍须经过原取消/模型准入，不发provider',async t=>{
 for(const kind of ['cancel','source-expired'] as const)await t.test(kind,async sub=>{
  const f=await runtime(sub,successScripts());let refused=0
  if(kind==='cancel')f.agent.ctx.on('session/event',(_session,event)=>{
   if(event.type==='tool/result'&&f.adapter.requests.length===3){refused++;f.agent.cancel({kind:'hook',reason:'原执行许可取消'})}
  })
  else f.agent.ctx.on('llm/stream',async function*(_request,next){
   if(f.adapter.requests.length===3){refused++;throw Error('original source lease expired')}
   yield* next()
  })
  await f.send()
  assert.equal(refused,1)
  assert.equal(f.adapter.requests.length,3,'R3请求未到达provider')
  assert.deepEqual(ends(f.events),[kind==='cancel'?'aborted':'error'])
  assert.ok(f.events.some(event=>event.type==='tool/result'&&!event.data.message.isError),'已实际收下R2原生回执')
  assert.equal(result(f.events),undefined)
  assert.equal(delivered(f.events).length,0)
 })
})

test('真实Loop：schema纠参名额由R1至R4共享，已在R1或R3使用后R4非法不得多一次调用',async t=>{
 for(const usedAt of ['r1','r3','r4'] as const)await t.test(usedAt,async sub=>{
  const invalidRevise=call({phase:'revise',issues:''}),invalidVerify=call({...r4Accept(),checks:''})
  const scripts=[text(draft),...usedAt==='r1'?[invalidRevise]:[],call(revise()),call(r2Reject()),...usedAt==='r3'?[invalidRevise]:[],call(revise(fixed)),invalidVerify,...usedAt==='r4'?[call(r4Accept())]:[]]
  const f=await runtime(sub,scripts);await f.send()
  assert.equal(f.adapter.requests.length,6,'整个lease仅一次原生参数纠正')
  assert.deepEqual(ends(f.events),[usedAt==='r4'?'completed':'error'])
  assert.equal(result(f.events),usedAt==='r4'?fixed:undefined)
  assert.equal(result(clone(f.events)),usedAt==='r4'?fixed:undefined)
  assert.equal(f.events.filter(event=>event.type==='tool/result'&&event.data.message.isError).length,usedAt==='r4'?1:2,'原生schema错误完整保留')
  if(usedAt==='r4')assert.match(JSON.stringify(f.adapter.requests[5]!.messages),/invalid arguments:/,'纠参看到真实原生错误')
 })
})

test('真实Loop四轮冷读拒绝伪造：缺任一真实修订/拒绝回执、改R2依据或R4依赖及交付正文均不交付',async t=>{
 const f=await runtime(t,successScripts(true));await f.send()
 assert.equal(result(f.events),fixed,'先证明原始完整事件确可交付')
 for(const kind of ['remove-r2-result','remove-r3-call','r2-basis','r3-edit','r4-missing-r1','round-count','delivery-text'] as const){
  const copy=clone(f.events),output=delivered(copy)[0]!,source=output.data.source
  const rounds=Reflect.get(source,'rounds') as {units:{callId:string;issues?:{edits?:unknown[]}[];findings?:{basis:object[]}[];changeChecks?:{issueId:string}[]}[]}[]
  if(kind==='remove-r2-result'||kind==='remove-r3-call'){
   const index=copy.findIndex(event=>kind==='remove-r2-result'?event.type==='tool/result'&&event.data.message.toolCallId===rounds[1]!.units[0]!.callId:event.type==='tool/call'&&event.data.callId===rounds[2]!.units[0]!.callId)
   assert.ok(index>=0,'篡改必须命中实际相应原生事件');copy.splice(index,1)
  }else if(kind==='r2-basis')Reflect.set(rounds[1]!.units[0]!.findings![0]!.basis[0]!,'sourceSha256','0'.repeat(64))
  else if(kind==='r3-edit')Reflect.set(rounds[2]!.units[0]!.issues![0]!.edits![0] as object,'after','伪造的另一正文。')
  else if(kind==='r4-missing-r1')rounds[3]!.units[0]!.changeChecks=rounds[3]!.units[0]!.changeChecks!.filter(row=>row.issueId!=='r1:u1:i1')
  else if(kind==='round-count')rounds.pop()
  else {Reflect.set(output.data,'content',[{type:'text',text:'伪造交付。'}]);Reflect.set(source,'deliverySha256',draftSha256('伪造交付。'))}
  if(kind==='remove-r2-result'||kind==='remove-r3-call')assert.throws(()=>result(copy),{code:'teloa/storage-corrupt'},kind)
  else assert.equal(result(copy),undefined,kind)
 }
})
