import {useEffect,useRef,useState} from 'react'
import type {GroupMessageBody,GroupMessageBodySummary} from '@teloa/contract'
import type {GroupApi} from './group-api.js'
import {ContextDrawer} from './ContextDrawer.js'
import {DocumentPreview} from './DocumentPreview.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './GroupArtifactPreview.module.css'

/** 从原群、原消息的固定摘要读取；切群和关闭后的迟到结果不进入当前视图。 */
export function GroupMessageBodyPreview({groupId,messageId,summary,authorName,groupName,api,isCurrent,close}:{groupId:string;messageId:string;summary:GroupMessageBodySummary;authorName:string;groupName:string;api:Pick<GroupApi,'messageBody'>;isCurrent:()=>boolean;close:()=>void}){
 const {t,locale}=useI18n(),[value,setValue]=useState<GroupMessageBody>(),[error,setError]=useState(''),current=useRef(isCurrent);current.current=isCurrent
 const identity=JSON.stringify([groupId,messageId,summary.chars,summary.sha256])
 useEffect(()=>{
  let active=true;setValue(undefined);setError('')
  if(!current.current())return
  void api.messageBody(groupId,messageId,summary).then(row=>{
   if(!active||!current.current())return
   if(row.groupId!==groupId||row.messageId!==messageId||row.sha256!==summary.sha256||row.chars!==summary.chars)throw Object.assign(Error(),{code:'teloa/source-unavailable'})
   setValue(row)
  }).catch(cause=>{if(active&&current.current())setError(localizeWorkError(locale,cause))})
  return()=>{active=false}
 },[api,identity,locale])
 const valid=!!value&&value.groupId===groupId&&value.messageId===messageId&&value.sha256===summary.sha256&&value.chars===summary.chars&&current.current()
 const label=t('group.message.fullTextBy',{name:authorName})
 const download=()=>{
  if(!valid||!value||!current.current())throw Object.assign(Error(),{code:'teloa/source-unavailable'})
  const url=URL.createObjectURL(new Blob([value.text],{type:'text/markdown;charset=utf-8'})),anchor=document.createElement('a')
  anchor.href=url;anchor.download=label.replace(/[\\/:*?"<>|\x00-\x1f]/g,'_')+'.md';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),0)
 }
 return <ContextDrawer title={t('group.message.fullText')} close={close}>
  <div className={css.root}>{error?<p role="alert">{error}</p>:valid&&value?<div className={css.preview}><DocumentPreview identity={identity} label={label} metadata={groupName} text={value.text} previewKind="markdown" backLabel={t('group.message.back')} onBack={close} onDownload={download}/></div>:<p role="status">{t('collaboration.state.loading')}</p>}</div>
 </ContextDrawer>
}
