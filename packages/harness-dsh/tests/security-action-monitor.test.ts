import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {monitorTaskRuns} from '../src/task-run-monitor.ts'

/**
 * 安全执行恢复循环与任务执行回填共用同一份循环（规格 §二 D3）：
 * 这里断言的是"共用之后关键性质仍然成立"，而不是再造一套调度器。
 *
 * 探针触发后立即把自己复位成 idle（调用即抛错），只有循环重新调用 schedule() 才会
 * 重新武装。这样"某条路径忘了重排下一轮"这类变异会在下一次 tick() 时显式炸出来，
 * 而不是安静地让测试保持绿色。
 */
const settle=()=>new Promise(resolve=>setImmediate(resolve))
const manual=()=>{const idle=()=>{throw Error('循环未重排下一轮')}
 let run:()=>void=idle
 const schedule=(work:()=>void)=>{run=work;return()=>{run=idle}}
 return {schedule,tick:()=>{const work=run;run=idle;work()}}}

test('安全执行后台扫描串行推进，单条失败不阻塞其他记录，重复错误不刷屏',async()=>{
 const order:string[]=[],reports:string[]=[],clock=manual()
 const stop=monitorTaskRuns({
  list:async()=>['op-1','op-2','op-3'],
  reconcile:async id=>{order.push(id);if(id==='op-2')throw Object.assign(Error('未就绪'),{code:'teloa/dependency-unavailable'})},
  report:(id,code)=>reports.push(id+':'+code),
 },clock.schedule)
 clock.tick();await settle()
 assert.deepEqual(order,['op-1','op-2','op-3'])
 assert.deepEqual(reports,['op-2:teloa/dependency-unavailable'])
 clock.tick();await settle()
 assert.deepEqual(order,['op-1','op-2','op-3','op-1','op-2','op-3'])
 assert.deepEqual(reports,['op-2:teloa/dependency-unavailable'],'同一错误码第二轮不再报一次')
 await stop()
})

test('卸载等待已开始的恢复，停止后不处理下一条且不再定时',async()=>{
 const order:string[]=[],clock=manual()
 let release=()=>{}
 const gate=new Promise<void>(resolve=>{release=resolve})
 const stop=monitorTaskRuns({
  list:async()=>['op-1','op-2'],
  reconcile:async id=>{order.push(id);if(id==='op-1')await gate},
  report:()=>{},
 },clock.schedule)
 clock.tick();await settle()
 assert.deepEqual(order,['op-1'])
 const stopping=stop();release();await stopping
 assert.deepEqual(order,['op-1'],'停止之后不再处理 op-2')
 assert.throws(()=>clock.tick(),/循环未重排下一轮/,'停止之后不再定时')
})

test('目录读取失败只报一次，恢复之后清掉该条报告',async()=>{
 const reports:string[]=[],clock=manual()
 let fail=true
 const stop=monitorTaskRuns({
  list:async()=>{if(fail)throw Object.assign(Error('库不可读'),{code:'teloa/storage-corrupt'});return []},
  reconcile:async()=>{},
  report:(id,code)=>reports.push(id+':'+code),
 },clock.schedule)
 clock.tick();await settle()
 assert.deepEqual(reports,['directory:teloa/storage-corrupt'])
 fail=false;clock.tick();await settle()
 clock.tick();await settle()
 assert.deepEqual(reports,['directory:teloa/storage-corrupt'],'恢复之后不再重复报')
 fail=true;clock.tick();await settle()
 assert.equal(reports.length,2,'清掉记录之后再坏一次应重新报告，钉住成功后 failures.delete(\'directory\')')
 await stop()
})

/**
 * 规格 §九 开放问题 2：一分钟冷却只推迟首次捡起，不构成退避——`markUnknown` 对已是
 * `effect_unknown` 的记录直接返回不写库，`updated_at` 不推进，所以 `observe` 恒 null +
 * `execute` 恒失败的记录被推迟 60 秒之后仍会每 2 秒无退避无上限重放 POST。
 * 验收报告给的两条修法里，"失败时推进 updated_at" 与 append-only 语义冲突（须先定），
 * 这里落地另一条：按连续失败轮数在宿主侧跳过。退避只装在安全执行这条循环上，
 * 任务执行回填与通知投递的节奏逐字不动（端口缺席即完全按原样跑）。
 */
