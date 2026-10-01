import {useId} from 'react'
import type {ModelReference,RoleRuntimeConfig} from '@teloa/contract'
import {useI18n} from './i18n/provider.js'
import {findRoleModel,modelOption,modelOptionValue,roleModelIssue,roleModelLabel,type RoleModelField,type RoleModelLoadState} from './role-models.js'
import css from './RoleModelFields.module.css'

export function RoleModelFields({runtime,state,change,retry}:{runtime:RoleRuntimeConfig|undefined;state:RoleModelLoadState;change:(field:RoleModelField,model:ModelReference|undefined)=>void;retry:()=>void}){
 const {t}=useI18n(),id=useId(),directory=state.directory
 return <div className={css.fields}>
  <p className={css.hint}>{t('roleModels.scope')}</p>
  {(state.status==='loading'||state.status==='idle')&&<p role="status">{t('roleModels.loading')}</p>}
  {state.status==='error'&&<div role="alert" className={css.notice}>{t('roleModels.failed')} <button type="button" onClick={retry}>{t('roleModels.retry')}</button></div>}
  {!!directory?.failures.length&&<p role="status" className={css.notice}>{t('roleModels.partial',{providers:directory.failures.map(row=>row.name).join(', ')})}</p>}
  <div className={css.grid}>{(['model','fallbackModel'] as const).map(field=>{
   const reference=runtime?.[field],found=modelOption(directory,reference),issue=roleModelIssue(field,runtime,directory)
   const groups=directory?.groups.filter(group=>field==='model'||group.remote)??[]
   const missing=reference&&!groups.some(group=>group.id===reference.provider&&group.models.some(model=>model.id===reference.model))
   const selectId=`${id}-${field}`,errorId=`${selectId}-error`,efforts=found?.model.reasoning?.efforts??[]
   return <div key={field} className={css.column}>
    <label htmlFor={selectId}>{t(field==='model'?'roleModels.primary':'roleModels.fallback')}</label>
    <select id={selectId} disabled={!directory} value={reference?modelOptionValue(reference):''} aria-invalid={!!issue} aria-describedby={issue?errorId:undefined} onChange={event=>{const value=event.target.value;if(!value)change(field,undefined);else if(directory){const selected=findRoleModel(directory,value);if(selected)change(field,selected)}}}>
     <option value="">{t(field==='model'?'roleModels.inherit':'roleModels.noFallback')}</option>
     {missing&&<option value={modelOptionValue(reference)} disabled>{roleModelLabel(reference)} · {t('roleModels.unavailable')}</option>}
     {groups.map(group=><optgroup key={group.id} label={group.name}>{group.models.map(model=><option key={model.id} value={modelOptionValue({provider:group.id,model:model.id})}>{model.name}</option>)}</optgroup>)}
    </select>
    {(efforts.length>0||reference?.reasoningEffort)&&<><label htmlFor={`${selectId}-effort`}>{t('roleModels.effort')}</label><select id={`${selectId}-effort`} disabled={!directory||!found} value={reference?.reasoningEffort??''} aria-invalid={issue==='effort'} aria-describedby={issue==='effort'?errorId:undefined} onChange={event=>{if(!reference)return;change(field,{provider:reference.provider,model:reference.model,...(event.target.value?{reasoningEffort:event.target.value}:{})})}}><option value="">{t('roleModels.defaultEffort')}</option>{reference?.reasoningEffort&&!efforts.some(row=>row.id===reference.reasoningEffort)&&<option disabled value={reference.reasoningEffort}>{reference.reasoningEffort} · {t('roleModels.unavailable')}</option>}{efforts.map(effort=><option key={effort.id} value={effort.id}>{effort.name}</option>)}</select></>}
    {issue&&<p id={errorId} role="alert" className={css.notice}>{t(`roleModels.issue.${issue}`)}</p>}
   </div>
  })}</div>
  <p className={css.hint}>{t('roleModels.fallbackHint')}</p>
 </div>
}
