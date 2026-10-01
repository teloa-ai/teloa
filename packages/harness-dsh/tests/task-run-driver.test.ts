import test from 'node:test'
import assert from 'node:assert/strict'
import type {TaskExecutionScope,TaskRun} from '@teloa/backend'
import type {SessionEvent} from '@deepseek-ai/dsh-session/types'
import {TaskRunDriver} from '../src/task-run-driver.ts'
import {createManagedAvailabilitySync} from '../src/managed-skill-availability-sync.ts'
import {createAssistantMessage} from '@deepseek-ai/dsh-llm'

function fixture(){
 let run={id:'run',sessionId:'session',nativeRequestId:'native',state:'prepared',stopRequestedAt:null,inputText:'固定目标'} as TaskRun,sends=0,checks=0,stops=0,requests=0,fail=false
 const checkedTarget:TaskExecutionScope={taskId:'task',taskVersion:1,sessionId:'session',linkVersion:1,scope:'SOC'}
 const claimedTarget:TaskExecutionScope={...checkedTarget}
 const stopped:Array<string|null>=[]
 let events:SessionEvent[]=[]
 const service={get:async()=>run,executionScope:async()=>checkedTarget,claim:async()=>{if(run.state!=='prepared')return {run,dispatch:false as const};run={...run,state:'submitting'};return {run,dispatch:true as const,target:claimedTarget}},record:async(_owner:string,input:unknown)=>{const evidence=(input as {evidence:TaskRun['evidence']}).evidence!;run={...run,state:evidence.state,evidence};return run},requestStop:async()=>{requests++;run={...run,stopRequestedAt:run.stopRequestedAt??'2026-09-20T09:00:0'+requests+'.000Z'};return run}}
 const driver=new TaskRunDriver(service,{check:async(_run,_signal,target)=>{assert.deepEqual(target,checkedTarget);checks++},send:async(sent,_signal,target)=>{assert.equal(sent.nativeRequestId,'native');assert.equal(sent.inputText,'固定目标');assert.deepEqual(target,claimedTarget);sends++;if(fail)throw Error('secret transport details')},stop:async stopping=>{stops++;stopped.push(stopping.stopRequestedAt)},events:async()=>events})
 return {driver,run:()=>run,sends:()=>sends,stops:()=>stops,requests:()=>requests,stopped:()=>stopped,checks:()=>checks,fail:()=>{fail=true},events:(value:SessionEvent[])=>{events=value}}
}
test('宿主仅领取者发送固定请求，未知提交重试不重发',async()=>{
 const f=fixture();f.fail()
 await assert.rejects(f.driver.start('owner',{runId:'run'},new AbortController().signal),error=>error instanceof Error&&!error.message.includes('secret')&&error.message.includes('核对'))
 assert.equal(f.run().state,'submitting');assert.equal(f.sends(),1)
 await f.driver.start('owner',{runId:'run'},new AbortController().signal)
 assert.equal(f.sends(),1)
 assert.equal((await f.driver.reconcile('owner',{runId:'run'})).state,'submitting')
})
test('发送接收与日志恢复分离，取消信号不领取发送权',async()=>{
 const f=fixture(),controller=new AbortController();controller.abort()
 await assert.rejects(f.driver.start('owner',{runId:'run'},controller.signal));assert.equal(f.checks(),0);assert.equal(f.sends(),0)
 assert.equal((await f.driver.start('owner',{runId:'run'},new AbortController().signal)).state,'accepted')
 f.events([{seq:0,time:0,type:'turn/start',data:{turn:0}},{seq:1,time:1,type:'user/message',surfaceOp:'append',data:{source:{kind:'user',rpcId:'native'},content:[],id:'message',role:'user'}},{seq:2,time:2,type:'turn/end',data:{turn:0,reason:{kind:'interrupted'}}}] as SessionEvent[])
 assert.equal((await f.driver.reconcile('owner',{runId:'run'})).evidence?.state,'ended')
 assert.equal(f.sends(),1)
})

