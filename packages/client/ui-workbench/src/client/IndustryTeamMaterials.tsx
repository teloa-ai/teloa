import {useEffect,useRef,useState} from 'react'
import {ContextDrawer} from './ContextDrawer.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import type {GroupSnapshot} from './group-api.ts'
import type {MessageReference} from '@teloa/contract'
import type {IndustryTeamMaterialsPort,IndustryTeamMaterialsPreview} from './industry-team-materials.ts'
import css from './CollaborationPage.module.css'
import readerCss from './IndustryTeamMaterials.module.css'

/** 原群的轻量确认；关开保选择，写入中的原 journal 不因关窗或切群重建。 */
export function IndustryTeamMaterials({open,readRequest=0,group,port,references,isCurrent,close,ready}:{open:boolean;readRequest?:number;group:GroupSnapshot;port:IndustryTeamMaterialsPort;references:readonly MessageReference[];isCurrent:()=>boolean;close:()=>void;ready:(references:MessageReference[],preview:IndustryTeamMaterialsPreview)=>void}){
 const {locale,t}=useI18n(),epoch=useRef(0),active=useRef(true),openRef=useRef(open),currentRef=useRef(isCurrent),portRef=useRef(port)
 openRef.current=open;currentRef.current=isCurrent;portRef.current=port
 const [preview,setPreview]=useState<IndustryTeamMaterialsPreview>(),[selected,setSelected]=useState<string[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState<string>(),[shown,setShown]=useState<string>()
 const pending=()=>port.pending(group.group.id),origin=useRef({port,id:group.group.id,readRequest})
 const read=async(reset=false)=>{const token=++epoch.current;setBusy(true);setError(undefined);try{const value=await port.load(group);if(active.current&&portRef.current===port&&token===epoch.current&&openRef.current&&currentRef.current()){setPreview(value);setSelected(pending()??(!reset&&preview?selected.filter(id=>value.documents.some(doc=>doc.id===id)):value.documents.map(doc=>doc.id)))}}catch(cause){if(active.current&&portRef.current===port&&token===epoch.current)setError(localizeWorkError(locale,cause))}finally{if(active.current&&portRef.current===port&&token===epoch.current)setBusy(false)}}
 useEffect(()=>{active.current=true;return()=>{active.current=false;epoch.current++}},[])
 useEffect(()=>{const changed=origin.current.port!==port||origin.current.id!==group.group.id,requested=origin.current.readRequest!==readRequest;if(changed){origin.current={port,id:group.group.id,readRequest};epoch.current++;setPreview(undefined);setSelected([]);setShown(undefined);setError(undefined);setBusy(false)}else origin.current.readRequest=readRequest;if(open&&(changed||!preview||requested))void read(changed)},[open,readRequest,port,group.group.id])
 const submit=async()=>{if(origin.current.port!==port||origin.current.id!==group.group.id||!preview||busy||!selected.length)return;const token=++epoch.current;setBusy(true);setError(undefined);const current=()=>active.current&&portRef.current===port&&token===epoch.current&&openRef.current&&currentRef.current();try{const refs=await port.prepare(preview,selected,current,references);if(current()){ready(refs,preview);port.complete?.(group.group.id)}}catch(cause){if(current())setError(localizeWorkError(locale,cause))}finally{if(active.current&&portRef.current===port&&token===epoch.current)setBusy(false)}}
 let locked=false;try{locked=!!pending()}catch{locked=true}
 const dismiss=()=>{epoch.current++;setBusy(false);close()}
 const currentPreview=origin.current.port===port&&origin.current.id===group.group.id?preview:undefined
 const previewDocument=currentPreview?.documents.find(doc=>doc.id===shown)
 const empty=!!currentPreview&&!currentPreview.documents.length
 return <ContextDrawer padded title={t('group.templateMaterials.title')} open={open} close={dismiss} className={css.dialog+' '+css.lightDrawer}>
  {error&&<><p role="alert">{error}</p>{preview&&<button type="button" className={css.secondary} disabled={busy||port.canReview?.(group.group.id)===false} onClick={()=>{try{port.review?.(group.group.id);void read()}catch(cause){setError(localizeWorkError(locale,cause))}}}>{t('group.templateMaterials.review')}</button>}</>}
  {!empty&&<p className={css.hint}>{t('group.templateMaterials.boundary')}</p>}
  {empty?<p role="status">{t('group.templateMaterials.empty')}</p>:currentPreview?<><p>{t('group.templateMaterials.recipients',{names:currentPreview.roles.map(role=>role.name+(role.state==='paused'?' · '+t('role.state.paused'):'')).join('、')})}</p><p className={css.hint}>{t('group.templateMaterials.samples')}</p>
   <div className={readerCss.workspace}><fieldset className={readerCss.list}><legend>{t('group.templateMaterials.choose')}</legend>{currentPreview.documents.map(doc=><div className={readerCss.row} key={doc.id}><label><input type="checkbox" disabled={busy||locked} aria-label={doc.title} checked={selected.includes(doc.id)} onChange={event=>setSelected(current=>event.target.checked?[...current,doc.id]:current.filter(id=>id!==doc.id))}/><span>{doc.title}<small>{doc.path}</small></span></label><button type="button" aria-label={t('group.templateMaterials.preview')+' · '+doc.title} aria-expanded={previewDocument?.id===doc.id} onClick={()=>setShown(current=>current===doc.id?undefined:doc.id)}>{t('group.templateMaterials.preview')}</button></div>)}</fieldset>
   {previewDocument&&<section className={readerCss.reading} aria-label={previewDocument.title}><h3>{previewDocument.title}</h3><pre>{previewDocument.text}</pre></section>}</div>
   {locked&&<p role="status">{t('group.templateMaterials.recovery')}</p>}
  </>:!busy&&<button type="button" className={css.secondary} onClick={()=>void read()}>{t('group.templateMaterials.retry')}</button>}
  {!empty&&<footer className={readerCss.footer}><button type="button" className={css.primary} disabled={busy||!currentPreview||!selected.length} onClick={()=>void submit()}>{t(locked?'group.templateMaterials.resume':'group.templateMaterials.confirm')}</button></footer>}
 </ContextDrawer>
}
