import test from 'node:test'
import assert from 'node:assert/strict'
import {monitorTaskRuns} from '../src/task-run-monitor.ts'
const settle=()=>new Promise(resolve=>setImmediate(resolve))
test('后台观察串行扫描，单条失败不阻塞其他记录，重复错误不刷屏',async()=>{
 let tick=()=>{},scheduled=0,calls:string[]=[],reports:string[]=[]
 const stop=monitorTaskRuns({list:async()=>['bad','good'],reconcile:async id=>{calls.push(id);if(id==='bad')throw Error('private details')},deliver:async()=>{},report:(id,code)=>reports.push(id+code)},work=>{tick=work;scheduled++;return ()=>{}})
 tick();await settle();assert.deepEqual(calls,['bad','good']);assert.equal(scheduled,2)
 tick();await settle();assert.deepEqual(calls,['bad','good','bad','good']);assert.equal(reports.length,1);assert.ok(!reports[0]!.includes('private'))
 await stop()
})
test('卸载等待已开始回填，停止后不处理下一条且不再定时',async()=>{
 let tick=()=>{},resolve!:()=>void,scheduled=0,finished=false
 const gate=new Promise<void>(r=>{resolve=r}),calls:string[]=[]
 const stop=monitorTaskRuns({list:async()=>['one','two'],reconcile:async id=>{calls.push(id);await gate},deliver:async()=>{},report:()=>{}},work=>{tick=work;scheduled++;return ()=>{}})
 tick();await settle()
 const ending=stop().then(()=>{finished=true});await settle();assert.equal(finished,false)
 resolve();await ending;assert.deepEqual(calls,['one']);assert.equal(scheduled,1)
})
test('通知故障只报告投递错误，不重复执行本轮 Run 回填',async()=>{
 let tick=()=>{},reconciles=0,deliveries=0
 const reports:Array<[string,string]>=[]
 const stop=monitorTaskRuns({
  list:async()=>['ended-run'],
  reconcile:async()=>{reconciles++},
  deliver:async()=>{deliveries++;throw Error('channel credential')},
  report:(id,code)=>reports.push([id,code]),
 },work=>{tick=work;return ()=>{}})
 tick();await settle()
 assert.equal(reconciles,1);assert.equal(deliveries,1)
 assert.deepEqual(reports,[['notification-delivery','teloa/notification-unavailable']])
 assert.ok(!JSON.stringify(reports).includes('credential'))
 tick();await settle();assert.equal(reconciles,2);assert.equal(deliveries,2)
 assert.equal(reports.length,1,'相同投递错误不应在每轮观察重复刷屏')
 await stop()
})
test('已请求停止但仍在执行的记录按退避有界重发取消，上限之后不再重发也不伪造终态',async()=>{
 let tick=()=>{},millis=0,state={state:'active',stopRequestedAt:'2026-09-20T09:00:00.000Z'}
 const resends:string[]=[],reports:string[]=[]
 const stop=monitorTaskRuns({
  list:async()=>['run-1'],
  reconcile:async()=>state,
  report:(id,code)=>reports.push(id+':'+code),
  resendStop:{
   needed:observed=>{const run=observed as typeof state;return run.stopRequestedAt!==null&&run.state==='active'},
   send:async id=>{resends.push(id)},
   limit:3,
   backoff:{initialMs:1000,maxMs:1000,now:()=>millis,jitter:()=>0},
  },
 },work=>{tick=work;return ()=>{}})
 tick();await settle();assert.equal(resends.length,1)
 // 退避窗口内的那一轮只观察，不重发。
 tick();await settle();assert.equal(resends.length,1)
 millis+=500;tick();await settle();assert.equal(resends.length,2)
 millis+=500;tick();await settle();assert.equal(resends.length,3)
 millis+=500;tick();await settle();assert.equal(resends.length,3,'到达上限后只保留停止时间，不再重发')
 assert.deepEqual(reports,[])
 // 记录仍是 active：重发既不写终态，也不改变观察结果。
 assert.deepEqual(state,{state:'active',stopRequestedAt:'2026-09-20T09:00:00.000Z'})
 // 没有停止请求的记录一次都不重发。
 state={state:'active',stopRequestedAt:null as unknown as string};millis+=100000
 tick();await settle();assert.equal(resends.length,3)
 await stop()
})

test('停止重发失败只报告，不影响本轮观察节奏',async()=>{
 let tick=()=>{},reconciles=0
 const reports:Array<[string,string]>=[]
 const stop=monitorTaskRuns({
  list:async()=>['run-1'],
  reconcile:async()=>{reconciles++;return {state:'active',stopRequestedAt:'2026-09-20T09:00:00.000Z'}},
  report:(id,code)=>reports.push([id,code]),
  resendStop:{needed:()=>true,send:async()=>{throw Error('native private detail')},limit:5},
 },work=>{tick=work;return ()=>{}})
 tick();await settle();tick();await settle()
 assert.equal(reconciles,2,'重发失败不该让观察退避')
 // 观察成功会清掉这条记录的去重键，所以每次重发失败都留一行；重发有上限，日志不会无休止。
 assert.deepEqual(reports,[['run-1','teloa/execution-pending'],['run-1','teloa/execution-pending']])
 assert.ok(!JSON.stringify(reports).includes('private'))
 await stop()
})

test('未提供通知投递端口时整轮扫描照常完成，不产生投递失败报告',async()=>{
 const seen:string[]=[],reports:string[]=[]
 let tick=()=>{}
 const stop=monitorTaskRuns({
  list:async()=>['a','b'],
  reconcile:async id=>{seen.push(id)},
  report:(id,code)=>reports.push(id+':'+code),
 },work=>{tick=work;return()=>{}})
 tick();await settle()
 assert.deepEqual(seen,['a','b']);assert.deepEqual(reports,[])
 tick();await settle();assert.deepEqual(seen,['a','b','a','b'],'缺席端口不影响第二轮继续扫描')
 await stop()
})

test('停止重发的判定可以读宿主：宿主仍在运行才重发，已不在运行只等收口，读不到只报告',async()=>{
 let tick=()=>{},running=true,fail=false,reconciles=0
 const resends:string[]=[],reports:Array<[string,string]>=[]
 const stop=monitorTaskRuns({
  list:async()=>['run-1'],
  reconcile:async()=>{reconciles++;return {state:'active',stopRequestedAt:'2026-09-20T09:00:00.000Z'}},
  report:(id,code)=>reports.push([id,code]),
  resendStop:{
   needed:async observed=>{
    const run=observed as {state:string;stopRequestedAt:string|null}
    if(run.stopRequestedAt===null||run.state!=='active')return false
    if(fail)throw Error('native private detail')
    return running
   },
   send:async id=>{resends.push(id)},
   limit:5,
  },
 },work=>{tick=work;return ()=>{}})
 tick();await settle();assert.equal(resends.length,1)
 running=false
 tick();await settle();assert.equal(resends.length,1,'宿主已不在运行，再喊停只是 no-op，收口交给 reconcile')
 fail=true
 tick();await settle()
 assert.equal(resends.length,1)
 assert.equal(reconciles,3,'判定读不到宿主不该让观察退避')
 assert.deepEqual(reports,[['run-1','teloa/execution-pending']])
 assert.ok(!JSON.stringify(reports).includes('private'))
 await stop()
})
