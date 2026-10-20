import type {ReactNode} from 'react'
import {CircleCheck,type LucideIcon} from 'lucide-react'
import css from './EmptyState.module.css'

/** 空态动作：页面级最多两个，右侧那个可设为唯一实心主按钮。 */
export type EmptyAction={label:string;onClick:()=>void;primary?:boolean}

/**
 * 页面级空态（1.0 设计 30）：40px 图标块 + 标题 + 一句说明 + 最多两个动作；
 * 用在整块内容为空的位置，说明要写清下一步，不写「开发中」之类研发状态。
 */
export function EmptyBlock({icon:Icon,title,description,actions,status=false}:{icon?:LucideIcon|undefined;title:string;description?:ReactNode;actions?:readonly []|readonly [EmptyAction]|readonly [EmptyAction,EmptyAction]|undefined;status?:boolean}){
 return <section className={css.block} role={status?'status':undefined}>
  {Icon&&<span className={css.icon} aria-hidden="true"><Icon size={18}/></span>}
  <h2 className={css.title}>{title}</h2>
  {description&&<p className={css.description}>{description}</p>}
  {actions&&actions.length>0&&<div className={css.actions}>{actions.map(action=><button key={action.label} type="button" className={action.primary?css.primary:undefined} onClick={action.onClick}>{action.label}</button>)}</div>}
 </section>
}

/** 卡片内空态：压成一行浅底提示，默认带完成勾，表示「此处没有待办」。 */
export function EmptyInline({children,icon:Icon=CircleCheck}:{children:ReactNode;icon?:LucideIcon}){
 return <p className={css.inline}><Icon size={15} aria-hidden="true"/>{children}</p>
}
