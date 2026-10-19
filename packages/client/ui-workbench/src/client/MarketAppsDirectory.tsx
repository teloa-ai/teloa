import {useEffect,useMemo,useRef,useState,type ReactNode} from 'react'
import {ChevronRight,Plus,Search} from 'lucide-react'
import type {MarketCatalogConnectorEntry} from '@teloa/contract'
import {ContextDrawer} from './ContextDrawer.js'
import {useDismissible} from './use-dismissible.js'
import {AppResourceIcon} from './AppResourceIcon.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import {getTaxonomyLabel} from './market-taxonomy-filter.js'
import {loadCatalogListing,type MarketCatalogApi,type MarketCatalogItem,type MarketCatalogRanking} from './market-catalog-api.js'
import type {ManagedMcpConnectionApi} from './mcp-connections-api.js'
import type {SkillInstallApi,SkillInstallationRecord} from './skill-install-api.js'
import {installAppPack,type AppPackOutcome} from './market-app-pack-install.js'
import {appsCategories,appsDirectoryRows,appsRowAction,appsRowShareSource,appsRowStatus,appsSections,skillAction,skillStatus,type AppsConnections,type AppsConnector,type AppsDeclaredPackage,type AppsStoredContent,type AppsRow,type AppsRowAction,type AppsSection,type AppsSkill,type AppsView} from './market-apps-presentation.js'
import {CapabilityTemplateShare,useTemplateShare} from './EmployeeTemplateShare.js'
import type {ShareSkillSource} from './share-package-plan.js'
import {SkillSecretsBadgeButton} from './SkillSecretsBadgeButton.js'
import type {SkillSecretsState} from './skill-secrets-api.js'
import type {IndustryLoadRecord} from './industry-load-api.js'
import type {MarketAppsMessageKey} from './i18n/locales/market-apps.js'
import css from './MarketAppsDirectory.module.css'

/**
 * 能力详情里的分享入口：目录技能与连接器直接按固定引用打包；本机安装技能经分享来源端口解析静态正文，
 * 读不到许可允许的正文时只显示准确的不可用状态，不伪造内容。
 */
function AppShareEntry({row}:{row:AppsRow}){
 const {t}=useI18n(),shared=useTemplateShare()
 const [open,setOpen]=useState(false),[resolved,setResolved]=useState<ShareSkillSource[]>(),[unavailable,setUnavailable]=useState(false),[busy,setBusy]=useState(false)
 const catalog=useMemo(()=>appsRowShareSource(row),[row])
 if(!shared)return null
 if(catalog)return <><button type="button"onClick={()=>setOpen(true)}>{t(catalog.subject==='skill'?'templateShare.shareSkill':catalog.subject==='mcp'?'templateShare.shareConnection':'templateShare.shareApp')}</button>{open&&<CapabilityTemplateShare subject={catalog.subject} skills={catalog.skills} connections={catalog.connections} open close={()=>setOpen(false)} draftKey={row.key}/>}</>
 if(row.kind!=='installed-skill')return null
 const resolve=async()=>{setBusy(true);setUnavailable(false);try{if(!row.installationId||!row.nativeName){setUnavailable(true);return}const sources=await shared.sources?.skills([row.nativeName],{installationId:row.installationId})??[];const usable=sources.filter(source=>source.text!==undefined||source.publicId);if(!usable.length){setUnavailable(true);return}setResolved(usable);setOpen(true)}catch{setUnavailable(true)}finally{setBusy(false)}}
 return <><button type="button"disabled={busy} onClick={()=>void resolve()}>{t('templateShare.shareSkill')}</button>{unavailable&&<p className={css.note} role="status">{t('templateShare.sourceUnavailable')}</p>}{open&&resolved&&<CapabilityTemplateShare subject="skill" skills={resolved} open close={()=>setOpen(false)} draftKey={row.key}/>}</>
}

type Text=(key:MarketAppsMessageKey,params?:Record<string,string|number>)=>string
/** 本专题词条由 `market-apps.ts` 定稿；产品词典的键类型含字符串行，按本专题键约束调用即可。 */
function useAppsText():{text:Text;locale:string}{
 const {t,locale}=useI18n()
 return {text:(key,params)=>t(key,params),locale}
}

export type AppsCatalogState={status:'loading'}|{status:'ready'}|{status:'error';message:string}
/** 应用包一次安装的进度与逐项结果（error 已本地化）；只反映本次真实返回，刷新后以安装记录为准。 */
export type AppsPackRun={done:number;total:number;running:boolean;outcomes:{entryId:string;state:AppPackOutcome['state'];nameInUse?:string;error?:string}[];stopped:'pending'|'stale'|null}
export const initialAppsView:AppsView={query:'',category:'all',mine:false}

