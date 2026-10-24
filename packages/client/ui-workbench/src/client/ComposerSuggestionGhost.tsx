import {useEffect} from 'react'
import {createPortal} from 'react-dom'
import {routeSuggestionKey} from './composer-suggestion-keys.ts'
import {useI18n} from './i18n/provider.js'
import styles from './ComposerSuggestionGhost.module.css'

/**
 * 输入框里的灰色「下一条建议」。
 *
 * 与 Codex 一致：灰字出现在**输入框内部**、盖住占位提示的位置，按 Tab 才放进草稿、绝不发送。
 * 官方 composer 的占位提示是独立元素，所以显示建议时临时隐藏它，隐藏建议时恢复。
 */
export function ComposerSuggestionGhost({text,onAccept,onDismiss,onDraft,visible,overlay,target}:{
 text:string|null
 visible:boolean
 onAccept:(text:string)=>void
 onDismiss:()=>void
 /** 输入框内容变化（含删空）：只做临时让位，不清候选。 */
 onDraft?:(text:string)=>void
 overlay?:boolean
 /** 输入框内用于挂载的容器（官方 composer 的 grow 层，position:relative）。 */
 target?:HTMLElement|null
}){
 const {t}=useI18n()
 // 建议本身可能已带句号，拼进无障碍句子前去掉结尾标点，避免出现「。。」。
 const label=t('composerSuggestion.aria',{text:(text??'').replace(/[。！？.!?]+$/u,'')})
 useEffect(()=>{
  if(!visible||!text)return
  const onKeyDown=(event:KeyboardEvent)=>{
   const outcome=routeSuggestionKey({key:event.key,visible:true,composing:event.isComposing,modifier:event.shiftKey||event.altKey||event.metaKey||event.ctrlKey})
   if(outcome==='accept'){event.preventDefault();onAccept(text)}
   else if(outcome==='dismiss'){event.preventDefault();onDismiss()}
  }
  document.addEventListener('keydown',onKeyDown,true)
  return ()=>document.removeEventListener('keydown',onKeyDown,true)
 },[text,visible,onAccept,onDismiss])
 // 显示建议时把官方占位提示让位；恢复时还原原值。
 useEffect(()=>{
  const parent=target?.parentElement
  const placeholder=parent?parent.querySelector('[class*="_placeholder"]') as HTMLElement|null:null
  if(!placeholder)return
  const previous=placeholder.style.visibility
  placeholder.style.visibility=visible&&text?'hidden':previous
  return ()=>{placeholder.style.visibility=previous}
 },[target,visible,text])
 // 官方输入框的快照不带草稿正文，所以"开始输入即丢弃"直接听输入框自己的 input 事件。
 useEffect(()=>{
  // 只要还有候选就一直监听：建议隐藏期间也要能收到"删回空"，否则永远不回来。
  if(!text||!target)return
  // 官方编辑器删到空时不保证再抛 input 事件（实测），所以除了监听事件再定时核对一次内容。
  let last=target.innerText??''
  const report=()=>{
   const current=target.innerText??''
   if(current===last)return
   last=current
   onDraft?.(current)
  }
  target.addEventListener('input',report)
  target.addEventListener('keyup',report)
  const timer=window.setInterval(report,400)
  return ()=>{target.removeEventListener('input',report);target.removeEventListener('keyup',report);window.clearInterval(timer)}
 },[target,text,onDraft])
 if(!text)return null
 const body=<div className={overlay?styles.ghostInline:styles.ghost} data-composer-suggestion="1" role="status" aria-label={label} title={label}>
  <span className={styles.text}>{text}</span>
 </div>
 if(!visible||!target)return null
 // 直接对齐官方占位提示的位置与字体：灰字就落在"占位提示本来所在的那一行"。
 const box=target
 const host=box.parentElement??box
 const placeholder=host.querySelector('[class*="_placeholder"]') as HTMLElement|null
 const anchor=placeholder??box
 const acs=getComputedStyle(anchor)
 const inline:Record<string,string>={
  position:'absolute',
  left:`${anchor.offsetLeft}px`,
  top:`${anchor.offsetTop}px`,
  maxWidth:`${Math.max(80,host.clientWidth-anchor.offsetLeft-16)}px`,
  boxSizing:'border-box',
  font:acs.font||'',
  fontSize:acs.fontSize,
  lineHeight:acs.lineHeight||'normal',
  color:'var(--text-tertiary,rgba(120,120,128,.9))',
  whiteSpace:'pre-wrap',
  wordBreak:'break-word',
  pointerEvents:'none',
  userSelect:'none',
 }
 const styled=<div className={overlay?styles.ghostInline:styles.ghost} data-composer-suggestion="1" role="status" aria-label={label} title={label} style={inline}><span className={styles.text}>{text}</span></div>
 return createPortal(styled,host)
}
