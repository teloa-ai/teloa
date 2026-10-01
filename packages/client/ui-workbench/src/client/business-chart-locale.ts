import {resolveProductLocale} from './i18n/locale.ts'

/**
 * 看板图表时间轴本地化（规格 §6）：时间轴格式由平台按界面语言统一给出，不由声明负责。
 * - locale：按界面语言经浏览器 `Intl` 生成 Vega `config.locale`（d3-format / d3-time-format 的 locale 定义），不引入 locale 数据包。
 * - 粒度：编码 `timeUnit` → transform 产出该字段的 `timeUnit` → 按数据推断；刻度按粒度的时间间隔出，永不细于数据粒度。
 * - 格式：「语言 × 粒度」小表，时 / 分一律 24 小时制，跨多天时带月-日。
 */

export type ChartTimeUnit='year'|'month'|'day'|'hour'|'minute'
export type BusinessChartLocale={
 number:{decimal:string;thousands:string;grouping:number[];currency:[string,string]}
 time:{dateTime:string;date:string;time:string;periods:[string,string];days:string[];shortDays:string[];months:string[];shortMonths:string[]}
}

const isRecord=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value)
const partsOf=(locale:string,options:Intl.DateTimeFormatOptions,at:number)=>new Intl.DateTimeFormat(locale,{...options,timeZone:'UTC'}).formatToParts(at)
const nameOf=(locale:string,options:Intl.DateTimeFormatOptions,at:number)=>new Intl.DateTimeFormat(locale,{...options,timeZone:'UTC'}).format(at)

/** 由 `Intl` 的数字日期写法拼出 d3 时间格式（年 / 月 / 日为数字指令，其余照字面，`%` 转义）。 */
function datePattern(locale:string):string{
 return partsOf(locale,{year:'numeric',month:'numeric',day:'numeric'},Date.UTC(2000,0,2)).map(part=>
  part.type==='year'?'%Y'
  :part.type==='month'?(part.value.length>1?'%m':'%-m')
  :part.type==='day'?(part.value.length>1?'%d':'%-d')
  :part.value.replaceAll('%','%%')).join('')
}

export function businessChartLocale(locale:string):BusinessChartLocale{
 const tag=resolveProductLocale(locale)
 const numberParts=new Intl.NumberFormat(tag).formatToParts(1234567.5)
 const integers=numberParts.filter(part=>part.type==='integer')
 const decimal=numberParts.find(part=>part.type==='decimal')?.value??'.'
 const thousands=numberParts.find(part=>part.type==='group')?.value??','
 // 2000-01-02 是星期日：d3 的 days[0] 为星期日。
 const days=Array.from({length:7},(_,index)=>Date.UTC(2000,0,2+index))
 const months=Array.from({length:12},(_,index)=>Date.UTC(2000,index,1))
 const shortMonths=months.map(at=>nameOf(tag,{month:'short'},at))
 // 月份按数字称呼的语言（简称带数字，如简中「1月」）全称也用数字写法，与日期写法一致，不写「一月」。
 const longMonths=months.map(at=>nameOf(tag,{month:'long'},at))
 const numbered=shortMonths.every(name=>/\d/.test(name))&&longMonths.some(name=>!/\d/.test(name))
 const period=(hour:number)=>partsOf(tag,{hour:'numeric',hour12:true},Date.UTC(2000,0,1,hour)).find(part=>part.type==='dayPeriod')?.value
 const date=datePattern(tag),time='%H:%M:%S'
 return {
  // 货币符号保持图表库默认：数值轴 `axis.format` 里的 `$` 按声明原意照旧（规格 §6：数值轴格式照旧生效）。
  number:{decimal,thousands,grouping:[integers.at(-1)?.value.length??3],currency:['$','']},
  time:{
   dateTime:date+' '+time,date,time,
   periods:[period(1)??'AM',period(13)??'PM'],
   days:days.map(at=>nameOf(tag,{weekday:'long'},at)),
   shortDays:days.map(at=>nameOf(tag,{weekday:'short'},at)),
   months:numbered?shortMonths:longMonths,
   shortMonths,
  },
 }
}