test('旧世代只有 owner 关联的纯文本 Run 从固定原生完成轮恢复，带工具能力仍视为中断',async()=>{
 const answer=createAssistantMessage({source:{provider:'test',model:'test'},content:[{type:'text',text:'固定结论'}]})
 const events=[
  {seq:0,time:0,type:'turn/start',data:{turn:0}},
  {seq:1,time:1,type:'user/message',surfaceOp:'append',data:{source:{kind:'user',rpcId:'native'},content:[],id:'fixed-message',role:'user'}},
  {seq:2,time:2,type:'assistant/message',surfaceOp:'append',data:{turn:0,step:1,message:answer,stream:[]}},
  {seq:3,time:3,type:'turn/end',data:{turn:0,reason:{kind:'completed'}}},
 ] as SessionEvent[]
 const make=(allowedTools:string[],ownerOnly:boolean,observedEvents=events,extra:Partial<TaskRun>={})=>{
  let run={id:'run',sessionId:'session',nativeRequestId:'native',state:'submitting',evidence:null,stopRequestedAt:null,allowedTools,skills:[],inputText:'固定目标',...extra} as TaskRun
  const service={get:async()=>run,executionScope:async()=>{throw Error('不应重新领取')},claim:async()=>{throw Error('不应重新领取')},requestStop:async()=>{throw Error('不应停止')},record:async(_owner:string,input:unknown)=>{const evidence=(input as {evidence:NonNullable<TaskRun['evidence']>}).evidence;run={...run,state:evidence.state,evidence};return run}}
  const driver=new TaskRunDriver(service,{check:async()=>{},send:async()=>{throw Error('不得重发')},stop:async()=>{},events:async()=>observedEvents,backgroundState:async()=>({outstanding:false,interrupted:true,ownerOnly})})
  return {driver,run:()=>run}
 }
 const safe=make([],true),recovered=await safe.driver.reconcile('owner',{runId:'run'})
 assert.equal(recovered.state,'ended')
 assert.deepEqual(recovered.evidence,{state:'ended',turn:0,messageSeq:1,endSeq:3,reason:'completed'})
 assert.equal((await safe.driver.start('owner',{runId:'run'},new AbortController().signal)).state,'ended')
 const withTools=await make(['bash'],true).driver.reconcile('owner',{runId:'run'})
 assert.equal(withTools.evidence?.state==='ended'?withTools.evidence.reason:undefined,'interrupted')
 const unproven=await make([],false).driver.reconcile('owner',{runId:'run'})
 assert.equal(unproven.evidence?.state==='ended'?unproven.evidence.reason:undefined,'interrupted')
 for(const extra of [{skills:[{name:'managed'}]},{groupContext:{groupId:'group'}},{flowId:'flow'},{subagents:[{childSessionId:'child'}]}]){
  const unsafe=await make([],true,events,extra as Partial<TaskRun>).driver.reconcile('owner',{runId:'run'})
  assert.equal(unsafe.evidence?.state==='ended'?unsafe.evidence.reason:undefined,'interrupted')
 }
 const toolAnswer=createAssistantMessage({source:{provider:'test',model:'test'},content:[{type:'text',text:'先调用'},{type:'tool-call',id:'call' as never,name:'bash',arguments:'{}'}]})
 for(const unsafe of [
  events.filter(event=>event.type!=='assistant/message').map((event,seq)=>({...event,seq})) as SessionEvent[],
  events.map(event=>event.type==='assistant/message'?{...event,data:{...event.data,message:toolAnswer}}:event),
  events.map(event=>event.type==='assistant/message'?{...event,data:{...event.data,interrupted:true}}:event) as SessionEvent[],
  events.map(event=>event.type==='assistant/message'?{...event,data:{...event.data,stream:[{type:'tool-call-chunks',id:'call',name:'bash',args:['{}'],time0:0,index:0,dt:[0]}]}}:event) as SessionEvent[],
  [events[0]!,{seq:1,time:1,type:'tool/call',data:{}},...events.slice(1).map(event=>({...event,seq:event.seq+1}))] as SessionEvent[],
  [...events.slice(0,3),{seq:3,time:3,type:'tool/call',data:{}},{...events[3]!,seq:4}] as SessionEvent[],
  [...events.slice(0,3),{seq:3,time:3,type:'team/message/queued',data:{}},{...events[3]!,seq:4}] as SessionEvent[],
  [...events,{seq:4,time:4,type:'turn/start',data:{turn:1}},{seq:5,time:5,type:'user/message',surfaceOp:'append',data:{id:'continuation',role:'user',content:[],source:{kind:'tool-jobs'}}},{seq:6,time:6,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}] as SessionEvent[],
 ]){
  const rejected=await make([],true,unsafe).driver.reconcile('owner',{runId:'run'})
  assert.equal(rejected.evidence?.state==='ended'?rejected.evidence.reason:undefined,'interrupted')
 }
})

