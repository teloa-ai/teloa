import {useId,useState,type ReactNode} from 'react'
import {ChevronDown} from 'lucide-react'
import clsx from 'clsx'
import {isLongDetailText} from './detail-density-copy.js'
import css from './TaskDetail.module.css'
import {MarkdownPreview} from './knowledge-markdown.js'
import markdownTypography from './MarkdownTypography.module.css'

/** 内容常驻，折叠不重置执行面、资料读取或未提交表单；复用对象页的锚点展开协议。defaultOpen 只决定首次呈现。 */
export function TaskDetailSection({title,anchor,defaultOpen=false,children}:{title:string;anchor?:string;defaultOpen?:boolean;children:ReactNode}){
 const [open,setOpen]=useState(defaultOpen),id=useId()
 return <section className={css.disclosure} data-teloa-fold="task-detail" data-teloa-anchor={anchor}>
  <button type="button" className={css.disclosureTrigger} aria-expanded={open} aria-controls={id} onClick={()=>setOpen(value=>!value)}><ChevronDown size={15} aria-hidden="true"/>{title}</button>
  <div id={id} hidden={!open} className={css.disclosureBody}>{children}</div>
 </section>
}

export function TaskFact({label,children,wide=false}:{label:string;children:ReactNode;wide?:boolean}){
 return <div className={wide?css.wideFact:css.fact}><dt>{label}</dt><dd>{children}</dd></div>
}

/** 长文本先显示前几行，展开后显示全文；原文始终完整在页面中，只改变可见高度，不截断、不改写。 */
export function DetailText({text,expandLabel,collapseLabel,className,markdown=false}:{text:string;expandLabel:string;collapseLabel:string;className?:string;markdown?:boolean}){
 const [expanded,setExpanded]=useState(false),id=useId(),long=isLongDetailText(text),Tag=markdown?'div':'span'
 return <>
  <Tag id={id} className={clsx(css.detailText,long&&!expanded&&css.detailTextClamped,markdown&&css.detailMarkdown,markdown&&markdownTypography.typography,className)}>{markdown?<MarkdownPreview markdown={text} images={false}/>:text}</Tag>
  {long&&<button type="button" className={css.detailTextToggle} aria-expanded={expanded} aria-controls={id} onClick={()=>setExpanded(value=>!value)}>{expanded?collapseLabel:expandLabel}</button>}
 </>
}