export type MarketAppsDirectoryViewProps={
 rows:readonly AppsRow[]
 ranking:MarketCatalogRanking
 catalog:AppsCatalogState
 connections:AppsConnections
 view:AppsView
 onViewChange:(view:AppsView)=>void
 runAction:(row:AppsRow,action:AppsRowAction)=>void
 busy:string|undefined
 errors:Readonly<Record<string,string>>
 packRuns?:Readonly<Record<string,AppsPackRun>>
 retryCatalog?:()=>void
 retryConnections?:()=>void
 connectionServiceUnavailable?:boolean
 onDescribe?:(query:string)=>void
 onImportSkill?:()=>void
 onCreateSkill?:()=>void
 onCreateApp?:()=>void
 nativeApps?:ReactNode
 onManagePlugins?:()=>void
 onOpenTemplates?:()=>void
 skillSecrets?:{describe:(skill:string)=>Promise<SkillSecretsState>;open:(skill:string,title:string)=>void}|undefined
}

const actionKey=(action:AppsRowAction)=>'entryId' in action?action.entryId:action.kind==='open-package'?action.packageId:action.kind==='install-pack'?action.key:''

/** 行与详情共用的主按钮文字：未添加先“添加”，已添加的应用显示连接进度，技能显示添加 / 安装状态。 */
function actionLabel(text:Text,row:AppsRow,action:AppsRowAction,busy:string|undefined,run?:AppsPackRun):string{
 if(run?.running)return text('market.apps.action.installingPack',{done:run.done,total:run.total})
 if(action.kind==='install-pack')return text('market.apps.action.install')
 if(busy&&busy===actionKey(action))return text('market.apps.action.adding')
 if(action.kind==='add-connector'||action.kind==='add-skill')return text('market.apps.action.add')
 if(action.kind==='open-package')return text('market.apps.action.openPackage')
 if(row.contentId)return text('market.apps.action.view')
 const status=appsRowStatus(row)
 if(row.kind==='app'&&status.key==='not-connected')return text('market.apps.action.connect')
 if(row.pack)return status.key==='installedCount'?text('market.apps.state.installedCount',status.params):text('market.apps.action.view')
 if(row.kind==='library')return status.key==='addedCount'?text('market.apps.state.addedCount',status.params):text('market.apps.action.view')
 if(action.kind==='detail'&&['not-added','unknown'].includes(status.key))return text('market.apps.action.view')
 return text(('market.apps.state.'+status.key) as MarketAppsMessageKey,status.params)
}

function AppRow({row,view,onViewChange,runAction,busy,errors,run}:Pick<MarketAppsDirectoryViewProps,'view'|'onViewChange'|'runAction'|'busy'|'errors'>&{row:AppsRow;run?:AppsPackRun|undefined}){
 const {text}=useAppsText(),action=appsRowAction(row),key=actionKey(action),error=key?errors[key]:undefined
 const meta=row.contentId?[row.summary,row.publisher,row.version?'v'+row.version:undefined].filter(Boolean).join(' · '):row.kind==='library'?text('market.apps.skillCount',{count:row.skills.length})+' · '+text(row.connectors.length?'market.apps.connectionNeeded':'market.apps.noConnectionNeeded'):row.summary
 const open=()=>onViewChange({...view,detail:row.key})
 return <li className={css.row}>
  <button type="button" className={css.main} onClick={()=>row.contentId?runAction(row,action):open()}>
   <AppResourceIcon row={row}/>
   <span className={css.text}><strong>{row.title}</strong><small>{meta}</small>{row.savedState?<small>{text(('market.apps.state.'+row.savedState) as MarketAppsMessageKey)}</small>:appsRowStatus(row).key==='unknown'&&<small>{text('market.apps.state.unknown')}</small>}</span>
  </button>
  <button type="button" className={css.action} disabled={!!busy&&busy===key||!!run?.running} onClick={()=>action.kind==='detail'?open():runAction(row,action)}>{actionLabel(text,row,action,busy,run)}</button>
  {error&&<p className={css.rowError} role="alert">{text('market.apps.action.failed',{reason:error})}</p>}
 </li>
}

function sectionTitle(text:Text,locale:string,section:AppsSection):string{
 if(section.id==='recommended')return text('market.apps.recommended')
 if(section.id==='results')return text('market.apps.results')
 if(section.id==='mine')return text('market.apps.mineTitle')
 return getTaxonomyLabel('function',section.id,locale)??section.id
}