test('群任务终态先记录原生证据，再回传同轮最终助手文本',async()=>{
 const groupContext={groupId:'group'} as NonNullable<TaskRun['groupContext']>
 let run={id:'run',sessionId:'session',nativeRequestId:'native',state:'accepted',groupContext} as TaskRun
 const answer=createAssistantMessage({source:{provider:'test',model:'test'},content:[{type:'text',text:'已完成研判'}]})
 const events=[
  {seq:0,time:0,type:'turn/start',data:{turn:0}},
  {seq:1,time:1,type:'user/message',surfaceOp:'append',data:{source:{kind:'user',rpcId:'native'},content:[],id:'message',role:'user'}},
  {seq:2,time:2,type:'assistant/message',surfaceOp:'append',data:{turn:0,step:1,message:answer,stream:[]}},
  {seq:3,time:3,type:'turn/end',data:{turn:0,reason:{kind:'completed'}}},
 ] as SessionEvent[]
 const calls:string[]=[]
 const driver=new TaskRunDriver({
  get:async()=>run,
  executionScope:async()=>{throw Error('不应读取')},
  claim:async()=>{throw Error('不应领取')},
  requestStop:async()=>{throw Error('不应请求停止')},
  record:async(_owner,input)=>{calls.push('record');run={...run,state:'ended',evidence:(input as {evidence:TaskRun['evidence']}).evidence};return run},
 },{check:async()=>{},send:async()=>{},stop:async()=>{},events:async()=>events,publishGroupResult:async(saved,text)=>{calls.push('publish');assert.equal(saved.state,'ended');assert.equal(text,'已完成研判')}})
 const result=await driver.reconcile('owner',{runId:'run'})
 assert.equal(result.state,'ended')
 assert.deepEqual(calls,['record','publish'])
})

test('终态交付失败后按已落定证据重试，迟到后台通知不改写证据或正文',async()=>{
 let run={id:'run',sessionId:'session',nativeRequestId:'native',state:'active',groupContext:{groupId:'group'}} as TaskRun
 const answer=(text:string)=>createAssistantMessage({source:{provider:'test',model:'test'},content:[{type:'text',text}]})
 const events=[
  {seq:0,time:0,type:'turn/start',data:{turn:0}},
  {seq:1,time:1,type:'user/message',surfaceOp:'append',data:{source:{kind:'user',rpcId:'native'},content:[],id:'message',role:'user'}},
  {seq:2,time:2,type:'assistant/message',surfaceOp:'append',data:{turn:0,step:1,message:answer('已交付结果'),stream:[]}},
  {seq:3,time:3,type:'turn/end',data:{turn:0,reason:{kind:'completed'}}},
 ] as SessionEvent[]
 let records=0
 const delivered:string[]=[]
 const driver=new TaskRunDriver({
  get:async()=>run,executionScope:async()=>{throw Error('不应读取')},claim:async()=>{throw Error('不应领取')},requestStop:async()=>{throw Error('不应停止')},
  record:async(_owner,input)=>{records++;run={...run,state:'ended',evidence:(input as {evidence:TaskRun['evidence']}).evidence};return run},
 },{check:async()=>{},send:async()=>{},stop:async()=>{},events:async()=>events,publishGroupResult:async(saved,text)=>{
  assert.equal(saved.evidence?.state==='ended'&&saved.evidence.endSeq,3)
  delivered.push(text)
  if(delivered.length===1)throw Error('交付暂不可用')
 }})
 await assert.rejects(driver.reconcile('owner',{runId:'run'}),/交付暂不可用/)
 const evidence=run.evidence
 events.push(...[
  {seq:4,time:4,type:'turn/start',data:{turn:1}},
  {seq:5,time:5,type:'user/message',surfaceOp:'append',data:{source:{kind:'tool-jobs'},content:[],id:'notice',role:'user'}},
  {seq:6,time:6,type:'assistant/message',surfaceOp:'append',data:{turn:1,step:1,message:answer('迟到通知中的内容'),stream:[]}},
  {seq:7,time:7,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}},
 ] as SessionEvent[])
 await driver.reconcile('owner',{runId:'run'})
 await driver.reconcile('owner',{runId:'run'})
 assert.equal(records,1)
 assert.deepEqual(run.evidence,evidence)
 assert.deepEqual(delivered,['已交付结果','已交付结果','已交付结果'])
})

