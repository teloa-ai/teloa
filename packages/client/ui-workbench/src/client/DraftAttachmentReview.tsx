import {useEffect,useId,useRef,useState,useSyncExternalStore} from 'react'
import type {PropsRuntime} from '@deepseek-ai/dsh-client-ui-slots'
import type {DraftAttachmentReview,createDraftAttachmentReviews} from './native-draft-attachments.js'
import {draftContinuityCopy} from './draft-continuity-copy.js'
import {useI18n} from './i18n/provider.js'
import {ComposerPopover} from './ComposerPopover.js'
import css from './DraftAttachmentReview.module.css'
const emptySnapshot={files:[],enabled:false} as const
const empty={getSnapshot:()=>emptySnapshot,subscribe:()=>()=>{}}
type Props=PropsRuntime<'conversation.input.left'>&{reviews:ReturnType<typeof createDraftAttachmentReviews>;owner:{getSnapshot:()=>string|null;subscribe:(fn:()=>void)=>()=>void}}
/** 只展示当前本人会话的旧 File；明确添加仍走原生草稿与上传准入，不发送。 */
export function DraftAttachmentReview({sessionId,reviews,owner}:Props){
 const {locale}=useI18n(),copy=(key:Parameters<typeof draftContinuityCopy>[1])=>draftContinuityCopy(locale,key)
 const namespace=useSyncExternalStore(owner.subscribe,owner.getSnapshot)
 const directory=useSyncExternalStore(reviews.subscribe,reviews.getSnapshot)
 const review=namespace?directory.get(reviews.key(namespace,sessionId)):undefined
 const source=review??empty,state=useSyncExternalStore(source.subscribe,source.getSnapshot)
 const [open,setOpen]=useState(false),[error,setError]=useState(false),anchor=useRef<HTMLButtonElement>(null),id=useId(),generation=useRef(0)
 useEffect(()=>{generation.current++;setOpen(false);setError(false);return()=>{generation.current++}},[review,sessionId,namespace])
 const act=async(controller:DraftAttachmentReview,id:string,add:boolean)=>{
  const current=generation.current;setError(false)
  try{const ok=await (add?controller.add(id):controller.remove(id));if(current===generation.current&&!ok)setError(true)}catch{if(current===generation.current)setError(true)}
 }
 const download=(id:string)=>{
  const file=review?.file(id);if(!file){setError(true);return}
  const url=URL.createObjectURL(file),link=document.createElement('a');link.href=url;link.download=file.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),0)
 }
 if(!state.files.length)return null
 return <div className={css.root}>
  <button ref={anchor} type="button" aria-haspopup="dialog" aria-controls={open?id:undefined} aria-expanded={open} onClick={()=>setOpen(value=>!value)}>{copy('saved').replace('{count}',String(state.files.length))}</button>
  {open&&<ComposerPopover anchor={anchor} id={id} label={copy('saved').replace('{count}',String(state.files.length))} close={()=>setOpen(false)}><div className={css.content}>
   <p>{copy('reviewHelp')}</p>
   <ul>{state.files.map(row=><li key={row.id}>
    <span className={css.name}>{row.name}</span><span className={css.meta}>{row.type||copy('fileType')} · {row.size.toLocaleString()} B</span>
    <div className={css.actions}>
     <button type="button" disabled={!state.enabled} onClick={()=>review&&void act(review,row.id,true)}>{copy('add')}</button>
     <button type="button" disabled={!state.enabled} onClick={()=>download(row.id)}>{copy('download')}</button>
     <button type="button" disabled={!state.enabled} onClick={()=>review&&void act(review,row.id,false)}>{copy('remove')}</button>
    </div>
   </li>)}</ul>
   {error&&<p role="alert">{copy('failed')}</p>}
  </div></ComposerPopover>}
 </div>
}
