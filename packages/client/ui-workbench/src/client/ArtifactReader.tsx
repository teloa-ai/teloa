import {useEffect,useRef,useState,type ReactNode} from 'react'
import {ChevronDown,Download,History,Info,MoreHorizontal,Paperclip,Pencil,X} from 'lucide-react'
import type {Artifact,ArtifactVersion} from './artifact-preview.js'
import type {ArtifactFile} from './artifact-files.js'
import {ArtifactAssetDownload,ArtifactAssetPreview,artifactAssetName} from './ArtifactAssetPreview.js'
import {DetailsMenu} from './DetailsMenu.js'
import {useI18n} from './i18n/provider.js'
import {artifactReaderCopy} from './artifact-reader-copy.js'
import type {ArtifactWithdrawalControl} from './use-artifact-withdrawal.ts'
import {localizeWorkError} from './i18n/errors.js'
import css from './ArtifactReader.module.css'

export type ArtifactReaderDrawer='history'|'details'|'files'|'advanced'|'withdraw'
export const artifactReaderFileKey=(file:ArtifactFile)=>JSON.stringify([file.sessionId,file.id,file.path,file.sha256,file.capturedAt])
export function artifactReaderFile(version:ArtifactVersion,selection:string|undefined):ArtifactFile|null|undefined{
 if(selection==='description')return null
 return selection===undefined?version.files?.[0]??null:version.files?.find(file=>artifactReaderFileKey(file)===selection)
}
/** hydrate 的文件目录占位只说明快照，不是可按段落续改的正文。 */
export const artifactReaderTextSections=(version:ArtifactVersion)=>version.sections.filter(section=>!(version.files?.length&&section.id==='files-summary'&&section.title==='文件快照'&&section.text===version.files.map(file=>file.path).join('、')))
type Props={artifact:Artifact;version:ArtifactVersion;selection:string|undefined;select:(key:string)=>void;instruction:string;patchInstruction:(value:string)=>void;prepare?:((instruction:string,file?:{id:string;sha256:string;path:string})=>Promise<void>)|undefined;sourceUnavailable:boolean;busy:boolean;markdown:string;body:ReactNode;drawer:(view:ArtifactReaderDrawer)=>void;chooseVersion:(number:number)=>void;newResult?:{label:string;disabled:boolean;run:()=>void}|undefined;withdrawal?:ArtifactWithdrawalControl|undefined}
export function ArtifactReader({artifact,version,selection,select,instruction,patchInstruction,prepare,sourceUnavailable,busy,markdown,body,drawer,chooseVersion,newResult,withdrawal}:Props){
 const {locale}=useI18n(),copy=artifactReaderCopy(locale),file=artifactReaderFile(version,selection),files=version.files??[],latest=artifact.versions.at(-1)!,old=version.number!==latest.number,sections=artifactReaderTextSections(version),missing=file===undefined
 const identity=JSON.stringify([artifact.id,version.number,file?artifactReaderFileKey(file):selection??'description']),[composing,setComposing]=useState(false),input=useRef<HTMLTextAreaElement>(null),modify=useRef<HTMLButtonElement>(null)
 useEffect(()=>setComposing(false),[identity])
 const canPrepare=!!prepare&&!old&&!sourceUnavailable&&!missing&&!withdrawal?.blocked
 const begin=()=>{if(!canPrepare)return;setComposing(true);requestAnimationFrame(()=>{input.current?.focus();input.current?.scrollIntoView({block:'nearest'})})}
 const closeCompose=()=>{setComposing(false);modify.current?.focus()}
 return <section className={css.reader} data-artifact-reader onKeyDown={event=>{if(event.key==='Escape'&&!event.defaultPrevented&&!event.nativeEvent.isComposing&&composing){event.preventDefault();event.stopPropagation();closeCompose()}}}>
  <header className={css.head}><h3 title={version.title}>{version.title}</h3><div className={css.actions}>
   {file?<ArtifactAssetDownload file={file}/>:!missing&&<a download={'teloa-'+artifact.id.replace(/[^\w-]/g,'_')+'-v'+version.number+'.md'} href={'data:text/markdown;charset=utf-8,'+encodeURIComponent(markdown)}><Download size={15} aria-hidden="true"/>{copy.download}</a>}
   <button ref={modify} type="button" className={css.modify} disabled={!canPrepare||busy} onClick={begin}><Pencil size={15} aria-hidden="true"/>{copy.modify}</button>
   <DetailsMenu className={css.more} resetKey={identity} closeOnSelect><summary aria-label={copy.more} title={copy.more}><MoreHorizontal size={18}/></summary><div role="menu" aria-label={copy.more}>
    <button type="button" role="menuitem" onClick={()=>drawer('history')}><History size={15}/>{copy.history}</button><button type="button" role="menuitem" onClick={()=>drawer('details')}><Info size={15}/>{copy.details}</button>{(files.length>0||artifact.source.kind==='session'||artifact.source.kind==='task')&&<button type="button" role="menuitem" onClick={()=>drawer('files')}><Paperclip size={15}/>{copy.files}</button>}<button type="button" role="menuitem" onClick={()=>drawer('advanced')}>{copy.advanced}</button>{newResult&&<button type="button" role="menuitem" disabled={newResult.disabled} onClick={newResult.run}>{newResult.label}</button>}
    {withdrawal?.enabled&&withdrawal.state!=='withdrawn'&&<button type="button" role="menuitem" disabled={busy||withdrawal.blocked} onClick={()=>drawer('withdraw')}>{copy.withdraw}</button>}
   </div></DetailsMenu>
  </div></header>
  <div className={css.meta}><button type="button" aria-label={copy.history} onClick={()=>drawer('history')}>v{version.number}<ChevronDown size={13}/></button><span aria-hidden="true">·</span><span>{version.author}</span><span aria-hidden="true">·</span><time dateTime={version.at}>{new Intl.DateTimeFormat(locale,{month:'short',day:'numeric'}).format(new Date(version.at))}</time>{files.length>0&&<button type="button" onClick={()=>drawer('files')}><Paperclip size={13}/>{copy.fileCount(files.length)}</button>}</div>
  {old&&<div className={css.notice} role="status"><span>{copy.oldVersion(version.number)}</span><button type="button" onClick={()=>chooseVersion(latest.number)}>{copy.latest}</button></div>}
  {sourceUnavailable&&<p className={css.notice} role="status">{copy.sourceUnavailable}</p>}
  {withdrawal?.state==='withdrawn'&&<p className={css.notice} role="status">{copy.withdrawn}</p>}
  {withdrawal?.pending&&<div className={css.notice} role="status"><span>{withdrawal.working?copy.checkingWithdrawal:copy.withdrawPending}</span><button type="button" disabled={withdrawal.working} onClick={()=>void withdrawal.recover()}>{copy.recoverWithdrawal}</button></div>}
  {!!withdrawal?.error&&!withdrawal.pending&&<div className={css.notice} role="status"><span>{copy.availabilityError}</span><button type="button" disabled={withdrawal.loading||withdrawal.working} onClick={()=>void withdrawal.refresh()}>{copy.retryAvailability}</button></div>}
  {!!withdrawal?.actionError&&!withdrawal.pending&&<p className={css.notice} role="alert">{localizeWorkError(locale,withdrawal.actionError)}</p>}
  {files.length>0&&(files.length>1||sections.length>0)&&<div className={css.fileChoices} role="group" aria-label={copy.files}>{files.map(item=><button type="button" key={artifactReaderFileKey(item)} aria-pressed={!!file&&artifactReaderFileKey(file)===artifactReaderFileKey(item)} onClick={()=>select(artifactReaderFileKey(item))}>{files.filter(other=>artifactAssetName(other)===artifactAssetName(item)).length>1?item.path:artifactAssetName(item)}</button>)}{sections.length>0&&<button type="button" aria-pressed={file===null} onClick={()=>select('description')}>{copy.description}</button>}</div>}
  <div className={css.body}>{missing?<p className={css.notice} role="status">{copy.fileUnavailable}</p>:file?<ArtifactAssetPreview file={file}/>:sections.length?body:<p className={css.empty}>{copy.empty}</p>}</div>
  {composing&&<form className={css.compose} aria-label={copy.instruction} onSubmit={event=>{event.preventDefault();if(canPrepare&&!busy&&instruction.trim())void prepare?.(instruction.trim(),file?{id:file.id,sha256:file.sha256,path:file.path}:undefined)}}><header><h4>{copy.composeTitle}</h4><button type="button" aria-label={copy.closeCompose} onClick={closeCompose}><X size={16}/></button></header><textarea ref={input} rows={4} maxLength={4000} aria-label={copy.instruction} placeholder={copy.placeholder} value={instruction} onChange={event=>patchInstruction(event.target.value)}/><footer><small>{copy.prepareHint}</small><button type="submit" disabled={!canPrepare||busy||!instruction.trim()}>{copy.continue}</button></footer></form>}
  {!prepare&&!old&&!sourceUnavailable&&<p className={css.empty}>{copy.unavailable}</p>}
 </section>
}
