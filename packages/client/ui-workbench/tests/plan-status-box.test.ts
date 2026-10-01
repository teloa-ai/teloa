import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync} from 'node:fs'
import {consecutiveSkips,planStatusBox} from '../src/client/plan-status-box.ts'
import type {PlanStatusInput} from '../src/client/plan-status-box.ts'
import type {PlanScheduleOccurrence,PlanScheduleSkip,PlanScheduleSummary} from '../src/client/plan-schedule-summary.ts'
import type {PlanExecutionHistoryItem} from '../src/client/plan-execution-history.ts'
import type {TeloaTranslate} from '../src/client/i18n/index.ts'
import {CONTINUOUS_DETAIL_MESSAGE_ROWS} from '../src/client/i18n/locales/continuous-details.ts'

// 本任务新增的 24 条 plan.status.* / plan.timeline.* / plan.rail.* / plan.menu.* 词条在 T9 接线 PlanDetail 之前没有 src/client 引用。
// i18n-orphan-keys 守卫今天不管 `plan.` 命名空间（NAMESPACES 里没有），所以此时不会报孤儿；T9 接线后由 PlanDetail 真实引用，不加豁免。

const planId='8ddfd681-086b-4bb5-b9b2-3aca4b7b8612'
const claimA='bb77082a-7cdd-48ad-b52e-6896575c59ad'
const claimB='0e415961-d4b0-4ef4-a6d8-7b1e58689ca5'
const taskId='d3b63b68-e8a2-4ef5-ae25-d4abf9cb260c'
const latestTaskId='4f23edeb-d497-405a-8606-c1a8666fb3ef'
const t:TeloaTranslate=(key,params)=>params?key+':'+JSON.stringify(params):key
const stamp=(at:string)=>'@'+at
const trigger={kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'} as const
const occurrence={id:claimA,ownerId:'local:teloa-owner',planId,planVersion:3,configVersion:1,occurrenceId:'2026-09-13T09:00[Asia/Singapore]',scheduledAt:'2026-09-13T01:00:00.000Z',claimedAt:'2026-09-13T01:00:01.000Z',taskRequestId:'9ce2aa39-59c5-4bf6-9d58-f8fe308d27ac',fields:{title:'每日核对',goal:'核对资料',scope:'SOC',dataScope:'已授权资料',delivery:'摘要',roleId:latestTaskId,trigger},source:{kind:'manual'},roleVersion:1,taskRequest:{requestId:'9ce2aa39-59c5-4bf6-9d58-f8fe308d27ac',fields:{title:'每日核对',goal:'核对资料',scope:'SOC'},assignee:{roleId:latestTaskId,expectedVersion:1}}} as PlanScheduleOccurrence
const skip=(scheduledAt:string,reason:PlanScheduleSkip['reason'],blockingClaimId:string):PlanScheduleSkip=>({planId,planVersion:3,configVersion:1,occurrenceId:scheduledAt.slice(0,16)+'[UTC]',scheduledAt,skippedAt:scheduledAt.replace('00.000Z','02.000Z'),reason,blockingClaimId,taskId:reason==='previous-pending'?null:taskId})
const summary=(overview:Partial<NonNullable<PlanScheduleSummary['overview']>>={}):PlanScheduleSummary=>({available:true,overview:{planId,planVersion:3,state:'active',nextAt:null,latest:null,latestSkip:null,...overview},health:null})
const execution=(run:PlanExecutionHistoryItem['run']):PlanExecutionHistoryItem=>({claimId:claimA,planId,occurrenceId:occurrence.occurrenceId,planVersion:3,configVersion:1,scheduledAt:occurrence.scheduledAt,claimedAt:occurrence.claimedAt,task:{id:taskId,state:'running'},run})
const input=(overrides:Partial<PlanStatusInput>={}):PlanStatusInput=>({plan:{state:'active',trigger},schedule:summary(),skips:[],latestExecution:null,stamp,t,...overrides})

test('第 1 行：归档优先于一切',()=>{
 const model=planStatusBox(input({plan:{state:'archived',trigger},schedule:{available:false,overview:null,health:null}}))
 assert.deepEqual(model,{tone:'muted',sentence:'plan.status.archived',detail:'continuous.detail.status.archived'})
})

test('第 2 行：宿主未装配调度只给手动触发',()=>{
 const model=planStatusBox(input({schedule:{available:false,overview:null,health:null}}))
 assert.deepEqual(model,{tone:'warn',sentence:'plan.status.unavailable',detail:'plan.schedule.unavailable',primary:{label:'continuous.detail.triggerOnce',action:{kind:'trigger'}}})
})

test('第 3 行：暂停态带触发方式与恢复按钮；摘要未读时无 detail',()=>{
 const connected=planStatusBox(input({plan:{state:'paused',trigger}}))
 assert.equal(connected.tone,'muted')
 assert.match(connected.sentence,/^plan\.status\.paused:\{"trigger":"continuous\.trigger\.daily:/)
 assert.equal(connected.detail,'continuous.detail.status.pausedConnected')
 assert.deepEqual(connected.primary,{label:'continuous.detail.resume',action:{kind:'resume'}})
 assert.equal(connected.secondary,undefined)
 const unread=planStatusBox(input({plan:{state:'paused',trigger},schedule:undefined}))
 assert.equal(unread.detail,undefined)
 assert.ok(!('detail' in unread))
})

test('第 4 行：被阻塞——日期取 scheduledAt、连续次数取 consecutiveSkips、主按钮开被阻塞任务',()=>{
 const latestSkip=skip('2026-09-15T01:00:00.000Z','previous-task-unfinished',claimA)
 const skips=[latestSkip,skip('2026-09-14T01:00:00.000Z','previous-task-unfinished',claimA),skip('2026-09-13T01:00:00.000Z','previous-task-unfinished',claimA)]
 const model=planStatusBox(input({schedule:summary({nextAt:'2026-09-16T01:00:00.000Z',latestSkip}),skips}))
 assert.deepEqual(model,{tone:'warn',sentence:'plan.status.blocked:{"date":"@2026-09-15T01:00:00.000Z","count":3}',detail:'plan.schedule.skipRunning',hint:'plan.status.blockedHint',primary:{label:'plan.status.action.openTask',action:{kind:'open-task',taskId}}})
})

test("第 4' 行：previous-pending 无 taskId 时主按钮落到最近领取的任务，没有就不给",()=>{
 const latestSkip=skip('2026-09-15T01:00:00.000Z','previous-pending',claimA)
 const withLatest=planStatusBox(input({schedule:summary({latestSkip,latest:{occurrence,task:{id:latestTaskId,state:'waiting'}}})}))
 assert.equal(withLatest.sentence,'plan.status.blocked:{"date":"@2026-09-15T01:00:00.000Z","count":1}')
 assert.equal(withLatest.detail,'plan.schedule.skipPending')
 assert.equal(withLatest.hint,'plan.status.blockedHint')
 assert.deepEqual(withLatest.primary,{label:'plan.status.action.openTask',action:{kind:'open-task',taskId:latestTaskId}})
 const without=planStatusBox(input({schedule:summary({latestSkip,latest:{occurrence,task:null}})}))
 assert.equal(without.tone,'warn')
 assert.equal(without.primary,undefined)
 assert.ok(!('primary' in without))
})

test('第 4 行不成立：有更晚的成功领取时，旧跳过已被解开，落到第 6/7 行',()=>{
 const latestSkip=skip('2026-09-13T01:00:00.000Z','previous-task-unfinished',claimA)
 const later={occurrence:{...occurrence,scheduledAt:'2026-09-16T01:00:00.000Z',claimedAt:'2026-09-16T01:00:01.000Z'},task:{id:latestTaskId,state:'running'}} as const
 const withNext=planStatusBox(input({schedule:summary({latestSkip,latest:later,nextAt:'2026-09-17T01:00:00.000Z'}),skips:[latestSkip]}))
 assert.equal(withNext.tone,'good')
 assert.equal(withNext.sentence,'plan.status.active:{"time":"@2026-09-17T01:00:00.000Z","timezone":"Asia/Singapore"}')
 assert.ok(!('hint' in withNext))
 const withoutNext=planStatusBox(input({schedule:summary({latestSkip,latest:later}),skips:[latestSkip]}))
 assert.equal(withoutNext.sentence,'plan.status.activeNoNext')
 const sameMoment=planStatusBox(input({schedule:summary({latestSkip,latest:{occurrence:{...occurrence,scheduledAt:latestSkip.scheduledAt,claimedAt:'2026-09-13T01:00:01.000Z'},task:null}})}))
 assert.equal(sameMoment.sentence,'plan.status.activeNoNext')
})

test('第 5 行：最近一次执行运行配置失败',()=>{
 const model=planStatusBox(input({latestExecution:execution({id:claimB,state:'configuration_failed',sessionId:'s-1',createdAt:occurrence.claimedAt})}))
 assert.deepEqual(model,{tone:'warn',sentence:'plan.status.configFailed',detail:'plan.run.configurationFailed',primary:{label:'plan.status.action.rePrepare',action:{kind:'open-task',taskId}}})
 const ended=planStatusBox(input({latestExecution:execution({id:claimB,state:'ended',sessionId:'s-1',createdAt:occurrence.claimedAt})}))
 assert.equal(ended.sentence,'plan.status.activeNoNext')
 // 更早的跳过已被更晚领取解开（第 4 行不成立）时，运行配置失败仍要压过第 6 行。
 const latestSkip=skip('2026-09-13T01:00:00.000Z','previous-task-unfinished',claimA)
 const later={occurrence:{...occurrence,scheduledAt:'2026-09-16T01:00:00.000Z',claimedAt:'2026-09-16T01:00:01.000Z'},task:{id:latestTaskId,state:'running'}} as const
 const unblocked=planStatusBox(input({schedule:summary({latestSkip,latest:later,nextAt:'2026-09-17T01:00:00.000Z'}),skips:[latestSkip],latestExecution:execution({id:claimB,state:'configuration_failed',sessionId:'s-1',createdAt:'2026-09-16T01:00:02.000Z'})}))
 assert.equal(unblocked.sentence,'plan.status.configFailed')
 assert.equal(unblocked.tone,'warn')
 assert.ok(!('hint' in unblocked))
})

test('第 6 行：有下次触发时间的正常态带时区、触发一次与暂停',()=>{
 const model=planStatusBox(input({schedule:summary({nextAt:'2026-09-16T01:00:00.000Z'})}))
 assert.deepEqual(model,{tone:'good',sentence:'plan.status.active:{"time":"@2026-09-16T01:00:00.000Z","timezone":"Asia/Singapore"}',primary:{label:'continuous.detail.triggerOnce',action:{kind:'trigger'}},secondary:{label:'continuous.detail.pause',action:{kind:'pause'}}})
})

test('第 7 行：其它情形按启用无下次处理；摘要未读不假称未装配',()=>{
 const connected=planStatusBox(input())
 assert.deepEqual(connected,{tone:'info',sentence:'plan.status.activeNoNext',detail:'continuous.detail.status.noSummary',primary:{label:'continuous.detail.triggerOnce',action:{kind:'trigger'}},secondary:{label:'continuous.detail.pause',action:{kind:'pause'}}})
 const unread=planStatusBox(input({schedule:undefined}))
 assert.deepEqual(unread,{tone:'info',sentence:'plan.status.activeNoNext',primary:{label:'continuous.detail.triggerOnce',action:{kind:'trigger'}},secondary:{label:'continuous.detail.pause',action:{kind:'pause'}}})
})

test('consecutiveSkips：同 claim 同 reason 连续计数，异 claim 截断，空表按 latestSkip 计 1',()=>{
 const latest=skip('2026-09-15T01:00:00.000Z','previous-task-unfinished',claimA)
 const same=[latest,skip('2026-09-14T01:00:00.000Z','previous-task-unfinished',claimA),skip('2026-09-13T01:00:00.000Z','previous-task-unfinished',claimA)]
 assert.equal(consecutiveSkips(same,latest),3)
 const broken=[latest,skip('2026-09-14T01:00:00.000Z','previous-task-unfinished',claimA),skip('2026-09-13T01:00:00.000Z','previous-task-unfinished',claimB),skip('2026-09-12T01:00:00.000Z','previous-task-unfinished',claimA)]
 assert.equal(consecutiveSkips(broken,latest),2)
 const reasonChanged=[latest,skip('2026-09-14T01:00:00.000Z','previous-pending',claimA)]
 assert.equal(consecutiveSkips(reasonChanged,latest),1)
 assert.equal(consecutiveSkips([],latest),1)
 assert.equal(consecutiveSkips([skip('2026-09-11T01:00:00.000Z','previous-task-unfinished',claimA)],latest),1)
 assert.equal(consecutiveSkips(same,null),0)
})

test('新增 24 条词条各恰一行、11 列、zh-CN 无界面禁词',()=>{
 const keys=['plan.status.aria','plan.status.active','plan.status.activeNoNext','plan.status.blocked','plan.status.blockedHint','plan.status.configFailed','plan.status.paused','plan.status.archived','plan.status.unavailable','plan.status.action.openTask','plan.status.action.rePrepare','plan.timeline.aria','plan.timeline.empty','plan.timeline.trigger','plan.timeline.skip','plan.timeline.fold.skip','plan.timeline.revision','plan.timeline.source','plan.timeline.noTrigger','plan.rail.aria','plan.rail.timezone','plan.rail.health','plan.rail.healthAt','plan.menu.more']
 assert.equal(keys.length,24)
 const forbidden=/工作空间|单空间|实例|投影|尚未加载|内容待读取|\d+\s*项资源|人类/
 for(const key of keys){
  const rows=CONTINUOUS_DETAIL_MESSAGE_ROWS.filter(row=>row[0]===key)
  assert.equal(rows.length,1,key)
  const row=rows[0]!
  assert.equal(row.length,11,key)
  for(const cell of row.slice(1))assert.ok(cell.trim(),key)
  assert.doesNotMatch(row[1],forbidden,key)
 }
 assert.equal(CONTINUOUS_DETAIL_MESSAGE_ROWS.find(row=>row[0]==='plan.status.blocked')?.[1],'被 {date} 那次任务卡住，已连续跳过 {count} 次')
 assert.equal(CONTINUOUS_DETAIL_MESSAGE_ROWS.find(row=>row[0]==='plan.timeline.fold.skip')?.[1],'连续跳过 {count} 次 · {reason}')
})

test('PlanDetail 已换到对象页骨架：状态框、时间线、属性栏接线，旧 planGrid 与三条说明词条不再出现',()=>{
 const source=readFileSync(new URL('../src/client/ContinuousPage.tsx',import.meta.url),'utf8')
 const styles=readFileSync(new URL('../src/client/ContinuousPage.module.css',import.meta.url),'utf8')
 for(const needle of ['planStatusBox(','planTimelineEvents(','<ObjectPageHeader','<StatusBox','<EventTimeline','<PropertyRail',"ariaLabel={t('plan.status.aria')}",'focusObjectAnchor(root.current,anchor,','data-teloa-anchor="archive"','data-teloa-anchor="trigger-demo"'])assert.ok(source.includes(needle),needle)
 for(const key of ['plan.status.aria','plan.timeline.aria','plan.timeline.empty','plan.timeline.fold.skip','plan.rail.aria','plan.rail.health','plan.rail.healthAt','plan.menu.more','continuous.detail.status.sandbox'])assert.ok(source.includes(`'${key}'`),key)
 for(const gone of ['own.planGrid','own.planSheet','own.planFacts','ScheduleSummaryView','continuous.detail.specification','continuous.detail.controls','continuous.detail.record','dangerouslySetInnerHTML'])assert.ok(!source.includes(gone),gone)
 for(const gone of ['.planGrid','.planSheet','.planFacts'])assert.ok(!styles.includes(gone),gone)
 assert.ok(styles.includes('.planBody{'))
 const savedSource=source.slice(source.indexOf('\nfunction SavedPlanSource'))
 assert.ok(savedSource.includes('objectCss.mono'))
 assert.ok(savedSource.includes('{display.summary}'))
 for(const key of ['continuous.detail.specification','continuous.detail.controls','continuous.detail.record'])assert.equal(CONTINUOUS_DETAIL_MESSAGE_ROWS.some(row=>row[0]===key),false,key)
 // notification.explanation 仍由 PlanForm（零改动区）引用，词条保留；这里只确认 PlanDetail 段不再用它。
 assert.ok(!source.slice(source.indexOf('\nfunction PlanDetail'),source.indexOf('\nfunction SavedPlanSource')).includes('continuous.detail.notification.explanation'))
})
