import {useState,type KeyboardEvent} from 'react'
import {Check} from 'lucide-react'
import clsx from 'clsx'
import type {RoleAvatarKey} from '@teloa/contract'
import {EmployeeAvatar} from './EmployeeAvatar.js'
import {employeeAvatars,employeeAvatarName} from './employee-avatars.js'
import {employeeCopy} from './employee-copy.js'
import {useI18n} from './i18n/provider.js'
// 与 TeamPage/EmployeeProfileEditor 同序：页面基础样式先于团队样式进入包，保持 .segment/.avatarOption 的层叠不变。
import './TaskPage.module.css'
import css from './TeamPage.module.css'

/** 员工形象的唯一选择方式：内置形象网格（搜索 + 单选组 + 方向键），新建、完整编辑与轻量编辑共用；只回传 avatarKey，不做保存。 */
export function EmployeeAvatarPicker({value,onChange}:{value:RoleAvatarKey|undefined;onChange:(key:RoleAvatarKey)=>void}){
 const {locale}=useI18n(),[query,setQuery]=useState(''),current=value??'general'
 const choices=employeeAvatars.filter(item=>[item.zh,item.en,employeeAvatarName(item.key,locale)].some(text=>text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())))
 const focusExists=choices.some(item=>item.key===current)
 const move=(event:KeyboardEvent<HTMLButtonElement>,index:number)=>{
  const last=choices.length-1
  const next=event.key==='ArrowRight'||event.key==='ArrowDown'?(index+1)%(last+1):event.key==='ArrowLeft'||event.key==='ArrowUp'?(index+last)%(last+1):event.key==='Home'?0:event.key==='End'?last:undefined
  if(next===undefined)return
  event.preventDefault();onChange(choices[next]!.key)
  event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button[role="radio"]')[next]?.focus()
 }
 return <>
  <label>{employeeCopy(locale,'avatar')}<input value={query} onChange={event=>setQuery(event.target.value)} placeholder={employeeCopy(locale,'avatarSearch')}/></label>
  <div className={css.avatarGrid} role="radiogroup" aria-label={employeeCopy(locale,'avatar')}>
   {choices.map((item,index)=><button key={item.key} type="button" role="radio" aria-checked={current===item.key} aria-label={employeeAvatarName(item.key,locale)} tabIndex={current===item.key||!focusExists&&index===0?0:-1} onKeyDown={event=>move(event,index)} className={clsx(css.avatarOption,current===item.key&&css.lookPicked)} onClick={()=>onChange(item.key)}><EmployeeAvatar avatarKey={item.key} size="lg"/>{current===item.key&&<span className={css.avatarSelected} aria-hidden="true"><Check size={13}/></span>}<small>{employeeAvatarName(item.key,locale)}</small></button>)}
  </div>{!choices.length&&<p role="status">{employeeCopy(locale,'noAvatars')}</p>}
 </>
}
