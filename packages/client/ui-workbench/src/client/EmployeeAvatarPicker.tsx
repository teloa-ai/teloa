import {useId,type KeyboardEvent} from 'react'
import type {RoleAvatarKey} from '@teloa/contract'
import {EmployeeAvatar} from './EmployeeAvatar.js'
import {botColors} from './bot-avatar.js'
import {avatarShapes,avatarColors,avatarKeyOf,avatarChoice,avatarShapeName,avatarColorName,employeeAvatarName} from './employee-avatars.js'
import {employeeCopy} from './employee-copy.js'
import {useI18n} from './i18n/provider.js'
// 与 TeamPage/EmployeeProfileEditor 同序：页面基础样式先于团队样式进入包，保持按钮基础样式与头像选项的层叠不变。
import './TaskPage.module.css'
import css from './TeamPage.module.css'

/** 单选组方向键：左右/上下循环，Home/End 到首尾；选中即回传并把焦点移到新项。 */
function arrowSelect(event:KeyboardEvent<HTMLButtonElement>,index:number,count:number,pick:(index:number)=>void){
 const last=count-1
 const next=event.key==='ArrowRight'||event.key==='ArrowDown'?(index+1)%count:event.key==='ArrowLeft'||event.key==='ArrowUp'?(index+last)%count:event.key==='Home'?0:event.key==='End'?last:undefined
 if(next===undefined)return
 event.preventDefault();pick(next)
 event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button[role="radio"]')[next]?.focus()
}

/**
 * 员工形象的唯一选择方式（新建、完整编辑与轻量编辑共用）：大预览 + 名字，下面形状一行、色板一行，自由组合 12 × 10。
 * 组合等于某个预设时回传预设键（旧版本也能读），否则回传 `bot:<shape>:<color>`；未改动时不回传，保持「未设置」。只回传值，不做保存。
 */
export function EmployeeAvatarPicker({value,name,onChange}:{value:RoleAvatarKey|undefined;name?:string|undefined;onChange:(key:RoleAvatarKey)=>void}){
 const {locale}=useI18n(),id=useId(),{shape,color}=avatarChoice(value)
 return <div className={css.avatarPicker} role="group" aria-label={employeeCopy(locale,'avatar')}>
  <div className={css.avatarPreview}><EmployeeAvatar avatarKey={value} size="xl"/><strong>{name?.trim()||employeeCopy(locale,'avatarUnnamed')}</strong><small>{employeeAvatarName(value,locale)}</small></div>
  <div className={css.avatarField}><span id={id+'shape'}>{employeeCopy(locale,'avatarShape')}</span>
  <div className={css.avatarShapes} role="radiogroup" aria-labelledby={id+'shape'}>
   {avatarShapes.map((item,index)=><button key={item} type="button" role="radio" aria-checked={shape===item} aria-label={avatarShapeName(item,locale)} title={avatarShapeName(item,locale)} tabIndex={shape===item?0:-1} onKeyDown={event=>arrowSelect(event,index,avatarShapes.length,next=>onChange(avatarKeyOf(avatarShapes[next]!,color)))} className={css.avatarShape} onClick={()=>onChange(avatarKeyOf(item,color))}><EmployeeAvatar avatarKey={avatarKeyOf(item,color)} size="sm"/></button>)}
  </div></div>
  <div className={css.avatarField}><span id={id+'color'}>{employeeCopy(locale,'avatarColor')}</span>
  <div className={css.avatarColors} role="radiogroup" aria-labelledby={id+'color'}>
   {avatarColors.map((item,index)=><button key={item} type="button" role="radio" aria-checked={color===item} aria-label={avatarColorName(item,locale)} title={avatarColorName(item,locale)} tabIndex={color===item?0:-1} onKeyDown={event=>arrowSelect(event,index,avatarColors.length,next=>onChange(avatarKeyOf(shape,avatarColors[next]!)))} className={css.avatarSwatch} style={{background:botColors[item]}} onClick={()=>onChange(avatarKeyOf(shape,item))}/>)}
  </div></div>
 </div>
}
