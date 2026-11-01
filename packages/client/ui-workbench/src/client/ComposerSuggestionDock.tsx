import {Component,useCallback,useEffect,useMemo,useRef,useState,useSyncExternalStore,type ReactNode} from 'react'
import {ComposerSuggestionGhost} from './ComposerSuggestionGhost.tsx'
import {ComposerSuggestionController,createSuggestionValidity} from './composer-suggestion-controller.ts'
import {readSuggestionEnabled,subscribeSuggestionEnabled} from './composer-suggestion.ts'
import {readComposerSuggestionAnswer,type ComposerSuggestionEvents} from './composer-suggestion-events.ts'

type Pending={answerSeq:number;abort:AbortController}
type SharedEntry={controller:ComposerSuggestionController;listeners:Set<()=>void>;requested:Set<number>;pending?:Pending|undefined}
const sharedControllers=new WeakMap<ComposerSuggestionEvents,Map<string,SharedEntry>>()
function sharedEntry(events:ComposerSuggestionEvents|undefined,sessionId:string,enabled:boolean):SharedEntry{
 let sessions=events?sharedControllers.get(events):undefined
 if(!sessions&&events){sessions=new Map();sharedControllers.set(events,sessions)}
 let entry=sessions?.get(sessionId)
 if(!entry){entry={controller:new ComposerSuggestionController(enabled),listeners:new Set(),requested:new Set()};sessions?.set(sessionId,entry)}
 return entry
}
function notify(entry:SharedEntry){for(const listener of [...entry.listeners])listener()}
function cancelPending(entry:SharedEntry){
 const pending=entry.pending
 if(!pending)return
 entry.pending=undefined
 entry.requested.delete(pending.answerSeq)
 pending.abort.abort()
}

type InputLike={getSnapshot?:()=>{draft?:string;focused?:boolean};subscribe?:(listener:()=>void)=>()=>void}
export type ComposerSuggestionDockProps={
 overlay?:boolean
 sessionId:string
 events?:ComposerSuggestionEvents|undefined
 input?:InputLike
 running?:boolean
 insertText?:(text:string)=>void
 /** 宿主模型是候选的唯一来源；失败或空结果不显示建议。 */
 suggest?:(signal?:AbortSignal,options?:{cacheOnly:true})=>Promise<string|null>
 stateFor?:(sessionId:string)=>InputLike|undefined
 runningFor?:(sessionId:string)=>boolean
 insertFor?:(sessionId:string,text:string)=>void
}
const noopSubscribe=()=>()=>{}
function useDraft(input:InputLike|undefined):string{
 const subscribe=useCallback((listener:()=>void)=>input?.subscribe?.(listener)??noopSubscribe(),[input])
 return useSyncExternalStore(subscribe,()=>String(input?.getSnapshot?.().draft??''),()=>'')
}

/** 这个槽属于官方输入框，建议失败不能使输入框本身不可用。 */
class SuggestionBoundary extends Component<{children:ReactNode},{failed:boolean}>{
 constructor(props:{children:ReactNode}){super(props);this.state={failed:false}}
 static getDerivedStateFromError(){return {failed:true}}
 componentDidCatch(){}
 render(){return this.state.failed?null:this.props.children}
}

