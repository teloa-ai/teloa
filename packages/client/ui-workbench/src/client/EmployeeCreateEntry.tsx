import {useState} from 'react'
import type {PageCreateApi} from './page-create-api.js'
import type {RoleFields} from './role-preview.js'
import type {WorkbenchNavigationStorage} from './workbench-navigation-state.js'
import {ContextDrawer} from './ContextDrawer.js'
import {CreateEntry} from './CreateEntry.js'
import {createRoleFormInitial} from './page-create-presentation.js'
import {useI18n} from './i18n/provider.js'
import {useApplicationCapability} from './CapabilityNotice.js'
import css from './MarketTemplateCreator.module.css'

type Prompt={sourceId:string;title:string;text:string}

/** 新建员工沿用页内草案协议；说明进会话，真实写入仍由本人核对后确认。 */
export function EmployeeCreateEntry({api,scope,scopeName,storage,prepare,create,created,close}:{
 api:PageCreateApi;scope:string;scopeName:string;storage?:WorkbenchNavigationStorage|undefined
 prepare:(prompt:Prompt,scope?:string)=>void|Promise<void>
 create:(fields:RoleFields)=>Promise<string>
 created:(id:string)=>void;close:()=>void
}){
 const {t}=useI18n(),allowed=useApplicationCapability('people'),[busy,setBusy]=useState(false)
 return <ContextDrawer title={t('team.form.newRole')} close={close} canClose={!busy}>
  <div className={css.body}><CreateEntry entity="role" embedded directSentence api={api} onBusyChange={setBusy}
   descriptionPlaceholderKey="create.sentence.placeholder.employee"
   {...(storage?{sentenceDraft:{key:'teloa.employee-creation-input/v1/'+scope,storage}}:{})}
   prepare={prompt=>prepare({...prompt,sourceId:'role:'+scope,text:prompt.text+'\n\n'+t('create.employee.prompt.scope',{scope,name:scopeName})},scope)}
   onPrepared={close}
   onConfirm={async preview=>{
    if(!allowed)throw Object.assign(Error(),{code:'teloa/forbidden'})
    return create(createRoleFormInitial(preview))
   }}
   afterConfirm={id=>{close();created(id)}}/></div>
 </ContextDrawer>
}
