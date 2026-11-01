import {Component,useCallback,useEffect,useMemo,useRef,useState,useSyncExternalStore,type ReactNode} from 'react'
import {ComposerSuggestionGhost} from './ComposerSuggestionGhost.tsx'
import {ComposerSuggestionController} from './composer-suggestion-controller.ts'
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
 suggest?:(signal?:AbortSignal)=>Promise<string|null>
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
 const findComposer=()=>document.querySelector('div[data-composer-input][contenteditable="true"]') as HTMLElement|null
 const [portalTarget,setPortalTarget]=useState<HTMLElement|null>(()=>findComposer())
 useEffect(()=>{
  const read=()=>{const next=findComposer();setPortalTarget(previous=>previous===next?previous:next)}
  read();const timer=window.setInterval(read,200)
  return()=>window.clearInterval(timer)
 },[sessionId])
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
 const accept=useCallback(()=>{
  // 按键瞬间再核对本人草稿、开关与会话；不能因异步回包覆盖已有输入。
  if(!readSuggestionEnabled(globalThis.localStorage)||resolvedRunning===true||!events||readComposerSuggestionAnswer(events.getSnapshot().entries)!==controller.snapshot.answerSeq)return
  const actual=portalTarget?.innerText??draft
  controller.setDraft(actual)
  const accepted=controller.accept()
  if(accepted===null){refresh();return}
  try{if(insertFor)insertFor(sessionId,accepted);else insertText?.(accepted)}catch{/* 草稿写入失败不触发发送或重试。 */}
  refresh()
 },[controller,draft,events,insertFor,insertText,portalTarget,refresh,resolvedRunning,sessionId])
 const dismiss=useCallback(()=>{controller.dismiss();refresh()},[controller,refresh])
 const draftChanged=useCallback((text:string)=>{controller.setDraft(text);refresh()},[controller,refresh])
 const visible=enabled&&resolvedRunning!==true&&answerSeq!==null&&snapshot.answerSeq===answerSeq&&controller.decision==='show'
 return <ComposerSuggestionGhost text={snapshot.text} visible={visible} onAccept={accept} onDismiss={dismiss} onDraft={draftChanged} target={portalTarget} {...(overlay?{overlay:true}:{})}/>
}

export function ComposerSuggestionDock(props:ComposerSuggestionDockProps){
 return <SuggestionBoundary><ComposerSuggestionDockInner {...props}/></SuggestionBoundary>
}