/** 目录主体：统一搜索、轻用途分类、推荐与分区双列；详情与动作交给宿主端口，不另起技术渠道导航。 */
export function MarketAppsDirectoryView(props:MarketAppsDirectoryViewProps){
 const {text,locale}=useAppsText(),{rows,view,onViewChange,catalog,connections}=props
 const categories=appsCategories(rows),sections=appsSections(rows,view,props.ranking),mineCount=rows.filter(row=>row.mine).length
 const [addOpen,setAddOpen]=useState(false),addMenu=useRef<HTMLDetailsElement>(null)
 useDismissible(addMenu,addOpen,()=>setAddOpen(false))
 const choose=(action:()=>void)=>{addMenu.current?.querySelector('summary')?.focus();setAddOpen(false);action()}
 const set=(patch:Partial<AppsView>)=>{const {detail:_,...rest}={...view,...patch};onViewChange(rest)}
 const detail=view.detail?rows.find(row=>row.key===view.detail):undefined
 return <section className={css.directory} aria-labelledby="market-apps-title">
  <div className={css.title}>
   <h2 id="market-apps-title">{text('market.apps.title')}</h2>
   <div className={css.titleActions}><button type="button" aria-pressed={view.mine} onClick={()=>set({mine:!view.mine})}>{text('market.apps.mine',{count:mineCount})}</button>
    {(props.onCreateSkill||props.onCreateApp||props.onImportSkill)&&<details ref={addMenu} className={css.addMenu} open={addOpen} onToggle={event=>setAddOpen(event.currentTarget.open)}><summary aria-label={text('market.apps.add')} title={text('market.apps.add')}><Plus size={18}/></summary><div>{props.onCreateSkill&&<button type="button" onClick={()=>choose(props.onCreateSkill!)}>{text('market.apps.createSkill')}</button>}{props.onCreateApp&&<button type="button" onClick={()=>choose(props.onCreateApp!)}>{text('market.apps.createApp')}</button>}{props.onImportSkill&&<button type="button" onClick={()=>choose(props.onImportSkill!)}>{text('market.apps.importSkill')}</button>}</div></details>}
   </div>
  </div>
  <div className={css.searchRow}>
   <label className={css.search}><Search size={16} aria-hidden="true"/><input type="search" value={view.query} placeholder={text('market.apps.search')} aria-label={text('market.apps.search')} onChange={event=>set({query:event.currentTarget.value})}/></label>
   {props.onOpenTemplates&&<button type="button" className={css.link} onClick={props.onOpenTemplates}>{text('market.apps.templates')}</button>}
  </div>
  <nav className={css.categories} aria-label={text('market.apps.categoryAria')}>
   {(['all',...categories] as const).map(key=><button key={key} type="button" aria-pressed={view.category===key} onClick={()=>set({category:key})}>{key==='all'?text('market.apps.all'):getTaxonomyLabel('function',key,locale)??key}</button>)}
  </nav>
  {connections.status==='unavailable'&&<p className={css.notice} role="status">{text(props.connectionServiceUnavailable?'market.apps.connectionServiceUnavailable':'market.apps.connectionsUnknown')}{props.retryConnections&&<button type="button" onClick={props.retryConnections}>{text('market.apps.connectionsRetry')}</button>}</p>}
  {catalog.status==='loading'&&!sections.length?<p className={css.empty} role="status">{text('market.apps.loading')}</p>
  :catalog.status==='error'&&!rows.length?<div className={css.empty} role="alert"><p>{text('market.apps.loadFailed',{reason:catalog.message})}</p>{props.retryCatalog&&<button type="button" onClick={props.retryCatalog}>{text('market.apps.retry')}</button>}</div>
  :sections.length?sections.map(section=><section key={section.id} className={css.group} aria-label={sectionTitle(text,locale,section)}>
   <div className={css.groupHead}><h3>{sectionTitle(text,locale,section)}</h3>{section.more&&section.id!=='recommended'&&section.id!=='results'&&section.id!=='mine'&&<button type="button" onClick={()=>set({category:section.id as AppsView['category']})}>{text('market.apps.seeAll')}</button>}</div>
   <ul className={css.grid}>{section.rows.map(row=><AppRow key={row.key} row={row} view={view} onViewChange={onViewChange} runAction={props.runAction} busy={props.busy} errors={props.errors} run={props.packRuns?.[row.key]}/>)}</ul>
  </section>)
  :props.nativeApps?null:view.mine&&!view.query.trim()?<div className={css.empty}><h3>{text('market.apps.mineEmpty')}</h3><button type="button" onClick={()=>set({mine:false,category:'all'})}>{text('market.apps.seeAll')}</button></div>
  :<div className={css.empty}><h3>{text('market.apps.noMatch')}</h3><div className={css.emptyActions}>
   {props.onDescribe&&<button type="button" className={css.primary} onClick={()=>props.onDescribe?.(view.query)}>{text('market.apps.describe')}</button>}
   {props.onImportSkill&&<button type="button" onClick={props.onImportSkill}>{text('market.apps.importSkill')}</button>}
   {view.query&&<button type="button" onClick={()=>set({query:''})}>{text('market.apps.clearSearch')}</button>}
  </div></div>}
  {props.nativeApps}
  {props.onManagePlugins&&<div className={css.advanced}><button type="button" className={css.link} onClick={props.onManagePlugins}>{text('market.apps.managePlugins')}<ChevronRight size={14} aria-hidden/></button></div>}
  {detail&&<MarketAppDetailView row={detail} close={()=>set({})} runAction={props.runAction} busy={props.busy} error={props.errors[detail.key]??detail.entryIds.map(id=>props.errors[id]).find(Boolean)??(detail.packageId?props.errors[detail.packageId]:undefined)} packRun={props.packRuns?.[detail.key]} skillSecrets={props.skillSecrets}/>}
 </section>
}

