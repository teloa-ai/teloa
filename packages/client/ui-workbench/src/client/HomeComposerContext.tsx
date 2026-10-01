import {useEffect,useRef,useState,useSyncExternalStore} from 'react'
import type {PropsRuntime} from '@deepseek-ai/dsh-client-ui-slots'
import type {BindingClient} from './binding-client.js'
import type {HomeContextApi,HomeWorkContext} from './home-native-controller.js'
import type {HomeWorkAssigneeOption} from './home-work-assignee.js'
import {useBusinessScopes} from './business-scope-context.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import {homeNativeCopy} from './home-native-copy.js'
import css from './HomeComposerContext.module.css'

type Props=PropsRuntime<'conversation.input.left'>&{api:HomeContextApi;work:BindingClient;isNativeChild:(id:string)=>boolean;isAssistantContext:(id:string)=>Promise<boolean>;roles:()=>Promise<HomeWorkAssigneeOption[]>;block:(sessionId:string,reason:string|undefined)=>void}
/** 选择只写受信上下文；主助手及真正接手岗位仍由后端分别核验。 */
export function HomeComposerContext({sessionId,useSession,useInput,api,roles,block,work,isNativeChild,isAssistantContext}:Props){
 const {locale}=useI18n(),scopes=useBusinessScopes(),copy=(key:Parameters<typeof homeNativeCopy>[1])=>homeNativeCopy(locale,key)
 const binding=useSyncExternalStore(work.subscribe,work.getSnapshot)
 const excluded=isNativeChild(sessionId)||binding.sessionId===sessionId&&binding.conversation?.purpose==='task-run'
 const bindingReady=binding.sessionId===sessionId&&binding.status==='ready'
 const [objectIdentity,setObjectIdentity]=useState(false)
 const session=useSession(value=>value),input=useInput(value=>value)
 const [context,setContext]=useState<HomeWorkContext|null>(null),[options,setOptions]=useState<HomeWorkAssigneeOption[]>([])
 const [status,setStatus]=useState<'loading'|'ready'|'saving'|'failed'>('loading'),[error,setError]=useState<string>(),[lostAttachments,setLostAttachments]=useState(false)
 const generation=useRef(0),pending=api.pending(),locked=context?.locked||session.pendingSubmissions.length>0||!session.blank
 const refresh=async()=>{
  if(excluded){block(sessionId,undefined);return}
  if(!bindingReady){block(sessionId,copy('reading'));return}
  const current=++generation.current;setStatus('loading');setError(undefined);block(sessionId,copy('reading'))
  try{const linked=!await isAssistantContext(sessionId);if(current!==generation.current)return;setObjectIdentity(linked);if(linked){block(sessionId,undefined);return}
   const [row,available]=await Promise.all([api.read(sessionId),roles()]);if(current!==generation.current)return;setContext(row);setOptions(available);if(api.pending()?.sessionId===sessionId){setStatus('failed');setError(copy('failed'));block(sessionId,copy('failed'))}else{setStatus('ready');block(sessionId,undefined)}}
  catch(cause){if(current!==generation.current)return;setError(localizeWorkError(locale,cause));setStatus('failed');block(sessionId,copy('failed'))}
 }
 useEffect(()=>{void refresh();return()=>{generation.current++;block(sessionId,undefined)}},[sessionId,api,bindingReady,excluded])
 useEffect(()=>api.subscribe(()=>{void refresh()}),[sessionId,api,bindingReady,excluded])
 useEffect(()=>{
  const key='teloa.home-attachment-count/'+sessionId
  try{setLostAttachments(Number(sessionStorage.getItem(key))>0&&input.attachmentIds.length===0)}catch{/* 附件提示不阻断读取。 */}
 },[sessionId])
 useEffect(()=>{try{sessionStorage.setItem('teloa.home-attachment-count/'+sessionId,String(input.attachmentIds.length))}catch{/* 原生附件仍由运行期所有者保留。 */}},[sessionId,input.attachmentIds.length])
 const change=async(scopeId:string,roleId:string|null,retry=false)=>{
  if(!retry&&(locked||status!=='ready'))return
  const current=++generation.current;setStatus('saving');setError(undefined);block(sessionId,copy('saving'))
  try{const row=await (retry?api.retry():api.set({sessionId,scopeId,roleId,expectedVersion:context?.version??0}));if(current!==generation.current)return;setContext(row);setStatus('ready');block(sessionId,undefined)}
  catch(cause){if(current!==generation.current)return;setError(localizeWorkError(locale,cause));setStatus('failed');block(sessionId,copy('failed'))}
 }
 const scopeId=context?.scopeId??'general',roleId=context?.roleId??null
 if(excluded||objectIdentity)return lostAttachments?<div className={css.context}><p className={css.notice} role="status">{copy('attachments')}</p></div>:null
 const readonly=locked||status!=='ready'||!!pending
 return <div className={css.context} aria-busy={status==='loading'||status==='saving'}>
  {locked?<span className={css.fixed} aria-label={copy('scope')} title={copy('scope')}>{scopes[scopeId]??scopeId}</span>:<label><span className={css.visuallyHidden}>{copy('scope')}</span><select aria-label={copy('scope')} value={scopeId} disabled={readonly} onChange={event=>void change(event.target.value,roleId)}>{Object.entries(scopes).filter(([id])=>!roleId||id==='general'||options.some(role=>role.id===roleId&&role.scopes.includes(id))).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label>}
  {roleId&&<span className={css.fixed}>{copy('owner')} · {options.find(role=>role.id===roleId)?.name??copy('missing')}{!locked&&<button type="button" disabled={readonly} aria-label={locale.startsWith('zh')?'移除指定员工':'Remove assigned employee'} onClick={()=>void change(scopeId,null)}>×</button>}</span>}
  {status==='loading'||status==='saving'?<span className={css.visuallyHidden} role="status">{copy(status==='saving'?'saving':'reading')}</span>:null}
  {(error||lostAttachments)&&<div className={css.notice}>{error&&<p role="alert">{error} <button type="button" onClick={()=>void (pending?.sessionId===sessionId?change(scopeId,roleId,true):refresh())}>{copy('retry')}</button></p>}{lostAttachments&&<p role="status">{copy('attachments')}</p>}</div>}
 </div>
}
