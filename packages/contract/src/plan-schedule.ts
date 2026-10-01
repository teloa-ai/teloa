/** 时区白名单的唯一真源：判据与界面下拉都从这里取，不各自抄一份。 */
export const scheduleTimezones=['Asia/Singapore','Asia/Shanghai','UTC'] as const
export type ScheduleTrigger={kind:'schedule';cadence:'daily'|'weekly';weekday:number;time:string;timezone:typeof scheduleTimezones[number]}
export function readScheduleTrigger(value:unknown):ScheduleTrigger{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('日程配置无效。')
 const r=value as Record<string,unknown>
 if(Object.keys(r).some(key=>!['kind','cadence','weekday','time','timezone'].includes(key))||r.kind!=='schedule'||r.cadence!=='daily'&&r.cadence!=='weekly'||!Number.isInteger(r.weekday)||(r.weekday as number)<1||(r.weekday as number)>7||typeof r.time!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(r.time)||!(scheduleTimezones as readonly string[]).includes(String(r.timezone)))throw Error('日程配置无效。')
 return {kind:'schedule',cadence:r.cadence,weekday:r.weekday as number,time:r.time,timezone:r.timezone as ScheduleTrigger['timezone']}
}
function utc(year:number,month:number,day:number,hour=0,minute=0,second=0){const date=new Date(0);date.setUTCFullYear(year,month,day);date.setUTCHours(hour,minute,second,0);return date.getTime()}
/** 严格晚于显式时间，不读取时钟；调用方将计划身份和修订号加入触发唯一键。 */
export function nextScheduleOccurrence(input:unknown,after:string):{at:string;occurrenceId:string}{
 const trigger=readScheduleTrigger(input)
 if(typeof after!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(after))throw Error('需要明确的 UTC 时间。')
 const epoch=Date.parse(after),canonical=after.includes('.')?after:after.replace('Z','.000Z')
 if(after.startsWith('0000-')||!Number.isFinite(epoch)||new Date(epoch).toISOString()!==canonical)throw Error('UTC 时间无效。')
 const formatter=new Intl.DateTimeFormat('en-US',{timeZone:trigger.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'})
 const parts=(at:number)=>Object.fromEntries(formatter.formatToParts(at).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)])) as Record<'year'|'month'|'day'|'hour'|'minute'|'second',number>
 const local=parts(epoch),[hour,minute]=trigger.time.split(':').map(Number)
 for(let day=0;day<=15;day++){
  const calendar=new Date(utc(local.year,local.month-1,local.day+day)),weekday=calendar.getUTCDay()||7
  if(calendar.getUTCFullYear()>9999)break
  if(trigger.cadence==='weekly'&&weekday!==trigger.weekday)continue
  const wall=utc(calendar.getUTCFullYear(),calendar.getUTCMonth(),calendar.getUTCDate(),hour,minute)
  let candidate=wall
  for(let attempt=0;attempt<4;attempt++){
   const p=parts(candidate),represented=utc(p.year,p.month-1,p.day,p.hour,p.minute,p.second)
   const shift=wall-represented;if(!shift)break;candidate+=shift
  }
  const check=parts(candidate)
  // 不存在的本地时刻跳过，不把它偷偷改到其他时刻。
  if(utc(check.year,check.month-1,check.day,check.hour,check.minute)!==wall||candidate<=epoch)continue
  const date=calendar.toISOString().slice(0,10)
  return {at:new Date(candidate).toISOString(),occurrenceId:`${date}T${trigger.time}[${trigger.timezone}]`}
 }
 throw Error('无法确定下一次日程，请核对时区和日期。')
}