test('取消回执不伪造终态，准备态拒绝停止，已终止不再取消',async()=>{
 const f=fixture(),signal=new AbortController().signal
 await assert.rejects(f.driver.stop('owner',{runId:'run'},signal),{code:'teloa/conflict'})
 assert.equal(f.stops(),0)
 await f.driver.start('owner',{runId:'run'},signal)
 assert.equal((await f.driver.stop('owner',{runId:'run'},signal)).state,'accepted')
 assert.equal(f.stops(),1)
 f.events([{seq:0,time:0,type:'turn/start',data:{turn:0}},{seq:1,time:1,type:'user/message',surfaceOp:'append',data:{source:{kind:'user',rpcId:'native'},content:[],id:'message',role:'user'}},{seq:2,time:2,type:'turn/end',data:{turn:0,reason:{kind:'aborted',reason:{kind:'user'}}}}] as SessionEvent[])
 assert.equal((await f.driver.stop('owner',{runId:'run'},signal)).evidence?.state,'ended')
 assert.equal(f.stops(),2)
 await f.driver.stop('owner',{runId:'run'},signal);assert.equal(f.stops(),2)
})

test('停止先落停止意图再递交取消，重复停止不覆盖首次时间',async()=>{
 const f=fixture(),signal=new AbortController().signal
 await f.driver.start('owner',{runId:'run'},signal)
 const first=await f.driver.stop('owner',{runId:'run'},signal)
 assert.equal(f.requests(),1);assert.equal(f.stops(),1)
 // 顺序是先落库后取消：递交给 ports.stop 的那份记录必须已经带上停止时间。
 assert.deepEqual(f.stopped(),['2026-09-20T09:00:01.000Z'])
 assert.equal(first.stopRequestedAt,'2026-09-20T09:00:01.000Z')
 assert.equal(first.state,'accepted')
 const again=await f.driver.stop('owner',{runId:'run'},signal)
 assert.equal(f.requests(),2);assert.equal(again.stopRequestedAt,'2026-09-20T09:00:01.000Z')
 assert.deepEqual(f.stopped(),['2026-09-20T09:00:01.000Z','2026-09-20T09:00:01.000Z'])
})

for(const reason of ['completed','failed','interrupted','aborted'] as const)test('停止意图不改写固定原生 '+reason+' 结束原因，重复核对不重发',async()=>{
 const f=fixture(),signal=new AbortController().signal
 await f.driver.start('owner',{runId:'run'},signal)
 let records=0
 const record=f.driver.service.record
 f.driver.service.record=async(...args)=>{records++;return record(...args)}
 // 原生结束已经发生，停止意图在业务核对前迟到；停止不能改变这轮真实结果。
 f.events([
  {seq:0,time:0,type:'turn/start',data:{turn:0}},
  {seq:1,time:1,type:'user/message',surfaceOp:'append',data:{source:{kind:'user',rpcId:'native'},content:[],id:'message',role:'user'}},
  {seq:2,time:2,type:'turn/end',data:{turn:0,reason:{kind:reason}}},
 ] as SessionEvent[])
 const result=await f.driver.stop('owner',{runId:'run'},signal)
 const evidence={state:'ended',turn:0,messageSeq:1,endSeq:2,reason}
 assert.equal(result.state,'ended')
 assert.deepEqual(result.evidence,evidence)
 assert.equal(result.stopRequestedAt,'2026-09-20T09:00:01.000Z')
 assert.deepEqual((await f.driver.reconcile('owner',{runId:'run'})).evidence,evidence)
 assert.deepEqual((await f.driver.start('owner',{runId:'run'},signal)).evidence,evidence)
 assert.deepEqual((await f.driver.stop('owner',{runId:'run'},signal)).evidence,evidence)
 assert.equal(f.run().stopRequestedAt,'2026-09-20T09:00:01.000Z')
 assert.deepEqual({records,sends:f.sends(),stops:f.stops(),requests:f.requests()},{records:1,sends:1,stops:1,requests:1})
})

