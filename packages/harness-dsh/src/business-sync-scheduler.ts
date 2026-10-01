import {randomUUID} from 'node:crypto'
import type {Logger} from '@deepseek-ai/cordis'
import type {BusinessDashboardService,BusinessSyncService} from '@teloa/backend'

export type BusinessSyncTickPorts={
 owner:string
 services:()=>Promise<{sync:BusinessSyncService;dashboards:BusinessDashboardService}>
 /** 本人登记范围：到期项的范围不在其中（范围已注销）即跳过，不再替它拉外部数据或算组件。 */
 scopeIds:()=>Promise<readonly string[]>
 logger:Pick<Logger,'warn'>
}

const codeOf=(error:unknown)=>error!==null&&typeof error==='object'&&'code' in error&&typeof error.code==='string'&&/^teloa\/[a-z-]+$/.test(error.code)?error.code:'teloa/dependency-unavailable'

/**
 * 业务同步与看板刷新的一次 tick：先逐个跑到期的数据源映射同步，再逐个刷新到期的看板。
 * 只有 tick，没有循环——单飞、重入、停机检测、取消与错误上报全部由 `startPlanScheduler` 提供；本文件不计时。
 * 每项之间核对取消信号；一项失败只记一行告警（码与标识，不含 SQL 正文与凭据），不影响其余各项。
 * 数据源连续失败的退避由同步服务按映射记录（`teloa_business_sync_cursors.backoff_until`），到期判定已把退避期排除在外。
 * 看板刷新整次抛错（组件失败不算，它们照常落库）时按看板在进程内退避：第 n 次连续失败后停 1 分钟 × 2^(n-1)，封顶 1 小时；
 * 成功一次即清零；「正在刷新」冲突不计。宿主重启即清空，最坏多刷一次。
 */
const refreshBackoffMs=60_000,refreshBackoffMaxMs=3_600_000
export function createBusinessSyncTick(ports:BusinessSyncTickPorts):(now:string,signal:AbortSignal)=>Promise<void>{
 const backoff=new Map<string,{failures:number;until:number}>()
 return async(now,signal)=>{
  signal.throwIfAborted()
  const [{sync,dashboards},scopes]=await Promise.all([ports.services(),ports.scopeIds()])
  const actor={ownerId:ports.owner,scopeIds:[...scopes]}
  for(const item of await sync.due(ports.owner,now)){
   signal.throwIfAborted()
   if(!scopes.includes(item.scope))continue
   try{await sync.run(actor,{scope:item.scope,mappingId:item.mappingId,trigger:'schedule'},signal)}
   catch(error){if(signal.aborted)throw error;ports.logger.warn('Teloa 业务数据同步未完成：%s/%s（%s）',item.scope,item.mappingId,codeOf(error))}
  }
  signal.throwIfAborted()
  for(const item of await dashboards.due(ports.owner,now)){
   signal.throwIfAborted()
   if(!scopes.includes(item.scope))continue
   const key=item.scope+'\u001f'+item.dashboardId,held=backoff.get(key)
   if(held&&Date.parse(now)<held.until)continue
   try{
    await dashboards.refresh(actor,{requestId:randomUUID(),scope:item.scope,dashboardId:item.dashboardId},signal,{trigger:'schedule',...(item.widgetIds===undefined?{}:{widgetIds:item.widgetIds})})
    backoff.delete(key)
   }catch(error){
    if(signal.aborted)throw error
    const code=codeOf(error)
    if(code!=='teloa/conflict'){const failures=(held?.failures??0)+1;backoff.set(key,{failures,until:Date.parse(now)+Math.min(refreshBackoffMs*2**(failures-1),refreshBackoffMaxMs)})}
    ports.logger.warn('Teloa 看板定时刷新未完成：%s/%s（%s）',item.scope,item.dashboardId,code)
   }
  }
 }
}
