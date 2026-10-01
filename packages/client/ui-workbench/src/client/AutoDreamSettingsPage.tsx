import {useEffect,useState} from 'react'
import clsx from 'clsx'
import {TriangleAlert} from 'lucide-react'
import {scheduleTimezones,type ScheduleTrigger} from '@teloa/contract'
import type {PlanApi,SavedPlan} from './plan-api.js'
import type {AutoDreamRecentApi,AutoDreamRecentRow} from './auto-dream-recent-api.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './AutoDreamSettingsPage.module.css'

/**
 * Auto Dream 的开关与时间统一以全部 `source.kind==='system-digest'` 的持续计划为载体（既有 `plans/list`+`plans/change`，
 * 零新端点）；任一 `active` 即「开」，时间与时区取其中一条的 `trigger`（本设置面写入时对所有条目一起改，值本就该一致）。
 * `plan-api.ts` 已认得 `system-digest`（`a035c00`），这里直接复用 `PlanApi`：`list()` 挑 `source.kind==='system-digest'`
 * 的行，开关走 `planApi.change` 的 `enable`/`pause`，时间与时区走 `planApi.update` 的 `trigger`——三者都已有逐字段
 * 回执核对、`owned()` 越权检查与 Journal 恢复，不必在这里重做一遍投影核对。
 */
export type AutoDreamSettingApi={
  list:()=>Promise<SavedPlan[]>
  setEnabled:(rows:readonly SavedPlan[],enabled:boolean)=>Promise<void>
  setTrigger:(rows:readonly SavedPlan[],time:string,timezone:ScheduleTrigger['timezone'])=>Promise<void>
}
/** 纯逻辑抽成独立工厂：不依赖 React，方便单测直接喂一个假 `PlanApi` 核对映射，不必挂整个 WorkbenchFrame。 */
export function createAutoDreamSettingApi(planApi:Pick<PlanApi,'list'|'change'|'update'>):AutoDreamSettingApi{
  const digestRows=async()=>(await planApi.list()).filter(plan=>plan.source.kind==='system-digest')
  return {
    list:digestRows,
    // rows 形参只保留做签名兼容，内部一律重新调 planApi.list() 取最新全量：组件挂载时快照的 rows 会过期——
    // 挂载后新建同事的系统摘要计划不在那份快照里，用旧快照切换永远漏掉它们（浏览器脚本第七轮复跑发现）。
    async setEnabled(rows,enabled){
      // 逐条 try/catch：某位同事的计划 version 已漂移导致 teloa/version-conflict 时不中止整段，
      // 先用 list() 取回最新 version 重试一次，其余成功的条目仍保持成功；重试仍失败的汇总成一个错误上抛。
      const action=enabled?'enable':'pause',targetState=enabled?'active':'paused',targets=(await digestRows()).filter(row=>enabled?row.state==='paused':row.state==='active')
      const failures:unknown[]=[]
      for(const row of targets){
        try{await planApi.change(row.id,row.version,action)}
        catch(error){
          try{
            const latest=(await planApi.list()).find(item=>item.id===row.id)
            // 别处已经把这条改到目标态：再调一次 change 只会撞 teloa/conflict，视为已达成直接跳过。
            if(latest&&latest.state===targetState)continue
            await planApi.change(latest?.id??row.id,latest?.version??row.version,action)
          }catch(retryError){failures.push(retryError)}
        }
      }
      if(failures.length)throw failures[0]
    },
    async setTrigger(rows,time,timezone){
      for(const row of await digestRows())await planApi.update(row,{title:row.title,goal:row.goal,dataScope:row.dataScope,delivery:row.delivery,trigger:{...row.trigger,time,timezone},notificationPolicy:row.notificationPolicy??'silent'})
    },
  }
}
/**
 * 设置面板可见性广播（第三轮修复）：AutoDreamSettings 挂载点在 `renderSlot('sidebar',…)` 之下，
 * 隔着 sidebar.settings/settings.section/settings.general.item 三层第三方 slot 契约——
 * 三者的 owner props 都由上游包在 node_modules 里锁死成固定形状（`SidebarSettingsOwnerProps`
 * 只有 `wide`、`SettingsSectionOwnerProps` 只有 `close`、`SettingsGeneralItemOwnerProps` 干脆是
 * `{children?:never}`），renderSlot 调用处传对象字面量夹带自定义字段会被多余属性检查直接拒绝，
 * 没法把 `state.view==='settings'` 沿 owner props 一路传下来。承载设置面板的 `<section>`
 * （见本文件 `state.view!=='settings'&&css.hidden` 那处）只用 CSS 隐藏、从不卸载，
 * `AutoDreamSettings` 因此只在应用启动时挂载一次，`rows` 永远是那份空快照。
 * 改在同一文件内用一条最小的模块级广播：WorkbenchFrame 在 state.view 变化时发布，
 * AutoDreamSettings 订阅后据此判断设置页是否当前可见，可见时才重新拉取全量计划。
 */