test('停止意图不把后台中断的固定原生轮改成取消，终态核对不重发',async()=>{
 const f=fixture(),signal=new AbortController().signal
 await f.driver.start('owner',{runId:'run'},signal)
 f.events([
  {seq:0,time:0,type:'turn/start',data:{turn:0}},
  {seq:1,time:1,type:'user/message',surfaceOp:'append',data:{source:{kind:'user',rpcId:'native'},content:[],id:'message',role:'user'}},
  {seq:2,time:2,type:'session/meta',data:{}},
 ] as SessionEvent[])
 f.driver.ports.backgroundState=async()=>({outstanding:false,interrupted:true})
 const result=await f.driver.stop('owner',{runId:'run'},signal)
 const evidence={state:'ended',turn:0,messageSeq:1,endSeq:2,reason:'interrupted'}
 assert.deepEqual(result.evidence,evidence)
 assert.equal(result.stopRequestedAt,'2026-09-20T09:00:01.000Z')
 assert.deepEqual((await f.driver.reconcile('owner',{runId:'run'})).evidence,evidence)
 await f.driver.start('owner',{runId:'run'},signal)
 assert.deepEqual({sends:f.sends(),stops:f.stops(),requests:f.requests()},{sends:1,stops:1,requests:1})
})

test('停止先取消父与登记子级，子级实际结清前不可收口，读口失败仍保留停止意图',async()=>{
 let run={id:'run',sessionId:'session',nativeRequestId:'native',state:'active',stopRequestedAt:null} as TaskRun
 let stops=0,requests=0,childStops=0,outstanding=true
 const events=[{seq:0,time:0,type:'turn/start',data:{turn:0}},{seq:1,time:1,type:'user/message',surfaceOp:'append',data:{source:{kind:'user',rpcId:'native'},content:[],id:'message',role:'user'}},{seq:2,time:2,type:'turn/end',data:{turn:0,reason:{kind:'completed'}}}] as SessionEvent[]
 const service={get:async()=>run,executionScope:async()=>{throw Error('不应读取')},claim:async()=>{throw Error('不应领取')},record:async(_owner:string,input:unknown)=>{const evidence=(input as {evidence:NonNullable<TaskRun['evidence']>}).evidence;run={...run,state:evidence.state,evidence};return run},requestStop:async()=>{requests++;run={...run,stopRequestedAt:'2026-09-24T00:00:00Z'};return run}}
 const ports={check:async()=>{},send:async()=>{},stop:async()=>{assert.ok(run.stopRequestedAt);stops++},stopChildren:async()=>{assert.ok(run.stopRequestedAt);childStops++},events:async()=>events}
 const driver=new TaskRunDriver(service,{...ports,subagentState:async()=>outstanding?'outstanding':'none'})
 assert.equal((await driver.stop('owner',{runId:'run'},new AbortController().signal)).state,'active')
 assert.deepEqual({stops,requests,childStops},{stops:1,requests:1,childStops:1})
 const unavailable=new TaskRunDriver(service,{...ports,subagentState:async()=>{throw Error('database unavailable')}})
 await assert.rejects(unavailable.stop('owner',{runId:'run'},new AbortController().signal),/database unavailable/)
 assert.equal(run.state,'active');assert.ok(run.stopRequestedAt)
 outstanding=false
 const result=await driver.reconcile('owner',{runId:'run'})
 assert.equal(result.state,'ended');assert.deepEqual(result.evidence,{state:'ended',turn:0,messageSeq:1,endSeq:2,reason:'completed'})
 assert.equal(result.stopRequestedAt,'2026-09-24T00:00:00Z')
})

test('运行配置失败是不可再停止或核对原生日志的终态',async()=>{
 let reads=0,stops=0,records=0
 const run={id:'run',sessionId:'session',nativeRequestId:'native',state:'configuration_failed'} as TaskRun
 const driver=new TaskRunDriver({get:async()=>run,executionScope:async()=>{throw Error('不应读取')},claim:async()=>{throw Error('不应领取')},record:async()=>{records++;throw Error('不应记录')},requestStop:async()=>{throw Error('不应请求停止')}},{check:async()=>{},send:async()=>{},stop:async()=>{stops++},events:async()=>{reads++;return []}})
 assert.equal(await driver.stop('owner',{runId:'run'},new AbortController().signal),run)
 assert.equal(await driver.reconcile('owner',{runId:'run'}),run)
 assert.deepEqual({reads,stops,records},{reads:0,stops:0,records:0})
})

