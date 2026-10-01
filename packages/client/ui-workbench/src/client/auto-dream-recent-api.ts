import type {DigitalRole,RoleDailyLogSummary,ScheduleTrigger} from '@teloa/contract'
import {autoDreamObservationDay,autoDreamRecentDays} from './auto-dream-day.ts'
export type AutoDreamRecentDay={day:string;kept:boolean|null}
export type AutoDreamRecentRow={roleId:string;name:string;kind:'employee'|'twin';days:AutoDreamRecentDay[];today:'generated'|'none'|'habit'|'unavailable';hasPlan:boolean}
export type AutoDreamRecentApi={load:(input:{trigger:Pick<ScheduleTrigger,'time'|'timezone'>;planRoleIds:readonly string[];now?:string})=>Promise<AutoDreamRecentRow[]>}
export function createAutoDreamRecentApi(ports:{roles:()=>Promise<DigitalRole[]>;dailyLogs:(roleId:string)=>Promise<RoleDailyLogSummary[]>}):AutoDreamRecentApi{
 return {async load({trigger,planRoleIds,now}){
  const today=autoDreamObservationDay(now??new Date().toISOString(),trigger),days=autoDreamRecentDays(today,7)
  const roles=(await ports.roles()).filter(role=>role.state==='active')
  const summaries=await Promise.allSettled(roles.map(role=>ports.dailyLogs(role.id)))
  return roles.map((role,index)=>{
   const result=summaries[index]!,logs=result.status==='fulfilled'?result.value:[]
   const kept=(day:string)=>logs.some(log=>log.day===day&&log.state==='kept'&&log.kind===(role.kind==='twin'?'habit-digest':'daily-digest'))
   return {roleId:role.id,name:role.name,kind:role.kind,days:days.map(day=>({day,kept:result.status==='rejected'?null:kept(day)})),today:result.status==='rejected'?'unavailable':kept(today)?role.kind==='twin'?'habit':'generated':'none',hasPlan:role.kind==='twin'||planRoleIds.includes(role.id)}
  })
 }}
}
