import {useEffect,useId,useRef,useState} from 'react'
import {ArrowUpRight,ArrowUp,ArrowDown,CornerDownLeft,Search,X,MessageCircle,Users,CheckSquare,Bot,Folder,FileText,Sparkles,Store,Clock,Loader2} from 'lucide-react'
import {openDialog} from './dialog-focus.js'
import {useDialogDismiss} from './use-dialog-dismiss.js'
import {filterWorkspaceSearchResults,searchWorkspace,workspaceSearchKinds,type WorkspaceSearchKindFilter,type WorkspaceSearchSource,type WorkspaceSearchResult} from './workspace-search.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import {dialogueCopy} from './dialogue-copy.js'
import {EmployeeAvatar} from './EmployeeAvatar.js'
import css from './WorkspaceSearch.module.css'

const kinds=['all','conversation','group','task','plan','role','business','knowledge','resource'] as const
/** 员工行用员工形象（分身没有形象，沿用图标）；其余类型统一 30px 图标块。 */
const resultTile=(row:WorkspaceSearchResult,Icon:typeof Bot,role?:Pick<WorkspaceSearchSource['roles'][number],'kind'|'avatarKey'>)=>row.kind==='role'&&role&&role.kind!=='twin'?<span className={css.avatarTile}><EmployeeAvatar avatarKey={role.avatarKey} size="sm"/></span>:<span className={css.tile}><Icon size={16} aria-hidden="true"/></span>
const resultIcons={conversation:MessageCircle,group:Users,task:CheckSquare,plan:Clock,role:Bot,business:Folder,knowledge:FileText,capability:Sparkles,market:Store}

