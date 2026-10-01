import test from 'node:test'
import assert from 'node:assert/strict'
import {WorkError} from '../src/work-error.ts'
import {nextScheduleOccurrence} from '../src/plan-schedule.ts'
import {businessSyncLimits,businessSyncScheduleWarning,nextBusinessSyncOccurrence,readBusinessSyncSchedule,type BusinessSyncSchedule} from '../src/business-sync-schedule.ts'

const invalid=(run:()=>unknown,message?:string)=>assert.throws(run,(error:unknown)=>error instanceof WorkError&&error.code==='teloa/invalid-input',message)

test('every：短于 60 秒必须显式确认；60–600 秒提示 short-interval；更长无提示',()=>{
 assert.deepEqual(businessSyncLimits,{minIntervalSeconds:60,warnIntervalSeconds:600,maxIntervalSeconds:2_592_000})
 invalid(()=>readBusinessSyncSchedule({kind:'every',seconds:30}),'30 秒未确认应拒绝')
 invalid(()=>readBusinessSyncSchedule({kind:'every',seconds:30,acknowledgeShortInterval:false}))
 const short=readBusinessSyncSchedule({kind:'every',seconds:30,acknowledgeShortInterval:true})
 assert.deepEqual(short,{schedule:{kind:'every',seconds:30},acknowledgeShortInterval:true})
 assert.equal(businessSyncScheduleWarning(short.schedule),'very-short-interval')
 const medium=readBusinessSyncSchedule({kind:'every',seconds:300})
 assert.deepEqual(medium,{schedule:{kind:'every',seconds:300},acknowledgeShortInterval:false})
 assert.equal(businessSyncScheduleWarning(medium.schedule),'short-interval')
 assert.equal(businessSyncScheduleWarning(readBusinessSyncSchedule({kind:'every',seconds:3600}).schedule),null)
 assert.equal(businessSyncScheduleWarning(readBusinessSyncSchedule({kind:'every',seconds:2_592_000}).schedule),null)
 for(const seconds of [0,-1,1.5,2_592_001,'60',NaN,Infinity])invalid(()=>readBusinessSyncSchedule({kind:'every',seconds,acknowledgeShortInterval:true}),JSON.stringify(seconds)+' 应拒绝')
 invalid(()=>readBusinessSyncSchedule({kind:'every',seconds:60,acknowledgeShortInterval:'true'}))
 invalid(()=>readBusinessSyncSchedule({kind:'every',seconds:60,minute:0}),'多余键应拒绝')
 invalid(()=>readBusinessSyncSchedule({kind:'weekly'}))
 invalid(()=>readBusinessSyncSchedule(null))
 invalid(()=>readBusinessSyncSchedule([]))
})

