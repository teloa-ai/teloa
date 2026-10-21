import {useState} from 'react'
import type {McpConnectionSetup} from '@teloa/contract'
import {useI18n} from './i18n/provider.js'
import css from './TemplateShareDrawer.module.css'

/** 只显示声明；不把模板地址变成可点击链接，也不发起连接。 */
export function ConnectionTemplateSetup({setup}:{setup:McpConnectionSetup}){
 const {t}=useI18n()
 return <>{setup.urlTemplate&&<small>{t('templateShare.addressTemplate')} <code>{setup.urlTemplate}</code></small>}{setup.configurationKeys.length>0&&<small>{t('templateShare.configurationNames')} {setup.configurationKeys.join(', ')}</small>}</>
}

/** 作者明确填写可复用结构，不读取或自动填入运行 URL、配置值或凭据。 */
export function ConnectionTemplateSetupEditor({title,setup,disabled,apply}:{title:string;setup?:McpConnectionSetup|undefined;disabled:boolean;apply:(value:unknown)=>void}){
 const {t}=useI18n(),[url,setUrl]=useState(setup?.urlTemplate??''),[names,setNames]=useState(setup?.configurationKeys.join('\n')??''),[invalid,setInvalid]=useState(false),[saved,setSaved]=useState(false)
 return <form onSubmit={event=>{event.preventDefault();setInvalid(false);setSaved(false);try{apply({...url.trim()?{urlTemplate:url.trim()}:{},configurationKeys:names.split(/[\n,]/).map(name=>name.trim()).filter(Boolean)});setSaved(true)}catch{setInvalid(true)}}}>
  <strong>{title}</strong>
  <label>{t('templateShare.addressTemplate')}<input type="text" value={url} disabled={disabled} maxLength={2048} placeholder="https://service.example/{tenant}/mcp?key={API_KEY}" onChange={event=>{setUrl(event.target.value);setSaved(false)}}/></label>
  <label>{t('templateShare.configurationNames')}<textarea value={names} disabled={disabled} maxLength={2600} onChange={event=>{setNames(event.target.value);setSaved(false)}}/></label>
  {invalid&&<p className={css.alert} role="alert">{t('templateShare.connectionTemplateInvalid')}</p>}
  {saved&&<p role="status">{t('templateShare.connectionTemplateSaved')}</p>}
  <button type="submit" disabled={disabled}>{t('templateShare.applyConnectionTemplate')}</button>
 </form>
}