export type MarketAppDetailViewProps={row:AppsRow;close:()=>void;runAction:(row:AppsRow,action:AppsRowAction)=>void;busy:string|undefined;error:string|undefined;packRun?:AppsPackRun|undefined}&Pick<MarketAppsDirectoryViewProps,'skillSecrets'>

/** 目录连接条目的设置入口：与目录应用同一动作；状态未知或未对应到目录条目时不给入口。 */
function ConnectorButton({row,item,runAction}:{row:AppsRow;item:AppsConnector;runAction:MarketAppDetailViewProps['runAction']}){
 const {text}=useAppsText()
 if(!item.entry||!item.catalogId||!item.state||item.state.install==='unknown')return null
 const entry=item.entry,catalogId=item.catalogId,state=item.state
 return <button type="button" onClick={()=>runAction(row,{kind:state.install==='not-added'&&!item.added?'add-connector':'open-connection',entryId:catalogId,entry})}>{text(state.connection==='not-connected'?'market.apps.action.connect':'market.apps.action.manage')}</button>
}
/** 应用包的安装区：一个安装动作、本次结果汇总、未采用组件说明与需要本人连接的应用；逐项状态在技能列表里。 */
function PackInstallSection({row,run,runAction}:{row:AppsRow;run:AppsPackRun|undefined;runAction:MarketAppDetailViewProps['runAction']}){
 const {text}=useAppsText(),pack=row.pack!,action=appsRowAction(row)
 const count=(states:readonly string[])=>run?run.outcomes.filter(item=>states.includes(item.state)).length:0
 const unsupported=pack.unsupported.reduce((sum,item)=>sum+item.count,0),resumable=!!run&&!run.running&&run.outcomes.some(item=>['failed','pending','not-started'].includes(item.state))
 const label=run?.running?text('market.apps.action.installingPack',{done:run.done,total:run.total}):resumable?text('market.apps.action.continuePack'):action.kind==='install-pack'?text('market.apps.action.installPack',{count:action.members.length}):undefined
 return <section className={css.detailSection}>
  {label&&<button type="button" className={css.primary} disabled={!!run?.running||action.kind!=='install-pack'} onClick={()=>action.kind==='install-pack'&&runAction(row,action)}>{label}</button>}
  {action.kind==='install-pack'&&<p className={css.note}>{text('market.apps.pack.installHint')}</p>}
  {run&&!run.running&&<p className={css.note} role="status">{[text('market.apps.pack.installed',{count:count(['installed','already-installed'])}),...(count(['pending'])?[text('market.apps.pack.pending',{count:count(['pending'])})]:[]),...(count(['failed'])?[text('market.apps.pack.failed',{count:count(['failed'])})]:[])].join('；')}</p>}
  {unsupported>0&&<p className={css.note}>{text('market.apps.pack.unsupported',{count:unsupported})}</p>}
  {row.connectors.length>0&&<><h3>{text('market.apps.pack.connections')}</h3><ul className={css.lines}>{row.connectors.map(item=><li key={item.catalogId??item.title}><strong>{item.title}</strong><ConnectorButton row={row} item={item} runAction={runAction}/></li>)}</ul></>}
 </section>
}
function packMemberLabel(text:Text,row:AppsRow,entryId:string|undefined,run:AppsPackRun|undefined):string{
 const outcome=run?.outcomes.find(item=>item.entryId===entryId),member=row.pack?.members.find(item=>item.entryId===entryId)
 if(outcome?.state==='name-conflict')return text('market.apps.pack.nameInUse',{name:outcome.nameInUse??''})
 if(outcome?.state==='failed')return text('market.apps.pack.memberFailed',{reason:outcome.error??''})
 if(outcome?.state==='pending')return text('market.apps.pack.memberPending')
 if(outcome?.state==='installed'||outcome?.state==='already-installed'||member?.installed)return text('market.apps.state.installed')
 return text(member?.supported===false?'market.apps.state.unsupported':'market.apps.state.not-added')
}

