import {Fingerprint,UserRound} from 'lucide-react'
import clsx from 'clsx'
import css from './TwinAvatar.module.css'

/**
 * 分身头像的唯一渲染（规格 §4.5.3）：本人姓名缩写（双词姓名取两个首字母；没有可用姓名时用通用人像）在固定 34px 圆形内居中，
 * 右下角 Fingerprint 角标标示"分身"。size=sm 为 22px，用于话题预览与群进度等小号头像。角标只由 .badge 定位，不依赖"子 svg 即角标"，避免通用人像被当成角标。
 * 纯装饰：名称由旁边的文字或外层按钮提供，这里 aria-hidden。
 */
export function TwinAvatar({initials,size='md',className}:{initials:string;size?:'sm'|'md';className?:string|undefined}){
 return <span className={clsx(css.twin,size==='sm'&&css.sm,className)} aria-hidden="true" data-teloa-twin-avatar="">
  {initials?<span className={css.initials}>{initials}</span>:<UserRound size={size==='sm'?12:14}/>}
  <Fingerprint size={size==='sm'?9:12} className={css.badge}/>
 </span>
}
