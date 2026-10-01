import {WorkError} from './work-error.ts'
import {isRecord} from './resources.ts'
import {nextScheduleOccurrence,scheduleTimezones} from './plan-schedule.ts'

/**
 * 同步周期（规格 §4.1）：数据源同步器与看板 `refresh`（§4.4）共用同一口径。
 * `daily` / `cron` 的时区白名单沿用 `plan-schedule.ts` 的 `scheduleTimezones`，不另开一份。
 */
export type BusinessSyncSchedule=
 |{kind:'every';seconds:number}
 |{kind:'hourly';minute:number}
 |{kind:'daily';time:string;timezone:typeof scheduleTimezones[number]}
 |{kind:'cron';expression:string;timezone:typeof scheduleTimezones[number]}
/** 默认最小 60 秒，短于 600 秒提示外部 API 额度与本机资源，上限 30 天；全是字面量常量，不做设置项。 */
export const businessSyncLimits={minIntervalSeconds:60,warnIntervalSeconds:600,maxIntervalSeconds:2_592_000} as const

const bad=(message:string)=>new WorkError('teloa/invalid-input',message)
const exact=(value:unknown,keys:readonly string[],message:string):Record<string,unknown>=>{
 if(!isRecord(value))throw bad(message)
 const missing=keys.filter(key=>!(key in value)),extra=Object.keys(value).filter(key=>!keys.includes(key))
 if(missing.length||extra.length)throw bad(message.replace(/。$/,'')+'：'+[...(missing.length?['缺少字段 '+missing.join('、')]:[]),...(extra.length?['不认识的字段 '+extra.join('、')]:[])].join('；')+'。')
 return value
}
const timezone=(value:unknown):value is typeof scheduleTimezones[number]=>(scheduleTimezones as readonly string[]).includes(value as string)
const clockTime=/^([01]\d|2[0-3]):[0-5]\d$/

/** cron 五段：分 时 日 月 周；每段只认数字、`*`、`,`、`-`、`/`，不认名称与 `L`/`W`/`#`/`?`。 */
type CronField={values:Set<number>;any:boolean}
type CronSpec={minute:CronField;hour:CronField;dayOfMonth:CronField;month:CronField;dayOfWeek:CronField}
const cronFieldText=/^[0-9*,/-]+$/
const cronBounds:Array<{key:keyof CronSpec;min:number;max:number}>=[{key:'minute',min:0,max:59},{key:'hour',min:0,max:23},{key:'dayOfMonth',min:1,max:31},{key:'month',min:1,max:12},{key:'dayOfWeek',min:0,max:7}]
function cronField(text:string,min:number,max:number):CronField|undefined{
 if(!cronFieldText.test(text))return undefined
 const values=new Set<number>();let any=false
 for(const item of text.split(',')){
  const [range,step,...rest]=item.split('/')
  if(rest.length||range===undefined||range===''||step==='')return undefined
  let from:number,to:number
  if(range==='*'){from=min;to=max;if(step===undefined)any=true}
  else{
   const bounds=range.split('-')
   if(bounds.length>2||bounds.some(bound=>!/^\d{1,2}$/.test(bound)))return undefined
   from=Number(bounds[0]);to=bounds.length===2?Number(bounds[1]):step===undefined?from:max
   if(from<min||to>max||from>to)return undefined
  }
  const by=step===undefined?1:/^\d{1,2}$/.test(step)?Number(step):0
  if(by<1)return undefined
  for(let value=from;value<=to;value+=by)values.add(value)
 }
 return {values,any}
}
function cronSpec(expression:string):CronSpec|undefined{
 if(expression.length>128)return undefined
 const fields=expression.split(' ')
 if(fields.length!==5)return undefined
 const spec:Partial<CronSpec>={}
 for(const [index,{key,min,max}] of cronBounds.entries()){
  const field=cronField(fields[index]!,min,max)
  if(!field)return undefined
  spec[key]=field
 }
 // 周日既可写 0 也可写 7，统一成 0。
 if(spec.dayOfWeek!.values.delete(7))spec.dayOfWeek!.values.add(0)
 return spec as CronSpec
}

/**
 * 读取即核对可达性：只看日 / 月 / 周三段能否在日历上同时成立（时分两段总有取值）。
 * 从闰年 2024-01-01 起扫 1461 天，覆盖四年一次的 2 月 29 日与每个日期落在每个星期几的情形；
 * `0 0 31 2 *` 这类永不触发的组合在读取时就拒绝，不留到调度时才发现。日与周的「或」规则与 `nextCronOccurrence` 同一条。
 */
