import test from 'node:test'
import assert from 'node:assert/strict'
import {isScheduledOccurrenceId,nextScheduleOccurrence,readScheduleTrigger} from '../src/plan-schedule.ts'
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
 for(const patch of [{weekday:0},{weekday:8},{time:'24:00'},{timezone:'Etc/Not_A_Zone'},{cadence:'hourly'},{extra:true}])assert.throws(()=>readScheduleTrigger({...daily,...patch}))
 for(const value of ['2026-02-30T01:00:00Z','2026-09-11','2026-09-11T01:00:00+08:00','invalid','0000-01-01T00:00:00Z'])assert.throws(()=>nextScheduleOccurrence(daily,value))
})

test('早期年份不被Date.UTC自动转换为1900年代',()=>{assert.equal(nextScheduleOccurrence({...daily,timezone:'UTC'},'0099-01-01T10:00:00Z').at,'0099-01-02T09:00:00.000Z')})

test('AD02-DST：纽约合法且23:30跨春秋转换保持本地日身份',()=>{
 const ny={...daily,time:'23:30',timezone:'America/New_York'}
 assert.deepEqual(readScheduleTrigger(ny),ny)
 for(const [after,at,day]of [
  ['2026-03-08T04:29:59.999Z','2026-03-08T04:30:00.000Z','2026-03-07'],
  ['2026-03-08T04:30:00.000Z','2026-03-09T03:30:00.000Z','2026-03-08'],
  ['2026-11-01T03:29:59.999Z','2026-11-01T03:30:00.000Z','2026-10-31'],
  ['2026-11-01T03:30:00.000Z','2026-11-02T04:30:00.000Z','2026-11-01'],
 ] as const)assert.deepEqual(nextScheduleOccurrence(ny,after),{at,occurrenceId:`${day}T23:30[America/New_York]`})
})
test('AD02-DST：春跳缺失02:30跳过当天，次日接续且周计划不偷改时刻',()=>{
 const ny={...daily,time:'02:30',timezone:'America/New_York'}
 assert.deepEqual(nextScheduleOccurrence(ny,'2026-03-08T06:59:59.999Z'),{at:'2026-03-09T06:30:00.000Z',occurrenceId:'2026-03-09T02:30[America/New_York]'})
 assert.deepEqual(nextScheduleOccurrence({...ny,cadence:'weekly',weekday:7},'2026-03-07T08:00:00.000Z'),{at:'2026-03-15T06:30:00.000Z',occurrenceId:'2026-03-15T02:30[America/New_York]'})
})
test('AD02-DST：秋复01:30固定首次时刻，第二次不产生同日新身份',()=>{
 const ny={...daily,time:'01:30',timezone:'America/New_York'}
 assert.deepEqual(nextScheduleOccurrence(ny,'2026-11-01T05:29:59.999Z'),{at:'2026-11-01T05:30:00.000Z',occurrenceId:'2026-11-01T01:30[America/New_York]'})
 for(const after of ['2026-11-01T05:30:00.000Z','2026-11-01T06:29:59.999Z','2026-11-01T06:30:00.000Z'])assert.deepEqual(nextScheduleOccurrence(ny,after),{at:'2026-11-02T06:30:00.000Z',occurrenceId:'2026-11-02T01:30[America/New_York]'})
})

test('AD02-DST：持久日程身份仅接受固定形状与四个合法时区',()=>{
 for(const zone of ['Asia/Singapore','Asia/Shanghai','UTC','America/New_York'])assert.equal(isScheduledOccurrenceId(`2026-11-01T01:30[${zone}]`),true)
 for(const value of [null,{},'2026-11-01T01:30[Europe/London]','2026-11-01T01:30[America/New_York]extra','2026-11-01T01:30America/New_York','2026-11-01T01:30:00[UTC]','manual:123'])assert.equal(isScheduledOccurrenceId(value),false)
})
