import type {ReactNode} from 'react'
import {Info} from 'lucide-react'
import css from './DisabledReason.module.css'

/** 禁用原因（1.0 设计 30）：写在禁用按钮旁，调用方把 id 绑到按钮的 aria-describedby，不只靠变灰表达。 */
export function DisabledReason({id,children,className}:{id:string;children:ReactNode;className?:string|undefined}){
 return <p id={id} className={className?css.reason+' '+className:css.reason}><Info size={14} aria-hidden="true"/><span>{children}</span></p>
}
