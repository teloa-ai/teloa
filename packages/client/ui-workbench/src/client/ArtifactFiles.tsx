import { useEffect,useMemo,useRef,useState } from 'react'
import { copyArtifactFiles,fileBytes,fileText,fileImageType,type ArtifactFile,type ArtifactFileApi,type ArtifactFileForm } from './artifact-files.js'
import type { ArtifactFileDirectory } from '@teloa/contract'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import base from './TaskPage.module.css'
import css from './ArtifactFiles.module.css'

type Props={sessionId:string;api:ArtifactFileApi;files:ArtifactFile[];enabled:boolean;form:ArtifactFileForm;changeForm:(value:ArtifactFileForm)=>void;changeFiles?:(files:ArtifactFile[])=>void;label?:string}
export function ArtifactFiles({sessionId,api,files,enabled,form,changeForm,changeFiles,label}:Props){
  const {locale,t}=useI18n(),visibleLabel=label??t('artifactFiles.label')
  const [directory,setDirectory]=useState<ArtifactFileDirectory>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),request=useRef<AbortController>(),generation=useRef(0)
  useEffect(()=>{generation.current++;request.current?.abort();setBusy(false);setDirectory(undefined);setError('');setNotice('');return()=>{generation.current++;request.current?.abort()}},[sessionId,enabled,form.query])
  const load=async(mode:'list'|'read',path=form.query)=>{
    request.current?.abort();const controller=new AbortController();request.current=controller;const current=++generation.current;setBusy(true);setError('');setNotice('')
    try{
      if(mode==='list'){const value=await api.list(sessionId,path,controller.signal);if(current===generation.current)setDirectory(value)}
      else{const value=await api.read(sessionId,path,controller.signal);if(current===generation.current)changeForm({...form,candidate:value})}
    }catch(cause){if(!controller.signal.aborted&&current===generation.current)setError(localizeWorkError(locale,cause))}
    finally{if(!controller.signal.aborted&&current===generation.current)setBusy(false)}
  }
  const edit=(file:ArtifactFile)=>{const text=fileText(fileBytes(file));if(text!==null)changeForm({...form,edit:{file,text}})}
  const saveEdit=async()=>{
    if(!form.edit||!api.write)return
    const controller=new AbortController();request.current=controller;const current=++generation.current;setBusy(true);setError('');setNotice('')
    try{const file=await api.write(form.edit.file,form.edit.text,controller.signal);if(current===generation.current){changeForm({...form,edit:undefined,candidate:file});setNotice(t('artifactFiles.writeSaved'))}}
    catch(cause){if(current===generation.current)setError(localizeWorkError(locale,cause))}
    finally{if(current===generation.current)setBusy(false)}
  }
  const candidate=form.candidate,existing=candidate?files.find(file=>file.id===candidate.id||file.path===candidate.path):undefined
  const keep=()=>{
    if(!candidate||!changeFiles)return
    try{changeFiles(copyArtifactFiles([...files.filter(file=>file.id!==candidate.id&&file.path!==candidate.path),candidate],{kind:'session',id:sessionId}));changeForm({...form,candidate:null});setNotice(t('artifactFiles.added'));setError('')}
    catch(cause){setError(localizeWorkError(locale,cause))}
  }
  return <section className={css.files} aria-label={visibleLabel}>
    <h3>{t('artifactFiles.count',{label:visibleLabel,count:files.length})}</h3><p>{t('artifactFiles.description')}</p>
    {files.map(file=><section className={css.item} key={file.id}><FileSnapshot file={file} edit={api.write&&enabled&&!busy?()=>edit(file):undefined}/>{changeFiles&&<div className={base.buttons}><button type="button" disabled={!enabled||busy} onClick={()=>void load('read',file.path)}>{t('artifactFiles.reread')}</button><button type="button" onClick={()=>changeFiles(files.filter(value=>value.id!==file.id))}>{t('artifactFiles.remove')}</button></div>}</section>)}
    {!files.length&&<p>{t('artifactFiles.empty')}</p>}
    {changeFiles&&<details><summary>{t('artifactFiles.addOrUpdate')}</summary><div className={css.editor}>
      <p>{t('artifactFiles.limits')}</p>
      <label>{t('artifactFiles.pathLabel')}<input value={form.query} maxLength={1024} onChange={event=>changeForm({...form,query:event.target.value,candidate:null})} placeholder={t('artifactFiles.pathPlaceholder')}/></label>
      <div className={base.buttons}><button type="button" disabled={!enabled||busy} onClick={()=>void load('list')}>{t('artifactFiles.find')}</button><button type="button" disabled={!enabled||busy||!form.query.trim()} onClick={()=>void load('read')}>{t('artifactFiles.read')}</button></div>
      {directory&&<div className={css.directory} aria-label={t('artifactFiles.candidates')}>{directory.items.length?directory.items.map(item=><button type="button" key={item.path} disabled={busy||!enabled} onClick={()=>item.kind==='directory'?changeForm({...form,query:item.path.replace(/\/?$/,'/'),candidate:null}):void load('read',item.path)}>{t(item.kind==='directory'?'artifactFiles.directory':'artifactFiles.file')} · {item.path}</button>):<p>{t('artifactFiles.noMatch')}</p>}</div>}
    </div></details>}
    {form.edit&&<section className={css.editor} aria-label={t('artifactFiles.editAria')}><h4>{t('artifactFiles.editTitle',{path:form.edit.file.path})}</h4><p>{t('artifactFiles.editDescription')}</p><label>{t('artifactFiles.editContent')}<textarea rows={14} value={form.edit.text} disabled={busy} onChange={event=>changeForm({...form,edit:{...form.edit!,text:event.target.value}})}/></label><div className={base.buttons}><button type="button" disabled={!enabled||busy} onClick={()=>void saveEdit()}>{t('artifactFiles.saveOriginal')}</button><button type="button" disabled={busy} onClick={()=>changeForm({...form,edit:undefined})}>{t('artifactFiles.discardEdit')}</button></div></section>}
    {busy&&<p role="status">{t('artifactFiles.processing')}</p>}{error&&<p role="alert" className={base.error}>{error}</p>}{notice&&<p role="status">{notice}</p>}
    {candidate&&changeFiles&&<section className={css.candidate} aria-label={t('artifactFiles.reviewAria')}><h4>{t(existing?'artifactFiles.reviewUpdate':'artifactFiles.reviewRead')}</h4>{existing&&<p>{t('artifactFiles.selectedSha',{sha:existing.sha256})}</p>}<FileSnapshot file={candidate} edit={api.write&&enabled&&!busy?()=>edit(candidate):undefined}/>
      {existing?.sha256===candidate.sha256&&existing.id===candidate.id?<p>{t('artifactFiles.unchanged')}</p>:<button type="button" disabled={!enabled||busy} onClick={keep}>{t(existing?'artifactFiles.replace':'artifactFiles.keep')}</button>}
      <button type="button" onClick={()=>changeForm({...form,candidate:null})}>{t('artifactFiles.discardRead')}</button>
    </section>}
  </section>
}

