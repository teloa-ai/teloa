import {useId,useState} from 'react'
import {AlertCircle,ArrowRightLeft,BookOpen,CalendarClock,CheckCheck,ChevronDown,ChevronRight,FileCheck,Flag,GitCommitHorizontal,Hash,Pencil,Play,SkipForward,type LucideIcon} from 'lucide-react'
import clsx from 'clsx'
import {foldTimeline,type TimelineEvent,type TimelineEventKind} from './object-timeline.js'
import css from './ObjectPage.module.css'

export const timelineIcons:Record<TimelineEventKind,LucideIcon>={run:Play,approval:CheckCheck,artifact:FileCheck,completion:Flag,handoff:ArrowRightLeft,source:Hash,knowledge:BookOpen,change:Pencil,attention:AlertCircle,trigger:CalendarClock,skip:SkipForward,revision:GitCommitHorizontal}

type Labels={expandLabel:string;collapseLabel:string;stamp:(at:string)=>string}
type Toggle=(key:string,fallback:boolean)=>{open:boolean;flip:()=>void}

function EventItem({event,labels,toggle}:{event:TimelineEvent;labels:Labels;toggle:Toggle}){
 const Icon=timelineIcons[event.kind],detailId=useId()
 // 同一内容面更新记录时保留首次展开状态，避免操作中途收起。
 const [initialOpen]=useState(event.pending===true&&event.kind!=='completion'&&event.kind!=='run')
 const {open,flip}=toggle(event.id,initialOpen)
 return <li className={clsx(css.event,event.pending&&css.pending)} data-teloa-event={event.kind} data-teloa-anchor={event.anchor}>
  <span className={css.icon}><Icon size={14}/></span>
  <div className={css.line}><strong>{event.title}</strong>{event.meta&&<small>{event.meta}</small>}<time dateTime={event.at}>{labels.stamp(event.at)}</time>{event.actions}</div>
  {event.detail!==undefined&&<button type="button" className={css.toggle} aria-expanded={open} aria-controls={detailId} aria-label={(open?labels.collapseLabel:labels.expandLabel)+' · '+event.title} onClick={flip}>{open?<ChevronDown size={14}/>:<ChevronRight size={14}/>}</button>}
  {event.detail!==undefined&&<div id={detailId} hidden={!open} className={css.detail}>{event.detail}</div>}
 </li>
}

function FoldItem({foldKey,events,at,label,labels,toggle}:{foldKey:string;events:TimelineEvent[];at:string;label:string;labels:Labels;toggle:Toggle}){
 const foldId=useId()
 const {open,flip}=toggle('fold:'+foldKey+':'+at+':'+(events[0]?.id??''),false)
 return <li className={css.fold} data-teloa-fold={foldKey}>
  <button type="button" aria-expanded={open} aria-controls={foldId} onClick={flip}>{label}</button><time dateTime={at}>{labels.stamp(at)}</time>
  <ol id={foldId} hidden={!open} className={css.events}>{events.map(event=><EventItem key={event.id} event={event} labels={labels} toggle={toggle}/>)}</ol>
 </li>
}

/** 对象页正文：一条倒序、可折叠的事件时间线，事件形状来自 `object-timeline.ts`。 */
export function EventTimeline(props:{
 ariaLabel:string;events:readonly TimelineEvent[];emptyText:string
 foldLabel:(kind:TimelineEventKind,count:number,foldKey:string)=>string
 expandLabel:string;collapseLabel:string
 stamp:(at:string)=>string
 minFold?:number
}):JSX.Element{
 const [opened,setOpened]=useState<Record<string,boolean>>({})
 const labels:Labels={expandLabel:props.expandLabel,collapseLabel:props.collapseLabel,stamp:props.stamp}
 const toggle:Toggle=(key,fallback)=>({open:opened[key]??fallback,flip:()=>setOpened(current=>({...current,[key]:!(current[key]??fallback)}))})
 const entries=foldTimeline(props.events,props.minFold)
 return <section className={css.timeline} aria-label={props.ariaLabel}>
  {entries.length===0?<p className={css.empty}>{props.emptyText}</p>:<ol className={css.events}>
   {entries.map(entry=>entry.kind==='event'
    ?<EventItem key={entry.event.id} event={entry.event} labels={labels} toggle={toggle}/>
    :<FoldItem key={'fold:'+entry.foldKey+':'+entry.at+':'+(entry.events[0]?.id??'')} foldKey={entry.foldKey} events={entry.events} at={entry.at} label={props.foldLabel(entry.eventKind,entry.events.length,entry.foldKey)} labels={labels} toggle={toggle}/>)}
  </ol>}
 </section>
}