type AxisLanguage='zh'|'ja'|'ko'|'en'|'de'|'fr'|'es'|'pt'|'vi'
/** 「语言 × 粒度」格式表（规格 §6）：d3 时间格式串，不是词条；时 / 分一律 24 小时制。 */
// 越南语日粒度用通行的数字短写「日/月」（CLDR vi 的 Md 骨架 `d/M`，如 1/9）：`%-d %b` 会渲染成偏长的「1 Tháng 9」。
const dayFormats:Record<AxisLanguage,string>={zh:'%-m月%-d日',ja:'%-m月%-d日',ko:'%-m월 %-d일',en:'%b %-d',de:'%-d. %b',fr:'%-d %b',es:'%-d %b',pt:'%-d %b',vi:'%-d/%-m'}
const monthFormats:Record<AxisLanguage,string>={zh:'%Y年%-m月',ja:'%Y年%-m月',ko:'%Y년 %-m월',en:'%b %Y',de:'%b %Y',fr:'%b %Y',es:'%b %Y',pt:'%b %Y',vi:'%b %Y'}

/** 时 / 分粒度的数据跨越多天时（`multiDay`），刻度带上按语言的「月-日」，否则两天各一个 `00:00` 会同名；同一天内只写 `%H:%M`。 */
export function temporalAxisFormat(locale:string,unit:ChartTimeUnit,multiDay=false):string{
 const language=resolveProductLocale(locale).split('-')[0] as AxisLanguage
 return unit==='year'?'%Y':unit==='month'?monthFormats[language]:unit==='day'?dayFormats[language]:multiDay?dayFormats[language]+' %H:%M':'%H:%M'
}

/**
 * 周期型时间单位：去掉 `utc` 前缀后不以 `year` 开头（`day` 星期几、`date` 每月第几日、`month`、`quarter`、`hours`……）。
 * Vega-Lite 把这类取值的年份折叠到固定年，不能按具体日期出格式、算跨天与刻度步长。
 */
export function isPeriodicTimeUnit(timeUnit:string):boolean{
 return !timeUnit.replace(/^utc/,'').startsWith('year')
}
/** 周期表的季度与每月第几日写法（按语言；d3 `%q` 为季度数字）。 */
const quarterFormats:Record<AxisLanguage,string>={zh:'第%q季度',ja:'第%q四半期',ko:'%q분기',en:'Q%q',de:'Q%q',vi:'Q%q',fr:'T%q',es:'T%q',pt:'T%q'}
const dateOfMonthFormats:Record<AxisLanguage,string>={zh:'%-d日',ja:'%-d日',ko:'%-d일',en:'%-d',de:'%-d',fr:'%-d',es:'%-d',pt:'%-d',vi:'%-d'}
/**
 * 周期型时间单位的轴格式：星期几用本地化星期简称，月用本地化月份简称（不带年），季度按语言写「第 N 季度 / Q1」，
 * 每月第几日写数字日，时 / 分写 `%H:%M`，「月-日」用日粒度写法（不带年）。表外的周期组合返回 undefined，保持一期 Vega-Lite 行为（只带语言）。
 */
export function periodicAxisFormat(locale:string,timeUnit:string):string|undefined{
 const language=resolveProductLocale(locale).split('-')[0] as AxisLanguage
 switch(timeUnit.replace(/^utc/,'')){
  case 'day':return '%a'
  case 'date':return dateOfMonthFormats[language]
  case 'month':return '%b'
  case 'quarter':return quarterFormats[language]
  case 'monthdate':return dayFormats[language]
  case 'hours':case 'hoursminutes':case 'minutes':return '%H:%M'
  default:return undefined
 }
}

/**
 * 周期型时间单位的刻度间隔（vega-time 单位名，不带步长）：刻度不细于周期本身。
 * 不设时 Vega 按像素宽度挑间隔，7 天的「星期几」会按 12 小时出刻度（周日、周日、周一……），宽图上的月份 / 季度会按周出刻度。
 * 「时:分」用小时间隔（比数据粗、不会重复），避免一天 1440 个刻度。
 */
export function periodicTickInterval(timeUnit:string):string|undefined{
 return ({day:'day',date:'date',monthdate:'date',month:'month',quarter:'quarter',hours:'hours',hoursminutes:'hours',minutes:'minutes'} as Record<string,string>)[timeUnit.replace(/^utc/,'')]
}

