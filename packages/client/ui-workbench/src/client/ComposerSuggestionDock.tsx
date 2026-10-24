import {Component,useCallback,useEffect,useMemo,useRef,useState,useSyncExternalStore,type ReactNode} from 'react'
import {ComposerSuggestionGhost} from './ComposerSuggestionGhost.tsx'
import {ComposerSuggestionController} from './composer-suggestion-controller.ts'
import {readSuggestionEnabled,shouldShowSuggestion} from './composer-suggestion.ts'
/**
 * 同一个会话的 dock 可能被渲染多次（主会话与覆盖层），所有实例必须共享同一份候选状态，
 * 否则"按 Tab 采纳"只让其中一个实例隐藏，另一个仍显示旧灰字。
 */
type SharedEntry={controller:ComposerSuggestionController;listeners:Set<()=>void>}
const sharedControllers=new Map<string,SharedEntry>()
function sharedEntry(sessionId:string,enabled:boolean):SharedEntry{
 let entry=sharedControllers.get(sessionId)
 if(!entry){entry={controller:new ComposerSuggestionController(enabled),listeners:new Set()};sharedControllers.set(sessionId,entry)}
 return entry
}
function notify(entry:SharedEntry){for(const listener of [...entry.listeners]){try{listener()}catch{/* 单个实例出错不影响其它实例。 */}}}


/**
 * 把「下一条建议」挂到官方输入框 dock 上（单聊与工作台会话都走这个槽）。
 *
 * 这一层刻意写得"不信任任何输入"：任何一个来源缺失或形状不对，就整层不渲染。
 * 这个槽是官方输入框的一部分，**组件抛错会让整个 dock 变成错误占位**，
 * 所以这里不做任何可能抛出的假设。
 */
type MessageLike={role?:string;text?:string;state?:string;key?:string}
type InputLike={getSnapshot?:()=>{draft?:string;focused?:boolean};subscribe?:(listener:()=>void)=>()=>void}
export type ComposerSuggestionDockProps={
 /** 在输入框内做绝对定位覆盖层（更接近 Codex：灰字盖住占位提示）。 */
 overlay?:boolean
 sessionId:string
 session?:{messages?:readonly MessageLike[]}
 input?:InputLike
 running?:boolean
 insertText?:(text:string)=>void
 /** 请求宿主用模型算一条候选；返回 null/失败就退回本地兜底。 */
 suggest?:()=>Promise<string|null>
 /** 覆盖层槽不传 sessionId：由组件用自己的 sessionId 反查输入状态/运行态/写草稿。 */
 stateFor?:(sessionId:string)=>InputLike|undefined
 runningFor?:(sessionId:string)=>boolean
 insertFor?:(sessionId:string,text:string)=>void

}

const EMPTY_INPUT={draft:'',focused:true}
const noopSubscribe=()=>()=>{}

function useInput(input:InputLike|undefined):{draft:string;focused:boolean}{
 const subscribe=useCallback((listener:()=>void)=>{try{return input?.subscribe?.(listener)??noopSubscribe()}catch{return noopSubscribe()}},[input])
 // 只订阅"基元值"：getSnapshot 每次都返回新对象会被 React 判成快照不稳定并抛错。
 // 官方 InputState 的字段名不完全统一：草稿可能是 draft 或 text，聚焦同理。
 const draft=useSyncExternalStore(subscribe,()=>{try{const value=input?.getSnapshot?.() as Record<string,unknown>|undefined;return String(value?.draft??value?.text??'')}catch{return ''}},()=>'')
 const focused=useSyncExternalStore(subscribe,()=>{try{const value=input?.getSnapshot?.() as Record<string,unknown>|undefined;return value?.focused===true||value?.active===true}catch{return false}},()=>false)
 return {draft,focused}
}

/**
 * 兜底消息源：会话快照里没有消息正文时，从会话视图里读最后一条助手正文。
 * 只读、受控轮询、任何异常都当作"没有"（不能让它弄坏输入框）。
 */
function useLastAssistantFromDom():{text:string}|null{
 const [found,setFound]=useState<{text:string}|null>(null)
 useEffect(()=>{
  let stopped=false
  const read=()=>{
   if(stopped)return
   try{
    const nodes=[...document.querySelectorAll('[data-slot="main.conversation"] [class*="markdown"]')]
    const last=nodes[nodes.length-1]
    if(!last)return
    const text=String((last as HTMLElement).innerText??'').trim()
    if(!text)return
    setFound((previous:{text:string}|null)=>previous&&previous.text===text?previous:{text})
   }catch{/* 读不到就当没有。 */}
  }
  read()
  const timer=window.setInterval(read,1500)
  return()=>{stopped=true;window.clearInterval(timer)}
 },[])
 return found
}

function hashText(text:string):number{let hash=0;for(let index=0;index<text.length;index++)hash=(hash*31+text.charCodeAt(index))|0;return hash}

function lastAssistant(messages:readonly MessageLike[]|undefined):{text:string;seq:number}|null{
 if(!Array.isArray(messages))return null
 for(let index=messages.length-1;index>=0;index--){
  const row=messages[index]
  if(!row||row.role!=='assistant')continue
  const text=String(row.text??'').trim()
  if(!text||row.state==='streaming')return null
  return {text,seq:index}
 }
 return null
}

