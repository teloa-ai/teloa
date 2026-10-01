import test from 'node:test'
import assert from 'node:assert/strict'
import type {DigitalRole,RoleDailyLogSummary} from '@teloa/contract'
import {createAutoDreamRecentApi} from '../src/client/auto-dream-recent-api.ts'

const sg={time:'23:30',timezone:'Asia/Singapore' as const},now='2026-09-21T16:00:00.000Z' // 新加坡 22 日 00:00 → 观察日 2026-09-21
const role=(patch:Partial<DigitalRole>):DigitalRole=>({id:'11111111-1111-4111-8111-111111111111',ownerId:'local:owner',version:1,state:'active',createdAt:now,updatedAt:now,name:'林析',kind:'employee',scopes:['general'],duty:'x',dataScope:'x',executionScope:'x',skills:[],knowledge:[],...patch})
const summary=(day:string,state:'kept'|'discarded'='kept',kind:'daily-digest'|'habit-digest'='daily-digest'):RoleDailyLogSummary=>({id:'22222222-2222-4222-8222-2222222222'+day.slice(8),kind,day,state,title:'小结 '+day,createdAt:now})
const employee=role({}),twin=role({id:'33333333-3333-4333-8333-333333333333',name:'分身',kind:'twin'}),paused=role({id:'44444444-4444-4444-8444-444444444444',name:'已暂停',state:'paused'})

test('只取在岗岗位，每位恰调一次 dailyLogs，7 个方格按日期升序、kept 才实心',async()=>{
 const calls:string[]=[]
 const api=createAutoDreamRecentApi({roles:async()=>[employee,twin,paused],dailyLogs:async id=>{calls.push(id);return id===employee.id?[summary('2026-09-21'),summary('2026-09-20','discarded'),summary('2026-09-15')]:[summary('2026-09-21','kept','habit-digest')]}})
 const rows=await api.load({trigger:sg,planRoleIds:[employee.id],now})
 assert.deepEqual(calls,[employee.id,twin.id])
 assert.equal(rows.length,2)
 assert.deepEqual(rows[0]!.days.map(d=>d.day),['2026-09-15','2026-09-16','2026-09-17','2026-09-18','2026-09-19','2026-09-20','2026-09-21'])
 assert.deepEqual(rows[0]!.days.map(d=>d.kept),[true,false,false,false,false,false,true])
 assert.equal(rows[0]!.today,'generated');assert.equal(rows[0]!.hasPlan,true);assert.equal(rows[0]!.kind,'employee')
 assert.equal(rows[1]!.today,'habit');assert.equal(rows[1]!.hasPlan,true,'分身不需要计划，恒 true')
})
test('在岗同事无计划 → hasPlan=false；当日无日志 → today=none',async()=>{
 const api=createAutoDreamRecentApi({roles:async()=>[employee],dailyLogs:async()=>[summary('2026-09-19')]})
 const [row]=await api.load({trigger:sg,planRoleIds:[],now})
 assert.equal(row!.hasPlan,false);assert.equal(row!.today,'none')
})
test('某位的 dailyLogs 抛错不中止其余行：失败行显示未知，不能冒充无证据',async()=>{
 const api=createAutoDreamRecentApi({roles:async()=>[employee,twin],dailyLogs:async id=>{if(id===employee.id)throw Error('断线');return [summary('2026-09-21','kept','habit-digest')]}})
 const rows=await api.load({trigger:sg,planRoleIds:[employee.id],now})
 assert.equal(rows.length,2)
 assert.ok(rows[0]!.days.every(d=>d.kept===null));assert.equal(rows[0]!.today,'unavailable')
 assert.equal(rows[1]!.today,'habit')
})
test('当日日志是 discarded 视同没有：today=none、当日方格空心',async()=>{
 const api=createAutoDreamRecentApi({roles:async()=>[employee],dailyLogs:async()=>[summary('2026-09-21','discarded')]})
 const [row]=await api.load({trigger:sg,planRoleIds:[employee.id],now})
 assert.equal(row!.today,'none');assert.equal(row!.days.at(-1)!.kept,false)
})
