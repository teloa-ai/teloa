import { useEffect,useState,useSyncExternalStore } from 'react'
import { isWebAccessBlockedHost } from '@teloa/contract'
import type { WebAccessApi } from './web-access-api.js'
import { webAccessDrafts, type WebAccessDraft } from './web-access-drafts.js'
import { useI18n } from './i18n/provider.js'
import { localizeWorkError } from './i18n/errors.js'
import css from './WebAccessSettings.module.css'

/**
 * 设置壳只渲染当前选中的一节，切走即卸载（教训 c，见 web-access-drafts.ts 顶部注释）：
 * 编辑中的总开关、拦截名单与输入框都从跨挂载的 `webAccessDrafts` 单例取，不落在组件自己的
 * `useState(初值)` 上，切到别的设置节再切回来草稿也不会丢。`busy`/`error` 这类瞬时反馈与
 * 用户没有编辑价值的状态，仍留在组件本地。
 */
export function WebAccessSettings({api,embedded=false}:{api:WebAccessApi;embedded?:boolean}){
 const {locale,t}=useI18n()
 const draft=useSyncExternalStore(webAccessDrafts.subscribe,webAccessDrafts.getSnapshot)
 const [version,setVersion]=useState<number>(),[busy,setBusy]=useState(false),[error,setError]=useState<string>(),[discarded,setDiscarded]=useState(false)
 useEffect(()=>{let live=true
  api.get().then(value=>{
   if(!live)return
   setVersion(value.version)
   // 已有草稿（比如从别的设置节切回来）不覆盖：那正是草稿要保住的编辑。
   if(!webAccessDrafts.read())webAccessDrafts.write({enabled:value.enabled,blocked:[...value.blocked],input:''})
  },e=>{if(live)setError(localizeWorkError(locale,e))})
  return ()=>{live=false}
 },[api,locale])
 const pending=api.pending(),failure=api.recoveryMessage()
 const locked=busy||!!pending||!!failure
 const write=(next:WebAccessDraft)=>webAccessDrafts.write(next)
 const addHost=()=>{
  if(!draft)return
  const host=draft.input.trim()
  if(!isWebAccessBlockedHost(host)){setError(t('webAccess.settings.blockInvalid'));return}
  setError(undefined)
  if(draft.blocked.includes(host)){write({...draft,input:''});return}
  write({...draft,blocked:[...draft.blocked,host],input:''})
 }
 const removeHost=(host:string)=>{if(draft)write({...draft,blocked:draft.blocked.filter(item=>item!==host)})}
 const save=async()=>{
  if(!draft||version===undefined||locked)return
  setBusy(true);setError(undefined)
  try{
   const result=await api.change({requestId:crypto.randomUUID(),expectedVersion:version,enabled:draft.enabled,blocked:draft.blocked})
   // 不清空草稿：草稿是 useSyncExternalStore 的编辑态来源，clear() 会让界面在同一页面会话内
   // 短暂回落成「总开关关闭、拦截名单为空」的错误展示态，直到下一次挂载的 useEffect 重读服务端。
   // 改成用回包重写草稿为「已保存态」，与加载路径（第 24 行）同形。
   webAccessDrafts.write({enabled:result.enabled,blocked:[...result.blocked],input:''});setVersion(result.version)
  }catch(e){
   setError(localizeWorkError(locale,e))
   // 任何一次保存失败都把 version 取回最新：否则 `teloa/version-conflict` 之后再点保存必撞同一堵墙，
   // 本人只能靠整页刷新才出得去。草稿一个字都不动（只有保存成功那一支才用回包重写为已保存态）。
   // 刷新本身也失败就保留上面那条保存失败的文案，不拿读口的错覆盖真正的原因。
   try{setVersion((await api.get()).version)}catch{/* 保留上面的 setError */}
  }finally{setBusy(false)}
 }
 return <section className={css.page} aria-label={t('webAccess.settings.title')}>
  {!embedded&&<h2>{t('webAccess.settings.title')}</h2>}
  <p className={css.hint}>{t('webAccess.settings.scope')}</p>
  {error&&<p role="alert">{error}</p>}
  {failure&&<p role="alert">{localizeWorkError(locale,failure)} {t('recovery.nextStep')}</p>}
  {failure&&<button type="button" onClick={()=>{api.discard();setDiscarded(true)}}>{t('recovery.discard')}</button>}
  {discarded&&<p role="status">{t('recovery.discarded')}</p>}
  <label className={css.toggle}>
   <input type="checkbox" checked={draft?.enabled??false} disabled={!draft||locked} onChange={event=>draft&&write({...draft,enabled:event.target.checked})}/>
   {t('webAccess.settings.enabled')}
  </label>
  <p className={css.hint}>{t('webAccess.settings.enabledHint')}</p>
  <h3>{t('webAccess.settings.blockTitle')}</h3>
  <p className={css.hint}>{t('webAccess.settings.blockHint')}</p>
  {draft&&draft.blocked.length>0?<ul className={css.blockList}>{draft.blocked.map(host=><li key={host}><code>{host}</code><button type="button" disabled={locked} onClick={()=>removeHost(host)}>{t('webAccess.settings.blockRemove')}</button></li>)}</ul>:<p className={css.hint}>{t('webAccess.settings.blockEmpty')}</p>}
  <form className={css.add} onSubmit={event=>{event.preventDefault();addHost()}}>
   <input aria-label={t('webAccess.settings.blockTitle')} placeholder="example.com" value={draft?.input??''} disabled={!draft||locked} onChange={event=>draft&&write({...draft,input:event.target.value})}/>
   <button type="submit" disabled={!draft||locked||!draft.input.trim()}>{t('webAccess.settings.blockAdd')}</button>
  </form>
  <p className={css.hint}>{t('webAccess.settings.disclosure')}</p>
  <div className={css.actions}><button type="button" disabled={!draft||version===undefined||locked} onClick={()=>void save()}>{t('roleGrant.save')}</button></div>
 </section>
}
