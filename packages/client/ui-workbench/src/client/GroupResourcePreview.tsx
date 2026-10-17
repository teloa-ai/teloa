import {useEffect,useRef,useState} from 'react'
import type {GroupResourceVersion,MessageReference} from '@teloa/contract'
import type {GroupApi} from './group-api.js'
import {ContextDrawer} from './ContextDrawer.js'
import {DocumentPreview} from './DocumentPreview.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './GroupArtifactPreview.module.css'

/** 仅读取明确群身份和引用版本。标题也来自该版本，不拿当前目录替换历史正文。 */
export function GroupResourcePreview({groupId,reference,api,isCurrent,close}:{groupId:string;reference:MessageReference&{kind:'group-resource'};api:Pick<GroupApi,'resource'>;isCurrent:()=>boolean;close:()=>void}){
 const {t,locale}=useI18n(),[value,setValue]=useState<GroupResourceVersion>(),[error,setError]=useState(''),current=useRef(isCurrent);current.current=isCurrent
 const versionKey=JSON.stringify([groupId,reference.id,reference.version])
 useEffect(()=>{
  let active=true;setValue(undefined);setError('')
  if(reference.kind!=='group-resource'||!current.current())return
  void api.resource(groupId,reference.id,reference.version).then(row=>{
   if(!active||!current.current())return
   if(row.groupId!==groupId||row.resourceId!==reference.id||row.version!==reference.version)throw Object.assign(Error(),{code:'teloa/source-unavailable'})
   setValue(row)
  }).catch(cause=>{if(active&&current.current())setError(localizeWorkError(locale,cause))})
  return()=>{active=false}
 },[api,versionKey,locale])
 const valid=value?.groupId===groupId&&value.resourceId===reference.id&&value.version===reference.version&&current.current()
 const download=()=>{
  if(!valid||!value||!current.current())throw Object.assign(Error(),{code:'teloa/source-unavailable'})
  const url=URL.createObjectURL(new Blob([value.markdown],{type:'text/markdown;charset=utf-8'})),anchor=document.createElement('a')
  anchor.href=url;const name=value.title.replace(/[\\/:*?"<>|\x00-\x1f]/g,'_');anchor.download=/\.md$/i.test(name)?name:name+'.md';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),0)
 }
 return <ContextDrawer title={t('collaboration.view.materials')} close={close}>
  <div className={css.root}>{error?<p role="alert">{error}</p>:valid&&value?<div className={css.preview}><DocumentPreview identity={versionKey} label={value.title} metadata={<>{t('collaboration.view.materials')} · v{value.version}</>} text={value.markdown} previewKind="markdown" backLabel={t('group.materials.back')} onBack={close} onDownload={download}/></div>:<p role="status">{t('collaboration.state.loading')}</p>}</div>
 </ContextDrawer>
}
