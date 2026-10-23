import type {ScheduleTrigger} from '@teloa/contract'

/** 计划时区里的日期与 HH:mm；两个口径（日历日/观察日）共用同一次换算。 */
function localDateTime(nowIso:string,trigger:Pick<ScheduleTrigger,'time'|'timezone'>):{localDate:string;localTime:string}{
 const epoch=Date.parse(nowIso)
 if(!Number.isFinite(epoch))throw Error('时间戳不正确。')
 const formatter=new Intl.DateTimeFormat('en-US',{timeZone:trigger.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})
 const parts=Object.fromEntries(formatter.formatToParts(epoch).filter(part=>part.type!=='literal').map(part=>[part.type,part.value])) as Record<'year'|'month'|'day'|'hour'|'minute',string>
 return {localDate:`${parts.year}-${parts.month}-${parts.day}`,localTime:`${parts.hour}:${parts.minute}`}
}

/**
 * 计划时区的日历日（不按生成时刻回退）。员工每日小结的 day 就是领取时的日历日，
 * “最近 7 天”的窗口和员工行的“今天已生成”都用这个口径；观察日回退只服务分身的习惯观察。
 */
export function autoDreamCalendarDay(nowIso:string,trigger:Pick<ScheduleTrigger,'time'|'timezone'>):string{
 return localDateTime(nowIso,trigger).localDate
}

/** 镜像后端的观察日切分：早于生成时刻算前一天。 */
export function autoDreamObservationDay(nowIso:string,trigger:Pick<ScheduleTrigger,'time'|'timezone'>):string{
 const {localDate,localTime}=localDateTime(nowIso,trigger)
 if(localTime>=trigger.time)return localDate
 const shifted=new Date(localDate+'T00:00:00.000Z');shifted.setUTCDate(shifted.getUTCDate()-1)
 return shifted.toISOString().slice(0,10)
}

export function autoDreamRecentDays(today:string,count:number):string[]{
 const epoch=Date.parse(today+'T00:00:00.000Z')
 return Array.from({length:count},(_,index)=>new Date(epoch-(count-index-1)*86400000).toISOString().slice(0,10))
}