test('hourly / daily / cron 的键集与取值范围严格',()=>{
 assert.deepEqual(readBusinessSyncSchedule({kind:'hourly',minute:0}).schedule,{kind:'hourly',minute:0})
 assert.deepEqual(readBusinessSyncSchedule({kind:'hourly',minute:59}).schedule,{kind:'hourly',minute:59})
 for(const minute of [-1,60,1.5,'0'])invalid(()=>readBusinessSyncSchedule({kind:'hourly',minute}))
 assert.deepEqual(readBusinessSyncSchedule({kind:'daily',time:'02:30',timezone:'Asia/Shanghai'}).schedule,{kind:'daily',time:'02:30',timezone:'Asia/Shanghai'})
 for(const patch of [{time:'24:00'},{time:'2:30'},{time:'02:60'},{timezone:'America/New_York'},{timezone:'asia/shanghai'}])invalid(()=>readBusinessSyncSchedule({kind:'daily',time:'02:30',timezone:'Asia/Shanghai',...patch}),JSON.stringify(patch))
 invalid(()=>readBusinessSyncSchedule({kind:'daily',time:'02:30'}),'daily 缺时区应拒绝')
 const cron=readBusinessSyncSchedule({kind:'cron',expression:'0 9 * * 1-5',timezone:'Asia/Shanghai'}).schedule
 assert.deepEqual(cron,{kind:'cron',expression:'0 9 * * 1-5',timezone:'Asia/Shanghai'})
 for(const expression of ['0 9 * * MON','0 9 * * * *','0 9 * *','*/0 * * * *','60 * * * *','* 24 * * *','* * 0 * *','* * 32 * *','* * * 13 *','* * * * 8','5-1 * * * *','0 9 * * 1-5 ','0  9 * * *','','* * * * ?','0 9 * * 1#2','0 9 L * *','*/5/2 * * * *','1,,2 * * * *'])
  invalid(()=>readBusinessSyncSchedule({kind:'cron',expression,timezone:'UTC'}),JSON.stringify(expression)+' 应拒绝')
 assert.equal(businessSyncScheduleWarning(cron),null)
 assert.equal(businessSyncScheduleWarning({kind:'cron',expression:'*/15 * * * *',timezone:'UTC'}),null,'15 分钟 = 900 秒不短于 600 秒')
 assert.equal(businessSyncScheduleWarning({kind:'cron',expression:'*/5 * * * *',timezone:'UTC'}),'short-interval')
 assert.equal(businessSyncScheduleWarning({kind:'cron',expression:'0,30 * * * *',timezone:'UTC'}),null,'半小时一次不短于 600 秒')
 assert.equal(businessSyncScheduleWarning({kind:'cron',expression:'0,5 * * * *',timezone:'UTC'}),'short-interval')
 assert.equal(businessSyncScheduleWarning({kind:'cron',expression:'0,5 9 * * *',timezone:'UTC'}),'short-interval','同一小时内相隔 5 分钟')
 assert.equal(businessSyncScheduleWarning({kind:'cron',expression:'0,55 9,11 * * *',timezone:'UTC'}),null,'小时不相邻时不跨小时计间隔')
 assert.equal(businessSyncScheduleWarning({kind:'cron',expression:'0 */2 * * *',timezone:'UTC'}),null)
 assert.equal(businessSyncScheduleWarning({kind:'hourly',minute:5}),null)
 assert.equal(businessSyncScheduleWarning({kind:'daily',time:'02:30',timezone:'UTC'}),null)
})

test('cron：按时区求严格晚于 after 的下一次触发',()=>{
 const weekdays:BusinessSyncSchedule={kind:'cron',expression:'0 9 * * 1-5',timezone:'Asia/Shanghai'}
 // 2026-09-25 是周五，上海 10:00 已过 09:00，下一次是周一。
 assert.equal(nextBusinessSyncOccurrence(weekdays,'2026-09-25T02:00:00.000Z'),'2026-09-28T01:00:00.000Z')
 // 恰好落在触发时刻时不算"晚于"。
 assert.equal(nextBusinessSyncOccurrence(weekdays,'2026-09-28T01:00:00.000Z'),'2026-09-29T01:00:00.000Z')
 assert.equal(nextBusinessSyncOccurrence(weekdays,'2026-09-28T00:59:59.999Z'),'2026-09-28T01:00:00.000Z')
 const quarter:BusinessSyncSchedule={kind:'cron',expression:'*/15 * * * *',timezone:'UTC'}
 assert.equal(nextBusinessSyncOccurrence(quarter,'2026-09-25T02:07:00Z'),'2026-09-25T02:15:00.000Z')
 assert.equal(nextBusinessSyncOccurrence(quarter,'2026-09-25T02:15:00Z'),'2026-09-25T02:30:00.000Z')
 assert.equal(nextBusinessSyncOccurrence(quarter,'2026-09-25T23:50:00Z'),'2026-09-26T00:00:00.000Z')
 // 日与周同时限定时按 cron 惯例取"或"。
 assert.equal(nextBusinessSyncOccurrence({kind:'cron',expression:'0 0 1 * 1',timezone:'UTC'},'2026-09-25T00:00:00Z'),'2026-09-28T00:00:00.000Z')
 assert.equal(nextBusinessSyncOccurrence({kind:'cron',expression:'0 0 1 * 1',timezone:'UTC'},'2026-09-28T00:00:00Z'),'2026-10-01T00:00:00.000Z')
 // 周日既可写 0 也可写 7。
 assert.equal(nextBusinessSyncOccurrence({kind:'cron',expression:'30 8 * * 7',timezone:'Asia/Singapore'},'2026-09-25T00:00:00Z'),'2026-09-27T00:30:00.000Z')
 assert.equal(nextBusinessSyncOccurrence({kind:'cron',expression:'30 8 * * 0',timezone:'Asia/Singapore'},'2026-09-25T00:00:00Z'),'2026-09-27T00:30:00.000Z')
 // 闰日与月末。
 assert.equal(nextBusinessSyncOccurrence({kind:'cron',expression:'0 0 29 2 *',timezone:'UTC'},'2027-03-01T00:00:00Z'),'2028-02-29T00:00:00.000Z')
 assert.equal(nextBusinessSyncOccurrence({kind:'cron',expression:'0 12 31 * *',timezone:'UTC'},'2026-09-25T00:00:00Z'),'2026-10-31T12:00:00.000Z')
 // 闰日要跨四年：扫描天数与读取时的可达性判定同为 1461 天，读取放行的表达式调度时也算得出下一次。
 assert.equal(nextBusinessSyncOccurrence({kind:'cron',expression:'0 0 29 2 *',timezone:'UTC'},'2028-03-01T00:00:00Z'),'2032-02-29T00:00:00.000Z')
 assert.equal(nextBusinessSyncOccurrence({kind:'cron',expression:'0 0 29 2 *',timezone:'UTC'},'1970-01-01T00:00:00.000Z'),'1972-02-29T00:00:00.000Z','从未成功过的映射从 epoch 起算')
 // 永远撞不上的表达式：向前扫 1461 天扫不到即拒绝；2100 年不闰，2096 年之后的下一个 2 月 29 日在八年后。
 invalid(()=>nextBusinessSyncOccurrence({kind:'cron',expression:'0 0 30 2 *',timezone:'UTC'},'2026-09-25T00:00:00Z'))
 invalid(()=>nextBusinessSyncOccurrence({kind:'cron',expression:'0 0 29 2 *',timezone:'UTC'},'2096-03-01T00:00:00Z'),'2100 年 2 月没有 29 日')
 for(const value of ['2026-02-30T01:00:00Z','2026-09-11','2026-09-11T01:00:00+08:00','invalid','0000-01-01T00:00:00Z'])invalid(()=>nextBusinessSyncOccurrence(quarter,value),value)
})

