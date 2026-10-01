import {useId,useState,type ReactNode} from 'react'
import {ArrowUpRight,ChevronDown,ChevronRight} from 'lucide-react'
import css from './ObjectPage.module.css'

export type PropertyRow={id:string;label:string;value:string;onOpen?:()=>void;openLabel?:string;detail?:ReactNode;detailOpen?:boolean;anchor?:string;mono?:boolean}

function RailRow({row,expandLabel,collapseLabel}:{row:PropertyRow;expandLabel:string;collapseLabel:string}){
 const [open,setOpen]=useState(row.detailOpen??false),detailId=useId()
 return <div className={css.row} data-teloa-anchor={row.anchor}>
  <dt>{row.label}</dt>
  <dd>
   {row.onOpen?<button type="button" className={css.railLink} aria-label={row.openLabel} onClick={row.onOpen}>{row.value}<ArrowUpRight size={12}/></button>:<span className={row.mono?css.mono:undefined}>{row.value}</span>}
   {row.detail!==undefined&&<button type="button" className={css.toggle} aria-expanded={open} aria-controls={detailId} aria-label={open?collapseLabel:expandLabel} onClick={()=>setOpen(value=>!value)}>{open?<ChevronDown size={14}/>:<ChevronRight size={14}/>}</button>}
   {open&&row.detail!==undefined&&<div id={detailId} className={css.railDetail}>{row.detail}</div>}
  </dd>
 </div>
}

/** 对象页右侧属性栏：每行「标签 · 值」，值可为跳转按钮，可带展开详情面。 */
export function PropertyRail(props:{ariaLabel:string;rows:readonly PropertyRow[];expandLabel:string;collapseLabel:string}):JSX.Element{
 return <aside className={css.rail} aria-label={props.ariaLabel}><dl>
  {props.rows.map(row=><RailRow key={row.id} row={row} expandLabel={props.expandLabel} collapseLabel={props.collapseLabel}/>)}
 </dl></aside>
}
