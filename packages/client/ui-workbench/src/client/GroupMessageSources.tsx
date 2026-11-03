import {useEffect,useRef,useState} from 'react'
import {MarkdownText} from '@deepseek-ai/dsh-client-ui-primitives'
import type {GroupEmployeeMessage,GroupMessage,GroupMessageSourceItem,GroupMessageSources as Sources} from '@teloa/contract'
import type {GroupApi} from './group-api.js'
import {ContextDrawer} from './ContextDrawer.js'
import {GroupMessageBodyPreview} from './GroupMessageBodyPreview.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './GroupMessageSources.module.css'

type Location={message:GroupMessage;rootId:string|null;excerpt:string}
/** 只读已验证的来源列表；正文不改写，定位仍由原群分页器处理。 */
export function GroupMessageSources({api,message,rootId,groupName,author,time,isCurrent,locate,close}:{api:Pick<GroupApi,'messageSources'|'messageBody'>;message:GroupEmployeeMessage;rootId:string|null;groupName:string;author:(message:GroupMessage)=>string;time:(value:string)=>string;isCurrent:()=>boolean;locate:(item:Location)=>Promise<boolean>;close:()=>void}){
 const {t,locale}=useI18n(),[value,setValue]=useState<Sources>(),[error,setError]=useState(''),[retry,setRetry]=useState(0),[busy,setBusy]=useState(false),[preview,setPreview]=useState<GroupMessageSourceItem>()
 const current=useRef(isCurrent),alive=useRef(true),navigating=useRef(0),moved=useRef(false);current.current=isCurrent
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;++navigating.current}},[api,message.groupId,message.id,message.runId])
 useEffect(()=>{
  let active=true;setValue(undefined);setError('')
  void api.messageSources(message.groupId,message.id,message.runId).then(result=>{if(active&&alive.current&&current.current())setValue(result)}).catch(cause=>{if(active&&alive.current&&current.current())setError(localizeWorkError(locale,cause))})
  return()=>{active=false}
 },[api,message.groupId,message.id,message.runId,retry,locale])
 const present=()=>alive.current&&current.current()
 const dismiss=()=>{++navigating.current;alive.current=false;close()}
 const returnToOrigin=async()=>{
  const generation=++navigating.current
  setBusy(true);setError('')
  try{if(!await locate({message,rootId,excerpt:message.text}))throw Error(t('group.sources.locationFailed'));if(present()&&generation===navigating.current)dismiss()}
  catch(cause){if(present()&&generation===navigating.current)setError(localizeWorkError(locale,cause))}
  finally{if(present()&&generation===navigating.current)setBusy(false)}
 }
 const reveal=async(item:GroupMessageSourceItem)=>{
  const generation=++navigating.current;moved.current=true;setBusy(true);setError('')
  try{if(!await locate({...item,excerpt:item.message.text}))throw Error(t('group.sources.locationFailed'))}
  catch(cause){if(present()&&generation===navigating.current)setError(localizeWorkError(locale,cause))}
  finally{if(present()&&generation===navigating.current)setBusy(false)}
 }
 if(!present())return null
 if(preview){
  if('runId'in preview.message&&preview.message.fullText)return <GroupMessageBodyPreview groupId={message.groupId} messageId={preview.message.id} summary={preview.message.fullText} authorName={author(preview.message)} groupName={groupName} api={api} isCurrent={present} close={()=>setPreview(undefined)} backLabel={t('group.sources.back')}/>
  return <ContextDrawer title={t('group.sources.preview')} close={()=>setPreview(undefined)}><div className={css.body}><p className={css.meta}>{author(preview.message)} · {time(preview.message.createdAt)}</p><MarkdownText text={preview.message.text} labels={{code:{copyLabel:t('collaboration.markdown.code.copyLabel'),copiedLabel:t('collaboration.markdown.code.copiedLabel')},footnotes:t('collaboration.markdown.footnotes')}}/><button type="button" onClick={()=>setPreview(undefined)}>{t('group.sources.back')}</button></div></ContextDrawer>
 }
 return <ContextDrawer title={t('group.sources.title')} close={dismiss}><div className={css.body}>
  <p className={css.meta}>{t('group.sources.readOnly')}</p>
  {error&&<p role="alert">{error} {!value&&<button type="button" onClick={()=>setRetry(value=>value+1)}>{t('common.retry')}</button>}</p>}
  {!value&&!error&&<p role="status">{t('collaboration.state.loading')}</p>}
  {value?.items.map(item=><article key={item.message.id} className={css.source}>
   <p className={css.meta}>{author(item.message)} · {time(item.message.createdAt)}</p><p className={css.excerpt}>{item.message.text}</p>
   <div className={css.actions}><button type="button" disabled={busy} onClick={()=>setPreview(item)}>{t('group.sources.read')}</button><button type="button" disabled={busy} onClick={()=>void reveal(item)}>{t('group.sources.locate')}</button></div>
  </article>)}
  {value&&!value.items.length&&!value.unavailableCount&&<p role="status">{t('group.sources.empty')}</p>}
  {!!value?.unavailableCount&&<p role="status">{t('group.sources.unavailable')}</p>}
  {moved.current&&<button type="button" disabled={busy} onClick={()=>void returnToOrigin()}>{t('group.sources.return')}</button>}
 </div></ContextDrawer>
}
