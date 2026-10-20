import {useCallback,useEffect,useId,useRef,useState} from 'react'
import {ChevronDown,ExternalLink,Plug,TriangleAlert} from 'lucide-react'
import {ContextDrawer} from './ContextDrawer.js'
import {useI18n} from './i18n/provider.js'
import {subscribeSettingsPanelVisible} from './AutoDreamSettingsPage.js'
import {hardwareDevicesCopy} from './hardware-devices-copy.js'
import type {HardwareConnectionStatus,HardwareDevicesApi} from './hardware-devices-api.js'
import page from './AutoDreamSettingsPage.module.css'
import css from './HardwareDevicesSettings.module.css'
import {DirectDeviceSettings} from './DirectDeviceSettings.js'

export function HardwareDevicesSettings({api}:{api:HardwareDevicesApi}){
 const {locale}=useI18n(),copy=(key:Parameters<typeof hardwareDevicesCopy>[1])=>hardwareDevicesCopy(locale,key)
 const [status,setStatus]=useState<HardwareConnectionStatus>(),[editor,setEditor]=useState(false),[endpoint,setEndpoint]=useState(''),[consent,setConsent]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(false),[saved,setSaved]=useState(false)
 const [statusError,setStatusError]=useState(false)
 const mounted=useRef(false),visible=useRef(true),generation=useRef(0)
 const load=useCallback(async()=>{const current=++generation.current;try{const value=await api.status();if(mounted.current&&current===generation.current){setStatus(value);setStatusError(false)}}catch{if(mounted.current&&current===generation.current)setStatusError(true)}},[api])
 useEffect(()=>{
  mounted.current=true;void load()
  const off=subscribeSettingsPanelVisible(value=>{visible.current=value;if(value)void load();else setEditor(false)})
  const timer=setInterval(()=>{if(visible.current)void load()},2500)
  return()=>{mounted.current=false;generation.current++;off();clearInterval(timer)}
 },[load])
 const act=async(operation:()=>Promise<HardwareConnectionStatus>,save=false)=>{
  setBusy(true);setError(false);generation.current++
  try{const next=await operation();if(mounted.current){generation.current++;setStatus(next);if(save){setEndpoint('');setSaved(true);setConsent(false)}}}
  catch{if(mounted.current)setError(true)}finally{if(mounted.current)setBusy(false)}
 }
 const current=status?.available?status:undefined
 const hintId=useId(),permissionId=useId()
 const connectionState=current?copy(current.authorization.enabled?current.state:current.configured?'configured':'missing'):copy('connecting')
 const xiaozhi=status?.available===false?null:<div className={page.row}><div className={page.rowText}><strong>{copy('name')}</strong><p role="status">{connectionState}</p></div><div className={css.actions}><button type="button" onClick={()=>setEditor(true)} disabled={!current}>{copy('configure')}</button><button type="button" onClick={()=>void load()}>{copy('refresh')}</button></div></div>
 // 设备连接收在同一张卡片里；插件未加载时改为提示条，不留空卡。
 return <section className={page.page} aria-label={copy('title')}><h2>{copy('title')}</h2><p className={page.lead}>{copy('lead')}</p>
  {(api.direct||xiaozhi)&&<div className={page.card}>{api.direct&&<DirectDeviceSettings api={api.direct}/>}{xiaozhi}</div>}
  {status?.available===false&&<div className={page.missing}><TriangleAlert size={14} aria-hidden="true"/><span>{copy('absent')}</span></div>}
  <p className={css.note}>{copy('pending')}</p>
  {editor&&<ContextDrawer compact title={copy('name')} close={()=>setEditor(false)}><div className={css.editor}>
   <div className={css.connection}><span className={css.connectionIcon}><Plug size={20} aria-hidden="true"/></span><div><p className={css.connectionState} role="status"><span className={current?.state==='ready'&&current.authorization.enabled?css.connectedDot:css.statusDot}/>{connectionState}</p><p className={css.note}>{copy('summary')}</p></div></div>
   <section className={css.section} aria-label={copy('connectionTitle')}>
    <div className={css.sectionHeading}><h3>{copy('connectionTitle')}</h3><a href="https://xiaozhi.me/console/agent" target="_blank" rel="noreferrer">{copy('console')}<ExternalLink size={13} aria-hidden="true"/></a></div>
    <form onSubmit={event=>{event.preventDefault();void act(()=>api.save(endpoint.trim()),true)}}>
     <label className={css.field}>{copy('endpoint')}<input type="password" autoComplete="new-password" spellCheck={false} placeholder={current?.configured?copy('replaceEndpoint'):'wss://api.xiaozhi.me/mcp/…'} aria-describedby={hintId} value={endpoint} onChange={event=>{setEndpoint(event.target.value);setSaved(false);setConsent(false)}} disabled={busy||!current?.writable}/></label>
     <p id={hintId} className={css.note}>{copy('hint')}</p>
     {!current?.writable&&<p className={css.notice}>{copy('locked')}</p>}
     <div className={css.formActions}>{saved&&<p className={css.saved} role="status">{copy('saved')}</p>}<button className={!current?.configured||!!endpoint.trim()?css.primary:undefined} type="submit" disabled={busy||!current?.writable||!endpoint.trim()}>{copy(busy?'working':'save')}</button></div>
    </form>
   </section>
   <section className={css.section} aria-label={copy('permissionTitle')}>
    <div className={css.sectionHeading}><h3>{copy('permissionTitle')}</h3>{current?.authorization.enabled&&<span className={css.permissionState}>{copy('enabled')}</span>}</div>
    {current?.authorization.enabled?<><p className={css.note}>{copy('consent')}</p><div className={css.permissionActions}><button type="button" disabled={busy} onClick={()=>void act(api.test)}>{copy('test')}</button><button type="button" disabled={busy} onClick={()=>{setConsent(false);void act(api.revoke)}}>{copy('revoke')}</button></div></>:<>
     <label className={css.consent}><input type="checkbox" checked={consent} aria-describedby={permissionId} onChange={event=>setConsent(event.target.checked)} disabled={busy||!current?.configured||!!endpoint.trim()}/><span>{copy('permissionLabel')}</span></label>
     <p id={permissionId} className={css.permissionHint}>{copy('consent')}</p>
     {current?.configured&&!endpoint.trim()?<div className={css.permissionActions}><button className={css.primary} type="button" disabled={busy||!consent} onClick={()=>void act(api.enable)}>{copy(busy?'working':'enable')}</button></div>:<p className={css.nextStep}>{copy('saveFirst')}</p>}
    </>}
   </section>
   <details className={css.details}><summary>{copy('details')}<span className={css.disclosureIcon}><ChevronDown size={15} aria-hidden="true"/></span></summary><div><p>{copy('flow')}</p><p>{copy('pending')}</p></div></details>
   {(error||statusError)&&<p className={css.notice} role="alert">{copy('error')}</p>}
  </div></ContextDrawer>}
  {(error||statusError)&&!editor&&<p role="alert">{copy('error')}</p>}
 </section>
}