/** 详情先给出能力与下一步；来源、安装记录和协议按需展开。关闭只回到原目录，不触发安装。 */
export function MarketAppDetailView({row,close,runAction,busy,error,packRun,skillSecrets}:MarketAppDetailViewProps){
 const {text,locale}=useAppsText(),action=appsRowAction(row),connector=row.connectors[0],state=row.kind==='app'?connector?.state:undefined
 const stateLabel=(key:string)=>text(('market.apps.state.'+key) as MarketAppsMessageKey)
 const categories=row.categories.map(key=>getTaxonomyLabel('function',key,locale)??key)
 const tools=row.connectors.flatMap(item=>item.tools.map(tool=>({...tool,server:item.entry?.connector.serverName??item.title})))
 const primary=action.kind==='detail'||action.kind==='install-pack'?undefined:<button type="button" className={css.primary} disabled={!!busy&&busy===actionKey(action)} onClick={()=>runAction(row,action)}>{action.kind==='open-connection'&&state?.connection!=='not-connected'?text('market.apps.action.manage'):action.kind==='open-connection'?text('market.apps.action.connect'):actionLabel(text,row,action,busy)}</button>
 const toolList=(items:typeof tools)=><ul className={css.tools}>{items.map(tool=><li key={tool.server+':'+tool.name}><span>{tool.description||tool.name}</span><small>{text(tool.readOnly?'market.apps.advanced.readOnly':'market.apps.advanced.writable')}</small></li>)}</ul>
 const secretAction=(skill:AppsSkill|undefined)=>skillSecrets&&skill?.added&&skill.item?.entry.kind==='skill'&&skill.item.entry.secrets?.length?<SkillSecretsBadgeButton skill={skill.item.entry.skill.name} title={skill.title} describe={skillSecrets.describe} open={skillSecrets.open} iconOnly/>:null
 return <ContextDrawer title={text(row.pack?'market.apps.kind.pack':('market.apps.kind.'+row.kind) as MarketAppsMessageKey)} close={close} {...(css.drawer?{className:css.drawer}:{})}>
 <div className={css.detailBody}>
  <div className={css.detailHead}>
   <AppResourceIcon row={row} size={52}/>
   <div className={css.detailIdentity}><h3>{row.title}</h3>{(row.publisher||row.source)&&<p>{row.publisher??row.source?.label}</p>}</div>
   {primary}
   {row.kind==='skill'&&secretAction(row.skills[0])}
  </div>
  {row.summary&&<p className={css.summary}>{row.summary}</p>}
  {error&&<p className={css.rowError} role="alert">{text('market.apps.action.failed',{reason:error})}</p>}
  <div className={css.detailFacts}>
   {state&&<span>{stateLabel(state.connection==='unknown'?'unknown':state.connection)}</span>}
   {row.kind==='app'&&connector?.auth&&<span>{text(('market.apps.auth.'+connector.auth) as MarketAppsMessageKey)}</span>}
   {categories.map(category=><span key={category}>{category}</span>)}
  </div>
  {row.compatibility?.status==='unsupported'&&<p className={css.notice}>{text('market.apps.compat.unsupported')}{row.compatibility.conditions.map(condition=><span key={condition}>{condition}</span>)}</p>}
  {row.kind!=='app'&&!row.connectors.length&&<p className={css.note}>{text('market.apps.detail.noConnection')}</p>}
  {row.pack&&<PackInstallSection row={row} run={packRun} runAction={runAction}/>}
  {tools.length>0&&!row.pack&&<section className={css.detailSection}>
   <h3>{text('market.apps.advanced.tools')}</h3>
   {toolList(tools.slice(0,6))}
   {tools.length>6&&<details className={css.moreTools}><summary>{text('market.apps.seeAll')} · {tools.length}</summary>{toolList(tools.slice(6))}</details>}
  </section>}
  {row.kind==='bundle'&&row.connectors.length>0&&<section className={css.detailSection}><h3>{text('market.apps.detail.apps')}</h3><p>{text('market.apps.detail.bundleConnections')}</p><ul className={css.lines}>{row.connectors.map((item,index)=><li key={(item.catalogId??item.title)+':'+index}><span><strong>{item.title}</strong>{item.unresolved?<small>{text(item.unresolved==='unread'?'market.apps.bundle.unread':'market.apps.bundle.notInCatalog')}</small>:item.state&&<small>{[stateLabel(item.state.connection),...(item.auth?[text(('market.apps.auth.'+item.auth) as MarketAppsMessageKey)]:[])].join(' · ')}</small>}</span><ConnectorButton row={row} item={item} runAction={runAction}/></li>)}</ul></section>}
  {row.skills.length>0&&(row.kind==='library'||row.kind==='bundle')&&<section className={css.detailSection}><h3>{text('market.apps.detail.skills')} · {row.skills.length}</h3><ul className={css.lines}>{row.skills.map(skill=>{
   // 应用包只给整体安装，逐项只显示真实状态，不逐个打开内容页
   if(row.pack)return <li key={skill.entryId??skill.title}><span><strong>{skill.title}</strong>{skill.summary&&<small>{skill.summary}</small>}</span><div className={css.memberActions}><small>{packMemberLabel(text,row,skill.entryId,packRun)}</small>{secretAction(skill)}</div></li>
   const own=skillAction(skill),label=own.kind==='add-skill'?(busy===own.entryId?text('market.apps.action.adding'):text('market.apps.action.add')):stateLabel(skillStatus(skill))
   return <li key={skill.entryId??skill.title}><span><strong>{skill.title}</strong>{skill.summary&&<small>{skill.summary}</small>}</span><div className={css.memberActions}>{row.kind==='library'&&(own.kind==='detail'?<small>{label}</small>:<button type="button" disabled={own.kind==='add-skill'&&busy===own.entryId} onClick={()=>runAction(row,own)}>{label}</button>)}{secretAction(skill)}</div></li>
  })}</ul></section>}
  <AppShareEntry row={row}/>
  <details className={css.infoDisclosure}>
  <summary>{text('market.apps.detail.info')}</summary>
  {row.kind==='app'&&<p className={css.note}>{text('market.apps.detail.employeeScope')}</p>}
  <dl className={css.info}>
   {state&&<><dt>{text('market.apps.detail.install')}</dt><dd>{stateLabel(state.install==='unknown'?'unknown':state.install)}</dd><dt>{text('market.apps.detail.connection')}</dt><dd>{stateLabel(state.connection==='unknown'?'unknown':state.connection)}</dd></>}
   {row.source&&<><dt>{text('market.apps.info.source')}</dt><dd>{row.source.url?<a href={row.source.url} target="_blank" rel="noreferrer">{row.source.label}</a>:row.source.label}</dd></>}
   {row.publisher&&<><dt>{text('market.apps.info.publisher')}</dt><dd>{row.publisher}</dd></>}
   {categories.length>0&&<><dt>{text('market.apps.info.category')}</dt><dd>{categories.join(' · ')}</dd></>}
   {row.version&&<><dt>{text('market.apps.info.version')}</dt><dd>{row.version}</dd></>}
   {row.license&&<><dt>{text('market.apps.info.license')}</dt><dd>{row.license}</dd></>}
   {row.reviewedAt&&<><dt>{text('market.apps.info.reviewed')}</dt><dd>{row.reviewedAt}</dd></>}
   {row.compatibility&&<><dt>{text('market.apps.info.compatibility')}</dt><dd>{text(('market.apps.compat.'+row.compatibility.status) as MarketAppsMessageKey)}{row.compatibility.conditions.map(condition=><small key={condition}>{condition}</small>)}</dd></>}
  </dl>
  <details className={css.advancedInfo}>
   <summary>{text('market.apps.advanced.title')}</summary>
   <dl className={css.info}>
    {row.connectors.flatMap(item=>item.entry?[<div key={item.entry.id} className={css.infoGroup}>
     <dt>{text('market.apps.advanced.server')}</dt><dd className={css.mono}>{item.entry.connector.serverName}</dd>
     <dt>{text('market.apps.advanced.transport')}</dt><dd className={css.mono}>{item.entry.connector.recipe.transport}</dd>
     {item.tools.length>0&&<><dt>{text('market.apps.advanced.tools')}</dt><dd><ul>{item.tools.map(tool=><li key={tool.name}><span className={css.mono}>{tool.name}</span> · {text(tool.readOnly?'market.apps.advanced.readOnly':'market.apps.advanced.writable')}{tool.description?' · '+tool.description:''}</li>)}</ul></dd></>}
    </div>]:[])}
    {row.entryIds.length>0&&<><dt>{text('market.apps.advanced.entry')}</dt><dd className={css.mono}>{row.entryIds.join(', ')}</dd></>}
    {row.packageId&&<><dt>{text('market.apps.advanced.package')}</dt><dd className={css.mono}>{row.packageId}</dd></>}
   </dl>
  </details>
  </details>
 </div>
 </ContextDrawer>
}

