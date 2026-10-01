// 技能密钥页：密码框 write-only，不预填、提交后清空；只显示「已保存 / 未填写」，并如实显示每个密钥将发往何处。
import {useEffect,useState,type FormEvent} from 'react'
import css from './McpConnectionView.module.css'
import {useI18n} from './i18n/provider.js'
import {formatList} from './i18n/format.js'
import type {SkillSecretVar,SkillSecretsApi,SkillSecretsState} from './skill-secrets-api.js'

type T=(key:string,params?:Record<string,string|number>)=>string
export type SkillSecretsPresentationProps={title:string;state:SkillSecretsState|null;busy:boolean;error:string;locale:string;t:T;confirmingDelete:boolean;onBack:()=>void;onSave:(values:Record<string,string>)=>void;onAskDelete:()=>void;onCancelDelete:()=>void;onDelete:()=>void}

/** 目标地址：origin + 路径前缀逐条列出；注入位置按 target 说明（目录公开的声明信息，不含值）。 */
function destination(v:SkillSecretVar,t:T):string{
 const targets=v.endpoints.flatMap(endpoint=>endpoint.pathPrefixes.map(prefix=>endpoint.origin+prefix)).join('、')
 const place=v.target==='bearer'?t('market.skillSecrets.placeBearer'):t(v.target==='header'?'market.skillSecrets.placeHeader':'market.skillSecrets.placeQuery',{name:v.name??''})
 return t('market.skillSecrets.destination',{targets,place})
}

export function SkillSecretsViewPresentation({title,state,busy,error,locale,t,confirmingDelete,onBack,onSave,onAskDelete,onCancelDelete,onDelete}:SkillSecretsPresentationProps){
 const submit=(event:FormEvent<HTMLFormElement>)=>{
  event.preventDefault()
  const form=event.currentTarget,values:Record<string,string>={}
  for(const [name,value] of new FormData(form).entries())if(typeof value==='string'&&value)values[name]=value
  form.reset()
  if(Object.keys(values).length)onSave(values)
 }
 const body=()=>{
  if(!state)return error?null:<p className={css.loading}>{t('market.catalog.connector.loading')}</p>
  // 当前生效的不是声明密钥的市场安装：不给可填写表单。
  if(!state.vars.length)return <p className={css.reason} role="status">{t('market.skillSecrets.needsInstall')}</p>
  // 存储锁定或只读时宿主读不到记录：不显示「已保存 / 未填写」，只给到设置页处理的引导。
  const known=state.writable
  // 共享密钥组：保存与删除作用于整组，如实列出同组技能。
  const members=state.group?formatList(locale,state.group.members):''
  return <form onSubmit={submit}>
   {state.group&&<p className={css.reason} role="note">{t('market.skillSecrets.sharedGroup',{skills:members})}</p>}
   <fieldset className={css.fieldset} disabled={busy||!state.writable}>
    <legend className={css.legend}>{t('market.skillSecrets.title')}</legend>
    {state.vars.map(v=><label key={v.envVarName} className={css.label}>
     <span>{locale.startsWith('zh')?v.label['zh-CN']:v.label.en}（{v.required?t('market.skillSecrets.required'):t('market.skillSecrets.optional')}{known?` · ${v.configured?t('market.skillSecrets.saved'):t('market.skillSecrets.missing')}`:''}）</span>
     <span>{destination(v,t)}</span>
     <input className={css.input} type="password" name={v.envVarName} autoComplete="new-password"/>
    </label>)}
   </fieldset>
   {state.reconfirm&&<p className={css.reason} role="status">{t('market.skillSecrets.reconfirmShort')}：{t('market.skillSecrets.reconfirm')} {t('market.skillSecrets.reconfirmClears')}</p>}
   {!state.writable&&<p className={css.reason} role="status">{t('market.skillSecrets.readOnly')} {t('market.skillSecrets.locked')}</p>}
   <div className={css.actions}>
    <button type="submit" className={`${css.btn} ${css.btnPrimary}`} disabled={busy||!state.writable}>{busy?t('market.skillSecrets.saving'):t('market.skillSecrets.save')}</button>
    {state.writable&&state.vars.some(v=>v.configured)&&!confirmingDelete&&<button type="button" className={`${css.btn} ${css.btnDestructive}`} disabled={busy} onClick={onAskDelete}>{t('market.skillSecrets.delete')}</button>}
   </div>
   {confirmingDelete&&state.writable&&<div className={css.confirmBox} role="alertdialog" aria-label={t('market.skillSecrets.delete')}>
    <p className={css.confirmText}>{state.group?t('market.skillSecrets.deleteConfirmShared',{skills:members}):t('market.skillSecrets.deleteConfirm')}</p>
    <div className={css.actions}>
     <button type="button" className={`${css.btn} ${css.btnDestructive}`} disabled={busy} onClick={onDelete}>{t('market.skillSecrets.deleteConfirmYes')}</button>
     <button type="button" className={css.btn} disabled={busy} onClick={onCancelDelete}>{t('market.skillSecrets.cancel')}</button>
    </div>
   </div>}
  </form>
 }
 return <div className={css.view}>
  <button type="button" className={css.back} onClick={onBack}>{t('market.skillSecrets.back')}</button>
  <h2 className={css.title}>{title}</h2>
  <p className={css.reason}>{t('market.skillSecrets.hint')}</p>
  {body()}
  {error&&<p className={css.error} role="alert">{error}</p>}
 </div>
}
export function SkillSecretsView({skill,title,api,onBack}:{skill:string;title:string;api:SkillSecretsApi;onBack:()=>void}){
 const {t,locale}=useI18n()
 const [state,setState]=useState<SkillSecretsState|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[confirmingDelete,setConfirmingDelete]=useState(false)
 useEffect(()=>{let live=true;api.describe(skill).then(next=>{if(live)setState(next)},()=>{if(live)setError(t('market.skillSecrets.failed'))});return ()=>{live=false}},[api,skill])
 const act=async(task:()=>Promise<SkillSecretsState>)=>{
  setBusy(true);setError('')
  try{setState(await task())}catch(cause){
   if(cause&&typeof cause==='object'&&'code' in cause&&cause.code==='teloa/version-conflict'){
    // 移除旧表单（也丢弃输入）；只刷新公开声明，绝不拿旧值自动重试保存。
    setState(null)
    try{setState(await api.describe(skill));setError(`${t('market.skillSecrets.reconfirmShort')}：${t('market.skillSecrets.reconfirm')}`)}catch{setError(t('market.skillSecrets.failed'))}
   }else setError(cause instanceof Error&&cause.message?cause.message:t('market.skillSecrets.failed'))
  }finally{setBusy(false);setConfirmingDelete(false)}
 }
 return <SkillSecretsViewPresentation key={state?.binding??'unavailable'} title={title} state={state} busy={busy} error={error} locale={locale} t={t as T} confirmingDelete={confirmingDelete} onBack={onBack} onSave={values=>{const binding=state?.binding;if(binding)void act(()=>api.save(skill,values,binding))}} onAskDelete={()=>setConfirmingDelete(true)} onCancelDelete={()=>setConfirmingDelete(false)} onDelete={()=>void act(()=>api.remove(skill))}/>
}
