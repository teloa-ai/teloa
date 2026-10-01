import {useCallback,useEffect,useState} from 'react'
import {TriangleAlert} from 'lucide-react'
import type {CredentialStoreApi,CredentialStoreStatus} from './credential-store-api.js'
import {subscribeSettingsPanelVisible} from './AutoDreamSettingsPage.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './AutoDreamSettingsPage.module.css'

/** 设置 → 凭据存储：明文档与锁定常驻警告；历史明文副本逐项或全选勾选后两步确认删除（规格 §0-1、§0-3）。 */
export function CredentialStoreSettings({api}:{api:CredentialStoreApi}){
 const {locale,t}=useI18n()
 const [status,setStatus]=useState<CredentialStoreStatus>()
 const [selected,setSelected]=useState<readonly string[]>([])
 const [confirming,setConfirming]=useState(false)
 const [busy,setBusy]=useState(false)
 const [error,setError]=useState<string>()
 const [refused,setRefused]=useState(0)
 const load=useCallback(()=>{api.status().then(next=>{setStatus(next);setError(undefined);setSelected(ids=>ids.filter(id=>next.copies.some(copy=>copy.id===id&&!copy.shared)))},cause=>setError(localizeWorkError(locale,cause)))},[api,locale])
 // 挂载时读一次（设置面板可能已可见），之后每次设置面板变为可见时重读。
 useEffect(()=>{load();return subscribeSettingsPanelVisible(visible=>{if(visible)load()})},[load])
 const remove=async()=>{
  setBusy(true);setError(undefined);setRefused(0)
  try{const next=await api.deleteCopies(selected);setStatus(next);setSelected([]);setRefused(next.refused??0)}catch(cause){setError(localizeWorkError(locale,cause))}finally{setBusy(false);setConfirming(false)}
 }
 const faultDetail=status?.fault==='key-unavailable'?t('credentialStore.locked.keyUnavailable'):status?.fault==='document-corrupt'?t('credentialStore.locked.corrupt'):status?.fault==='meta-missing'||status?.fault==='meta-invalid'?t('credentialStore.locked.meta'):status?.fault==='store-unavailable'?t('credentialStore.locked.storeUnavailable'):''
 // 与其他路径共用内容的项（硬链接）服务端不会删除：不可勾选，全选也不含它。
 const selectable=status?.copies.filter(copy=>!copy.shared)??[]
 const allSelected=selectable.length>0&&selectable.every(copy=>selected.includes(copy.id))
 return <section className={css.page} aria-label={t('credentialStore.title')}>
  <h2>{t('credentialStore.title')}</h2>
  {status?.fault&&<div className={css.missing} role="alert"><TriangleAlert size={15} aria-hidden="true"/><span>{t('credentialStore.locked')} {faultDetail}</span></div>}
  {status&&!status.fault&&status.tier==='plaintext'&&<div className={css.missing} role="alert"><TriangleAlert size={15} aria-hidden="true"/><span>{t('credentialStore.tier.plaintext')}</span></div>}
  {status&&!status.fault&&(status.tier==='keyring'||status.tier==='file')&&<div className={css.row}><div className={css.rowText}><p>{t(status.tier==='keyring'?'credentialStore.tier.keyring':'credentialStore.tier.file')}</p></div></div>}
  {error&&<p role="alert">{error}</p>}
  {refused>0&&<p role="status">{t('credentialStore.copies.refused',{count:refused})}</p>}
  {status&&status.copies.length>0&&<section className={css.recent} aria-label={t('credentialStore.copies.title')}>
   <header className={css.recentHeader}><h3>{t('credentialStore.copies.title')}</h3>
    {confirming?<span className={css.rowControl}><button type="button" disabled={busy} onClick={()=>void remove()}>{t('credentialStore.copies.delete')}</button><button type="button" disabled={busy} onClick={()=>setConfirming(false)}>{t('credentialStore.copies.cancel')}</button></span>
     :<button type="button" disabled={busy||!selected.length} onClick={()=>setConfirming(true)}>{t('credentialStore.copies.delete')}</button>}
   </header>
   <p>{confirming?t('credentialStore.copies.confirm',{count:selected.length}):t('credentialStore.copies.hint')}</p>
   <label className={css.recentRow}><input type="checkbox" checked={allSelected} disabled={busy||confirming||!selectable.length} onChange={event=>{const checked=event.target.checked;setSelected(checked?selectable.map(copy=>copy.id):[])}}/><span className={css.name}>{t('credentialStore.copies.selectAll')}</span></label>
   {status.copies.map(copy=><label className={css.recentRow} key={copy.id}><input type="checkbox" checked={selected.includes(copy.id)} disabled={busy||confirming||copy.shared} onChange={event=>{const checked=event.target.checked;setSelected(ids=>checked?[...ids,copy.id]:ids.filter(id=>id!==copy.id))}}/><span className={css.name}>{copy.label}</span>{copy.shared&&<span className={css.status}>{t('credentialStore.copies.shared')}</span>}</label>)}
  </section>}
 </section>
}
