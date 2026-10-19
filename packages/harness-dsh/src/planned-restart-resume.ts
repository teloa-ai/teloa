import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {dirname,join} from 'node:path'
import type {WorkControl,RecoveryInspection} from '@teloa/contract'
import type {WorkControlService,WorkResumeInput} from '@teloa/backend'

type Ports={
 controls:Pick<WorkControlService,'plannedRestartState'|'get'|'recordPlannedRestart'>
 inspect:(owner:string,input:{controlId:string})=>Promise<RecoveryInspection[]>
 /** 与本人确认同一条整项恢复路径；plannedRestart 让恢复事务内复核撤防世代、safeRecovery 与所属本轮。 */
 resume:(owner:string,input:WorkResumeInput,signal:AbortSignal,plannedRestart:{generation:number})=>Promise<WorkControl>
 report:(code:string)=>void
 now?:()=>number
}
// 宿主端口暂未就绪或版本刚变化时留待下一轮；其余结果保持暂停，交本人在原入口处理。
const retryable=new Set(['teloa/unavailable','teloa/version-conflict']),attempts=3
/** 撤防后迟迟不收口的控制，超时即保持暂停，避免升级数小时后突然恢复。 */
export const plannedRestartWaitMs=10*60_000
const requestId=(restartId:string,controlId:string)=>{const s=createHash('sha256').update(JSON.stringify(['teloa/planned-restart-resume',restartId,controlId])).digest('hex');return s.slice(0,8)+'-'+s.slice(8,12)+'-5'+s.slice(13,16)+'-a'+s.slice(17,20)+'-'+s.slice(20,32)}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i

let receiptTaken=false
/** 回执只属于本进程首次装配的宿主：首次读取后作废，同一进程内再次装配按普通重启处理。 */
export async function takePlannedRestartReceipt(env:Readonly<Record<string,string|undefined>>):Promise<string|undefined>{
 if(receiptTaken)return undefined
 receiptTaken=true
 return readPlannedRestartReceipt(env)
}

/** 宿主只接受与本安装 upgrade.json 中仍在切换的升级记录一致的回执；源码启动或记录不符时按普通重启处理。 */
export async function readPlannedRestartReceipt(env:Readonly<Record<string,string|undefined>>):Promise<string|undefined>{
 const id=env.TELOA_PLANNED_RESTART
 if(!id||!uuid.test(id)||!env.TELOA_RUNTIME_ROOT)return undefined
 try{const record=JSON.parse(await readFile(join(dirname(env.TELOA_RUNTIME_ROOT),'upgrade.json'),'utf8'));return record?.status==='switching'&&record.restartId===id?id:undefined}catch{return undefined}
}

/**
 * 本人升级命令引起的计划重启：只恢复本次撤防所暂停（即升级前仍为 active）的控制，且只限没有候选、或全部候选已开启安全恢复的控制。
 * 本人暂停、升级前已暂停的控制不在撤防结果里；其余情况保持暂停，由原恢复入口说明原因，结果逐项落库。
 */
export function plannedRestartResume(owner:string,restartId:string,restarted:readonly WorkControl[],ports:Ports){
 const now=ports.now??Date.now,deadline=now()+plannedRestartWaitMs
 const pending=new Map(restarted.map(control=>[control.id,{generation:control.generation,tries:0,submitted:undefined as WorkResumeInput|undefined}]))
 const settle=async(controlId:string,outcome:string)=>{
  pending.delete(controlId)
  if(outcome!=='resumed')ports.report('teloa/planned-restart-held:'+controlId+':'+outcome.slice(5))
  try{await ports.controls.recordPlannedRestart(owner,{restartId,controlId,outcome})}catch{ports.report('teloa/planned-restart-unrecorded:'+controlId)}
 }
 return async(signal:AbortSignal):Promise<void>=>{
  for(const [controlId,entry] of [...pending]){
   signal.throwIfAborted()
   try{
    const state=await ports.controls.plannedRestartState(owner,{controlId,generation:entry.generation})
    if(state==='ready'){
     // 世代未变说明此前的恢复没有提交，按当前状态重新核对候选。
     const candidates=await ports.inspect(owner,{controlId})
     if(candidates.some(candidate=>!candidate.resumable||candidate.safeRecovery!==true)){await settle(controlId,'held:candidates');continue}
     const control=await ports.controls.get(owner,{controlId})
     entry.submitted={requestId:requestId(restartId,controlId),controlId,expectedVersion:control.version,candidateRunIds:candidates.map(candidate=>candidate.runId)}
    }else if(state==='wait'){if(now()>=deadline)await settle(controlId,'held:timeout');continue}
    // 已提交恢复、派发中途失败：同一请求续用 reserved 票据；不是本次提交引起的变化会在恢复事务内因世代不符而拒绝。
    else if(!(state==='changed'&&entry.submitted)){await settle(controlId,'held:'+state);continue}
    await ports.resume(owner,entry.submitted!,signal,{generation:entry.generation})
    await settle(controlId,'resumed')
   }catch(error){
    signal.throwIfAborted()
    const code=error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'&&/^[-a-z0-9/_]{1,64}$/.test(error.code)?error.code:'teloa/unavailable'
    if(!retryable.has(code)||++entry.tries>=attempts)await settle(controlId,'held:'+code)
    else ports.report('teloa/planned-restart-retry:'+controlId+':'+code)
   }
  }
 }
}
