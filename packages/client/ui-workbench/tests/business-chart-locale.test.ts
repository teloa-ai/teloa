import test from 'node:test'
import assert from 'node:assert/strict'
import {businessChartLocale,isPeriodicTimeUnit,periodicAxisFormat,temporalAxisFormat,temporalGranularity,temporalTickStep,type ChartTimeUnit} from '../src/client/business-chart-locale.ts'

const mainLocales=['zh-CN','zh-Hant','en','ja','ko','vi','es','fr','de','pt'] as const

test('十种主语言都由 Intl 生成完整的星期名与月份名，小数点与千分位随语言',()=>{
 for(const locale of mainLocales){
  const {number,time}=businessChartLocale(locale)
  for(const [key,length] of [['days',7],['shortDays',7],['months',12],['shortMonths',12]] as const){
   assert.equal(time[key].length,length,locale+' '+key)
   assert.ok(time[key].every(name=>typeof name==='string'&&name.trim().length>0),locale+' '+key)
   assert.equal(new Set(time[key]).size,length,locale+' '+key+' 不重复')
  }
  assert.equal(time.periods.length,2)
  assert.ok(number.decimal&&number.thousands,locale)
  assert.doesNotMatch(time.date+time.time+time.dateTime,/%[^-%YmdHMS]|%-[^md]/,locale+' 只用数字日期指令')
 }
 const zh=businessChartLocale('zh-CN')
 assert.match(zh.time.months[0]!,/1/)
 assert.match(zh.time.months[0]!,/月/)
 assert.equal(zh.time.shortDays[0],'周日')
 assert.equal(businessChartLocale('de').number.thousands,'.')
 assert.equal(businessChartLocale('de').number.decimal,',')
 assert.equal(businessChartLocale('de').time.months[0],'Januar')
})

test('英文与图表库一期默认（en-US）不冲突：名称、数字符号、日期写法一致',()=>{
 const {number,time}=businessChartLocale('en')
 assert.deepEqual(number,{decimal:'.',thousands:',',grouping:[3],currency:['$','']})
 assert.deepEqual(time.months,['January','February','March','April','May','June','July','August','September','October','November','December'])
 assert.deepEqual(time.shortMonths,['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'])
 assert.deepEqual(time.days,['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'])
 assert.deepEqual(time.shortDays,['Sun','Mon','Tue','Wed','Thu','Fri','Sat'])
 assert.deepEqual(time.periods,['AM','PM'])
 assert.equal(time.date,'%-m/%-d/%Y')
})

test('时间轴格式按「语言 × 粒度」查表（规格 §6）；繁中同简中，未知语言回落英文',()=>{
 const units:ChartTimeUnit[]=['year','month','day','hour','minute']
 const expected:Record<string,string[]>={
  'zh-CN':['%Y','%Y年%-m月','%-m月%-d日','%H:%M','%H:%M'],
  'zh-Hant':['%Y','%Y年%-m月','%-m月%-d日','%H:%M','%H:%M'],
  en:['%Y','%b %Y','%b %-d','%H:%M','%H:%M'],
  ja:['%Y','%Y年%-m月','%-m月%-d日','%H:%M','%H:%M'],
  ko:['%Y','%Y년 %-m월','%-m월 %-d일','%H:%M','%H:%M'],
  vi:['%Y','%b %Y','%-d/%-m','%H:%M','%H:%M'],
  es:['%Y','%b %Y','%-d %b','%H:%M','%H:%M'],
  fr:['%Y','%b %Y','%-d %b','%H:%M','%H:%M'],
  de:['%Y','%b %Y','%-d. %b','%H:%M','%H:%M'],
  pt:['%Y','%b %Y','%-d %b','%H:%M','%H:%M'],
 }
 for(const locale of mainLocales)assert.deepEqual(units.map(unit=>temporalAxisFormat(locale,unit)),expected[locale],locale)
 assert.deepEqual(units.map(unit=>temporalAxisFormat('zh-TW',unit)),expected['zh-CN'])
 assert.deepEqual(units.map(unit=>temporalAxisFormat('xx',unit)),expected.en)
 assert.deepEqual(units.map(unit=>temporalAxisFormat('',unit)),expected.en)
 // 时 / 分粒度跨多天：带按语言的月-日；年 / 月 / 日粒度不受影响。
 for(const locale of mainLocales)assert.deepEqual(units.map(unit=>temporalAxisFormat(locale,unit,true)),[...expected[locale]!.slice(0,3),expected[locale]![2]+' %H:%M',expected[locale]![2]+' %H:%M'],locale)
})

