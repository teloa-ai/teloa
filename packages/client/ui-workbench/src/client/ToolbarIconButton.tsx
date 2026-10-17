import type {ButtonHTMLAttributes} from 'react'
import type {LucideIcon} from 'lucide-react'
import clsx from 'clsx'
import css from './ToolbarIconButton.module.css'

/** 辅助动作共用命名、提示与点击尺寸；业务回调仍由所在页面持有。 */
export function ToolbarIconButton({label,icon:Icon,className,...props}:{label:string;icon:LucideIcon}&Omit<ButtonHTMLAttributes<HTMLButtonElement>,'children'|'type'|'aria-label'|'title'>){
 return <button {...props} type="button" data-teloa-toolbar-icon className={clsx(css.button,className)} aria-label={label} title={label}><Icon size={17} aria-hidden/></button>
}
