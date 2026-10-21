import {useEffect,useMemo,useSyncExternalStore} from 'react'
import {User,Wrench,FileText,Plug,ChevronDown,Settings2,ArrowUpRight,RotateCw,type LucideIcon} from 'lucide-react'
import {BusinessSetupController,type BusinessSetupApi,type BusinessSetupAction} from './business-setup.js'
import {useI18n} from './i18n/provider.js'
import css from './BusinessSetup.module.css'

export type BusinessSetupServices={api:BusinessSetupApi;open:(scope:string,title:string,target:BusinessSetupAction)=>void}
type Props={scope:string;title:string;configurationVersion:number;configurationHash:string;services:BusinessSetupServices;refreshKey?:number;visible?:boolean;sections?:readonly ('colleagues'|'skills'|'knowledge'|'connections')[]}
/** 正式业务的只读准备投影；配置动作仍进入已有页面，不触发业务执行。 */
export function BusinessSetup({scope,title,configurationVersion,configurationHash,services,refreshKey=0,visible=true,sections=['colleagues','skills','knowledge','connections']}:Props){
 const {t}=useI18n()
 const controller=useMemo(()=>new BusinessSetupController(services.api,{scope,expectedVersion:configurationVersion,expectedHash:configurationHash}),[services.api,scope,configurationVersion,configurationHash])
 const store=useMemo(()=>({subscribe:(listener:()=>void)=>controller.subscribe(listener),getSnapshot:()=>controller.getSnapshot()}),[controller])
 const state=useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot)
 useEffect(()=>()=>controller.dispose(),[controller])
 useEffect(()=>{if(visible)void controller.load()},[controller,refreshKey,visible])
 const value=state.status==='ready'?state.value:null
 const colleagues=value?.colleagues.status==='observed'?value.colleagues.value:null
 const skills=value?.skills.status==='observed'?value.skills.value:null
 const knowledge=value?.knowledge.status==='observed'?value.knowledge.value:null
 const connections=value?.connections.status==='observed'?value.connections.value:null
 const roleTarget:BusinessSetupAction=colleagues?.selectedRole?{kind:'role',id:colleagues.selectedRole.id}:{kind:'colleagues'}
 const open=(target:BusinessSetupAction)=>services.open(scope,title,target)
 const unavailable=t('business.setup.unavailable')
 const more=(count:number)=>count>5?<p className={css.note}>{t('business.setup.more',{count:count-5})}</p>:null
 const sourceStatus=!connections?'unknown':connections.items.length===0?'none':connections.items.some(item=>item.status==='connected')?'connected':'disconnected'
 const action=(label:string,target:BusinessSetupAction,Icon:LucideIcon=Settings2)=><button type="button" className={css.iconAction} aria-label={label} title={label} onClick={()=>open(target)}><Icon size={16} aria-hidden="true"/></button>
 const colleagueSummary=!colleagues?unavailable:colleagues.responsibility.roleId?<><span>{colleagues.selectedRole?.name??t('business.responsibility.unavailable')}</span>{colleagues.responsibility.availability!=='ready'&&colleagues.responsibility.availability!=='none'&&<span className={css.note}>{t(`business.responsibility.${colleagues.responsibility.availability}`)}</span>}</>:t('business.setup.optional')
 return <section className={css.card} aria-label={t('business.setup.title')} aria-busy={state.status==='loading'}>
  <h2>{t('business.setup.title')}</h2>
  {state.status==='loading'&&<p role="status">{t('business.setup.loading')}</p>}
  {state.status==='failed'&&<p role="alert">{t('business.setup.failed')} <button type="button" aria-label={t('business.records.retry')} title={t('business.records.retry')} onClick={()=>void controller.load()}><RotateCw size={16}/></button></p>}
  {value&&<div className={css.rows}>
   {sections.includes('colleagues')&&<details className={css.row}>
    <summary><User size={17}/><strong>{t('business.setup.colleagues')}</strong><span className={css.metric}>{colleagueSummary}</span><ChevronDown size={15}/></summary>
    <div className={css.rowContent}>
     {colleagues?.selectedRole&&<p>{colleagues.selectedRole.duty}</p>}
     {!colleagues?.responsibility.roleId&&<p className={css.note}>{t('business.setup.optionalNote')}</p>}
     <div className={css.actions}>{action(t('business.setup.configureDuties'),roleTarget)}{action(t('business.setup.colleagueDirectory'),{kind:'colleagues'},ArrowUpRight)}</div>
    </div>
   </details>}
   {sections.includes('skills')&&<details className={css.row}>
    <summary><Wrench size={17}/><strong>{t('business.setup.skills')}</strong><span className={css.metric}>{skills?t('business.setup.skillsSummary',{count:skills.declared.length}):unavailable}</span><ChevronDown size={15}/></summary>
    <div className={css.rowContent}>
     {skills&&<>{skills.declared.length===0?<p>{t('business.setup.noSkills')}</p>:<ul>{skills.declared.slice(0,5).map((item,index)=><li key={item.name+'/'+index}><span>{item.name}</span><span className={css.note}>{t(`business.setup.skill.${item.status}`)}</span></li>)}</ul>}{more(skills.declared.length)}</>}
     <p className={css.note}>{t('business.setup.executionCheck')}</p>
     <div className={css.actions}>{action(t('business.setup.configureSkills'),roleTarget)}{action(t('business.setup.installSkills'),{kind:'skills'},ArrowUpRight)}</div>
    </div>
   </details>}
   {sections.includes('knowledge')&&<details className={css.row}>
    <summary><FileText size={17}/><strong>{t('business.setup.knowledge')}</strong><span className={css.metric}>{knowledge?t('business.setup.knowledgeSummary',{count:knowledge.assigned.length}):unavailable}</span><ChevronDown size={15}/></summary>
    <div className={css.rowContent}>
     {knowledge&&<>{knowledge.assigned.length===0?<p>{t('business.setup.noKnowledge')}</p>:<ul>{knowledge.assigned.slice(0,5).map((item,index)=><li key={item.id}><span>{item.title??t('business.setup.unnamedResource',{index:index+1})}</span><span className={css.note}>{t(`business.setup.knowledge.${item.state}`)}</span></li>)}</ul>}{more(knowledge.assigned.length)}<p className={css.note}>{t('business.setup.resourceCounts',{business:knowledge.businessResourceCount,general:knowledge.generalResourceCount})}</p></>}
     <div className={css.actions}>{action(t('business.setup.configureKnowledge'),roleTarget)}{action(t('business.setup.manageResources'),{kind:'resources'},ArrowUpRight)}</div>
    </div>
   </details>}
   {sections.includes('connections')&&<details className={css.row}>
    <summary><Plug size={17}/><strong>{t('business.setup.connections')}</strong><span className={css.metric}>{connections?t('business.setup.connectionsSummary',{count:connections.items.filter(item=>item.status==='connected').length}):unavailable}</span><ChevronDown size={15}/></summary>
    <div className={css.rowContent}>
     {connections&&<>{connections.items.length===0?<p>{t('business.setup.noConnections')}</p>:<ul>{connections.items.slice(0,5).map(item=><li key={item.id}><span>{item.serverName}</span><span className={css.note}>{t(`business.setup.connection.${item.status}`)}</span>{action(t('business.setup.configureConnection',{name:item.serverName}),{kind:'connection',catalogId:item.catalogId})}</li>)}</ul>}{more(connections.items.length)}</>}
     <section className={css.sourceGuide} aria-label={t('business.setup.sourceGuide.title')}>
      <p>{t(`business.setup.sourceGuide.${sourceStatus}`)}</p><p className={css.note}>{t('business.setup.sourceGuide.steps')}</p>
      <div className={css.actions}>{action(t('business.setup.connectionDirectory'),{kind:'connections'},ArrowUpRight)}</div>
     </section>
    </div>
   </details>}
  </div>}
  {value&&(value.colleagues.status==='unavailable'||value.skills.status==='unavailable'||value.knowledge.status==='unavailable'||value.connections.status==='unavailable')&&<button type="button" className={css.retry} aria-label={t('business.records.retry')} title={t('business.records.retry')} onClick={()=>void controller.load()}><RotateCw size={16}/></button>}
 </section>
}
