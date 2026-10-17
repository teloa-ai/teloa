import {useEffect,useId,useRef,useState} from 'react'
import {openDialog} from './dialog-focus.js'
import {AtomicSkillMetadataError,readAtomicSkill,suggestAtomicSkillMetadata,validateAtomicSkillMetadata,type AtomicSkillMetadataField} from './atomic-skill.js'
import type {MarketContentApi} from './market-content-api.js'
import type {MarketItem} from './market-preview.js'
import css from './TaskPage.module.css'
import {useI18n} from './i18n/provider.js'
import {useDialogDismiss} from './use-dialog-dismiss.js'
import {createRoleFormDrafts,useRoleFormDraft} from './role-form-drafts.js'
import {ToolbarIconButton} from './ToolbarIconButton.js'
import {X} from 'lucide-react'
import importCss from './AtomicSkillImport.module.css'

type ImportDraft={files:File[];id:string;title:string;version:string;categories:string;idEdited?:boolean;titleEdited?:boolean;metadataStatus?:'loading'|'ready'|'manual'|'failed'}
type ImportReceipt={item:MarketItem}
// 只保留本人存活API中的原File对象，不序列化文件、路径或输入到浏览器持久存储。
const importDrafts=createRoleFormDrafts<ImportDraft>()
// 卸载期间完成的回执留给原入口消费；成功后不再保留原文件或表单。
const importReceipts=new WeakMap<object,ImportReceipt>()
const fileInputs=(files:File[])=>files.map(file=>({path:file.webkitRelativePath||file.name,size:file.size,read:async()=>new Uint8Array(await file.arrayBuffer())}))
const metadataOf=(draft:ImportDraft)=>({id:draft.id,title:draft.title,version:draft.version,categories:draft.categories.split(/[,，]/).map(value=>value.trim()).filter(Boolean)})
const invalidMessageKeys:Record<AtomicSkillMetadataField,string>={id:'market.skill.import.invalidId',title:'market.skill.import.invalidTitle',version:'market.skill.import.invalidVersion',categories:'market.skill.import.invalidCategories'}
export function AtomicSkillImport({contentApi,draftOwner,entryKey='atomic-skill',save,close}:{contentApi?:MarketContentApi;draftOwner?:object;entryKey?:string;save:(item:MarketItem)=>void;close:()=>void}){
 const {t}=useI18n()
 const dialog=useRef<HTMLDialogElement>(null),fallbackOwner=useRef({}),mounted=useRef(true)
 const [slot,snapshot]=useRoleFormDraft(importDrafts,contentApi??draftOwner??fallbackOwner.current,entryKey)
 const value:ImportDraft=snapshot.value??{files:[],id:'',title:'',version:'1.0.0',categories:''},{files,id,title,version,categories}=value,busy=!!snapshot.pending
 const [metadataOpen,setMetadataOpen]=useState(false)
 // 字段级校验提示只属于当前窗口的本次提交，不写入草稿；任何修改或重选目录即清除。
 const [invalidField,setInvalidField]=useState<AtomicSkillMetadataField>(),invalidId=useId()
 const current=useRef({slot,save});current.current={slot,save}
 const origin=useRef({slot,epoch:0});if(origin.current.slot!==slot)origin.current={slot,epoch:origin.current.epoch+1}
 const change=(patch:Partial<ImportDraft>)=>{slot.set({...value,...patch});setInvalidField(undefined)}
 const chooseFiles=(files:File[])=>{
  const idEdited=value.idEdited??!!value.id,titleEdited=value.titleEdited??!!value.title
  setInvalidField(undefined)
  slot.set({...value,files,idEdited,titleEdited,...(!idEdited?{id:''}:{}),...(!titleEdited?{title:''}:{}),metadataStatus:'loading'})
  void suggestAtomicSkillMetadata(fileInputs(files)).then(metadata=>{
   const current=slot.read();if(current.pending||current.value?.files!==files)return
   const draft=current.value
   slot.set({...draft,...(metadata&&!draft.idEdited?{id:metadata.id}:{}),...(metadata&&!draft.titleEdited?{title:metadata.title}:{}),metadataStatus:metadata?'ready':'manual'})
  },()=>{const current=slot.read();if(!current.pending&&current.value?.files===files)slot.set({...current.value,metadataStatus:'failed'})})
 }
 const deliver=()=>{const receipt=importReceipts.get(slot);if(receipt&&mounted.current&&current.current.slot===slot){importReceipts.delete(slot);current.current.save(receipt.item)}}
 const dismiss=useDialogDismiss(close,!busy)
 useEffect(()=>{mounted.current=true;const dispose=openDialog(dialog.current);return()=>{mounted.current=false;dispose()}},[])
 useEffect(()=>{setInvalidField(undefined)},[slot])
 useEffect(()=>{deliver();if(snapshot.pending)void snapshot.pending.then(deliver,()=>{})},[slot,snapshot.pending])
 const submit=async()=>{
  const state=slot.read()
  if(state.pending||!state.value?.files.length||state.value.metadataStatus==='loading'||state.value.metadataStatus==='failed')return
  const original=value
  // 产品校验先于读取与保存：失败只指向实际字段并展开，不进入保存流程，也不产生保存失败提示。
  try{validateAtomicSkillMetadata(metadataOf(original))}
  catch(error){setInvalidField(error instanceof AtomicSkillMetadataError?error.field:'id');setMetadataOpen(true);return}
  try{await slot.run(original,async()=>{const content=await readAtomicSkill(fileInputs(original.files),metadataOf(original));if(!contentApi)throw Error('unavailable');const item=await contentApi.importAtomic(content,original.files[0]?.webkitRelativePath.split('/')[0]||content.entryPath);importReceipts.set(slot,{item})});deliver()}
  catch{/* 原文件与字段留在原API和入口的草稿槽；重开不自动重发。 */}
 }
 return <dialog ref={dialog} className={css.dialog} aria-label={t('market.skill.import.aria')} {...dismiss}>
  <form className={css.form} noValidate onSubmit={event=>{event.preventDefault();void submit()}}>
   <header><h2>{t('market.skill.import.title')}</h2><ToolbarIconButton label={t('market.common.close')} icon={X} disabled={busy} onClick={close}/></header>
   <p>{t('market.skill.import.description')}</p>
   {!!snapshot.error&&<p role="alert">{t(contentApi?'market.skill.import.readFailed':'market.skill.import.serviceUnavailable')}</p>}
   {value.metadataStatus==='failed'&&<p role="alert">{t('market.skill.import.directoryInvalid')}</p>}
   <label>{t('market.skill.import.directory')}<input key={origin.current.epoch} type="file" aria-label={t('market.skill.import.directoryAria')} {...{webkitdirectory:'',directory:''}} disabled={busy} onChange={event=>chooseFiles(Array.from(event.target.files||[]))}/></label>
   {files.length>0&&<p>{t('market.skill.import.selectedDirectory',{name:(files[0]!.webkitRelativePath||files[0]!.name).split('/')[0]!,count:files.length})}</p>}
   {value.metadataStatus==='loading'&&<p role="status">{t('market.skill.import.reading')}</p>}
   {value.metadataStatus==='ready'&&<p className={importCss.identity}><strong>{title}</strong><small>{t('market.skill.import.localVersion',{version})}</small></p>}
   {value.metadataStatus==='manual'&&<p>{t('market.skill.import.missingName')}</p>}
   <details className={importCss.metadata} open={metadataOpen||value.metadataStatus==='manual'||!!invalidField} onToggle={event=>setMetadataOpen(event.currentTarget.open)}>
    <summary>{t('market.skill.import.editMetadata')}</summary>
    <div className={importCss.fields}>
     {invalidField&&<p role="alert" id={invalidId}>{t(invalidMessageKeys[invalidField])}</p>}
     <label>{t('market.skill.import.id')}<input required value={id} disabled={busy} maxLength={120} aria-invalid={invalidField==='id'||undefined} aria-describedby={invalidField==='id'?invalidId:undefined} onChange={event=>change({id:event.target.value,idEdited:true})} placeholder="report-writing"/></label>
     <label>{t('market.skill.import.name')}<input required value={title} disabled={busy} maxLength={120} aria-invalid={invalidField==='title'||undefined} aria-describedby={invalidField==='title'?invalidId:undefined} onChange={event=>change({title:event.target.value,titleEdited:true})}/></label>
     <label>{t('market.skill.import.version')}<input required value={version} disabled={busy} aria-invalid={invalidField==='version'||undefined} aria-describedby={invalidField==='version'?invalidId:undefined} onChange={event=>change({version:event.target.value})}/></label>
     <label>{t('market.skill.import.categories')}<input value={categories} disabled={busy} aria-invalid={invalidField==='categories'||undefined} aria-describedby={invalidField==='categories'?invalidId:undefined} onChange={event=>change({categories:event.target.value})} placeholder={t('market.skill.import.categoriesPlaceholder')}/></label>
    </div>
   </details>
   <p>{t('market.skill.import.boundary')}</p>
   <footer className={css.buttons}><button type="button" disabled={busy} onClick={close}>{t('market.common.cancel')}</button><button type="submit" disabled={busy||!files.length||value.metadataStatus==='loading'||value.metadataStatus==='failed'||!id.trim()||!title.trim()}>{busy?t('market.skill.import.saving'):t('market.skill.import.save')}</button></footer>
  </form>
 </dialog>
}