export type AppsActionPorts={
 catalogApi:Pick<MarketCatalogApi,'add'>
 openConnection:(catalogId:string,entry:MarketCatalogConnectorEntry)=>void
 openContent:(contentId:string)=>Promise<void>|void
 openPackage?:((packageId:string)=>void)|undefined
}
/**
 * 与原目录卡片同一添加语义。连接不是内容：后端目录 add 对 connector 明确拒绝，
 * 应用无论是否已添加都直接进入原连接页，由本人在该页明确动作后才提交或建立受管连接；
 * 技能先经目录添加为内容再进入原内容页安装，失败原样上抛，不跳转。
 */
export async function performAppsAction(action:AppsRowAction,ports:AppsActionPorts):Promise<{addedContentId?:string}>{
 if(action.kind==='detail'||action.kind==='install-pack')return {}
 if(action.kind==='open-package'){ports.openPackage?.(action.packageId);return {}}
 if(action.kind==='add-connector'||action.kind==='open-connection'){ports.openConnection(action.entryId,action.entry);return {}}
 if(action.kind==='open-content'){await ports.openContent(action.contentId);return {}}
 const {contentId}=await ports.catalogApi.add(action.entryId)
 await ports.openContent(contentId)
 return {addedContentId:contentId}
}

export type MarketAppsDirectoryProps={
 catalogApi:Pick<MarketCatalogApi,'list'|'add'|'ranking'>
 connectionApi?:Pick<ManagedMcpConnectionApi,'list'>|undefined
 /** 只带 list 时只读安装记录；宿主给出完整的原生预览 / 安装 / 待核对端口时，应用包才提供一次安装。 */
 installationApi?:Pick<SkillInstallApi,'list'>|Pick<SkillInstallApi,'list'|'preview'|'install'|'pending'|'recover'>|undefined
 packages?:readonly AppsDeclaredPackage[]
 loads?:readonly IndustryLoadRecord[]
 storedContents?:readonly AppsStoredContent[]
 view?:AppsView
 onViewChange?:(view:AppsView)=>void
 openConnection:(catalogId:string,entry:MarketCatalogConnectorEntry)=>void
 openContent:(contentId:string)=>Promise<void>|void
 openPackage?:(packageId:string)=>void
}&Pick<MarketAppsDirectoryViewProps,'onDescribe'|'onImportSkill'|'onCreateSkill'|'onCreateApp'|'nativeApps'|'onManagePlugins'|'onOpenTemplates'|'skillSecrets'>

