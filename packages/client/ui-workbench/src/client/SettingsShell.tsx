import type {RuntimeSettingsSurface} from './runtime-settings-surface.js'
import type {SettingsNavigation} from './settings-navigation.js'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import clsx from 'clsx'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { UseSessions } from '@deepseek-ai/dsh-client-ui-session/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {MainSessionSource} from './main-session.js'
import type { ConfigForms,SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { ChevronRight } from 'lucide-react'
import css from './SettingsShell.module.css'
import tokens from './theme-tokens.module.css'
import { mountSettingsSubdialogFocus } from './settings-subdialog-focus.js'
import { SettingsConfigurationGuide } from './SettingsConfigurationGuide.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import type {WebAccessApi} from './web-access-api.js'
import {WebAccessSettings} from './WebAccessSettings.js'

export type SettingsEntry={id:string;label:string;order:number}
type Directory={subscribe:(listener:()=>void)=>()=>void;getSnapshot:()=>readonly SettingsEntry[]}
type Seats='settings.header'|'settings.action'|'settings.section'|'settings.onboarding'
export type SettingsShellProps=PropsRenderSlots<Seats>&{
  selection:SettingsNavigation
  mainSession:MainSessionSource;wide:boolean;open:()=>void;close:()=>void;useSessions:UseSessions;sections:Directory;onboarding:Directory;connection:ConnectionHandle
}

/** 只负责设置组合；配置数据、持久化和引导步骤仍归 DSH。 */
export function SettingsShell({selection,mainSession,open,close,renderSlot,useSessions,sections,onboarding,connection}:SettingsShellProps){
  const {t}=useI18n()
  const rows=useSyncExternalStore(sections.subscribe,sections.getSnapshot),steps=useSyncExternalStore(onboarding.subscribe,onboarding.getSnapshot)
  const connectionState=useSyncExternalStore(connection.state.subscribe,connection.state.getSnapshot)
  const current=useSyncExternalStore(mainSession.subscribe,mainSession.getSnapshot)
  const eligible=useSessions(state=>state.phase==='ready'&&(current===undefined||state.byId[current]?.blank===true))
  const active=useSyncExternalStore(selection.subscribe,selection.getSnapshot)
  const [completed,setCompleted]=useState<ReadonlySet<string>>(()=>new Set())
  const shell=useRef<HTMLElement>(null)
  const content=useRef<HTMLDivElement>(null)
  useEffect(()=>{if(!eligible)setCompleted(new Set())},[eligible])
  useEffect(()=>{if(shell.current)return mountSettingsSubdialogFocus(shell.current)},[])
  const step=eligible?steps.find(row=>!completed.has(row.id)):undefined
  const selectedRow=rows.find(row=>row.id===active)??rows[0]
  const selected=selectedRow?.id
  useEffect(()=>{if(content.current)content.current.scrollTop=0},[selected])
  const entryLabel=(row:SettingsEntry)=>row.id==='general'?t('settings.general'):row.id==='teloa-workspaces'?t('settings.workspace'):row.id==='teloa-about'?t('settings.about'):row.id==='plugins'?t('settings.systemComponents'):row.label
  const entryButton=(row:SettingsEntry)=><button type="button" key={row.id} id={`settings-entry-${row.id}`} aria-current={row.id===selected?'page':undefined} aria-controls="settings-content" title={entryLabel(row)} onClick={()=>selection.select(row.id)}>{entryLabel(row)}</button>
  return <>
    <section ref={shell} className={clsx(tokens.tokens,css.shell)} aria-label={t('shell.settings')}>
      <header className={css.header}>
        <div className={css.heading}>{renderSlot('settings.header',{})}</div>
        <div className={css.actions}>{renderSlot('settings.action',{})}</div>
      </header>
      {connectionState!=='connected'&&<p className={css.connection} role="status">{t(connectionState==='connecting'?'settings.connecting':'settings.disconnected')} <button type="button" onClick={()=>connection.reconnect()}>{t('settings.reconnect')}</button></p>}
      <div className={css.layout}>
        <div className={css.navigationViewport}>
          <nav className={css.navigation} aria-label={t('shell.settings')}>{rows.map(entryButton)}</nav>
          <span className={css.navigationScrollHint} aria-hidden="true"><ChevronRight size={16}/></span>
        </div>
        <div ref={content} id="settings-content" aria-labelledby={selectedRow?`settings-entry-${selectedRow.id}`:undefined} className={clsx(css.content,selected!=='general'&&selected!=='teloa-about'&&css.page)}>{selected?renderSlot('settings.section',{close}, {only:selected}):<p role="status">{t('settings.loading')}</p>}</div>
      </div>
    </section>
    {step&&renderSlot('settings.onboarding',{stepId:step.id,complete:()=>setCompleted(previous=>new Set([...previous,step.id])),openSection:id=>{selection.select(id);open()}},{only:step.id})}
  </>
}
export function GeneralSettings({renderSlot}:PropsRenderSlots<'settings.general.item'>){
  const {t}=useI18n()
  return <section className={css.general} aria-label={t('settings.general')}>{renderSlot('settings.general.item',{})}<SettingsConfigurationGuide/></section>
}

/** rc.1 通用设置插件不导出单行组件；此处只接界面，偏好读取与保存完全交给官方服务。 */
export function DeveloperToolsSettings({preference}:{preference:ConfigForms['developerTools']}){
  const {t,locale}=useI18n()
  const enabled=useSyncExternalStore(listener=>preference.enabled.subscribe(listener),()=>preference.enabled.getSnapshot())
  const [busy,setBusy]=useState(false),[error,setError]=useState<string>()
  const pending=useRef(false)
  return <div className={css.developerTools}>
    <div><strong>{t('settings.developerTools.title')}</strong><p>{t('settings.developerTools.description')}</p>{error&&<p role="alert">{error}</p>}</div>
    <Switch checked={enabled} disabled={busy} label={t('settings.developerTools.title')} onChange={async next=>{
      if(pending.current)return
      pending.current=true;setBusy(true);setError(undefined)
      try{await preference.setEnabled(next)}catch(cause){setError(localizeWorkError(locale,cause))}finally{pending.current=false;setBusy(false)}
    }}/>
  </div>
}

/** 通过官方详情扩展点标记页面层级，通用设置只在插件列表显示。 */
export function NativePluginDetailMarker(){
  return <span hidden className={css.nativePluginDetail}/>
}

/** 整张官方管理页由 main 的拥有者委托渲染；保持原有配置、安装和恢复行为。 */
export function NativePanelsSettings({surface,webAccessApi}:{surface:RuntimeSettingsSurface;webAccessApi:WebAccessApi}){
  const {t}=useI18n()
  const render=useSyncExternalStore(surface.subscribe,surface.getSnapshot)
  return <section className={css.runtimeSurface} aria-label={t('teamCapability.runtime.manage')}>
    <p className={css.sectionPurpose}>{t('settings.runtime.purpose')}</p>
    <details className={css.webPolicy}>
      <summary>{t('webAccess.settings.title')}</summary>
      <div><WebAccessSettings api={webAccessApi} embedded/></div>
    </details>
    {render?render():<p role="status">{t('settings.loading')}</p>}
  </section>
}

/** 只替换诊断页外壳，组件清单、预设切换与状态读取继续由官方页签提供。 */
export function ComponentStatusSettings({renderSlot}:PropsRenderSlots<'settings.plugins.tab'>){
  const {t}=useI18n()
  return <section className={css.componentStatus} aria-label={t('settings.systemComponents')}>
    <header className={css.sectionHeading}><h2>{t('settings.systemComponents')}</h2><p>{t('settings.diagnostics.purpose')}</p></header>
    {renderSlot('settings.plugins.tab',{})}
  </section>
}

export function SettingsDocumentAction({describe,openDocument,loopback}:{describe:SettingsDescribeFace;openDocument:()=>Promise<void>;loopback:boolean}){
  const {locale,t}=useI18n()
  const subscribe=useCallback((listener:()=>void)=>describe.subscribe(listener),[describe])
  const getSnapshot=useCallback(()=>describe.getSnapshot(),[describe])
  const state=useSyncExternalStore(subscribe,getSnapshot)
  const [busy,setBusy]=useState(false),[error,setError]=useState<string>()
  const pending=useRef(false)
  useEffect(()=>{void describe.ensure().catch(error=>setError(localizeWorkError(locale,error)))},[describe,locale])
  if(!loopback||!state.view?.hasDocument)return null
  return <div className={css.documentAction}>{error&&<span role="alert">{error}</span>}<button type="button" disabled={busy} onClick={()=>{if(pending.current)return;pending.current=true;setBusy(true);setError(undefined);void openDocument().catch(error=>setError(localizeWorkError(locale,error))).finally(()=>{pending.current=false;setBusy(false)})}}>{t(busy?'settings.document.opening':'settings.document.open')}</button></div>
}
