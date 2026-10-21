import {createContext,useContext,useEffect,useRef,useState,type ReactNode} from 'react'
import {Share2} from 'lucide-react'
import type {BusinessDashboardShareSnapshot,BusinessDashboardShareTarget,Group} from '@teloa/contract'
import type {createDashboardShareApi} from './dashboard-share-api.js'
import {createDashboardGroupShare,type DashboardShareAttachments,type DashboardShareGroups} from './dashboard-share-group.js'
import {dashboardShareCsv,dashboardShareFilename,downloadDashboardShare} from './dashboard-share-files.js'
import {dashboardSharePng} from './dashboard-share-image.js'
import {BusinessDashboardGrid} from './BusinessDashboardGrid.js'
import {localizedBusinessViewTitle,localizedBusinessPageTitle} from './business-definition-localization.js'
import {ContextDrawer} from './ContextDrawer.js'
import {ToolbarIconButton} from './ToolbarIconButton.js'
import {useLightDraft} from './light-dialog-drafts.js'
import {useI18n} from './i18n/provider.js'
import css from './BusinessDashboardShare.module.css'

export type DashboardShareServices={read:ReturnType<typeof createDashboardShareApi>;groups:DashboardShareGroups;attachments:DashboardShareAttachments;namespace?:string|undefined;scopeName?:((scope:string)=>string)|undefined}
const ShareContext=createContext<DashboardShareServices|undefined>(undefined)
export function DashboardShareProvider({services,children}:{services:DashboardShareServices|undefined;children:ReactNode}){return <ShareContext.Provider value={services}>{children}</ShareContext.Provider>}
const rangeLabels={'24h':'business.dashboards.range.24h','7d':'business.dashboards.range.7d','30d':'business.dashboards.range.30d','90d':'business.dashboards.range.90d',all:'business.dashboards.range.all'} as const
const identities=new WeakMap<object,number>();let nextIdentity=0
function identity(value:object){let result=identities.get(value);if(!result){result=++nextIdentity;identities.set(value,result)}return result}
type Format='png'|'csv'|'both'
type Draft={groupId:string;format:Format;snapshot?:BusinessDashboardShareSnapshot|undefined;files?:Partial<Record<'png'|'csv',File>>;flow?:ReturnType<typeof createDashboardGroupShare>;sent?:boolean}

/** 只在已保存看板的真实入口出现；目标变化后旧异步打开不会进入新范围。 */
export function BusinessDashboardShareButton({target,identity:targetIdentity,colorScheme}:{target:()=>Promise<BusinessDashboardShareTarget>;identity:string;colorScheme:'light'|'dark'}){
 const services=useContext(ShareContext),{t}=useI18n(),[selected,setSelected]=useState<BusinessDashboardShareTarget>(),[opening,setOpening]=useState(false),[error,setError]=useState(false)
 const current=useRef({identity:targetIdentity,services});current.current={identity:targetIdentity,services}
 const mounted=useRef(true)
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[])
 useEffect(()=>{setSelected(undefined);setOpening(false)},[targetIdentity,services?.read,services?.groups])
 const open=async()=>{
  if(!services||opening)return
  const original=current.current;setOpening(true);setError(false)
  try{const value=await target();if(mounted.current&&current.current.identity===original.identity&&current.current.services?.read===original.services?.read&&current.current.services?.groups===original.services?.groups)setSelected(value)}
  catch{if(mounted.current)setError(true)}
  finally{if(mounted.current)setOpening(false)}
 }
 if(!services)return null
 return <><ToolbarIconButton label={t('dashboardShare.title')} icon={Share2} disabled={opening} onClick={()=>void open()}/>{error&&<span role="alert">{t('dashboardShare.readFailed')}</span>}{selected&&<DashboardShareDrawer key={JSON.stringify(selected)} target={selected} services={services} colorScheme={colorScheme} close={()=>setSelected(undefined)}/>}</>
}