test('恒失败的记录按连续失败次数指数退避，退避有上限与抖动，时钟与抖动都可注入',async()=>{
 const attempts:number[]=[],clock=manual()
 let millis=0
 const stop=monitorTaskRuns({
  list:async()=>['op-doomed'],
  reconcile:async()=>{attempts.push(millis);throw Object.assign(Error('厂商恒失败'),{code:'teloa/dependency-unavailable'})},
  report:()=>{},
  // 抖动固定成 1 才能在用例里算准下一次允许重试的时刻；生产用 Math.random。
  backoff:{initialMs:2000,maxMs:16000,now:()=>millis,jitter:()=>1},
 },clock.schedule)
 const round=async(advanceMs:number)=>{millis+=advanceMs;clock.tick();await settle()}
 await round(0)
 assert.deepEqual(attempts,[0],'第一轮照常尝试')
 await round(1999)
 assert.deepEqual(attempts,[0],'失败一次之后退避 2000ms，窗口内的 tick 一次都不打外部')
 await round(1)
 assert.deepEqual(attempts,[0,2000],'退避到期这一轮才允许第二次尝试')
 await round(3999)
 assert.deepEqual(attempts,[0,2000],'第二次失败之后退避翻倍到 4000ms')
 await round(1)
 assert.deepEqual(attempts,[0,2000,6000],'4000ms 退避到期后第三次尝试')
 await round(7999);assert.equal(attempts.length,3,'第三次失败退避 8000ms')
 await round(1);assert.deepEqual(attempts,[0,2000,6000,14000])
 await round(15999);assert.equal(attempts.length,4,'第四次失败退避 16000ms，正好撞上上限')
 await round(1);assert.deepEqual(attempts,[0,2000,6000,14000,30000])
 await round(15999);assert.equal(attempts.length,5,'退避封顶在 maxMs，不会翻到 32000ms')
 await round(1);assert.deepEqual(attempts,[0,2000,6000,14000,30000,46000],'封顶之后按上限周期重试，不是彻底放弃')
 await stop()
})

test('退避带半抖动（不足上限即随机提前），一次成功即清零退避',async()=>{
 const attempts:number[]=[],clock=manual()
 let millis=0,fail=true
 const stop=monitorTaskRuns({
  list:async()=>['op-flaky'],
  reconcile:async()=>{attempts.push(millis);if(fail)throw Error('厂商不可达')},
  report:()=>{},
  // 抖动取 0 是半抖动的下界：等待时间应是上限的一半，而不是 0。
  backoff:{initialMs:1000,maxMs:1000,now:()=>millis,jitter:()=>0},
 },clock.schedule)
 const round=async(advanceMs:number)=>{millis+=advanceMs;clock.tick();await settle()}
 await round(0);assert.deepEqual(attempts,[0])
 await round(499);assert.deepEqual(attempts,[0],'抖动取 0 时也要等满一半，不能退化成不退避')
 await round(1);assert.deepEqual(attempts,[0,500],'半抖动下界是 1000ms/2')
 fail=false;await round(500);assert.deepEqual(attempts,[0,500,1000])
 fail=true;await round(0);assert.deepEqual(attempts,[0,500,1000,1000],'一次成功即清零退避，下一轮立刻再试')
 await stop()
})

test('记录离开待恢复目录后退避状态一起清掉，回到目录时立刻重试',async()=>{
 const attempts:number[]=[],clock=manual()
 let millis=0,ids=['op-gone']
 const stop=monitorTaskRuns({
  list:async()=>ids,
  reconcile:async()=>{attempts.push(millis);throw Error('厂商不可达')},
  report:()=>{},
  backoff:{initialMs:60000,maxMs:60000,now:()=>millis,jitter:()=>1},
 },clock.schedule)
 const round=async(advanceMs:number)=>{millis+=advanceMs;clock.tick();await settle()}
 await round(0);assert.deepEqual(attempts,[0])
 ids=[];await round(1)
 ids=['op-gone'];await round(1)
 assert.deepEqual(attempts,[0,2],'离开目录（已落终态）再回来的是另一段生命，不该继续背着上一段的 60s 退避')
 await stop()
})

test('未配置退避的循环逐字保持原节奏：恒失败也每轮都试',async()=>{
 const attempts:string[]=[],clock=manual()
 const stop=monitorTaskRuns({
  list:async()=>['run-1'],
  reconcile:async()=>{attempts.push('try');throw Error('失败')},
  deliver:async()=>{},
  report:()=>{},
 },clock.schedule)
 clock.tick();await settle();clock.tick();await settle();clock.tick();await settle()
 assert.equal(attempts.length,3,'任务执行回填那条循环不受退避改动影响')
 await stop()
})

test('宿主接线：安全执行恢复循环配了退避，任务执行回填那条没有',async()=>{
 const source=await readFile(new URL('../src/index.ts',import.meta.url),'utf8')
 const loops=source.split('monitorTaskRuns({').slice(1)
 assert.equal(loops.length,2,'本用例按"两条循环"的现状写死；新增循环时要回来补判据')
 const security=loops.find(body=>body.includes('securityExecutions.outstanding'))
 const taskRuns=loops.find(body=>body.includes('runService()).outstanding'))
 // 只在顶层装配结束处截断，嵌套接单闸或回调也可能包含 `}))`。
 const loopBody=(body:string|undefined)=>body?.split(/\n {2}\}\)\)/,1)[0]??''
 assert.ok(loopBody(security).includes('backoff:'),'安全执行恢复会向外部重放 POST，必须配退避')
 const taskRunBody=loopBody(taskRuns)
 // 回填本身仍是"逐字原节奏"：整条循环不配 backoff。停止重发是另一件事，它的退避写在 resendStop 里面。
 assert.ok(!/\n\s{4}backoff:/.test(taskRunBody),'任务执行回填只读原生会话日志，不该顺手改它的节奏')
 assert.ok(/resendStop:\{[\s\S]*backoff:/.test(taskRunBody),'停止重发会再次向原生递交取消，必须按退避拉开间隔')
})