/** 兜底边界：这个槽属于官方输入框，本组件无论如何都不能把整个 dock 弄坏。 */
class SuggestionBoundary extends Component<{children:ReactNode},{failed:boolean}>{
 constructor(props:{children:ReactNode}){super(props);this.state={failed:false}}
 static getDerivedStateFromError(){return {failed:true}}
 componentDidCatch(){} 
 render(){return this.state.failed?null:this.props.children}
}

function ComposerSuggestionDockInner({sessionId,session,input,running,insertText,suggest,overlay,stateFor,runningFor,insertFor}:ComposerSuggestionDockProps){
 const resolvedInput=stateFor?stateFor(sessionId):input
 const resolvedRunning=runningFor?runningFor(sessionId):running
 const entry=useMemo(()=>{let enabled=true;try{enabled=readSuggestionEnabled(globalThis.localStorage)}catch{}return sharedEntry(sessionId,enabled)},[sessionId])
 const controller=entry.controller
 const [snapshot,setSnapshot]=useState(()=>controller.snapshot)
 const refresh=useCallback(()=>{setSnapshot({...controller.snapshot});notify(entry)},[controller,entry])
 // 其它实例改动状态时，本实例跟着刷新。
 useEffect(()=>{const listener=()=>setSnapshot({...controller.snapshot});entry.listeners.add(listener);return()=>{entry.listeners.delete(listener)}},[entry,controller])
 // 直接同步取输入框：拿不到就本轮不渲染（避免先在别处出现再"挪"进输入框）。
 const findComposer=()=>document.querySelector('div[data-composer-input][contenteditable="true"]') as HTMLElement|null
 const [portalTarget,setPortalTarget]=useState<HTMLElement|null>(()=>findComposer())
 const state=useInput(resolvedInput)
 useEffect(()=>{
  if(portalTarget&&portalTarget.isConnected)return
  const tick=()=>{const found=findComposer();if(found)setPortalTarget(found)}
  tick()
  const timer=window.setInterval(tick,200)
  return()=>window.clearInterval(timer)
 },[portalTarget])
 // 与 Codex 一致：建议不会因为"点了一下外面"就消失——只有开始输入、Tab 采纳或 Escape 才结束。
 // 因此这里不监听 focusin/pointerdown，只保留下面的输入内容判据与按键处理。
 const fromSnapshot=lastAssistant(session?.messages)
 const fromDom=useLastAssistantFromDom()
 // 快照没有消息正文时用视图兜底；两者的身份都用文本本身，避免序号漂移。
 const candidate=fromSnapshot??(fromDom?{text:fromDom.text,seq:hashText(fromDom.text)}:null)
 const lastSeq=candidate?candidate.seq:-1,lastText=candidate?candidate.text:''
 // 有模型通道时优先用模型候选：它比本地兜底更懂上下文措辞。
 const requested=useRef<number>(-1)
 useEffect(()=>{
  // 依赖只用稳定基元：candidate 每次渲染都是新对象，会导致 effect 反复重建、
  // 清理函数把还没返回的 suggest 结果丢掉（实测踩过）。
  if(!suggest||lastSeq===-1||resolvedRunning===true)return
  if(requested.current===lastSeq)return
  requested.current=lastSeq
  let live=true
  // 候选刚出现时会话可能还没完全落盘：最多重试 3 次，拿到模型文本就停。
  const attempt=async(remaining:number):Promise<void>=>{
   for(let index=0;index<remaining;index++){
    const text=await suggest().catch(()=>null)
    if(!live)return
    if(text){controller.setCandidate(lastSeq,text);refresh();return}
    await new Promise(done=>setTimeout(done,2500))
   }
  }
  void attempt(4)
  return()=>{live=false}
 },[suggest,lastSeq,resolvedRunning,controller,refresh])
 useEffect(()=>{
  if(!candidate||resolvedRunning===true)return
  controller.completeAnswer(lastSeq,lastText)
  refresh()
 },[controller,lastSeq,lastText,resolvedRunning,refresh])
 useEffect(()=>{if(!state.focused)return;controller.focus();refresh()},[controller,state.focused,refresh])
 useEffect(()=>{if(state.draft.trim().length===0)return;controller.setDraft(state.draft);refresh()},[controller,state.draft,refresh])
 const accept=useCallback((text:string)=>{  // 必须走控制器：它会清空本条候选，否则灰字会在草稿已填好后继续显示。
  const accepted=controller.accept()??text
  try{if(insertFor)insertFor(sessionId,accepted);else insertText?.(accepted)}catch{/* 写入草稿失败就当作没采纳，不影响输入框本身。 */}
  refresh()},[controller,insertText,refresh])
 const dismiss=useCallback(()=>{controller.dismiss();refresh()},[controller,refresh])
 const draftChanged=useCallback((text:string)=>{controller.setDraft(text);refresh()},[controller,refresh])
 const decision=shouldShowSuggestion({enabled:snapshot.enabled,draft:snapshot.draft,focused:snapshot.focused,dismissedForAnswer:snapshot.answerSeq!==null&&snapshot.dismissed.includes(snapshot.answerSeq),text:snapshot.text})
 return <>
  <ComposerSuggestionGhost text={snapshot.text} visible={decision==='show'} onAccept={accept} onDismiss={dismiss} onDraft={draftChanged} target={portalTarget} {...(overlay?{overlay:true}:{})}/>
 </>
}

/** 对外只暴露带边界的版本：内部出错就彻底隐身，不影响输入框。 */
export function ComposerSuggestionDock(props:ComposerSuggestionDockProps){
 return <SuggestionBoundary><ComposerSuggestionDockInner {...props}/></SuggestionBoundary>
}