const cronReachDays=1461
function cronReachable(spec:CronSpec):boolean{
 for(let offset=0;offset<cronReachDays;offset++){
  const calendar=new Date(Date.UTC(2024,0,1+offset))
  if(!spec.month.values.has(calendar.getUTCMonth()+1))continue
  const dayMatch=spec.dayOfMonth.values.has(calendar.getUTCDate()),weekMatch=spec.dayOfWeek.values.has(calendar.getUTCDay())
  if(spec.dayOfMonth.any?weekMatch:spec.dayOfWeek.any?dayMatch:dayMatch||weekMatch)return true
 }
 return false
}

/**
 * `acknowledgeShortInterval` 与周期本体写在同一个对象里：周期短于 60 秒必须为 true
 * （规格：短于默认最小值须显式覆盖并再次确认），其余情况可缺省（按 false 读）。
 */
export function readBusinessSyncSchedule(value:unknown):{schedule:BusinessSyncSchedule;acknowledgeShortInterval:boolean}{
 if(!isRecord(value))throw bad('同步周期格式不正确。')
 const hasAck=value.acknowledgeShortInterval!==undefined,ack=hasAck?['acknowledgeShortInterval']:[]
 if(hasAck&&typeof value.acknowledgeShortInterval!=='boolean')throw bad('同步周期的短周期确认位必须是布尔值。')
 const acknowledgeShortInterval=value.acknowledgeShortInterval===true
 let schedule:BusinessSyncSchedule
 if(value.kind==='every'){
  const row=exact(value,['kind','seconds',...ack],'同步周期格式不正确。')
  if(!Number.isSafeInteger(row.seconds)||Number(row.seconds)<1||Number(row.seconds)>businessSyncLimits.maxIntervalSeconds)throw bad('同步间隔秒数必须是 1 到 2592000（30 天）之间的整数。')
  if(Number(row.seconds)<businessSyncLimits.minIntervalSeconds&&!acknowledgeShortInterval)throw bad('同步间隔短于默认最小值 60 秒，必须把 acknowledgeShortInterval 设为 true 以确认接受外部 API 额度与本机资源占用。')
  schedule={kind:'every',seconds:row.seconds as number}
 }else if(value.kind==='hourly'){
  const row=exact(value,['kind','minute',...ack],'同步周期格式不正确。')
  if(!Number.isSafeInteger(row.minute)||Number(row.minute)<0||Number(row.minute)>59)throw bad('每小时同步的分钟必须是 0 到 59 之间的整数。')
  schedule={kind:'hourly',minute:row.minute as number}
 }else if(value.kind==='daily'){
  const row=exact(value,['kind','time','timezone',...ack],'同步周期格式不正确。')
  if(typeof row.time!=='string'||!clockTime.test(row.time))throw bad('每日同步时刻必须写成 HH:MM。')
  if(!timezone(row.timezone))throw bad('同步时区不在白名单内，允许：'+scheduleTimezones.join(' / ')+'。')
  schedule={kind:'daily',time:row.time,timezone:row.timezone}
 }else if(value.kind==='cron'){
  const row=exact(value,['kind','expression','timezone',...ack],'同步周期格式不正确。')
  const spec=typeof row.expression==='string'?cronSpec(row.expression):undefined
  if(!spec)throw bad('cron 表达式必须是 5 段（分 时 日 月 周），只认数字、*、,、-、/，不支持名称与 L/W/#。')
  if(!cronReachable(spec))throw bad('cron 表达式的日、月与周组合在日历上永远不会触发，请核对。')
  if(!timezone(row.timezone))throw bad('同步时区不在白名单内，允许：'+scheduleTimezones.join(' / ')+'。')
  schedule={kind:'cron',expression:row.expression as string,timezone:row.timezone}
 }else throw bad('同步周期种类不合法，当前为「'+String(value.kind)+'」，允许：every / hourly / daily / cron。')
 return {schedule,acknowledgeShortInterval}
}

/** 两次触发之间可能出现的最短间隔（秒）；cron 只按分钟与小时段估下界，日/月/周只会拉长间隔。 */
function shortestIntervalSeconds(schedule:BusinessSyncSchedule):number{
 if(schedule.kind==='every')return schedule.seconds
 if(schedule.kind==='hourly')return 3600
 if(schedule.kind==='daily')return 86400
 const spec=cronSpec(schedule.expression)
 if(!spec)throw bad('cron 表达式不合法。')
 const minutes=[...spec.minute.values].sort((a,b)=>a-b),hours=spec.hour.values
 let gap=minutes.length>1?Math.min(...minutes.slice(1).map((minute,index)=>minute-minutes[index]!)):60
 if([...hours].some(hour=>hours.has((hour+1)%24)))gap=Math.min(gap,60-minutes[minutes.length-1]!+minutes[0]!)
 else if(minutes.length===1)gap=Infinity
 return gap*60
}
export function businessSyncScheduleWarning(schedule:BusinessSyncSchedule):'short-interval'|'very-short-interval'|null{
 const seconds=shortestIntervalSeconds(schedule)
 if(seconds<businessSyncLimits.minIntervalSeconds)return 'very-short-interval'
 if(seconds<businessSyncLimits.warnIntervalSeconds)return 'short-interval'
 return null
}