/** searching：资料正文或技能仍在读取时为真，进度行显示转圈与已显示条数；其余状态文案照常逐条说明。 */
export function WorkspaceSearch({visible,source,conversationStatus,knowledgeStatus,capabilityStatus,searching=false,close,open,searchMessages}:{visible:boolean;source:WorkspaceSearchSource;conversationStatus:string;knowledgeStatus:string;capabilityStatus:string;searching?:boolean;close:()=>void;open:(row:WorkspaceSearchResult)=>Promise<void>;searchMessages:(query:string)=>void}){
 const {locale,t}=useI18n()
 const [query,setQuery]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false)
 const [selectedKind,setSelectedKind]=useState<WorkspaceSearchKindFilter>('all'),[selectedKey,setSelectedKey]=useState<string>()
 const dialog=useRef<HTMLDialogElement>(null),input=useRef<HTMLInputElement>(null),pending=useRef(false)
 const resultList=useId(),optionPrefix=useId(),options=useRef(new Map<string,HTMLButtonElement>())
 const dismissEvents=useDialogDismiss(close,!busy)
 useEffect(()=>{if(visible)return openDialog(dialog.current,input.current)},[visible])
 const trimmedQuery=query.trim()
 // 页签计数与列表同源：都来自本次未筛选的结果，「我的资源」与筛选同口径（应用 + 市场）。
 const allResults=searchWorkspace(source,query)
 const visibleResults=filterWorkspaceSearchResults(allResults,selectedKind)
 const kindCount=(kind:WorkspaceSearchKindFilter)=>filterWorkspaceSearchResults(allResults,kind).length
 const statuses=[conversationStatus,knowledgeStatus,capabilityStatus].filter(Boolean)
 const messageSearch=trimmedQuery!==''&&(selectedKind==='all'||selectedKind==='conversation')
 const keys=[...visibleResults.map(row=>row.key),...(messageSearch?['messages']:[])]
 const activeKey=selectedKey&&keys.includes(selectedKey)?selectedKey:keys[0]
 const activeIndex=activeKey?keys.indexOf(activeKey):-1
 const optionId=(key:string)=>optionPrefix+'-'+keys.indexOf(key)
 useEffect(()=>{if(visible&&activeKey)options.current.get(activeKey)?.scrollIntoView({block:'nearest'})},[visible,activeKey])
 const choose=async(row:WorkspaceSearchResult)=>{
  if(pending.current)return
  pending.current=true;setBusy(true);setError('')
  try{await open(row);close()}catch(caught){setError(localizeWorkError(locale,caught))}finally{pending.current=false;setBusy(false)}
 }
 const chooseMessages=()=>{if(pending.current)return;close();searchMessages(trimmedQuery)}
 const navigate=(event:React.KeyboardEvent)=>{
  if(event.nativeEvent.isComposing||busy)return
  if(event.key==='ArrowDown'||event.key==='ArrowUp'){
   event.preventDefault();if(keys.length)setSelectedKey(keys[(activeIndex+(event.key==='ArrowDown'?1:-1)+keys.length)%keys.length]);input.current?.focus()
  }else if(event.key==='Enter'&&activeKey){
   event.preventDefault();if(activeKey==='messages')chooseMessages();else {const row=visibleResults.find(row=>row.key===activeKey);if(row)void choose(row)}
  }
 }
 const selectKind=(kind:WorkspaceSearchKindFilter)=>{setSelectedKind(kind);setSelectedKey(undefined);setError('')}
 if(!visible)return null
 return <dialog ref={dialog} className={css.dialog} aria-label={t('workspaceSearch.title')} {...dismissEvents}>
 <header className={css.header}>
  <label className={css.search}><Search size={17} aria-hidden="true"/><input ref={input} role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls={resultList} aria-activedescendant={activeKey?optionId(activeKey):undefined} aria-label={t('workspaceSearch.inputAria')} value={query} onKeyDown={navigate} onChange={event=>{setQuery(event.target.value);setSelectedKey(undefined);setError('')}} placeholder={t('workspaceSearch.placeholder')}/></label>
  <button className={css.close} type="button" aria-label={t('workspaceSearch.closeAria')} disabled={busy} onClick={close}><X size={20}/></button>
 </header>
 <div className={css.types} role="tablist" aria-label={t('workspaceSearch.title')}>
  {kinds.map(kind=><button key={kind} type="button" role="tab" aria-selected={selectedKind===kind} aria-controls={resultList} tabIndex={selectedKind===kind?0:-1} disabled={busy} onClick={()=>selectKind(kind)} onKeyDown={event=>{
   if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return
   event.preventDefault();const index=event.key==='Home'?0:event.key==='End'?kinds.length-1:(kinds.indexOf(kind)+(event.key==='ArrowRight'?1:-1)+kinds.length)%kinds.length
   const next=kinds[index]!;selectKind(next);(event.currentTarget.parentElement?.children[index] as HTMLElement|undefined)?.focus()
  }}>{kind==='all'?t('common.all'):kind==='resource'?t('capabilityCenter.myResources'):kind==='group'||kind==='conversation'?dialogueCopy(locale,kind==='group'?'group':'session'):t(workspaceSearchKinds[kind])}{kindCount(kind)>0&&<span className={css.count} aria-hidden="true">{kindCount(kind)}</span>}</button>)}
 </div>
 <div className={css.body}>
  {statuses.length>0&&<div className={css.progress}>{searching&&<Loader2 className={css.spin} size={13} aria-hidden="true"/>}<div>{statuses.map(status=><p key={status} role="status" className={css.note}>{status}{searching&&status===statuses[statuses.length-1]&&<> {t('workspaceSearch.shown',{count:visibleResults.length})}</>}</p>)}</div></div>}
  {error&&<p role="alert" className={css.error}>{error}</p>}
  <div className={css.results} id={resultList} role="listbox" aria-label={t('workspaceSearch.title')} aria-busy={busy} onKeyDown={navigate}>
   {visibleResults.length===0&&<div className={css.empty}><h3>{t('workspaceSearch.emptyTitle')}</h3><p>{t('workspaceSearch.emptyDescription')}</p></div>}
   {visibleResults.map(row=>{const Icon=resultIcons[row.kind];return <button type="button" role="option" id={optionId(row.key)} key={row.key} ref={node=>{if(node)options.current.set(row.key,node);else options.current.delete(row.key)}} aria-selected={activeKey===row.key} tabIndex={-1} disabled={busy} onMouseMove={()=>setSelectedKey(row.key)} onClick={()=>void choose(row)}>{resultTile(row,Icon,row.kind==='role'?source.roles.find(role=>role.id===row.id):undefined)}<div><strong>{row.title}</strong><span className={css.meta}>{t(workspaceSearchKinds[row.kind])}{row.description&&<> · {row.description}</>} · {t(row.detailKey)}</span></div><ArrowUpRight size={14} aria-hidden="true"/></button>})}
   {messageSearch&&<button type="button" role="option" id={optionId('messages')} ref={node=>{if(node)options.current.set('messages',node);else options.current.delete('messages')}} aria-selected={activeKey==='messages'} tabIndex={-1} disabled={busy} onMouseMove={()=>setSelectedKey('messages')} onClick={chooseMessages}><span className={css.tile}><Search size={16} aria-hidden="true"/></span><div><strong>{t('workspaceSearch.searchMessagesTitle',{query:trimmedQuery})}</strong><span className={css.meta}>{t('workspaceSearch.detail.messages')}</span></div><ArrowUpRight size={14} aria-hidden="true"/></button>}
  </div>
 </div>
 <footer className={css.shortcuts}><span><kbd>Esc</kbd>{t('workspaceSearch.close')}</span><span><kbd aria-hidden="true"><ArrowUp size={11}/><ArrowDown size={11}/></kbd>{t('workspaceSearch.select')}</span><span><kbd aria-hidden="true"><CornerDownLeft size={11}/></kbd>{t('workspaceSearch.open')}</span></footer>
 </dialog>
}
