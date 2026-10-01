import {useId,useState,type ReactNode} from 'react'
import {ChevronDown} from 'lucide-react'
import css from './TaskDetail.module.css'

/** 内容常驻，折叠不重置执行面、资料读取或未提交表单；复用对象页的锚点展开协议。 */
export function TaskDetailSection({title,anchor,children}:{title:string;anchor?:string;children:ReactNode}){
 const [open,setOpen]=useState(false),id=useId()
 return <section className={css.disclosure} data-teloa-fold="task-detail" data-teloa-anchor={anchor}>
  <button type="button" className={css.disclosureTrigger} aria-expanded={open} aria-controls={id} onClick={()=>setOpen(value=>!value)}><ChevronDown size={15} aria-hidden="true"/>{title}</button>
  <div id={id} hidden={!open} className={css.disclosureBody}>{children}</div>
 </section>
}

export function TaskFact({label,children,wide=false}:{label:string;children:ReactNode;wide?:boolean}){
 return <div className={wide?css.wideFact:css.fact}><dt>{label}</dt><dd>{children}</dd></div>
}