/** 与 `nextScheduleOccurrence` 同一判据：规范 UTC 毫秒串或不带毫秒的秒串，拒绝被 Date 自动归一化的日期。 */
function utcEpoch(after:unknown):number{
 if(typeof after!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(after))throw bad('需要明确的 UTC 时间。')
 const epoch=Date.parse(after),canonical=after.includes('.')?after:after.replace('Z','.000Z')
 if(after.startsWith('0000-')||!Number.isFinite(epoch)||new Date(epoch).toISOString()!==canonical)throw bad('UTC 时间无效。')
 return epoch
}
function utc(year:number,month:number,day:number,hour=0,minute=0){const date=new Date(0);date.setUTCFullYear(year,month,day);date.setUTCHours(hour,minute,0,0);return date.getTime()}
type WallClock=Record<'year'|'month'|'day'|'hour'|'minute',number>
function wallClockReader(timeZone:string):(at:number)=>WallClock{
 const formatter=new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})
 return at=>Object.fromEntries(formatter.formatToParts(at).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)])) as WallClock
}
/** 本地墙钟 → UTC 时刻；不存在的本地时刻（时区跳变）返回 undefined，不偷偷挪到别的时刻。 */
function wallToUtc(read:(at:number)=>WallClock,year:number,month:number,day:number,hour:number,minute:number):number|undefined{
 const wall=utc(year,month,day,hour,minute);let candidate=wall
 for(let attempt=0;attempt<4;attempt++){
  const p=read(candidate),shift=wall-utc(p.year,p.month-1,p.day,p.hour,p.minute)
  if(!shift)break;candidate+=shift
 }
 const check=read(candidate)
 return utc(check.year,check.month-1,check.day,check.hour,check.minute)===wall?candidate:undefined
}
function nextCronOccurrence(spec:CronSpec,timeZone:string,epoch:number):number{
 const read=wallClockReader(timeZone),local=read(epoch)
 const hours=[...spec.hour.values].sort((a,b)=>a-b),minutes=[...spec.minute.values].sort((a,b)=>a-b)
 // 扫描天数与读取时的可达性判定同为 cronReachDays：读取放行的闰日表达式（如 `0 0 29 2 *`）调度时也算得出下一次。
 for(let offset=0;offset<=cronReachDays;offset++){
  const calendar=new Date(utc(local.year,local.month-1,local.day+offset))
  if(calendar.getUTCFullYear()>9999)break
  const year=calendar.getUTCFullYear(),month=calendar.getUTCMonth(),day=calendar.getUTCDate()
  if(!spec.month.values.has(month+1))continue
  // 日与周同时限定时按 cron 惯例取「或」；任一为 `*` 时只看另一个。
  const dayMatch=spec.dayOfMonth.values.has(day),weekMatch=spec.dayOfWeek.values.has(calendar.getUTCDay())
  if(spec.dayOfMonth.any?!weekMatch:spec.dayOfWeek.any?!dayMatch:!dayMatch&&!weekMatch)continue
  for(const hour of hours)for(const minute of minutes){
   const candidate=wallToUtc(read,year,month,day,hour,minute)
   if(candidate!==undefined&&candidate>epoch)return candidate
  }
 }
 throw bad('cron 表达式在未来 '+cronReachDays+' 天内没有任何触发时刻，请核对日、月与周的组合。')
}

/** 严格晚于 `after` 的下一次触发；不读时钟；纯函数。cron 最多向前扫 1461 天（四年），扫不到即拒绝。 */
export function nextBusinessSyncOccurrence(schedule:BusinessSyncSchedule,after:string):string{
 const epoch=utcEpoch(after)
 if(schedule.kind==='every')return new Date(epoch+schedule.seconds*1000).toISOString()
 if(schedule.kind==='hourly'){
  // 白名单时区的偏移都是整小时，整点后第 N 分在任何时区都是同一时刻。
  const hourStart=Math.floor(epoch/3_600_000)*3_600_000,candidate=hourStart+schedule.minute*60_000
  return new Date(candidate>epoch?candidate:candidate+3_600_000).toISOString()
 }
 if(schedule.kind==='daily'){
  try{return nextScheduleOccurrence({kind:'schedule',cadence:'daily',weekday:1,time:schedule.time,timezone:schedule.timezone},after).at}
  catch(error){throw bad(error instanceof Error?error.message:'无法确定下一次同步时刻。')}
 }
 const spec=cronSpec(schedule.expression)
 if(!spec)throw bad('cron 表达式不合法。')
 return new Date(nextCronOccurrence(spec,schedule.timezone,epoch)).toISOString()
}
