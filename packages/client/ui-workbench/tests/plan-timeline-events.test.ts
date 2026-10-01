import assert from 'node:assert/strict'
import test from 'node:test'
import {planTimelineEvents} from '../src/client/plan-timeline-events.ts'
import type {PlanTimelineInput} from '../src/client/plan-timeline-events.ts'
import type {PlanScheduleSkip} from '../src/client/plan-schedule-summary.ts'
import type {PlanExecutionHistoryItem} from '../src/client/plan-execution-history.ts'
import type {TeloaTranslate} from '../src/client/i18n/index.ts'

// plan.timeline.* 词条在 T9 接线 PlanDetail 之前没有 src/client 引用；i18n-orphan-keys 守卫今天不管 `plan.` 命名空间，故此时不报孤儿，T9 接线后由 PlanDetail 真实引用。

const planId='8ddfd681-086b-4bb5-b9b2-3aca4b7b8612'
const claimA='bb77082a-7cdd-48ad-b52e-6896575c59ad'
const claimB='0e415961-d4b0-4ef4-a6d8-7b1e58689ca5'
const taskId='d3b63b68-e8a2-4ef5-ae25-d4abf9cb260c'
const t:TeloaTranslate=(key,params)=>params?key+':'+JSON.stringify(params):key
const stamp=(at:string)=>'@'+at
const execution=(claimId:string,scheduledAt:string,run:PlanExecutionHistoryItem['run']):PlanExecutionHistoryItem=>({claimId,planId,occurrenceId:scheduledAt.slice(0,16)+'[UTC]',planVersion:3,configVersion:2,scheduledAt,claimedAt:scheduledAt.replace('00.000Z','01.000Z'),task:{id:taskId,state:'running'},run})
const skip=(scheduledAt:string):PlanScheduleSkip=>({planId,planVersion:3,configVersion:2,occurrenceId:scheduledAt.slice(0,16)+'[UTC]',scheduledAt,skippedAt:scheduledAt.replace('00.000Z','02.000Z'),reason:'previous-task-unfinished',blockingClaimId:claimA,taskId})
const faces={executions:'face:executions',execution:(item:PlanExecutionHistoryItem)=>'record:'+item.claimId,skips:'face:skips',source:'face:source'}
const input=(overrides:Partial<PlanTimelineInput>={}):PlanTimelineInput=>({
 plan:{id:planId,version:5,configVersion:2,createdAt:'2026-09-10T00:00:00.000Z',updatedAt:'2026-09-12T00:00:00.000Z',source:{kind:'manual'}},
 executions:[execution(claimB,'2026-09-16T01:00:00.000Z',{id:'f0b0c6a3-2e0e-4c8f-9a2f-4a1d8d1a0b11',state:'configuration_failed',sessionId:'s-2',createdAt:'2026-09-16T01:00:01.000Z'}),execution(claimA,'2026-09-13T01:00:00.000Z',{id:'f0b0c6a3-2e0e-4c8f-9a2f-4a1d8d1a0b12',state:'ended',sessionId:'s-1',createdAt:'2026-09-13T01:00:01.000Z'})],
 skips:[skip('2026-09-15T01:00:00.000Z'),skip('2026-09-14T01:00:00.000Z')],
 sourceLabel:'手动创建',faces,stamp,t,
 taskStateLabel:state=>'task:'+state,runStateLabel:state=>'run:'+state,
 ...overrides,
})

test('两次触发 + 两次跳过 + 修订 + 来源 = 6 条，按 at 倒序',()=>{
 const events=planTimelineEvents(input())
 assert.equal(events.length,6)
 assert.deepEqual(events.map(event=>event.kind),['trigger','skip','skip','trigger','revision','source'])
 assert.deepEqual(events.map(event=>event.id),['trigger:latest:'+planId,'skip:2026-09-15T01:00:02.000Z:2026-09-15T01:00[UTC]','skip:2026-09-14T01:00:02.000Z:2026-09-14T01:00[UTC]','trigger:'+claimA,'revision','source'])
 for(let index=1;index<events.length;index++)assert.ok(events[index-1]!.at>=events[index]!.at)
 for(const event of events)assert.match(event.at,/Z$/)
})

test('触发事件：标题用 scheduledAt、meta 拼任务态与运行态、配置失败置 pending、每次触发有自己的详情，最新一条额外承载分页面与锚点',()=>{
 const [latest,,,earlier]=planTimelineEvents(input())
 assert.equal(latest!.title,'plan.timeline.trigger:{"time":"@2026-09-16T01:00:00.000Z"}')
 assert.equal(latest!.meta,'plan.execution.task:{"state":"task:running"} · plan.execution.run:{"state":"run:configuration_failed"}')
 assert.equal(latest!.pending,true)
 assert.deepEqual(faceChildren(faceChildren(latest!.detail)[0]),['face:executions',null]);assert.equal(faceChildren(latest!.detail)[1],'record:'+claimB)
 assert.equal(latest!.anchor,'trigger')
 assert.equal(latest!.at,'2026-09-16T01:00:01.000Z')
 assert.equal(earlier!.kind,'trigger')
 assert.ok(!('pending' in earlier!))
 assert.deepEqual(faceChildren(earlier!.detail),[null,'record:'+claimA])
 assert.ok(!('anchor' in earlier!))
 assert.equal(earlier!.meta,'plan.execution.task:{"state":"task:running"} · plan.execution.run:{"state":"run:ended"}')
})