test('稳定区覆盖检查、领取和发送接收，维护不能插入领取与原生提交之间',async()=>{
 let run={id:'run',sessionId:'session',nativeRequestId:'native',state:'prepared',inputText:'固定目标'} as TaskRun
 const target:TaskExecutionScope={taskId:'task',taskVersion:1,sessionId:'session',linkVersion:1,scope:'SOC'},events:string[]=[]
 let releaseSend!:()=>void
 const sendAccepted=new Promise<void>(resolve=>{releaseSend=resolve})
 const sync=createManagedAvailabilitySync({deny:()=>events.push('deny'),read:async()=>{events.push('read');return 'snapshot'},replace:()=>events.push('replace')})
 const service={
  get:async()=>{events.push('get');return run},executionScope:async()=>{events.push('scope');return target},
  claim:async()=>{events.push('claim');run={...run,state:'submitting'};return {run,dispatch:true as const,target}},
  record:async()=>{events.push('record');run={...run,state:'accepted'};return run},
  requestStop:async()=>{events.push('requestStop');return run},
 }
 const driver=new TaskRunDriver(service,{stableStart:sync.stable,check:async()=>{events.push('check')},send:async()=>{events.push('send');await sendAccepted;events.push('accepted')},stop:async()=>{},events:async()=>[]})
 const starting=driver.start('owner',{runId:'run'},new AbortController().signal)
 while(!events.includes('send'))await Promise.resolve()
 const maintenance=sync.change(async()=>{events.push('maintenance')})
 await Promise.resolve();assert.equal(events.includes('maintenance'),false)
 releaseSend();assert.equal((await starting).state,'accepted');await maintenance
 assert.deepEqual(events,['get','scope','check','claim','send','accepted','record','deny','maintenance','read','replace'])
})

test('停止后宿主不在运行且 seq 冻结即收口为已中止；仍在跑、没冻结、没请求停止都不收口',async()=>{
 // 原生 turn/end 永远不会来的那种局面（H-C）：日志停在助手消息上，轮次未闭合。
 const events=[
  {seq:0,time:0,type:'turn/start',data:{turn:0}},
  {seq:1,time:1,type:'user/message',surfaceOp:'append',data:{source:{kind:'user',rpcId:'native'},content:[],id:'message',role:'user'}},
  {seq:2,time:2,type:'session/meta',data:{}},
 ] as SessionEvent[]
 const make=(stopRequestedAt:string|null,host:{running:boolean;settledSeq:number|null})=>{
  let run={id:'run',sessionId:'session',nativeRequestId:'native',state:'active',stopRequestedAt} as TaskRun
  let reads=0
  const service={get:async()=>run,executionScope:async()=>{throw Error('不应读取')},claim:async()=>{throw Error('不应领取')},requestStop:async()=>{throw Error('不应请求停止')},record:async(_owner:string,input:unknown)=>{const evidence=(input as {evidence:TaskRun['evidence']}).evidence!;run={...run,state:evidence.state,evidence};return run}}
  const driver=new TaskRunDriver(service,{check:async()=>{},send:async()=>{},stop:async()=>{},events:async()=>events,stopState:async()=>{reads++;return host}})
  return {driver,reads:()=>reads}
 }
 const settled=make('2026-09-20T09:00:00.000Z',{running:false,settledSeq:2})
 const saved=await settled.driver.reconcile('owner',{runId:'run'})
 assert.equal(settled.reads(),1)
 assert.equal(saved.state,'ended')
 // 收口依据留在证据里：冻结到的那个 seq 就是 endSeq，配合记录上的停止时间可回溯。
 assert.deepEqual(saved.evidence,{state:'ended',turn:0,messageSeq:1,endSeq:2,reason:'aborted'})
 // 宿主仍在跑：等原生收口，不替它宣布终态。
 assert.deepEqual((await make('2026-09-20T09:00:00.000Z',{running:true,settledSeq:2}).driver.reconcile('owner',{runId:'run'})).evidence,{state:'active',turn:0,messageSeq:1})
 // seq 还没冻结够久：同样不收口。
 assert.deepEqual((await make('2026-09-20T09:00:00.000Z',{running:false,settledSeq:null}).driver.reconcile('owner',{runId:'run'})).evidence,{state:'active',turn:0,messageSeq:1})
 // 从未请求停止：宿主静止只是空闲，连读都不该读。
 const idle=make(null,{running:false,settledSeq:2})
 assert.deepEqual((await idle.driver.reconcile('owner',{runId:'run'})).evidence,{state:'active',turn:0,messageSeq:1})
 assert.equal(idle.reads(),0)
})
test('执行被原生宿主接受后通知一次；重复启动、发送失败不通知，通知异常不影响结果',async()=>{
 const f=fixture();let notified=0
 ;f.driver.ports.onAccepted=()=>{notified++;throw Error('统计失败')}
 assert.equal((await f.driver.start('owner',{runId:'run'},new AbortController().signal)).state,'accepted')
 assert.equal(notified,1)
 await f.driver.start('owner',{runId:'run'},new AbortController().signal)
 assert.equal(notified,1)
 const failed=fixture();let failedNotified=0
 ;failed.driver.ports.onAccepted=()=>{failedNotified++}
 failed.fail()
 await assert.rejects(failed.driver.start('owner',{runId:'run'},new AbortController().signal))
 assert.equal(failedNotified,0)
})