/**
 * 连接应用目录的数据装配：官方目录（连接器与技能）、安装量榜单、受管连接记录、技能安装记录。
 * 添加沿用原目录端口：应用直接进入原连接设置（`openConnection`），技能添加后进入原内容页完成安装（`openContent`）。
 * 视图状态可由宿主受控保存，从连接页或内容页返回时恢复搜索、用途和详情。
 */
export function MarketAppsDirectory(props:MarketAppsDirectoryProps){
 const {locale}=useAppsText(),{catalogApi,connectionApi,installationApi}=props
 const [items,setItems]=useState<MarketCatalogItem[]>([]),[catalog,setCatalog]=useState<AppsCatalogState>({status:'loading'}),[ranking,setRanking]=useState<MarketCatalogRanking>(new Map())
 const [connections,setConnections]=useState<AppsConnections>({status:'loading'}),[installations,setInstallations]=useState<readonly SkillInstallationRecord[]>([])
 const [installationsKnown,setInstallationsKnown]=useState(false)
 const [ownView,setOwnView]=useState<AppsView>(initialAppsView),[busy,setBusy]=useState<string>(),[errors,setErrors]=useState<Record<string,string>>({}),[reload,setReload]=useState({catalog:0,connections:0})
 const view=props.view??ownView,onViewChange=(next:AppsView)=>{if(!props.view)setOwnView(next);props.onViewChange?.(next)}
 const installer=installationApi&&'preview' in installationApi&&'install' in installationApi&&'pending' in installationApi&&'recover' in installationApi?installationApi:undefined
 const [packRuns,setPackRuns]=useState<Record<string,AppsPackRun>>({})
 // 本人与宿主端口的代次：端口对象更换或离开目录后，进行中的应用包安装不再提交后续请求、也不写回结果
 const generation=useRef(0)
 useEffect(()=>{generation.current+=1;setPackRuns({});return ()=>{generation.current+=1}},[catalogApi,installationApi])
 useEffect(()=>{
  let active=true
  setCatalog({status:'loading'})
  setInstallations([]);setInstallationsKnown(false)
  void loadCatalogListing(catalogApi).then(listing=>{if(!active)return;setItems(listing.items);setCatalog({status:'ready'})},error=>{if(active)setCatalog({status:'error',message:localizeWorkError(locale,error)})})
  void catalogApi.ranking().then(value=>{if(active)setRanking(value)},()=>{})
  void installationApi?.list().then(value=>{if(active){setInstallations(value.items);setInstallationsKnown(true)}},()=>{})
  return ()=>{active=false}
 },[catalogApi,installationApi,reload.catalog])
 useEffect(()=>{
  let active=true
  if(!connectionApi){setConnections({status:'unavailable'});return}
  setConnections({status:'loading'})
  void connectionApi.list().then(records=>{if(active)setConnections({status:'ready',records})},()=>{if(active)setConnections({status:'unavailable'})})
  return ()=>{active=false}
 },[connectionApi,reload.connections])
 const rows=useMemo(()=>appsDirectoryRows({items,connections,installations,installationsKnown,packages:props.packages??[],loads:props.loads??[],storedContents:props.storedContents??[],locale,packInstall:!!installer}),[items,connections,installations,installationsKnown,props.packages,props.loads,props.storedContents,locale,installer])
 const fail=(key:string,error:unknown)=>setErrors(current=>({...current,[key]:localizeWorkError(locale,error)}))
 const clear=(key:string)=>setErrors(current=>{const {[key]:_,...rest}=current;return rest})
 const installPack=async(action:Extract<AppsRowAction,{kind:'install-pack'}>)=>{
  const key=action.key,token=generation.current,isCurrent=()=>generation.current===token
  if(!installer||packRuns[key]?.running)return
  clear(key)
  const view=(outcome:AppPackOutcome):AppsPackRun['outcomes'][number]=>({entryId:outcome.entryId,state:outcome.state,...(outcome.nameInUse?{nameInUse:outcome.nameInUse}:{}),...(outcome.error!==undefined?{error:localizeWorkError(locale,outcome.error)}:{})})
  setPackRuns(current=>({...current,[key]:{done:0,total:action.members.length,running:true,outcomes:[],stopped:null}}))
  try{
   const result=await installAppPack(action.members,{catalog:catalogApi,skills:installer},{isCurrent,onProgress:(outcome,done,total)=>{if(isCurrent())setPackRuns(current=>({...current,[key]:{...current[key]!,done,total,outcomes:[...(current[key]?.outcomes??[]).filter(item=>item.entryId!==outcome.entryId),view(outcome)]}}))}})
   if(!isCurrent())return
   setPackRuns(current=>({...current,[key]:{done:result.outcomes.filter(item=>item.state!=='not-started').length,total:action.members.length,running:false,outcomes:result.outcomes.map(view),stopped:result.stopped}}))
   const added=new Map(result.outcomes.flatMap(item=>item.contentId?[[item.entryId,item.contentId] as const]:[]))
   setItems(current=>current.map(row=>!row.addedContentId&&added.has(row.entry.id)?{...row,addedContentId:added.get(row.entry.id)!}:row))
   // 部分完成按原生安装记录重新显示
   const listed=await installer.list()
   if(isCurrent())setInstallations(listed.items)
  }catch(error){
   if(!isCurrent())return
   setPackRuns(current=>{const {[key]:_,...rest}=current;return rest})
   fail(key,error)
  }
 }
 const runAction=async(_row:AppsRow,action:AppsRowAction)=>{
  if(action.kind==='install-pack'){await installPack(action);return}
  const key='entryId' in action?action.entryId:undefined,adding=action.kind==='add-connector'||action.kind==='add-skill'
  if(key)clear(key)
  if(adding)setBusy(key)
  try{
   const {addedContentId}=await performAppsAction(action,{catalogApi,openConnection:props.openConnection,openContent:props.openContent,openPackage:props.openPackage})
   if(key&&addedContentId)setItems(current=>current.map(row=>row.entry.id===key?{...row,addedContentId}:row))
  }catch(error){if(key)fail(key,error)}
  finally{if(adding)setBusy(undefined)}
 }
 return <MarketAppsDirectoryView rows={rows} ranking={ranking} catalog={catalog} connections={connections} view={view} onViewChange={onViewChange} runAction={(row,action)=>void runAction(row,action)} busy={busy} errors={errors} packRuns={packRuns}
  connectionServiceUnavailable={!connectionApi} retryCatalog={()=>setReload(current=>({...current,catalog:current.catalog+1}))} {...(connectionApi?{retryConnections:()=>setReload(current=>({...current,connections:current.connections+1}))}:{})} skillSecrets={props.skillSecrets}
  {...(props.onDescribe?{onDescribe:props.onDescribe}:{})} {...(props.onImportSkill?{onImportSkill:props.onImportSkill}:{})} {...(props.onCreateSkill?{onCreateSkill:props.onCreateSkill}:{})} {...(props.onCreateApp?{onCreateApp:props.onCreateApp}:{})} {...(props.nativeApps?{nativeApps:props.nativeApps}:{})} {...(props.onManagePlugins?{onManagePlugins:props.onManagePlugins}:{})} {...(props.onOpenTemplates?{onOpenTemplates:props.onOpenTemplates}:{})}/>
}