/** 编码里（优先）或 transform 产出该字段时声明的时间单位。 */
export function declaredTimeUnit(spec:Record<string,unknown>,field:string):string|undefined{
 const channels=isRecord(spec.encoding)?Object.values(spec.encoding).filter(isRecord).filter(channel=>channel.field===field):[]
 const declared=channels.map(channel=>channel.timeUnit).find(unit=>typeof unit==='string')
  ??(Array.isArray(spec.transform)?spec.transform.filter(isRecord).find(item=>item.as===field&&typeof item.timeUnit==='string')?.timeUnit:undefined)
 return typeof declared==='string'?declared:undefined
}

/** 以 year 开头的 Vega-Lite 时间单位（去掉 `utc` 前缀）归到最细的那一级；星期、季度分别按天、按月。 */
function unitOf(timeUnit:string):ChartTimeUnit{
 const unit=timeUnit.replace(/^utc/,'')
 return /minutes|seconds|milliseconds/.test(unit)?'minute'
  :unit.includes('hours')?'hour'
  :/date|day|week/.test(unit)?'day'
  :/month|quarter/.test(unit)?'month'
  :'year'
}

function toDate(value:unknown):Date|null{
 if(typeof value!=='string'&&typeof value!=='number')return null
 const date=new Date(value)
 return Number.isNaN(date.getTime())?null:date
}
const clock=(date:Date,utc:boolean)=>utc
 ?{hours:date.getUTCHours(),minutes:date.getUTCMinutes(),seconds:date.getUTCSeconds(),ms:date.getUTCMilliseconds(),date:date.getUTCDate()}
 :{hours:date.getHours(),minutes:date.getMinutes(),seconds:date.getSeconds(),ms:date.getMilliseconds(),date:date.getDate()}
const midnight=(date:Date,utc:boolean)=>{const at=clock(date,utc);return at.hours===0&&at.minutes===0&&at.seconds===0&&at.ms===0}

/** 数据推断：全在当天零点 → day；再全在月初 → month；否则 hour。纯日期串按 UTC 零点解析，本地不是零点时按 UTC 算。 */
function inferred(dates:readonly Date[],utc:boolean):ChartTimeUnit|null{
 if(!dates.every(date=>midnight(date,utc)))return null
 return dates.every(date=>clock(date,utc).date===1)?'month':'day'
}

export function temporalGranularity(spec:Record<string,unknown>,field:string,values:readonly unknown[]):{unit:ChartTimeUnit;utc:boolean}{
 const channels=isRecord(spec.encoding)?Object.values(spec.encoding).filter(isRecord).filter(channel=>channel.field===field):[]
 const scaleType=channels.map(channel=>isRecord(channel.scale)?channel.scale.type:undefined).find(type=>typeof type==='string')
 const declared=declaredTimeUnit(spec,field)
 if(declared!==undefined)return {unit:unitOf(declared),utc:declared.startsWith('utc')||scaleType==='utc'}
 const dates=values.map(toDate).filter(date=>date!==null)
 if(!dates.length)return {unit:'day',utc:scaleType==='utc'}
 if(scaleType==='utc'||scaleType==='time'){const utc=scaleType==='utc';return {unit:inferred(dates,utc)??'hour',utc}}
 const local=inferred(dates,false)
 if(local)return {unit:local,utc:false}
 const utc=inferred(dates,true)
 return utc?{unit:utc,utc:true}:{unit:'hour',utc:false}
}

/** 刻度步长：`ceil(不同取值数 / max(2, floor(宽度 / 72)))`，至少 1。 */
export function temporalTickStep(distinct:number,width:number):number{
 return Math.max(1,Math.ceil(distinct/Math.max(2,Math.floor(width/72))))
}

/** 按粒度截断后的不同取值数（刻度步长的分子）：按天聚合的逐小时数据只算天数。 */
export function temporalDistinct(values:readonly unknown[],unit:ChartTimeUnit,utc:boolean):number{
 const keys=new Set<string>()
 for(const value of values){
  const date=toDate(value)
  if(!date)continue
  const parts=utc
   ?[date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate(),date.getUTCHours(),date.getUTCMinutes()]
   :[date.getFullYear(),date.getMonth(),date.getDate(),date.getHours(),date.getMinutes()]
  keys.add(parts.slice(0,['year','month','day','hour','minute'].indexOf(unit)+1).join('-'))
 }
 return keys.size
}