/** 草稿仅存本人 API/原目标的本页内存；快照、文件和原始记录不写浏览器存储。 */
export function DashboardShareDrawer({target,services,colorScheme,close}:{target:BusinessDashboardShareTarget;services:DashboardShareServices;colorScheme:'light'|'dark';close:()=>void}){
 const {t,locale,dateTime}=useI18n()
 const key=JSON.stringify(['dashboard-share',identity(services.groups),identity(services.read),services.namespace??null,target])
 const [draft,changeDraft]=useLightDraft<Draft>(key,()=>({groupId:'',format:'png'}))
 const [groups,setGroups]=useState<Group[]>(),[groupFailed,setGroupFailed]=useState(false),[groupRevision,setGroupRevision]=useState(0)
 const [reading,setReading]=useState(!draft.snapshot),[busy,setBusy]=useState(false),[error,setError]=useState<string>(),[notice,setNotice]=useState<string>()
 const [revision,setRevision]=useState(0),preview=useRef<HTMLDivElement>(null),alive=useRef(true),running=useRef(false)
 const latest=useRef(draft);latest.current=draft
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
 const save=(next:Draft)=>{latest.current=next;changeDraft(next)}
 const snapshot=draft.snapshot,locked=!!draft.flow?.locked()
 useEffect(()=>{
  if(latest.current.snapshot)return
  const controller=new AbortController();setReading(true);setError(undefined)
  void services.read(target,controller.signal).then(value=>{if(!controller.signal.aborted)save({...latest.current,snapshot:value,files:{}})},cause=>{if(!controller.signal.aborted)setError(cause&&typeof cause==='object'&&'code'in cause&&cause.code==='teloa/dashboard-share-limit'?'dashboardShare.limit':'dashboardShare.readFailed')}).finally(()=>{if(!controller.signal.aborted)setReading(false)})
  return()=>controller.abort()
 },[key,revision,services.read])
 useEffect(()=>{
  let active=true;setGroups(undefined);setGroupFailed(false)
  void services.groups.list().then(directory=>{if(active)setGroups(directory.items.filter(group=>group.scope===target.scope&&!group.archived))},()=>{if(active)setGroupFailed(true)})
  return()=>{active=false}
 },[key,services.groups,groupRevision])
 const title=snapshot?snapshot.page.kind==='configuration'?localizedBusinessPageTitle(snapshot.page.projection.page.definition,snapshot.page.projection.page.kind==='dashboard'?snapshot.page.projection.page.dashboard:undefined,locale):localizedBusinessViewTitle(snapshot.page.page.dashboard,locale):''
 const scopeTitle=services.scopeName?.(target.scope)??target.scope
 const version=target.kind==='configuration'?'v'+target.configurationVersion:snapshot?.page.kind==='legacy'?'v'+snapshot.page.page.dashboard.version:''
 const range=t(rangeLabels[target.timeRange])
 const metadata=snapshot?{title,scope:scopeTitle,version,timeRange:range,capturedAt:dateTime(new Date(snapshot.capturedAt),{dateStyle:'medium',timeStyle:'medium'})}:undefined
 const act=async(work:()=>Promise<void>)=>{
  if(running.current)return
  running.current=true;setBusy(true);setError(undefined);setNotice(undefined)
  try{await work()}catch(cause){
   const code=cause&&typeof cause==='object'&&'code'in cause?cause.code:undefined
   if(alive.current)setError(code==='teloa/dashboard-share-limit'||code==='too-large'?'dashboardShare.limit':code==='not-ready'?'dashboardShare.notReady':code==='unsupported'||code==='image-failed'?'dashboardShare.imageFailed':code==='teloa/dashboard-share-pending'?'dashboardShare.pending':code==='teloa/dashboard-share-group-changed'?'dashboardShare.groupChanged':'dashboardShare.failed')
  }finally{running.current=false;if(alive.current)setBusy(false)}
 }
 const file=async(kind:'png'|'csv'):Promise<File>=>{
  const original=latest.current,saved=original.snapshot
  if(!saved||!metadata)throw Object.assign(Error('not-ready'),{code:'not-ready'})
  if(original.files?.[kind])return original.files[kind]!
  let blob:Blob
  if(kind==='csv')blob=dashboardShareCsv(saved)
  else{
   if(!preview.current)throw Object.assign(Error('not-ready'),{code:'not-ready'})
   await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))
   blob=await dashboardSharePng(preview.current,metadata)
  }
  const value=new File([blob],dashboardShareFilename(saved,kind),{type:kind==='png'?'image/png':'text/csv'})
  save({...latest.current,files:{...latest.current.files,[kind]:value}})
  return value
 }
 const download=(kind:'png'|'csv')=>act(async()=>{const value=await file(kind);if(!alive.current)return;downloadDashboardShare(value,value.name);setNotice('dashboardShare.generated')})
 const send=()=>act(async()=>{
  const original=latest.current,saved=original.snapshot,group=groups?.find(group=>group.id===original.groupId)
  if(!saved||!group||!metadata)throw Object.assign(Error('teloa/dashboard-share-group-changed'),{code:'teloa/dashboard-share-group-changed'})
  const formats=original.format==='both'?['png','csv'] as const:[original.format] as const
  const files:File[]=[];for(const kind of formats)files.push(await file(kind))
  if(!alive.current)return
  const flow=latest.current.flow??createDashboardGroupShare(services.groups,services.attachments)
  save({...latest.current,flow})
  const text=[title,scopeTitle,version,range,metadata.capturedAt,'SHA-256 '+saved.snapshotHash].join('\n')
  await flow.send({scope:target.scope,snapshotHash:saved.snapshotHash,groupId:group.id,text,files})
  save({...latest.current,sent:true});if(alive.current)setNotice('dashboardShare.sent')
 })
 const ready=!!snapshot&&!reading,rawReady=snapshot?.raw.status==='ready'
 const renderPreview=()=>{
  if(!snapshot)return null
  if(snapshot.page.kind==='configuration'){
   const page=snapshot.page.projection.page
   return page.kind==='dashboard'?<BusinessDashboardGrid dashboard={page.dashboard} widgets={page.widgets} results={page.results} viewRefs={page.viewRefs} colorScheme={colorScheme} ranged={page.dashboard.filters!==undefined}/>:null
  }
  const page=snapshot.page.page
  return <BusinessDashboardGrid dashboard={page.dashboard} widgets={page.widgets} results={page.results} colorScheme={colorScheme} ranged={page.timeRange!==null}/>
 }
 return <ContextDrawer padded title={t('dashboardShare.title')} close={close}><div className={css.body}>
  {reading&&<p role="status">{t('dashboardShare.loading')}</p>}
  {error&&<p role="alert">{t(error)} {error==='dashboardShare.readFailed'&&<button type="button" onClick={()=>setRevision(value=>value+1)}>{t('business.ledger.retry')}</button>}</p>}
  {notice&&<p role="status">{t(notice)}</p>}
  {snapshot&&<><h3>{title}</h3><p className={css.meta}>{scopeTitle} · {version}<br/>{range} · {metadata?.capturedAt}</p><p className={css.hint}>{t('dashboardShare.boundary')}</p>
   <div className={css.exports}><button type="button" disabled={!ready||busy} onClick={()=>void download('png')}>{t('dashboardShare.png')}</button><button type="button" disabled={!ready||busy||!rawReady} onClick={()=>void download('csv')}>{t('dashboardShare.csv')}</button></div>
   {!rawReady&&<p role="status" className={css.hint}>{t('dashboardShare.noRaw')}</p>}
   {rawReady&&<p className={css.hint}>{t('dashboardShare.csvSafety')}</p>}
   <section className={css.group}><h3>{t('dashboardShare.group')}</h3><p className={css.hint}>{t('dashboardShare.groupBoundary')}</p>
    {groupFailed?<p role="alert">{t('dashboardShare.groupsFailed')} <button type="button" onClick={()=>setGroupRevision(value=>value+1)}>{t('business.ledger.retry')}</button></p>:groups===undefined?<p role="status">{t('dashboardShare.groupsLoading')}</p>:groups.length?<>
     <label>{t('dashboardShare.group')}<select aria-label={t('dashboardShare.group')} value={draft.groupId} disabled={busy||locked} onChange={event=>save({...latest.current,groupId:event.target.value})}><option value="">{t('dashboardShare.chooseGroup')}</option>{groups.map(group=><option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
     <label>{t('dashboardShare.contents')}<select aria-label={t('dashboardShare.contents')} value={draft.format} disabled={busy||locked} onChange={event=>save({...latest.current,format:event.target.value as Format})}><option value="png">PNG</option>{rawReady&&<><option value="csv">CSV</option><option value="both">PNG + CSV</option></>}</select></label>
     <button type="button" disabled={!ready||busy||!draft.groupId||draft.sent||!rawReady&&draft.format!=='png'} onClick={()=>void send()}>{t(draft.flow?.locked()&&!draft.sent?'dashboardShare.retrySend':'dashboardShare.send')}</button>
    </>:<p role="status" className={css.hint}>{t('dashboardShare.noGroups')}</p>}
   </section>
   {(!locked||draft.flow?.canRestart())&&<button type="button" className={css.reload} disabled={busy} onClick={()=>{save({groupId:latest.current.groupId,format:latest.current.format});setRevision(value=>value+1)}}>{t('dashboardShare.reload')}</button>}
   <div ref={preview} className={css.preview} aria-hidden="true">{renderPreview()}</div>
  </>}
 </div></ContextDrawer>
}

