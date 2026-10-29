import {useState,type ComponentProps} from 'react'
import {Pencil} from 'lucide-react'
import {KnowledgeDocument} from './KnowledgeDocument.js'
import {EmployeeKnowledgeDocument} from './EmployeeKnowledgeDocument.js'
import {useI18n} from './i18n/provider.js'
import css from './KnowledgeDocument.module.css'

/** 全局资料预览只允许明确选定一位已绑定员工后进入独立副本编辑。 */
export function ResourceKnowledgeDocument({employees,contextRoleId,beforeLeave,...props}:ComponentProps<typeof KnowledgeDocument>&{employees:readonly {id:string;name:string}[];contextRoleId?:string|undefined;beforeLeave:(action:()=>void)=>void}){
 const {t}=useI18n(),[roleId,setRoleId]=useState(contextRoleId??(employees.length===1?employees[0]!.id:'')),[editing,setEditing]=useState(!!contextRoleId)
 const role=employees.find(row=>row.id===roleId),employeeApi=props.api.employeeKnowledge
 if(editing&&role&&employeeApi)return <EmployeeKnowledgeDocument key={role.id+':'+props.resource.id} api={employeeApi} role={role} resource={props.resource} initialMode={contextRoleId?'preview':'write'} onDirtyChange={props.onDirtyChange} onClose={()=>beforeLeave(()=>setEditing(false))}/>
 return <>
  {employeeApi&&props.resource.status==='active'&&<div className={css.employeeEntry}>{employees.length>0?<><label>{t('employeeKnowledge.target')}{employees.length>1&&!contextRoleId?<select aria-label={t('employeeKnowledge.choose')} value={roleId} onChange={event=>setRoleId(event.target.value)}><option value="">{t('employeeKnowledge.choose')}</option>{employees.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select>:<strong>{role?.name??employees[0]!.name}</strong>}</label><button type="button" disabled={!role} onClick={()=>beforeLeave(()=>setEditing(true))}><Pencil size={15}/>{t('employeeKnowledge.edit')}</button></>:<p>{t('employeeKnowledge.none')}</p>}</div>}
  <KnowledgeDocument {...props}/>
 </>
}