test('提交回包未知时立即核验已收口的固定原生轮，持久终态后仍返回需核对',async()=>{
 const f=fixture(),signal=new AbortController().signal,send=f.driver.ports.send
 f.driver.ports.backgroundState=async()=>({outstanding:false,interrupted:false})
 f.driver.ports.send=async(...args)=>{
  await send(...args)
  f.events([
   {seq:0,time:0,type:'turn/start',data:{turn:0}},
   {seq:1,time:1,type:'user/message',surfaceOp:'append',data:{source:{kind:'user',rpcId:'native'},content:[],id:'fixed',role:'user'}},
   {seq:2,time:2,type:'turn/end',data:{turn:0,reason:{kind:'completed'}}},
  ] as SessionEvent[])
  throw Error('原生已收口，调用方回包丢失')
 }
 await assert.rejects(f.driver.start('owner',{runId:'run'},signal),{code:'teloa/execution-pending'})
 assert.deepEqual(f.run().evidence,{state:'ended',turn:0,messageSeq:1,endSeq:2,reason:'completed'})
 // 用同一持久Run重建驱动的背景读数，模拟另一进程；已核验终态不会被旧世代再降级。
 f.driver.ports.backgroundState=async()=>({outstanding:false,interrupted:true})
 assert.deepEqual((await f.driver.reconcile('owner',{runId:'run'})).evidence,{state:'ended',turn:0,messageSeq:1,endSeq:2,reason:'completed'})
 await f.driver.start('owner',{runId:'run'},signal)
 assert.equal(f.sends(),1)
})

test('提交未知核验中有未完后台工作，原生completed只能记active',async()=>{
 const f=fixture();f.fail()
 f.events([
  {seq:0,time:0,type:'turn/start',data:{turn:0}},
  {seq:1,time:1,type:'user/message',surfaceOp:'append',data:{source:{kind:'user',rpcId:'native'},content:[],id:'fixed',role:'user'}},
  {seq:2,time:2,type:'turn/end',data:{turn:0,reason:{kind:'completed'}}},
 ] as SessionEvent[])
 f.driver.ports.backgroundState=async()=>({outstanding:true,interrupted:false})
 await assert.rejects(f.driver.start('owner',{runId:'run'},new AbortController().signal),{code:'teloa/execution-pending'})
 assert.deepEqual(f.run().evidence,{state:'active',turn:0,messageSeq:1})
 assert.equal(f.sends(),1)
})

test('提交未知的核验读取或持久化失败不伪造收口，不掩盖原需核对状态',async()=>{
 for(const failure of ['read','record'] as const){
  const f=fixture();f.fail()
  f.events([
   {seq:0,time:0,type:'turn/start',data:{turn:0}},
   {seq:1,time:1,type:'user/message',surfaceOp:'append',data:{source:{kind:'user',rpcId:'native'},content:[],id:'fixed',role:'user'}},
   {seq:2,time:2,type:'turn/end',data:{turn:0,reason:{kind:'completed'}}},
  ] as SessionEvent[])
  if(failure==='read')f.driver.ports.events=async()=>{throw Error('secret storage details')}
  else f.driver.service.record=async()=>{throw Error('secret storage details')}
  await assert.rejects(f.driver.start('owner',{runId:'run'},new AbortController().signal),{code:'teloa/execution-pending'})
  assert.equal(f.run().state,'submitting');assert.equal(f.run().evidence,undefined);assert.equal(f.sends(),1)
 }
})

