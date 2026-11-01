import {useEffect,useRef,useState} from 'react'
import {ContextDrawer} from './ContextDrawer.js'
import {KnowledgeMarkdownEditor} from './KnowledgeMarkdownEditor.js'
import {SkillInstallControl} from './SkillInstallControl.js'
import type {MarketContentApi} from './market-content-api.js'
import type {MarketItem} from './market-preview.js'
import type {SkillInstallApi,SkillInstallationRecord} from './skill-install-api.js'
import {buildSkillDerivative,derivativeSavedItem,derivativeSourceName,loadSkillDerivative,skillDerivativeBinding,verifySkillDerivativeOrigin,type SkillDerivativeDraft} from './skill-derivation.js'
import {readSkillDerivativeDraft,restoreSkillDerivativeDraft,saveSkillDerivativeDraft,saveSkillDerivativeReceipt} from './skill-derivation-drafts.js'
import {createRoleFormDrafts,useRoleFormDraft} from './role-form-drafts.js'
import {skillDerivationCopy} from './skill-derivation-copy.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './SkillDerivation.module.css'

const drafts=createRoleFormDrafts<SkillDerivativeDraft>()
const receipts=new WeakMap<object,MarketItem>(),expected=new WeakMap<object,{hash:string;id:string;version:string}>(),loads=new WeakMap<object,{api:SkillInstallApi;promise:Promise<void>}>()
export function SkillDerivation({api,contentApi,record,changed}:{api:SkillInstallApi;contentApi:MarketContentApi;record:SkillInstallationRecord;changed:()=>void}){
 const {locale}=useI18n(),copy=skillDerivationCopy(locale),[open,setOpen]=useState(false)
 return <><button type="button" className={css.entry} onClick={()=>setOpen(true)}>{copy.open}</button>{open&&<SkillDerivativeEditor api={api} contentApi={contentApi} record={record} changed={changed} close={()=>setOpen(false)}/>}</>
}
function SkillDerivativeEditor({api,contentApi,record,changed,close}:{api:SkillInstallApi;contentApi:MarketContentApi;record:SkillInstallationRecord;changed:()=>void;close:()=>void}){
 const binding=skillDerivativeBinding(record),{locale}=useI18n(),copy=skillDerivationCopy(locale),[slot,snapshot]=useRoleFormDraft(drafts,contentApi,JSON.stringify(binding)),[loadingError,setLoadingError]=useState<unknown>(),[revision,setRevision]=useState(0),[path,setPath]=useState('SKILL.md'),[,setReceiptRevision]=useState(0),[draftStatus,setDraftStatus]=useState<'saving'|'saved'|'failed'>('saving'),[verified,setVerified]=useState<{slot:object;api:SkillInstallApi}>()
 const writes=useRef(0),live=useRef(true),currentIdentity=useRef({slot,api}),ready=verified?.slot===slot&&verified.api===api;currentIdentity.current={slot,api}
 const value=ready?snapshot.value:undefined,saved=ready?receipts.get(slot):undefined,pending=contentApi.pending(),bound=!!pending?.derivation&&pending.derivation.ownerId===binding.ownerId&&pending.derivation.installationId===binding.installationId&&pending.derivation.bundleHash===binding.bundleHash&&pending.derivation.sourceIdentity===binding.sourceIdentity,ours=expected.get(slot)??(bound&&pending?{hash:pending.hash,id:pending.logicalId,version:pending.version}:undefined),pendingHere=bound&&!!ours&&pending!.kind==='atomic-skill'&&pending!.hash===ours.hash&&pending!.logicalId===ours.id&&pending!.version===ours.version,busy=!!snapshot.pending,blocked=!!pending||!!contentApi.recoveryMessage()
 useEffect(()=>{live.current=true;return()=>{live.current=false}},[])
 useEffect(()=>{
  setLoadingError(undefined);setPath('SKILL.md');writes.current++
  if(slot.read().pending)return
  let current=true,loading=loads.get(slot)?.api===api?loads.get(slot)!.promise:undefined
  if(!loading){loading=(async()=>{
   const actual=await api.get(record.id)
   if(actual.id!==record.id||JSON.stringify(skillDerivativeBinding(actual))!==JSON.stringify(binding)||actual.state!=='installed')throw Error('原技能不属于当前本人或固定来源已变化。')
   if(receipts.has(slot))return
   const cached=slot.read().value;if(cached){await saveSkillDerivativeDraft(binding,cached);return}
   const original=await loadSkillDerivative(api,contentApi,record),stored=await readSkillDerivativeDraft(binding)
   if(stored?.state==='saved'){
    const summary=(await contentApi.list()).find(item=>item.contentStorage?.contentId===stored.saved.contentId&&item.hash===stored.saved.hash)
    if(!summary)throw Error('找不到已保存的技能版本，请在市场中核对原内容。')
    const item=verifySkillDerivativeOrigin(await contentApi.hydrate(summary),original.origin)
    if(item.atomicSkill!.id!==stored.saved.logicalId||item.version!==stored.saved.version)throw Error('已保存技能的身份不一致。')
    receipts.set(slot,item)
   }else{
    const draft=stored?restoreSkillDerivativeDraft(original,stored):original
    if(!stored)await saveSkillDerivativeDraft(binding,draft)
    slot.set(draft)
   }
  })();loads.set(slot,{api,promise:loading});void loading.finally(()=>{if(loads.get(slot)?.promise===loading)loads.delete(slot)}).catch(()=>{})}
  void loading.then(()=>{if(current){setVerified({slot,api});setDraftStatus('saved');setReceiptRevision(value=>value+1)}},error=>{if(current){setLoadingError(error);setDraftStatus('failed')}});return()=>{current=false}
 },[slot,api,revision,snapshot.pending])
 const persist=async(draft:SkillDerivativeDraft)=>{const token=++writes.current;setDraftStatus('saving');try{await saveSkillDerivativeDraft(binding,draft);if(live.current&&token===writes.current)setDraftStatus('saved')}catch(error){if(live.current&&token===writes.current)setDraftStatus('failed');throw error}}
 const change=(patch:Partial<SkillDerivativeDraft>)=>{if(value&&!slot.read().pending&&!blocked){const next={...value,...patch};slot.set(next);void persist(next).catch(()=>{})}}
 const options=(draft:SkillDerivativeDraft)=>({... (draft.origin.declaredLicense?{license:draft.origin.declaredLicense}:{}),...(draft.origin.requirements?{requirements:draft.origin.requirements}:{}),derivation:binding})
 const deliver=async(item:MarketItem,hash:string,id:string,version:string,draft:SkillDerivativeDraft)=>{const checked=verifySkillDerivativeOrigin(derivativeSavedItem(item),draft.origin);if(checked.atomicSkill!.hash!==hash||checked.atomicSkill!.id!==id||checked.version!==version)throw Error('派生技能保存回执与原请求不一致。');receipts.set(slot,checked);try{await saveSkillDerivativeReceipt(binding,{contentId:checked.contentStorage!.contentId,hash,logicalId:id,version})}catch{if(live.current&&currentIdentity.current.slot===slot&&currentIdentity.current.api===api)setLoadingError(copy.receiptKeepFailed)}}
 const submit=async()=>{
  if(!value||busy||blocked)return
  try{await slot.run(value,async()=>{await persist(value);const directory=await api.list(),content=await buildSkillDerivative(value,directory.items.map(item=>item.native.name));expected.set(slot,{hash:content.hash,id:content.id,version:content.version});const item=await contentApi.importAtomic(content,derivativeSourceName(value),options(value));await deliver(item,content.hash,content.id,content.version,value)})}catch{/* 原草稿与原请求保留，关闭不会重新保存。 */}
 }
 const recover=async()=>{
  if(!value||busy||!pendingHere||!ours)return
  try{await slot.run(value,async()=>{let item:MarketItem;try{item=await contentApi.recover()}catch(error){if(!error||typeof error!=='object'||!('code'in error)||error.code!=='teloa/not-found')throw error;const content=await buildSkillDerivative(value);if(content.hash!==ours.hash||content.id!==ours.id||content.version!==ours.version)throw Error('恢复草稿与原请求不一致，已停止继续保存。');item=await contentApi.importAtomic(content,derivativeSourceName(value),options(value))}await deliver(item,ours.hash,ours.id,ours.version,value)})}catch{/* 只核对原保存请求；未取得真实回执不显示完成。 */}
 }
 const file=value?.files.find(item=>item.path===path),error=loadingError??snapshot.error??contentApi.recoveryMessage()
 return <ContextDrawer title={copy.title} close={close} canClose={!busy} compact={false}><div className={css.body}>
  <p>{copy.description}</p>
  {!!error&&<p className={css.error} role="alert">{localizeWorkError(locale,error)||copy.unavailable}</p>}
  {!value&&!saved&&!loadingError&&<p role="status">{copy.loading}</p>}
  {!!loadingError&&<button type="button" className={css.retry} onClick={()=>setRevision(value=>value+1)}>{copy.retry}</button>}
  {value&&<><details><summary>{copy.source}</summary><dl><dt>{copy.source}</dt><dd>{value.origin.nativeName} · {value.origin.publisher}</dd><dt>{copy.version}</dt><dd>{value.origin.source.resourceVersion}</dd><dt>{copy.license}</dt><dd>{value.origin.license}</dd><dt>SHA-256</dt><dd>{value.origin.bundleHash}</dd></dl></details>
   {value.origin.modelDependencies&&<details><summary>{copy.models}</summary><p>{copy.modelsBoundary}</p><ul>{value.origin.modelDependencies.map(dependency=><li key={dependency.catalogId+'-'+dependency.usage}>{dependency.catalogId} · {dependency.version} · {dependency.usage} · {dependency.required?copy.required:copy.optional}</li>)}</ul></details>}
   {value.origin.sourcePackageDeclarations&&<details><summary>{copy.sourcePackage}</summary><p>{copy.sourcePackageBoundary}</p><ul>{value.origin.sourcePackageDeclarations.plugins.map(item=><li key={'plugin-'+item.id}>{item.id} · {item.version}</li>)}{value.origin.sourcePackageDeclarations.externalCapabilities.map(item=><li key={item.kind+'-'+item.id}>{item.id}</li>)}{value.origin.sourcePackageDeclarations.permissions.map(item=><li key={'permission-'+item.id}>{item.description}</li>)}</ul></details>}
   <p role="status">{draftStatus==='saving'?copy.draftSaving:draftStatus==='saved'?copy.draftSaved:copy.draftFailed}</p>
   <label>{copy.files}<select value={path} disabled={busy} onChange={event=>setPath(event.target.value)}>{value.files.map(item=><option key={item.path} value={item.path}>{item.path} · {item.text===undefined?item.bytes.length:new TextEncoder().encode(item.text).length} B</option>)}</select></label>
   {file?.text===undefined?<p>{copy.binary}</p>:<>{file.locked&&<p>{copy.locked}</p>}{/\.md$/i.test(file.path)?<KnowledgeMarkdownEditor key={file.path} value={file.text} readOnly={busy||blocked||file.locked} onChange={text=>change({files:value.files.map(item=>item.path===path&&!item.locked?{...item,text}:item)})}/>:<label>{copy.content}<textarea aria-label={copy.content} value={file.text} readOnly={busy||blocked||file.locked} onChange={event=>change({files:value.files.map(item=>item.path===path&&!item.locked?{...item,text:event.target.value}:item)})}/></label>}</>}
   <details><summary>{copy.metadata}</summary><label>{copy.name}<input value={value.title} disabled={busy||blocked} maxLength={120} onChange={event=>change({title:event.target.value})}/></label><label>{copy.fixedVersion}<input value={value.version} disabled={busy||blocked} onChange={event=>change({version:event.target.value})}/></label></details>
  </>}
  {pending&&<p role="status">{pendingHere?copy.pending:copy.otherPending}</p>}
  <p>{copy.boundary}</p>
  {saved&&<><p className={css.identity} role="status">{copy.saved}</p><strong>{saved.title} · {saved.version}</strong><SkillInstallControl api={api} source={{kind:'atomic',contentId:saved.contentStorage!.contentId}} title={saved.title} changed={changed}/></>}
  <footer className={css.actions}><button type="button" disabled={busy} onClick={close}>{copy.cancel}</button>{!saved&&(pendingHere?<button type="button" className={css.primary} disabled={!value||busy||!!contentApi.recoveryMessage()} onClick={()=>void recover()}>{copy.recover}</button>:<button type="button" className={css.primary} disabled={!value||busy||blocked} onClick={()=>void submit()}>{busy?copy.saving:copy.save}</button>)}</footer>
 </div></ContextDrawer>
}
