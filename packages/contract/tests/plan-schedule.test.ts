import test from 'node:test'
import assert from 'node:assert/strict'
import {nextScheduleOccurrence,readScheduleTrigger} from '../src/plan-schedule.ts'
const daily={kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'}
test('下一次触发严格晚于边界，跨UTC日期保留本地触发身份',()=>{
 assert.deepEqual(nextScheduleOccurrence(daily,'2026-09-10T23:00:00Z'),{at:'2026-09-11T01:00:00.000Z',occurrenceId:'2026-09-11T09:00[Asia/Singapore]'})
 assert.equal(nextScheduleOccurrence(daily,'2026-09-11T01:00:00Z').at,'2026-09-12T01:00:00.000Z')
 assert.equal(nextScheduleOccurrence({...daily,time:'00:00'},'2026-09-11T12:00:00Z').at,'2026-09-11T16:00:00.000Z')
})
test('周日到周一、闰日与年边界按配置时区计算',()=>{
 assert.equal(nextScheduleOccurrence({...daily,cadence:'weekly'},'2026-09-13T12:00:00Z').at,'2026-09-14T01:00:00.000Z')
 assert.equal(nextScheduleOccurrence({...daily,timezone:'Asia/Shanghai'},'2028-02-28T02:00:00Z').at,'2028-02-29T01:00:00.000Z')
 assert.equal(nextScheduleOccurrence({...daily,timezone:'UTC'},'2026-12-31T10:00:00Z').at,'2027-01-01T09:00:00.000Z')
})
test('无效配置和被Date自动归一化的日期不能穿透',()=>{
 for(const patch of [{weekday:0},{weekday:8},{time:'24:00'},{timezone:'America/New_York'},{cadence:'hourly'},{extra:true}])assert.throws(()=>readScheduleTrigger({...daily,...patch}))
 for(const value of ['2026-02-30T01:00:00Z','2026-09-11','2026-09-11T01:00:00+08:00','invalid','0000-01-01T00:00:00Z'])assert.throws(()=>nextScheduleOccurrence(daily,value))
})

test('早期年份不被Date.UTC自动转换为1900年代',()=>{assert.equal(nextScheduleOccurrence({...daily,timezone:'UTC'},'0099-01-01T10:00:00Z').at,'0099-01-02T09:00:00.000Z')})
