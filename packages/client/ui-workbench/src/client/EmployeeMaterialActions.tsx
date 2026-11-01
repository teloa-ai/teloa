import {useEffect,useState} from 'react'
import {MoreHorizontal} from 'lucide-react'
import {DirectoryFilterPopover} from './DirectoryFilterPopover.js'
import {useI18n} from './i18n/provider.js'
import type {EmployeeKnowledgeGroup} from './resource-manager-presentation.js'
import css from './ResourceManager.module.css'

/** 批量操作属于右侧资料工具栏；文件树只承担浏览和选择。 */
export function EmployeeMaterialActions({groups,roleId,busy,onAdopt,onEnroll}:{groups:readonly EmployeeKnowledgeGroup[];roleId?:string|undefined;busy:boolean;onAdopt?:((group:EmployeeKnowledgeGroup)=>void)|undefined;onEnroll?:((group:EmployeeKnowledgeGroup)=>void)|undefined}){
 const {t}=useI18n(),[selected,setSelected]=useState(roleId??'')
 useEffect(()=>{if(roleId)setSelected(roleId)},[roleId])
 const available=groups.filter(group=>group.resources.length>0),group=available.find(group=>group.roleId===selected)??available[0]
 if(!group||!onAdopt&&!onEnroll)return null
 const active=group.resources.filter(row=>row.status==='active').length
 return <DirectoryFilterPopover label={t('library.employeeActions')} icon={<MoreHorizontal size={18} aria-hidden/>} showLabel closeOnSelect>
  <div className={css.batchPanel}>
   <label>{t('library.employeeActionScope')}<select aria-label={t('library.employeeActionScope')} disabled={busy} value={group.roleId} onChange={event=>setSelected(event.target.value)}>{available.map(row=><option key={row.roleId} value={row.roleId}>{row.roleName}</option>)}</select></label>
   <p>{t('library.count',{count:group.resources.length})}</p>
   {onAdopt&&<button type="button" aria-label={t('roleDelegation.adoptEmployeeBusiness',{count:active})} disabled={busy||!active} onClick={()=>onAdopt(group)}>{t('roleDelegation.adoptOtherBusiness')}</button>}
   {onEnroll&&<button type="button" disabled={busy} onClick={()=>onEnroll(group)}>{t('retrieval.employee.enrollAll',{count:group.resources.length})}</button>}
  </div>
 </DirectoryFilterPopover>
}