test('every 与 hourly 不读时钟，严格晚于 after',()=>{
 assert.equal(nextBusinessSyncOccurrence({kind:'every',seconds:300},'2026-09-25T02:07:00.000Z'),'2026-09-25T02:12:00.000Z')
 assert.equal(nextBusinessSyncOccurrence({kind:'every',seconds:1},'2026-09-25T02:07:00.500Z'),'2026-09-25T02:07:01.500Z')
 assert.equal(nextBusinessSyncOccurrence({kind:'hourly',minute:15},'2026-09-25T02:07:00Z'),'2026-09-25T02:15:00.000Z')
 assert.equal(nextBusinessSyncOccurrence({kind:'hourly',minute:15},'2026-09-25T02:15:00Z'),'2026-09-25T03:15:00.000Z')
 assert.equal(nextBusinessSyncOccurrence({kind:'hourly',minute:0},'2026-09-25T23:30:00Z'),'2026-09-26T00:00:00.000Z')
})

test('daily 与 plan-schedule 的 nextScheduleOccurrence 对同一参数完全一致',()=>{
 const daily:BusinessSyncSchedule={kind:'daily',time:'02:30',timezone:'Asia/Shanghai'}
 const legacy={kind:'schedule',cadence:'daily',weekday:1,time:'02:30',timezone:'Asia/Shanghai'}
 for(const after of ['2026-09-25T02:00:00.000Z','2026-09-24T18:30:00.000Z','2028-02-28T18:30:00.000Z']){
  assert.equal(nextBusinessSyncOccurrence(daily,after),nextScheduleOccurrence(legacy,after).at,after)
 }
 assert.equal(nextBusinessSyncOccurrence(daily,'2026-09-24T18:30:00.000Z'),'2026-09-25T18:30:00.000Z')
})

test('cron 读取即核对可达性：日、月、周的组合永远不触发即拒',()=>{
 for(const expression of ['0 0 31 2 *','0 0 30 2 *','0 0 31 4,6,9,11 *'])invalid(()=>readBusinessSyncSchedule({kind:'cron',expression,timezone:'UTC'}),expression+' 永不触发')
 // 闰日四年一次仍可达；日与周同时限定按「或」，2 月 31 日加周一照样可达。
 for(const expression of ['0 0 29 2 *','0 0 31 2 1','0 0 31 1-12 *'])assert.equal(readBusinessSyncSchedule({kind:'cron',expression,timezone:'UTC'}).schedule.kind,'cron',expression)
})