function FileSnapshot({file,edit}:{file:ArtifactFile;edit?:(()=>void)|undefined}){
  const {t,dateTime}=useI18n()
  const bytes=useMemo(()=>fileBytes(file),[file.contentBase64]),imageType=useMemo(()=>fileImageType(bytes),[bytes]),text=useMemo(()=>imageType?null:fileText(bytes),[bytes,imageType]),[url,setUrl]=useState(''),[imageError,setImageError]=useState(false),[expanded,setExpanded]=useState(false)
  useEffect(()=>{const value=URL.createObjectURL(new Blob([bytes],{type:imageType||'application/octet-stream'}));setUrl(value);setImageError(false);setExpanded(false);return()=>URL.revokeObjectURL(value)},[bytes,imageType])
  const name=file.path.split('/').at(-1)!.replace(/[\\/:*?"<>|\x00-\x1f]/g,'_')
  return <div className={css.snapshot}><strong>{file.path}</strong><small>{t('artifactFiles.snapshotMeta',{bytes:file.bytes,at:dateTime(file.capturedAt)})}</small><details><summary>{t('artifactFiles.source')}</summary><p>{t('artifactFiles.sessionId',{id:file.sessionId})}<br/>{t('artifactFiles.fileId',{id:file.id})}<br/>SHA-256: {file.sha256}</p></details>
    {imageType&&url?<div className={css.imagePreview}>
      {imageError?<p role="status">{t('artifactFiles.imageUnavailable')}</p>:<><img className={expanded?css.expandedImage:css.thumbnail} src={url} alt={t('artifactFiles.imageAlt',{path:file.path})} decoding="async" onError={()=>setImageError(true)}/><button type="button" aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)}>{t(expanded?'artifactFiles.collapseImage':'artifactFiles.expandImage')}</button></>}
    </div>:text===null?<p>{t('artifactFiles.binary')}</p>:<details><summary>{t('artifactFiles.previewText')}{file.bytes===0?t('artifactFiles.emptySuffix'):''}</summary><pre>{text.slice(0,12000)||t('artifactFiles.zeroBytes')}</pre>{text.length>12000&&<p>{t('artifactFiles.truncated')}</p>}</details>}
    {text!==null&&edit&&<button type="button" onClick={edit}>{t('artifactFiles.editOriginal')}</button>}
    {url&&<a href={url} download={name}>{t('artifactFiles.download')}</a>}
  </div>
}