test('未知提交核验挂起时取消能退出稳定区，迟到读取不再落库',async()=>{
 const f=fixture(),controller=new AbortController();f.fail()
 let entered!:()=>void,release!:(events:SessionEvent[])=>void,maintenance=false
 const reading=new Promise<void>(resolve=>{entered=resolve})
 f.driver.ports.events=()=>{entered();return new Promise(resolve=>{release=resolve})}
 const sync=createManagedAvailabilitySync({deny:()=>{},read:async()=>null,replace:()=>{}})
 f.driver.ports.stableStart=sync.stable
 const start=f.driver.start('owner',{runId:'run'},controller.signal).then(()=> 'unexpected-success',error=>error.code)
 await reading
 const changing=sync.change(async()=>{maintenance=true})
 controller.abort()
 try{
  assert.equal(await Promise.race([start,new Promise(resolve=>setTimeout(()=>resolve('hung'),100))]),'teloa/execution-pending')
  await changing;assert.equal(maintenance,true)
 }finally{release([
  {seq:0,time:0,type:'turn/start',data:{turn:0}},
  {seq:1,time:1,type:'user/message',surfaceOp:'append',data:{source:{kind:'user',rpcId:'native'},content:[],id:'fixed',role:'user'}},
  {seq:2,time:2,type:'turn/end',data:{turn:0,reason:{kind:'completed'}}},
 ] as SessionEvent[])}
 await new Promise(resolve=>setImmediate(resolve))
 assert.equal(f.run().state,'submitting');assert.equal(f.run().evidence,undefined)
})

test('未知提交核验超时自行退出，迟到拒绝被接住且不重发',async()=>{
 const f=fixture();f.fail()
 let entered!:()=>void,rejectRead!:(error:Error)=>void
 const reading=new Promise<void>(resolve=>{entered=resolve})
 f.driver.ports.backgroundState=()=>{entered();return new Promise((_resolve,reject)=>{rejectRead=reject})}
 const start=f.driver.start('owner',{runId:'run'},new AbortController().signal).then(()=> 'unexpected-success',error=>error.code)
 await reading
 try{assert.equal(await Promise.race([start,new Promise(resolve=>setTimeout(()=>resolve('hung'),1500))]),'teloa/execution-pending')}
 finally{rejectRead(Error('late private failure'))}
 await new Promise(resolve=>setImmediate(resolve))
 assert.equal(f.run().state,'submitting');assert.equal(f.sends(),1)
})

test('取消时已经发出的固定证据写入可迟到完成，不继续发送或改成成功回包',async()=>{
 const f=fixture(),controller=new AbortController();f.fail()
 let entered!:()=>void,release!:()=>void
 const writing=new Promise<void>(resolve=>{entered=resolve}),pending=new Promise<void>(resolve=>{release=resolve})
 const record=f.driver.service.record
 f.driver.service.record=async(...args)=>{entered();await pending;return record(...args)}
 f.events([
  {seq:0,time:0,type:'turn/start',data:{turn:0}},
  {seq:1,time:1,type:'user/message',surfaceOp:'append',data:{source:{kind:'user',rpcId:'native'},content:[],id:'fixed',role:'user'}},
  {seq:2,time:2,type:'turn/end',data:{turn:0,reason:{kind:'completed'}}},
 ] as SessionEvent[])
 const start=f.driver.start('owner',{runId:'run'},controller.signal)
 await writing;controller.abort()
 await assert.rejects(start,{code:'teloa/execution-pending'})
 assert.equal(f.run().state,'submitting')
 release();await new Promise(resolve=>setImmediate(resolve))
 assert.deepEqual(f.run().evidence,{state:'ended',turn:0,messageSeq:1,endSeq:2,reason:'completed'})
 await f.driver.start('owner',{runId:'run'},new AbortController().signal)
 assert.equal(f.sends(),1)
})
