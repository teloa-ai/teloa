import clsx from 'clsx'
import type {RoleAvatarKey} from '@teloa/contract'
import {botAvatarPaint,botShapes,teloaBotPaint} from './bot-avatar.js'
import type {StaffAvatarSize} from './StaffAvatar.js'
import css from './StaffAvatar.module.css'
/** 员工形象：1.0 形状 × 颜色小机器人，旧身份稳定回退通用形象；`assistant` 为 Teloa 主助手的墨黑四角星。 */
export function EmployeeAvatar({avatarKey,assistant=false,size='md'}:{avatarKey?:RoleAvatarKey|undefined;assistant?:boolean;size?:StaffAvatarSize}){
 const {shape,fill,eye}=assistant?teloaBotPaint:botAvatarPaint(avatarKey),s=botShapes[shape],[x,y,r]=s.hl
 return <span className={clsx(css.botWrap,css['size'+size])} aria-hidden="true" data-avatar={assistant?'teloa':avatarKey??'general'}>
  <svg viewBox="0 0 64 64">
   <path d={s.d} fill={fill} {...s.soft?{stroke:fill,strokeWidth:5,strokeLinejoin:'round' as const}:{}}/>
   <ellipse cx={x} cy={y} rx="6" ry="3" transform={`rotate(${r} ${x} ${y})`} fill="#FFFFFF" fillOpacity="0.28"/>
   <ellipse cx="26" cy={s.eye} rx="3" ry="3.8" fill={eye}/>
   <ellipse cx="38" cy={s.eye} rx="3" ry="3.8" fill={eye}/>
  </svg>
 </span>
}
