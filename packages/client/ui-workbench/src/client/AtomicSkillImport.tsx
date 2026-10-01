import {useEffect,useRef,useState} from 'react'
import {openDialog} from './dialog-focus.js'
import {readAtomicSkill} from './atomic-skill.js'
import type {MarketContentApi} from './market-content-api.js'
import type {MarketItem} from './market-preview.js'
import css from './TaskPage.module.css'
import {useI18n} from './i18n/provider.js'

export function AtomicSkillImport({contentApi,save,close}:{contentApi?:MarketContentApi;save:(item:MarketItem)=>void;close:()=>void}){
 const {t}=useI18n()
 const dialog=useRef<HTMLDialogElement>(null),generation=useRef(0)
 const [files,setFiles]=useState<File[]>([]),[id,setId]=useState(''),[title,setTitle]=useState(''),[version,setVersion]=useState('1.0.0'),[categories,setCategories]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('')
 useEffect(()=>{const dispose=openDialog(dialog.current);return()=>{generation.current++;dispose()}},[])
 const submit=async()=>{
  if(busy)return
  const token=++generation.current;setBusy(true);setError('')
  try{const content=await readAtomicSkill(files.map(file=>({path:file.webkitRelativePath||file.name,size:file.size,read:async()=>new Uint8Array(await file.arrayBuffer())})),{id,title,version,categories:categories.split(/[,，]/).map(value=>value.trim()).filter(Boolean)});if(!contentApi)throw Error(t('market.skill.import.serviceUnavailable'));const item=await contentApi.importAtomic(content,files[0]?.webkitRelativePath.split('/')[0]||content.entryPath);if(token===generation.current)save(item)}
  catch{if(token===generation.current)setError(t('market.skill.import.readFailed'))}
  finally{if(token===generation.current)setBusy(false)}
 }
 return <dialog ref={dialog} className={css.dialog} aria-label={t('market.skill.import.aria')} onCancel={event=>{if(busy)event.preventDefault();else close()}}><form className={css.form} onSubmit={event=>{event.preventDefault();void submit()}}><header><h2>{t('market.skill.import.title')}</h2><button type="button" disabled={busy} onClick={close}>{t('market.common.close')}</button></header><p>{t('market.skill.import.description')}</p>{error&&<p role="alert">{error}</p>}<label>{t('market.skill.import.directory')}<input type="file" aria-label={t('market.skill.import.directoryAria')} {...{webkitdirectory:'',directory:''}} disabled={busy} onChange={event=>setFiles(Array.from(event.target.files||[]))}/></label><label>{t('market.skill.import.id')}<input required value={id} disabled={busy} maxLength={120} onChange={event=>setId(event.target.value)} placeholder="report-writing"/></label><label>{t('market.skill.import.name')}<input required value={title} disabled={busy} maxLength={120} onChange={event=>setTitle(event.target.value)}/></label><label>{t('market.skill.import.version')}<input required value={version} disabled={busy} onChange={event=>setVersion(event.target.value)}/></label><label>{t('market.skill.import.categories')}<input value={categories} disabled={busy} onChange={event=>setCategories(event.target.value)} placeholder={t('market.skill.import.categoriesPlaceholder')}/></label><p>{t('market.skill.import.boundary')}</p><footer className={css.buttons}><button type="button" disabled={busy} onClick={close}>{t('market.common.cancel')}</button><button type="submit" disabled={busy||!files.length}>{busy?t('market.skill.import.saving'):t('market.skill.import.save')}</button></footer></form></dialog>
}