test('时间粒度：编码 timeUnit 优先（utc 前缀归 utc），其次 transform 产出字段，再按数据推断',()=>{
 const spec=(x:Record<string,unknown>,transform?:unknown[])=>({mark:'line',encoding:{x:{field:'day',type:'temporal',...x}},...(transform?{transform}:{})})
 assert.deepEqual(temporalGranularity(spec({timeUnit:'yearmonthdate'}),'day',[]),{unit:'day',utc:false})
 assert.deepEqual(temporalGranularity(spec({timeUnit:'utcyearmonth'}),'day',[]),{unit:'month',utc:true})
 assert.deepEqual(temporalGranularity(spec({timeUnit:'yearweek'}),'day',[]),{unit:'day',utc:false})
 assert.deepEqual(temporalGranularity(spec({timeUnit:'yearmonthdatehours'}),'day',[]),{unit:'hour',utc:false})
 assert.deepEqual(temporalGranularity(spec({timeUnit:'utcyearmonthdatehoursminutesseconds'}),'day',[]),{unit:'minute',utc:true})
 assert.deepEqual(temporalGranularity(spec({timeUnit:'year'}),'day',[]),{unit:'year',utc:false})
 assert.deepEqual(temporalGranularity(spec({timeUnit:'yearquarter'}),'day',[]),{unit:'month',utc:false})
 assert.deepEqual(temporalGranularity(spec({}, [{timeUnit:'utcyearmonthdate',field:'created_at',as:'day'}]),'day',[]),{unit:'day',utc:true})
 assert.deepEqual(temporalGranularity(spec({scale:{type:'utc'}},[{timeUnit:'yearmonth',field:'created_at',as:'day'}]),'day',[]),{unit:'month',utc:true})
 const local=(...parts:[number,number,number,number?])=>new Date(parts[0],parts[1],parts[2],parts[3]??0).toISOString()
 assert.deepEqual(temporalGranularity(spec({}),'day',[local(2026,8,1),local(2026,8,2),null]),{unit:'day',utc:false})
 assert.deepEqual(temporalGranularity(spec({}),'day',[local(2026,7,1),local(2026,8,1)]),{unit:'month',utc:false})
 assert.deepEqual(temporalGranularity(spec({}),'day',[local(2026,8,1),local(2026,8,1,5)]),{unit:'hour',utc:false})
 assert.deepEqual(temporalGranularity(spec({}),'day',[new Date(2026,8,1).getTime(),new Date(2026,8,3).getTime()]),{unit:'day',utc:false})
 // 纯日期串按 UTC 零点解析：本地不是零点时按 UTC 当天算，而不是退成小时。
 const utcOnly=new Date('2026-09-01').getHours()!==0
 assert.deepEqual(temporalGranularity(spec({}),'day',['2026-09-01','2026-09-02']),{unit:'day',utc:utcOnly})
 assert.deepEqual(temporalGranularity(spec({scale:{type:'utc'}}),'day',['2026-09-01T00:00:00Z','2026-09-02T00:00:00Z']),{unit:'day',utc:true})
})

test('刻度步长：不同取值数 ÷ 能摆下的刻度数（宽度 / 72，至少 2），至少 1',()=>{
 assert.equal(temporalTickStep(14,300),4)
 assert.equal(temporalTickStep(2,300),1)
 assert.equal(temporalTickStep(0,300),1)
 assert.equal(temporalTickStep(14,100),7)
 assert.equal(temporalTickStep(30,720),3)
})

test('周期型时间单位：不以 year / utcyear 开头；周期表按语言给格式，表外组合不给',()=>{
 for(const unit of ['day','date','month','quarter','week','weekday','hours','minutes','monthdate','utcday','utcmonth','utchours'])assert.equal(isPeriodicTimeUnit(unit),true,unit)
 for(const unit of ['year','yearmonth','yearmonthdate','yearweek','utcyear','utcyearmonthdatehours'])assert.equal(isPeriodicTimeUnit(unit),false,unit)
 assert.deepEqual(['day','date','month','quarter','hours','monthdate'].map(unit=>periodicAxisFormat('zh-CN',unit)),['%a','%-d日','%b','第%q季度','%H:%M','%-m月%-d日'])
 assert.deepEqual(['day','date','month','quarter','hours','monthdate'].map(unit=>periodicAxisFormat('en',unit)),['%a','%-d','%b','Q%q','%H:%M','%b %-d'])
 assert.deepEqual(['quarter','quarter','quarter','date'].map((unit,index)=>periodicAxisFormat(['fr','ja','ko','ko'][index]!,unit)),['T%q','第%q四半期','%q분기','%-d일'])
 assert.equal(periodicAxisFormat('en','utcquarter'),'Q%q')
 assert.equal(periodicAxisFormat('en','week'),undefined)
})
