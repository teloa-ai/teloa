import {useEffect,useRef,useState} from 'react'
import {X} from 'lucide-react'
import {openDialog} from './dialog-focus.js'
import type {BusinessSpaceRecord,BusinessSpaceChange} from './business-directory.js'
import {BusinessSpaceRenameAlert,submitBusinessSpaceRename} from './business-space-rename.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './BusinessSpaceForm.module.css'
/**
 * 业务空间改名表单：只负责改名与说明，新建空间属于专业版 / 企业版。
 * 提交失败（本地校验或宿主版本冲突）时表单留在原地并播报错误，关闭由 `save` 成功后自行决定。
 *
 * 第二期把个人版业务页页头的「管理」菜单摘掉之后，个人版界面上没有它的入口
 * （「只有一个的东西不命名」）；组件、`changeBusinessDirectory`、`businessSpaceApi.rename`
 * 与 `EditionGate feature="business-space-create"` 一并留着不删，等企业版多空间开门时接回来
 * （第二期复审裁定③）。
 */
export function BusinessSpaceForm({initial,save,close}:{initial:BusinessSpaceRecord;save:(change:BusinessSpaceChange)=>Promise<void>|void;close:()=>void}){
 const {locale,t}=useI18n()
 const dialog=useRef<HTMLDialogElement>(null),input=useRef<HTMLInputElement>(null)
 const [name,setName]=useState(initial.name),[description,setDescription]=useState(initial.description),[error,setError]=useState(''),[busy,setBusy]=useState(false)
 useEffect(()=>openDialog(dialog.current,input.current),[])
 const submit=async()=>{
  if(busy)return
  setBusy(true)
  setError(await submitBusinessSpaceRename(save,{expectedVersion:initial.version,name,description},error=>localizeWorkError(locale,error)))
  setBusy(false)
 }
 return <dialog ref={dialog} className={css.dialog} aria-label={t('business.space.edit')} onCancel={close}><form onSubmit={event=>{event.preventDefault();void submit()}}><header><h2>{t('business.space.edit')}</h2><button type="button" aria-label={t('business.space.close')} onClick={close}><X size={18}/></button></header><p>{t('business.space.description')}</p><label>{t('business.space.name')}<input ref={input} value={name} maxLength={80} required onChange={event=>setName(event.target.value)}/></label><label>{t('business.space.notes')}<textarea value={description} maxLength={2000} rows={3} onChange={event=>setDescription(event.target.value)}/></label><BusinessSpaceRenameAlert message={error}/><footer><button type="button" onClick={close}>{t('business.form.cancel')}</button><button type="submit" disabled={busy||!name.trim()}>{t('business.space.save')}</button></footer></form></dialog>
}
