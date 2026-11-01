import {WorkError} from '@teloa/contract'

/** 用真实宿主 IANA 时区求日历月边界；不把本地“本月”误当 UTC 月，也不新增业务时区配置。 */
export function businessScopeTime(now:string,timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone){
 const instant=Date.parse(now)
 if(!Number.isFinite(instant)||new Date(instant).toISOString()!==now)throw new WorkError('teloa/invalid-host-response','当前业务时间不可核验。')
 const formatter=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'})
 const parts=(at:number)=>Object.fromEntries(formatter.formatToParts(at).filter(p=>['year','month','day'].includes(p.type)).map(p=>[p.type,p.value]))
 const current=parts(instant),year=Number(current.year),month=Number(current.month)
 const start=(y:number,m:number)=>{
  const utc=Date.UTC(y,m-1,1),key=y*12+m
  let low=utc-36*3600000,high=utc+36*3600000
  // 首个进入该本地日历月的真实 instant；同样覆盖午夜不存在的时区转换。
  while(high-low>1){const mid=Math.floor((low+high)/2),p=parts(mid);if(Number(p.year)*12+Number(p.month)>=key)high=mid;else low=mid}
  return new Date(high).toISOString()
 }
 return {observedAt:now,timeZone,timeZoneSource:'host-timezone' as const,currentDate:`${current.year}-${current.month}-${current.day}`,thisMonth:{from:start(year,month),to:start(month===12?year+1:year,month===12?1:month+1)}}
}