test('未建任务、未发起运行的触发用 unlinked / notStarted 文案',()=>{
 const [only]=planTimelineEvents(input({executions:[{...execution(claimA,'2026-09-13T01:00:00.000Z',null),task:null}],skips:[]}))
 assert.equal(only!.meta,'plan.execution.task:{"state":"plan.execution.unlinked"} · plan.execution.run:{"state":"plan.execution.notStarted"}')
})

test('跳过事件：同 reason 共用 foldKey，标题带原因文案，meta 是计划时刻，每次触发有自己的详情，最新一条额外承载分页面与锚点',()=>{
 const [,first,second]=planTimelineEvents(input())
 assert.equal(first!.foldKey,'skip:previous-task-unfinished')
 assert.equal(second!.foldKey,first!.foldKey)
 assert.equal(first!.title,'plan.timeline.skip:{"reason":"plan.schedule.skipRunning"}')
 assert.equal(first!.meta,'@2026-09-15T01:00:00.000Z')
 assert.equal(first!.at,'2026-09-15T01:00:02.000Z')
 assert.equal(first!.detail,'face:skips')
 assert.equal(first!.anchor,'skip')
 assert.ok(!('detail' in second!))
 assert.ok(!('anchor' in second!))
 const [pending]=planTimelineEvents(input({executions:[],skips:[{...skip('2026-09-15T01:00:00.000Z'),reason:'previous-pending',taskId:null}]}))
 assert.equal(pending!.title,'plan.timeline.skip:{"reason":"plan.schedule.skipPending"}')
 assert.equal(pending!.foldKey,'skip:previous-pending')
})

test('修订事件只在 configVersion>1 时出现，来源事件恒有且带详情面',()=>{
 const events=planTimelineEvents(input())
 const revision=events.find(event=>event.kind==='revision')!
 assert.deepEqual(revision,{id:'revision',kind:'revision',at:'2026-09-12T00:00:00.000Z',title:'plan.timeline.revision:{"version":2,"revision":5}'})
 const source=events.find(event=>event.kind==='source')!
 assert.deepEqual(source,{id:'source',kind:'source',at:'2026-09-10T00:00:00.000Z',title:'plan.timeline.source:{"label":"手动创建"}',detail:'face:source'})
 const fresh=planTimelineEvents(input({plan:{id:planId,version:1,configVersion:1,createdAt:'2026-09-10T00:00:00.000Z',updatedAt:'2026-09-10T00:00:00.000Z',source:{kind:'manual'}},executions:[],skips:[]}))
 // 新计划 updatedAt===createdAt，最新触发槽 与 source 同 at，按 id 升序 source 在前。
 assert.deepEqual(fresh.map(event=>event.kind),['source','trigger'])
})

const faceChildren=(detail:unknown)=>(detail as {props:{children:unknown[]}}).props.children

test('无执行：给一条 最新触发槽 承载 executions 面，非 pending，锚点与首条触发一致',()=>{
 const events=planTimelineEvents(input({executions:[]}))
 const none=events.find(event=>event.anchor==='trigger')!
 assert.equal(none.kind,'trigger')
 assert.equal(none.at,'2026-09-12T00:00:00.000Z')
 assert.equal(none.title,'plan.timeline.noTrigger')
 assert.equal(none.anchor,'trigger')
 assert.ok(!('pending' in none))
 assert.deepEqual(faceChildren(faceChildren(none.detail)[0]),['face:executions',null]);assert.equal(faceChildren(none.detail)[1],null)
 assert.equal(events.filter(event=>event.kind==='trigger').length,1)
})

test('无跳过：skips 面并入承载 executions 面的事件详情；两者皆无时并入 最新触发槽',()=>{
 const [latest]=planTimelineEvents(input({skips:[]}))
 assert.equal(latest!.id,'trigger:latest:'+planId)
 assert.deepEqual(faceChildren(faceChildren(latest!.detail)[0]),['face:executions','face:skips'])
 assert.equal(faceChildren(latest!.detail)[1],'record:'+claimB)
 assert.ok(!planTimelineEvents(input({skips:[]})).some(event=>event.kind==='skip'))
 const none=planTimelineEvents(input({executions:[],skips:[]})).find(event=>event.anchor==='trigger')!
 assert.deepEqual(faceChildren(faceChildren(none.detail)[0]),['face:executions','face:skips']);assert.equal(faceChildren(none.detail)[1],null)
})

test('有执行有跳过：与原行为一致——首条触发挂 executions 面、首条跳过挂 skips 面，单个最新触发槽',()=>{
 const events=planTimelineEvents(input())
 assert.equal(events.filter(event=>event.anchor==='trigger').length,1)
 assert.deepEqual(faceChildren(faceChildren(events.find(event=>event.kind==='trigger')!.detail)[0]),['face:executions',null])
 assert.equal(events.find(event=>event.kind==='skip')!.detail,'face:skips')
})

test('最新触发槽从空页变为有效页时身份稳定，不同计划各有身份',()=>{
 const empty=planTimelineEvents(input({executions:[]})).find(event=>event.anchor==='trigger')!
 const filled=planTimelineEvents(input()).find(event=>event.anchor==='trigger')!
 assert.equal(empty.id,filled.id)
 const other=planTimelineEvents(input({plan:{...input().plan,id:'another-plan'}})).find(event=>event.anchor==='trigger')!
 assert.notEqual(other.id,filled.id)
})
