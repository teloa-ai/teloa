import {useEffect,useState} from 'react'
import type {GroupApi} from './group-api.js'
import {readRoleGroups} from './role-group-membership.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './TaskPage.module.css'

export function RoleGroupMembership({api,roleId,open}:{api:GroupApi;roleId:string;open:(id:string)=>void}){
 const {locale,t}=useI18n(),[revision,retry]=useState(0)
 const [state,setState]=useState<{items?:{id:string;name:string}[];error?:string}>({})
 useEffect(()=>{let active=true;setState({});void readRoleGroups(api,roleId).then(items=>{if(active)setState({items})},error=>{if(active)setState({error:localizeWorkError(locale,error)})});return()=>{active=false}},[api,roleId,revision,locale])
 return <section className={css.block} aria-busy={!state.items&&!state.error}>
  <header><h3>{state.items?t('team.work.groups',{count:state.items.length}):t('team.work.groupsDesc')}</h3></header>
  {state.error?<p role="alert">{state.error} <button type="button" onClick={()=>retry(value=>value+1)}>{t('common.retry')}</button></p>:state.items?.map(group=><button type="button" key={group.id} onClick={()=>open(group.id)}>{group.name}</button>)}
  {state.items?.length===0&&<p className={css.muted}>{t('team.work.noGroups')}</p>}
 </section>
}
