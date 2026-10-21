import {useEffect,useRef,useState} from 'react'
import type {ResourceUsagePage,ResourceUsageTarget,WorkResource} from '@teloa/contract'
import type {ResourceApi} from './resource-api.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import {RefreshCw} from 'lucide-react'
import css from './ResourceCitationHistory.module.css'

/** 只呈现原消息的引用事实；缺失历史不等同没有引用。切换资料或连接时旧回包不能覆盖新对象。 */
export function ResourceUsage({resource,api,open}:{resource:WorkResource;api:ResourceApi;open?:((target:ResourceUsageTarget)=>void)|undefined}){
 const {t,locale}=useI18n(),text=(cn:string,hant:string,en:string)=>locale==='zh-CN'?cn:locale.startsWith('zh')?hant:en
 const [state,setState]=useState<{api:ResourceApi;key:string;page?:ResourceUsagePage;error?:string}>(),[loading,setLoading]=useState(false),[retry,setRetry]=useState(0)
 const key=resource.ownerId+':'+resource.id+':'+resource.version,request=useRef<AbortController>()
 const current=state?.api===api&&state.key===key?state:undefined
 const read=async(cursor?:string)=>{
  if(!api.usage)return
  request.current?.abort();const controller=new AbortController();request.current=controller;setLoading(true)
  try{
   const page=await api.usage(resource,cursor,controller.signal)
   if(controller.signal.aborted)return
   setState(previous=>({api,key,page:cursor&&previous?.api===api&&previous.key===key&&previous.page?{...page,scanned:previous.page.scanned+page.scanned,unavailable:previous.page.unavailable+page.unavailable,items:[...previous.page.items,...page.items.filter(item=>!previous.page!.items.some(old=>old.sessionId===item.sessionId))]}:page}))
  }catch(error){if(!controller.signal.aborted)setState(previous=>({api,key,...(previous?.api===api&&previous.key===key&&previous.page?{page:previous.page}:{}),error:localizeWorkError(locale,error)}))}
  finally{if(!controller.signal.aborted)setLoading(false)}
 }
 useEffect(()=>{void read();return()=>request.current?.abort()},[api,key,retry,locale])
 return <section className={css.root} aria-label={text('被引用','被引用','Cited in')}>
  <header className={css.usageHeader}><h3>{text('被引用','被引用','Cited in')}</h3>{api.usage&&<button type="button" disabled={loading} aria-label={text('刷新引用记录','重新整理引用紀錄','Refresh citations')} onClick={()=>setRetry(value=>value+1)}><RefreshCw size={14}/></button>}</header>
  <p className={css.hint}>{text('以下会话的原消息引用了此资料，版本按当时记录显示。','以下對話的原訊息引用了此資料，版本依當時紀錄顯示。','Original messages that cited this material, with the version used at the time.')}</p>
  {!api.usage&&<p>{text('当前宿主未提供引用查询。','目前宿主未提供引用查詢。','Citation lookup is unavailable on this host.')}</p>}
  {loading&&<p role="status">{t('knowledge.ui.085')}</p>}
  {current?.error&&<p role="alert">{current.error} <button type="button" disabled={loading} onClick={()=>setRetry(value=>value+1)}>{t('common.retry')}</button></p>}
  {current?.page?.items.map(item=><div className={css.reference} key={item.sessionId}>{open?<button type="button" onClick={()=>open({kind:'conversation',id:item.sessionId,messageId:item.messageId})}>{item.title}</button>:<strong>{item.title}</strong>}<span>v{item.version}</span></div>)}
  {current?.page&&<p className={css.hint}>{text(`已核对 ${current.page.scanned} 个会话`,`已核對 ${current.page.scanned} 個對話`,`Checked ${current.page.scanned} conversations`)}{current.page.unavailable>0&&text(`，其中 ${current.page.unavailable} 个历史暂不可读`,`，其中 ${current.page.unavailable} 個歷史暫時無法讀取`,`, ${current.page.unavailable} histories unavailable`)}</p>}
  {current?.page&&!loading&&!current.error&&current.page.items.length===0&&<p>{current.page.nextCursor||current.page.unavailable?text('已核对范围内未找到引用，仍有历史待核对。','已核對範圍內未找到引用，仍有歷史待核對。','No citations in the checked histories; some histories remain unchecked.'):text('未找到此资料的会话引用。','未找到此資料的對話引用。','No conversation citations found.')}</p>}
  {current?.page?.nextCursor&&<button type="button" disabled={loading} onClick={()=>void read(current.page!.nextCursor!)}>{text('继续核对历史','繼續核對歷史','Check more histories')}</button>}
  <h3>{text('关联工作','關聯工作','Related work')}</h3>
  {current?.page?.related.map(item=><div className={css.reference} key={item.kind+item.id+(item.kind==='group'?'@'+item.version:'')}>{open?<button type="button" onClick={()=>open(item)}>{item.title}</button>:<strong>{item.title}</strong>}<span>{item.kind==='group'?text(`群引用 · v${item.version} · ${item.count} 条消息`,`群引用 · v${item.version} · ${item.count} 則訊息`,`Group citation · v${item.version} · ${item.count} messages`):item.kind==='task'?text('任务','工作','Task'):item.kind==='project'?text('项目','專案','Project'):text('已分配员工','已指派員工','Assigned employee')}</span></div>)}
  {current?.page?.related.length===0&&<p className={css.hint}>{text('尚无直接关联的工作。','尚無直接關聯的工作。','No directly related work.')}</p>}
  {current?.page?.relatedMore&&<p className={css.hint}>{text('仅显示前 20 项，请在工作目录继续查看。','僅顯示前 20 項，請在工作目錄繼續查看。','Showing the first 20. Continue in the work directory.')}</p>}
 </section>
}
