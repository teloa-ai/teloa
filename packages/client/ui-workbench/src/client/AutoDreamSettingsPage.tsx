import {ToolbarIconButton} from './ToolbarIconButton.js'
import {useEffect,useState} from 'react'
import clsx from 'clsx'
import {TriangleAlert,RefreshCw} from 'lucide-react'
import {scheduleTimezones,type ScheduleTrigger} from '@teloa/contract'
import type {PlanApi,SavedPlan} from './plan-api.js'
import type {AutoDreamRecentApi,AutoDreamRecentRow} from './auto-dream-recent-api.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './AutoDreamSettingsPage.module.css'

/**
 * Auto Dream 默认启用；本页只管理生成时刻和查看日志，不批量启停员工计划。
 * 时间与时区复用 `source.kind==='system-digest'` 计划的 trigger 和既有 PlanApi 更新契约。
 */
export type AutoDreamSettingApi={
  list:()=>Promise<SavedPlan[]>
  setTrigger:(rows:readonly SavedPlan[],time:string,timezone:ScheduleTrigger['timezone'])=>Promise<void>
}
/** 纯逻辑抽成独立工厂：不依赖 React，方便单测直接喂一个假 `PlanApi` 核对映射，不必挂整个 WorkbenchFrame。 */
export function createAutoDreamSettingApi(planApi:Pick<PlanApi,'list'|'update'>):AutoDreamSettingApi{
  const digestRows=async()=>(await planApi.list()).filter(plan=>plan.source.kind==='system-digest')
  return {
    list:digestRows,
    // 编辑前重新读取全量，包含本页打开后新入职的员工计划。
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
  void recent.load({trigger,planRoleIds:rows.flatMap(row=>row.roleId===null?[]:[row.roleId])}).then(value=>{if(live)setRecentRows(value)}).catch(error=>{if(live)setRecentError(localizeWorkError(locale,error))}).finally(()=>{if(live)setRecentLoading(false)})
  return()=>{live=false}
 },[visible,rows,recent,locale,recentRefresh])
 const available=!!rows?.length
 const time=rows?.[0]?.trigger.time??'23:30',timezone=rows?.[0]?.trigger.timezone??'Asia/Singapore'
 const missing=recentRows?.filter(row=>row.kind==='employee'&&!row.hasPlan)??[]
 // 失败也重新读取版本，保留原设置写口的恢复规则。
 const run=async(action:()=>Promise<void>)=>{setBusy(true);setError(undefined);try{await action()}catch(error){setError(localizeWorkError(locale,error))}finally{setBusy(false);load()}}
 return <section className={css.page} aria-label={t('autoDream.name')}>
  <h2>{t('autoDream.name')}</h2>
  <div className={css.card}><div className={css.row}><div className={css.rowText}><strong>{t('dailyLog.triggerTitle')}</strong><p>{t('dailyLog.triggerHint')}</p></div><div className={css.rowControl}><input type="time" aria-label={t('dailyLog.triggerTitle')} disabled={!available||busy} value={time} onChange={event=>rows&&run(()=>api.setTrigger(rows,event.target.value,timezone))}/><select aria-label={t('continuous.form.timezone')} disabled={!available||busy} value={timezone} onChange={event=>rows&&run(()=>api.setTrigger(rows,time,event.target.value as ScheduleTrigger['timezone']))}>{scheduleTimezones.map(zone=><option key={zone} value={zone}>{zone}</option>)}</select></div></div></div>
  {error&&<p role="alert">{error}</p>}
  <section className={css.card+' '+css.recent} aria-label={t('autoDream.recent.title')}><header className={css.recentHeader}><h3>{t('autoDream.recent.title')}</h3>{recent&&<ToolbarIconButton label={t('autoDream.recent.refresh')} icon={RefreshCw} disabled={recentLoading||!rows} onClick={()=>setRecentRefresh(value=>value+1)}/>}</header>
   {recentError&&<p role="alert">{recentError}</p>}
   {recentRows?.length===0&&<p>{t('autoDream.recent.empty')}</p>}
   {recentRows?.map(row=><div className={css.recentRow} data-role-id={row.roleId} key={row.roleId}><span className={css.avatar} aria-hidden="true">{(row.kind==='twin'?t('navigation.twin'):row.name).slice(0,1)}</span><span className={css.name}>{row.kind==='twin'?t('navigation.twin'):row.name}</span><span className={css.days} role="img" aria-label={row.today==='unavailable'?t('autoDream.recent.unavailable'):row.days.filter(day=>day.kept).length+'/7'}>{row.days.map(day=><i key={day.day} data-day={day.day} title={day.day} className={clsx(css.day,day.kept===null&&css.dayUnknown,day.kept&&css.dayKept)}/>)}</span><span className={css.status}>{t(row.today==='unavailable'?'autoDream.recent.unavailable':row.today==='habit'?'autoDream.recent.habitGenerated':row.today==='generated'?'autoDream.recent.generated':'autoDream.recent.noEvidence')}</span></div>)}
  </section>
  {missing.length>0&&<div className={css.missing} role="status"><TriangleAlert size={15} aria-hidden="true"/><span>{t('autoDream.missingPlan',{count:missing.length})} {t('autoDream.missingPlanHint')}</span>{openRole&&<button type="button" onClick={()=>openRole(missing[0]!.roleId)}>{t('autoDream.missingPlanAction')}</button>}</div>}
 </section>
}
