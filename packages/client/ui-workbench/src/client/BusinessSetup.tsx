import {useEffect,useMemo,useSyncExternalStore} from 'react'
import {BusinessSetupController,type BusinessSetupApi,type BusinessSetupAction} from './business-setup.js'
import {useI18n} from './i18n/provider.js'
import css from './BusinessSetup.module.css'

export type BusinessSetupServices={api:BusinessSetupApi;open:(scope:string,title:string,target:BusinessSetupAction)=>void}
type Props={scope:string;title:string;configurationVersion:number;configurationHash:string;services:BusinessSetupServices;refreshKey?:number}
/** 正式业务的只读准备投影；配置动作仍进入已有页面，不触发业务执行。 */
export function BusinessSetup({scope,title,configurationVersion,configurationHash,services,refreshKey=0}:Props){
 const {t}=useI18n()
 const controller=useMemo(()=>new BusinessSetupController(services.api,{scope,expectedVersion:configurationVersion,expectedHash:configurationHash}),[services.api,scope,configurationVersion,configurationHash])
 const store=useMemo(()=>({subscribe:(listener:()=>void)=>controller.subscribe(listener),getSnapshot:()=>controller.getSnapshot()}),[controller])
 const state=useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot)
 useEffect(()=>()=>controller.dispose(),[controller])
 useEffect(()=>{void controller.load()},[controller,refreshKey])
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
 return <section className={css.card} aria-label={t('business.setup.title')} aria-busy={state.status==='loading'}>
  <h2>{t('business.setup.title')}</h2>
  {state.status==='loading'&&<p role="status">{t('business.setup.loading')}</p>}
  {state.status==='failed'&&<p role="alert">{t('business.setup.failed')} <button type="button" onClick={()=>void controller.load()}>{t('business.records.retry')}</button></p>}
  {value&&<>
   <dl className={css.overview}>
    <div><dt>{t('business.setup.colleagues')}</dt><dd>{!colleagues?unavailable:colleagues.responsibility.roleId?<><span>{colleagues.selectedRole?.name??t('business.responsibility.unavailable')}</span>{colleagues.responsibility.availability!=='ready'&&colleagues.responsibility.availability!=='none'&&<span className={css.note}>{t(`business.responsibility.${colleagues.responsibility.availability}`)}</span>}</>:t('business.setup.optional')}</dd></div>
    <div><dt>{t('business.setup.skills')}</dt><dd>{skills?t('business.setup.skillsSummary',{count:skills.declared.length}):unavailable}</dd></div>
    <div><dt>{t('business.setup.knowledge')}</dt><dd>{knowledge?t('business.setup.knowledgeSummary',{count:knowledge.assigned.length}):unavailable}</dd></div>
    <div><dt>{t('business.setup.connections')}</dt><dd>{connections?t('business.setup.connectionsSummary',{count:connections.items.filter(item=>item.status==='connected').length}):unavailable}</dd></div>
   </dl>
   <section className={css.sourceGuide} aria-label={t('business.setup.sourceGuide.title')}>
    <h3>{t('business.setup.sourceGuide.title')}</h3>
    <p>{t(`business.setup.sourceGuide.${sourceStatus}`)}</p>
    <p className={css.note}>{t('business.setup.sourceGuide.steps')}</p>
    <button type="button" onClick={()=>open({kind:'connections'})}>{t('business.setup.connectionDirectory')}</button>
   </section>
   <details className={css.details}>
    <summary>{t('business.setup.details')}</summary>
    <div className={css.grid}>
     <section aria-label={t('business.setup.colleagues')}>
      <h3>{t('business.setup.colleagues')}</h3><p className={css.note}>{t('business.setup.optionalNote')}</p>
      {colleagues?.selectedRole&&<p>{colleagues.selectedRole.duty}</p>}
      <div className={css.actions}><button type="button" onClick={()=>open(roleTarget)}>{t('business.setup.configureDuties')}</button><button type="button" onClick={()=>open({kind:'colleagues'})}>{t('business.setup.colleagueDirectory')}</button></div>
     </section>
     <section aria-label={t('business.setup.skills')}>
      <h3>{t('business.setup.skills')}</h3><p className={css.note}>{t('business.setup.executionCheck')}</p>
      {skills&&<>{skills.declared.length===0?<p>{t('business.setup.noSkills')}</p>:<ul>{skills.declared.slice(0,5).map((item,index)=><li key={item.name+'/'+index}><span>{item.name}</span><span className={css.note}>{t(`business.setup.skill.${item.status}`)}</span></li>)}</ul>}{more(skills.declared.length)}</>}
      <div className={css.actions}><button type="button" onClick={()=>open(roleTarget)}>{t('business.setup.configureSkills')}</button><button type="button" onClick={()=>open({kind:'skills'})}>{t('business.setup.installSkills')}</button></div>
     </section>
     <section aria-label={t('business.setup.knowledge')}>
      <h3>{t('business.setup.knowledge')}</h3>
      {knowledge&&<>{knowledge.assigned.length===0?<p>{t('business.setup.noKnowledge')}</p>:<ul>{knowledge.assigned.slice(0,5).map((item,index)=><li key={item.id}><span>{item.title??t('business.setup.unnamedResource',{index:index+1})}</span><span className={css.note}>{t(`business.setup.knowledge.${item.state}`)}</span></li>)}</ul>}{more(knowledge.assigned.length)}<p className={css.note}>{t('business.setup.resourceCounts',{business:knowledge.businessResourceCount,general:knowledge.generalResourceCount})}</p></>}
      <p className={css.note}>{t('business.setup.generalGuide')}</p>
      <div className={css.actions}><button type="button" onClick={()=>open(roleTarget)}>{t('business.setup.configureKnowledge')}</button><button type="button" onClick={()=>open({kind:'resources'})}>{t('business.setup.manageResources')}</button></div>
     </section>
     <section aria-label={t('business.setup.connections')}>
      <h3>{t('business.setup.connections')}</h3>
      {connections&&<>{connections.items.length===0?<p>{t('business.setup.noConnections')}</p>:<ul>{connections.items.slice(0,5).map(item=><li key={item.id}><span>{item.serverName}</span><span className={css.note}>{t(`business.setup.connection.${item.status}`)}</span><button type="button" onClick={()=>open({kind:'connection',catalogId:item.catalogId})}>{t('business.setup.configureConnection',{name:item.serverName})}</button></li>)}</ul>}{more(connections.items.length)}</>}
     </section>
    </div>
   </details>
   {(value.colleagues.status==='unavailable'||value.skills.status==='unavailable'||value.knowledge.status==='unavailable'||value.connections.status==='unavailable')&&<button type="button" className={css.retry} onClick={()=>void controller.load()}>{t('business.records.retry')}</button>}
  </>}
 </section>
}