function ComposerSuggestionDockInner({sessionId,events,input,running,insertText,suggest,overlay,stateFor,runningFor,insertFor}:ComposerSuggestionDockProps){
 const resolvedInput=stateFor?stateFor(sessionId):input
 const resolvedRunning=runningFor?runningFor(sessionId):running
 const enabled=useSyncExternalStore(subscribeSuggestionEnabled,()=>readSuggestionEnabled(globalThis.localStorage),()=>true)
 const entry=useMemo(()=>sharedEntry(events,sessionId,readSuggestionEnabled(globalThis.localStorage)),[events,sessionId])
 const controller=entry.controller
 const latest=useRef({sessionId,entry,events,input:resolvedInput,running:resolvedRunning})
 latest.current={sessionId,entry,events,input:resolvedInput,running:resolvedRunning}
 const subscribe=useCallback((listener:()=>void)=>{
  entry.listeners.add(listener)
  return()=>{
   entry.listeners.delete(listener)
   // StrictMode 的同批卸载/重挂共享一次请求；真正离开该会话则取消。
   queueMicrotask(()=>{if(entry.listeners.size===0)cancelPending(entry)})
  }
 },[entry])
 const snapshot=useSyncExternalStore(subscribe,()=>controller.snapshot,()=>controller.snapshot)
 const refresh=useCallback(()=>notify(entry),[entry])
 const subscribeEvents=useCallback((listener:()=>void)=>events?.subscribe(listener)??noopSubscribe(),[events])
 const answerSeq=useSyncExternalStore(subscribeEvents,()=>events?readComposerSuggestionAnswer(events.getSnapshot().entries):null,()=>null)
 const draft=useDraft(resolvedInput)
 // 注入函数可能每次渲染生成新引用；改变函数引用不能取消同一请求或重算同一回复。
 const suggestRef=useRef(suggest);suggestRef.current=suggest
 const hasSuggest=typeof suggest==='function'
 const composerAnchor=useRef<HTMLSpanElement|null>(null)
 const findComposer=useCallback(()=>{
  const selector='div[data-composer-input][contenteditable="true"]'
  // 官方 ConversationRoot 以这个容器标记当前会话；嵌套会话不属于本输入面。
  const owner=composerAnchor.current?.closest<HTMLElement>('[data-conversation-session]')
  if(owner){
   if(owner.dataset.conversationSession!==sessionId)return null
   const local=[...owner.querySelectorAll<HTMLElement>(selector)].filter(editor=>editor.closest('[data-conversation-session]')===owner)
   return local.length===1?local[0]??null:null
  }
  // 兼容没有会话容器的单输入面；多个目标或其他会话不能猜第一个。
  const editors=document.querySelectorAll<HTMLElement>(selector),editor=editors.length===1?editors[0]:undefined
  const session=editor?.closest<HTMLElement>('[data-conversation-session]')?.dataset.conversationSession
  return editor&&(session===undefined||session===sessionId)?editor:null
 },[sessionId])
 const [portalTarget,setPortalTarget]=useState<HTMLElement|null>(()=>findComposer())
 useEffect(()=>{
  const read=()=>{const next=findComposer();setPortalTarget(previous=>previous===next?previous:next)}
  read();const timer=window.setInterval(read,200)
  return()=>window.clearInterval(timer)
 },[findComposer])
 useEffect(()=>{controller.setDraft(draft);refresh()},[controller,draft,refresh])
 useEffect(()=>{
  controller.setEnabled(enabled)
  if(!enabled||answerSeq===null||resolvedRunning===true){
   cancelPending(entry)
   if(answerSeq===null||resolvedRunning===true)controller.clearAnswer()
   refresh();return
  }
  if(entry.pending?.answerSeq!==answerSeq)cancelPending(entry)
  controller.completeAnswer(answerSeq)
  refresh()
  if(!hasSuggest||entry.requested.has(answerSeq))return
  const pending:Pending={answerSeq,abort:new AbortController()}
  entry.pending=pending;entry.requested.add(answerSeq)
  void Promise.resolve().then(()=>{
   pending.abort.signal.throwIfAborted()
   return suggestRef.current?.(pending.abort.signal)??null
  }).catch(()=>null).then(text=>{
   if(entry.pending!==pending||pending.abort.signal.aborted)return
   entry.pending=undefined
   if(!readSuggestionEnabled(globalThis.localStorage)||!events||readComposerSuggestionAnswer(events.getSnapshot().entries)!==answerSeq)return
   controller.setCandidate(answerSeq,text)
   refresh()
  })
 },[entry,controller,events,answerSeq,enabled,resolvedRunning,hasSuggest,refresh])
 const visible=enabled&&resolvedRunning!==true&&answerSeq!==null&&snapshot.answerSeq===answerSeq&&controller.decision==='show'
 const validity=useRef<ReturnType<typeof createSuggestionValidity>|null>(null)
 useEffect(()=>{
  if(!visible||!snapshot.text||!hasSuggest)return
  const text=snapshot.text
  let current:ReturnType<typeof createSuggestionValidity>|null=null,timer:number|undefined
  const stop=()=>{if(timer!==undefined)window.clearInterval(timer);timer=undefined;current?.dispose();if(validity.current===current)validity.current=null;current=null}
  const start=()=>{
   stop()
   if(document.visibilityState==='hidden'||!document.hasFocus())return
   current=createSuggestionValidity(signal=>suggestRef.current?.(signal,{cacheOnly:true})??Promise.resolve(null),text,()=>{
    if(controller.snapshot.answerSeq===answerSeq&&controller.snapshot.text===text){controller.dismiss();refresh()}
   })
   validity.current=current
   void current.check()
   timer=window.setInterval(()=>{void current?.check()},1000)
  }
  start()
  window.addEventListener('blur',stop);window.addEventListener('focus',start);document.addEventListener('visibilitychange',start)
  return()=>{stop();window.removeEventListener('blur',stop);window.removeEventListener('focus',start);document.removeEventListener('visibilitychange',start)}
 },[visible,snapshot.text,answerSeq,controller,hasSuggest,refresh])
 const accept=useCallback(async()=>{
  // Ghost 已同步 preventDefault。Tab 单独核验，不能用上一次轮询代替本次准入。
  const candidate=controller.snapshot,reader=validity.current
  const sameBinding=()=>latest.current.sessionId===sessionId&&latest.current.entry===entry&&latest.current.events===events&&latest.current.input===resolvedInput&&latest.current.running!==true
  if(!reader||!await reader.check(true)||validity.current!==reader||!sameBinding())return
  // 等待宿主重验时，输入面可能已移除、换会话或转移焦点。
  if(!portalTarget||findComposer()!==portalTarget)return
  if(document.querySelectorAll('div[data-composer-input][contenteditable="true"]').length>1&&!portalTarget.contains(document.activeElement))return
  if(!readSuggestionEnabled(globalThis.localStorage)||resolvedRunning===true||!events||readComposerSuggestionAnswer(events.getSnapshot().entries)!==candidate.answerSeq||controller.snapshot!==candidate)return
  const actual=portalTarget?.innerText??draft
  const native=resolvedInput?.getSnapshot?.().draft??draft
  if(actual.trim()||native.trim())return
  controller.setDraft(actual)
  const accepted=controller.accept()
  if(accepted===null){refresh();return}
  try{if(insertFor)insertFor(sessionId,accepted);else insertText?.(accepted)}catch{/* 草稿写入失败不触发发送或重试。 */}
  refresh()
 },[controller,draft,entry,events,findComposer,insertFor,insertText,portalTarget,refresh,resolvedInput,resolvedRunning,sessionId])
 const dismiss=useCallback(()=>{controller.dismiss();refresh()},[controller,refresh])
 const draftChanged=useCallback((text:string)=>{controller.setDraft(text);refresh()},[controller,refresh])
 return <><span ref={composerAnchor} hidden/><ComposerSuggestionGhost text={snapshot.text} visible={visible} onAccept={accept} onDismiss={dismiss} onDraft={draftChanged} target={portalTarget} {...(overlay?{overlay:true}:{})}/></>
}

export function ComposerSuggestionDock(props:ComposerSuggestionDockProps){
 return <SuggestionBoundary><ComposerSuggestionDockInner {...props}/></SuggestionBoundary>
}