let settingsPanelVisible=false
const settingsPanelListeners=new Set<(visible:boolean)=>void>()
/** 只导出用于测试直接驱动这条广播（见 tests/auto-dream-settings-visibility.test.ts）；生产代码只有本文件内的 WorkbenchFrame 会调它。 */
export function publishSettingsPanelVisible(next:boolean){
  if(next===settingsPanelVisible)return
  settingsPanelVisible=next
  for(const listener of settingsPanelListeners)listener(next)
}
export function subscribeSettingsPanelVisible(listener:(visible:boolean)=>void){
  settingsPanelListeners.add(listener)
  return ()=>{settingsPanelListeners.delete(listener)}
}
export function AutoDreamSettingsPage({api,recent,openRole}:{api:AutoDreamSettingApi;recent?:AutoDreamRecentApi;openRole?:(roleId:string)=>void}){
 const {locale,t}=useI18n()
 const [rows,setRows]=useState<SavedPlan[]>(),[busy,setBusy]=useState(false),[error,setError]=useState<string>()
 const [visible,setVisible]=useState(()=>settingsPanelVisible)
 const [recentRows,setRecentRows]=useState<AutoDreamRecentRow[]>(),[recentError,setRecentError]=useState<string>(),[recentRefresh,setRecentRefresh]=useState(0),[recentLoading,setRecentLoading]=useState(false)
 useEffect(()=>subscribeSettingsPanelVisible(setVisible),[])
 const load=()=>{void api.list().then(setRows).catch(error=>setError(localizeWorkError(locale,error)))}
 useEffect(()=>{if(visible)load()},[api,visible])
 useEffect(()=>{
  if(!visible||!recent||!rows)return
  let live=true;setRecentError(undefined);setRecentLoading(true)
  const trigger=rows[0]?.trigger??{time:'23:30',timezone:'Asia/Singapore' as const}
  void recent.load({trigger,planRoleIds:rows.map(row=>row.roleId)}).then(value=>{if(live)setRecentRows(value)}).catch(error=>{if(live)setRecentError(localizeWorkError(locale,error))}).finally(()=>{if(live)setRecentLoading(false)})
  return()=>{live=false}
 },[visible,rows,recent,locale,recentRefresh])
 const available=!!rows?.length,enabled=!!rows?.some(row=>row.state==='active')
 const time=rows?.[0]?.trigger.time??'23:30',timezone=rows?.[0]?.trigger.timezone??'Asia/Singapore'
 const missing=recentRows?.filter(row=>row.kind==='employee'&&!row.hasPlan)??[]
 // 失败也重新读取版本，保留原设置写口的恢复规则。
 const run=async(action:()=>Promise<void>)=>{setBusy(true);setError(undefined);try{await action()}catch(error){setError(localizeWorkError(locale,error))}finally{setBusy(false);load()}}
 return <section className={css.page} aria-label={t('autoDream.name')}>
  <h2>{t('autoDream.name')}</h2>
  <div className={css.row}><div className={css.rowText}><strong>{t('dailyLog.switchTitle')}</strong><p>{t('dailyLog.switchHint')}</p></div><div className={css.rowControl}><input className={css.switch} type="checkbox" role="switch" aria-label={t('dailyLog.switch')} aria-checked={enabled} disabled={!available||busy} checked={enabled} onChange={()=>rows&&run(()=>api.setEnabled(rows,!enabled))}/></div></div>
  <div className={css.row}><div className={css.rowText}><strong>{t('dailyLog.triggerTitle')}</strong><p>{t('dailyLog.triggerHint')}</p></div><div className={css.rowControl}><input type="time" aria-label={t('dailyLog.triggerTitle')} disabled={!available||busy} value={time} onChange={event=>rows&&run(()=>api.setTrigger(rows,event.target.value,timezone))}/><select aria-label={t('continuous.form.timezone')} disabled={!available||busy} value={timezone} onChange={event=>rows&&run(()=>api.setTrigger(rows,time,event.target.value as ScheduleTrigger['timezone']))}>{scheduleTimezones.map(zone=><option key={zone} value={zone}>{zone}</option>)}</select></div></div>
  {error&&<p role="alert">{error}</p>}
  <section className={css.recent} aria-label={t('autoDream.recent.title')}><header className={css.recentHeader}><h3>{t('autoDream.recent.title')}</h3>{recent&&<button type="button" disabled={recentLoading||!rows} onClick={()=>setRecentRefresh(value=>value+1)}>{t('autoDream.recent.refresh')}</button>}</header>
   {recentError&&<p role="alert">{recentError}</p>}
   {recentRows?.length===0&&<p>{t('autoDream.recent.empty')}</p>}
   {recentRows?.map(row=><div className={css.recentRow} data-role-id={row.roleId} key={row.roleId}><span className={css.avatar} aria-hidden="true">{(row.kind==='twin'?t('navigation.twin'):row.name).slice(0,1)}</span><span className={css.name}>{row.kind==='twin'?t('navigation.twin'):row.name}</span><span className={css.days} role="img" aria-label={row.today==='unavailable'?t('autoDream.recent.unavailable'):row.days.filter(day=>day.kept).length+'/7'}>{row.days.map(day=><i key={day.day} data-day={day.day} title={day.day} className={clsx(css.day,day.kept===null&&css.dayUnknown,day.kept&&css.dayKept)}/>)}</span><span className={css.status}>{t(row.today==='unavailable'?'autoDream.recent.unavailable':row.today==='habit'?'autoDream.recent.habitGenerated':row.today==='generated'?'autoDream.recent.generated':'autoDream.recent.noEvidence')}</span></div>)}
  </section>
  {missing.length>0&&<div className={css.missing} role="status"><TriangleAlert size={15} aria-hidden="true"/><span>{t('autoDream.missingPlan',{count:missing.length})} {t('autoDream.missingPlanHint')}</span>{openRole&&<button type="button" onClick={()=>openRole(missing[0]!.roleId)}>{t('autoDream.missingPlanAction')}</button>}</div>}
 </section>
}
