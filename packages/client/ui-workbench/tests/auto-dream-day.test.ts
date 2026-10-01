import test from 'node:test'
import assert from 'node:assert/strict'
import {autoDreamObservationDay,autoDreamRecentDays} from '../src/client/auto-dream-day.ts'

const sg={time:'23:30',timezone:'Asia/Singapore' as const}
test('本地时刻早于触发时刻算前一天（镜像 backend auto-dream-habits.ts:24-34）',()=>{
 assert.equal(autoDreamObservationDay('2026-09-21T15:00:00.000Z',sg),'2026-09-20') // 新加坡 23:00 < 23:30
 assert.equal(autoDreamObservationDay('2026-09-21T15:30:00.000Z',sg),'2026-09-21') // 恰 23:30 取当天
 assert.equal(autoDreamObservationDay('2026-09-21T17:00:00.000Z',sg),'2026-09-21') // 新加坡 22 日 01:00 < 23:30 → 观察日仍是 21 日
 assert.equal(autoDreamObservationDay('2026-09-21T15:00:00.000Z',{time:'00:01',timezone:'UTC'}),'2026-09-21')
})
test('跨月与跨年往前数',()=>{
 assert.equal(autoDreamObservationDay('2026-03-01T10:00:00.000Z',{time:'23:30',timezone:'UTC'}),'2026-02-28')
 assert.equal(autoDreamObservationDay('2027-01-01T00:00:00.000Z',{time:'23:30',timezone:'UTC'}),'2026-12-31')
})
test('非法时间戳抛错',()=>{assert.throws(()=>autoDreamObservationDay('不是时间',sg))})
test('autoDreamRecentDays 含今天往前数 7 天升序',()=>{
 assert.deepEqual(autoDreamRecentDays('2026-03-02',7),['2026-02-24','2026-02-25','2026-02-26','2026-02-27','2026-02-28','2026-03-01','2026-03-02'])
})
