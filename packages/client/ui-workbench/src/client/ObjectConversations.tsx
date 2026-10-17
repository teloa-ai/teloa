import {ToolbarIconButton} from './ToolbarIconButton.js'
import {ClipboardCheck,Info,Link2,MessageCirclePlus,RefreshCw,Unlink} from 'lucide-react'
import {useEffect,useId,useRef,useState,useSyncExternalStore} from 'react'
import type {Conversation,WorkError} from '@teloa/contract'
import type {UseSessions} from '@deepseek-ai/dsh-client-ui-session/client'
import {presentConversations} from './work-presentation.js'
import type {BindingClient} from './binding-client.js'
import type {ConversationManagement} from './conversation-management.js'
import type {ConversationObject,ObjectConversationLink} from './object-conversations.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './ObjectConversations.module.css'

type MayContinue=()=>boolean
export function ObjectConversations({identity,prepare,persistence,object,links,work,management,useSessions,link,unlink,open,create}:{identity?:object;prepare?:((conversation:Conversation,mayContinue?:MayContinue)=>Promise<void>)|undefined;persistence?:{load:(mayContinue?:MayContinue)=>Promise<void>;recover:(mayContinue?:MayContinue)=>Promise<void>;pending:boolean;error:WorkError|undefined}|undefined;object:ConversationObject;links:readonly ObjectConversationLink[];work:BindingClient;management:ConversationManagement;useSessions:UseSessions;link:(conversation:Conversation,mayContinue?:MayContinue)=>void|Promise<void>;unlink:(id:string,mayContinue?:MayContinue)=>void|Promise<void>;open:(sessionId:string,mayContinue?:MayContinue)=>Promise<void>;create:()=>void}){
 const {locale,t,dateTime}=useI18n()
 const directory=useSyncExternalStore(work.subscribe,work.getDirectorySnapshot),managed=useSyncExternalStore(management.subscribe,management.getSnapshot)
 const native=useSessions(value=>value.byId)
 const presented=presentConversations(directory.rows,Object.values(native)),titles=new Map(presented.map(row=>[row.conversation.id,row.title]))
 const owner=useRef({identity:identity??work,work,kind:object.kind,id:object.id,persistent:!!persistence,active:false,running:false})
 if(owner.current.identity!==(identity??work)||owner.current.work!==work||owner.current.kind!==object.kind||owner.current.id!==object.id||owner.current.persistent!==!!persistence)owner.current={identity:identity??work,work,kind:object.kind,id:object.id,persistent:!!persistence,active:false,running:false}
 const origin=owner.current,[viewOrigin,setViewOrigin]=useState(origin),visible=viewOrigin===origin,current=()=>owner.current===origin&&origin.active
 const [loadedState,setLoaded]=useState(!persistence),loaded=visible&&loadedState
 const [chosen,setChosen]=useState(''),[query,setQuery]=useState(''),[picking,setPicking]=useState(false),[about,setAbout]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false),[refocus,setRefocus]=useState(0)
 const pickerGeneration=useRef(0),anchor=useRef<HTMLButtonElement|null>(null),popover=useRef<HTMLDivElement>(null),popoverId=useId(),aboutId=useId()
 // 查找词与选择按对象保留；换对象才清空，关闭弹层不丢草稿。
 useEffect(()=>{origin.active=true;setViewOrigin(origin);setPicking(false);setQuery('');setChosen('');setError('');setBusy(false);return()=>{origin.active=false}},[origin])
 useEffect(()=>{let active=true;setLoaded(!persistence);if(persistence){void persistence.load(current).then(()=>{if(active&&current())setLoaded(true)}).catch(cause=>{if(active&&current())setError(localizeWorkError(locale,cause))})}return()=>{active=false}},[origin,locale])
 // 弹层每次打开换代；在途回包只收尾发起时的同一对象与同一弹层。
 useEffect(()=>{if(picking)pickerGeneration.current++},[picking])
 const blocked=visible&&busy||!loaded||!!persistence?.pending||!!persistence?.error
 const rows=visible?links.filter(row=>row.kind===object.kind&&row.objectId===object.id):[]
 const candidates=presented.filter(row=>row.conversation.status==='ready'&&!managed.archived.includes(row.conversation.sessionId)&&!rows.some(item=>item.conversationId===row.conversation.id))
 const needle=query.trim().toLocaleLowerCase(),matches=needle?candidates.filter(row=>row.title.toLocaleLowerCase().includes(needle)):candidates
 const act=async(run:(mayContinue:MayContinue)=>void|Promise<void>)=>{if(!current()||origin.running)return false;origin.running=true;setBusy(true);setError('');try{await run(current);return current()}catch(cause){if(current())setError(localizeWorkError(locale,cause));return false}finally{origin.running=false;if(current())setBusy(false)}}
 const closePicker=(restore:boolean)=>{setPicking(false);if(restore)setRefocus(value=>value+1)}
 // 入口在途时处于禁用态；提交后再还原焦点。
 useEffect(()=>{if(refocus)anchor.current?.focus()},[refocus])
 // 与模态关闭一致：按下和松开都在弹层与入口之外才关闭，拖出不误关。
 useEffect(()=>{
  if(!visible||!picking)return
  const inside=(target:EventTarget|null)=>target instanceof Node&&(!!popover.current?.contains(target)||!!anchor.current?.contains(target))
  let pressed=false
  const down=(event:PointerEvent)=>{pressed=!inside(event.target)},up=(event:PointerEvent)=>{if(pressed&&!inside(event.target))setPicking(false);pressed=false},cancel=()=>{pressed=false}
  document.addEventListener('pointerdown',down,true);document.addEventListener('pointerup',up,true);document.addEventListener('pointercancel',cancel,true)
  return()=>{document.removeEventListener('pointerdown',down,true);document.removeEventListener('pointerup',up,true);document.removeEventListener('pointercancel',cancel,true)}
 },[visible,picking])
 useEffect(()=>{if(picking)popover.current?.querySelector<HTMLInputElement>('input')?.focus()},[picking])
 const choose=(id:string)=>{
  if(blocked||origin.running||!object.canStart)return
  const picker=pickerGeneration.current;setChosen(id)
  void act(async mayContinue=>{const row=candidates.find(value=>value.conversation.id===id);if(!row)throw Object.assign(Error(),{code:'teloa/source-unavailable'});await link(row.conversation,mayContinue)}).then(done=>{if(done&&current()&&picker===pickerGeneration.current){setChosen('');setQuery('');closePicker(true)}})
 }
 const errorAlert=visible&&error&&<p role="alert">{error}</p>
 return <section className={css.panel} aria-label={t('objectConversations.aria')}><header><h3>{t('objectConversations.title',{count:rows.length})}</h3><div className={css.actions}>
  <ToolbarIconButton label={t(object.kind==='task'&&!rows.length?'objectConversations.continue':'objectConversations.create')} icon={MessageCirclePlus} disabled={!object.canStart||blocked} onClick={create}/>
  <span className={css.anchor} ref={node=>{anchor.current=node?.querySelector('button')??null}}><ToolbarIconButton label={t('objectConversations.link')} icon={Link2} disabled={!object.canStart||blocked} aria-haspopup="dialog" aria-expanded={visible&&picking} aria-controls={visible&&picking?popoverId:undefined} onClick={()=>setPicking(value=>!value)}/>
   {visible&&picking&&<div ref={popover} id={popoverId} className={css.popover} role="dialog" aria-label={t('objectConversations.link')} onKeyDown={event=>{if(event.key!=='Escape')return;event.preventDefault();event.stopPropagation();closePicker(true)}}>
    <input type="search" aria-label={t('objectConversations.choose')} placeholder={t('adoptDialog.placeholder')} value={query} onChange={event=>setQuery(event.target.value)}/>
    {errorAlert}
    {matches.length?<ul className={css.candidates} aria-label={t('objectConversations.existing')} aria-busy={busy}>{matches.map(row=><li key={row.conversation.id}><button type="button" aria-current={chosen===row.conversation.id?'true':undefined} disabled={blocked||!object.canStart} onClick={()=>choose(row.conversation.id)}><span>{row.title}</span><small>{dateTime(row.updatedAt,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</small></button></li>)}</ul>:<p>{t('adoptDialog.noMatches')}</p>}
   </div>}
  </span>
  <ToolbarIconButton label={t('objectConversations.refresh')} icon={RefreshCw} disabled={!visible||busy} onClick={()=>void act(async mayContinue=>{await work.refreshDirectory();if(!mayContinue())return;if(persistence){await persistence.load(mayContinue);if(mayContinue())setLoaded(true)}})}/>
  <ToolbarIconButton label={t('objectConversations.boundary')} icon={Info} aria-expanded={about} aria-controls={aboutId} onClick={()=>setAbout(value=>!value)}/>
 </div></header>
 <p id={aboutId} hidden={!about}>{t(persistence?'objectConversations.saved':'objectConversations.preview')} {t('objectConversations.boundary')}</p>
 {persistence?.pending&&<button type="button" className={css.recover} disabled={!visible||busy} onClick={()=>void act(persistence.recover)}>{t('objectConversations.recover')}</button>}{persistence?.error&&<p role="alert">{localizeWorkError(locale,persistence.error)} {t('recovery.nextStep')}</p>}
 {!picking&&errorAlert}{Boolean(directory.error)&&<p role="alert">{localizeWorkError(locale,directory.error)}</p>}
 {!object.canStart&&<p>{t('objectConversations.readOnly')}</p>}
 {!rows.length&&<p>{t('objectConversations.empty')}</p>}
 <ul>{rows.map(row=>{const conversation=directory.rows.find(value=>value.id===row.conversationId&&value.sessionId===row.sessionId),taskRun=row.sessionId.startsWith('task-run-'),archived=managed.archived.includes(row.sessionId);return <li key={row.conversationId}><div><button type="button" className={css.name} title={t('objectConversations.open')} disabled={visible&&busy||archived||(!conversation&&!taskRun)} onClick={()=>void act(mayContinue=>open(row.sessionId,mayContinue))}>{conversation?(titles.get(conversation.id)||conversation.title):taskRun?t('taskExecution.title'):t('objectConversations.unavailable')}</button><small>{t(row.sourceOnly?'objectConversations.source':archived?'objectConversations.archived':row.objectVersion!==object.version?'objectConversations.changed':'objectConversations.independent')}</small></div>{prepare&&!row.sourceOnly&&<ToolbarIconButton label={t('objectConversations.prepare')} icon={ClipboardCheck} disabled={blocked||!object.canStart||!conversation||archived} onClick={()=>conversation&&void act(mayContinue=>prepare(conversation,mayContinue))}/>}<ToolbarIconButton label={t('objectConversations.unlink')} icon={Unlink} disabled={blocked||!object.canStart&&!row.sourceOnly} onClick={()=>void act(mayContinue=>unlink(row.conversationId,mayContinue))}/></li>})}</ul>
 </section>
}
