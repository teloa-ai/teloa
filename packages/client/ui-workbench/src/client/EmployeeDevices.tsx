import {useState} from 'react'
import {Mail,Monitor} from 'lucide-react'
import type {PreviewRole} from './role-preview.js'
import {ContextDrawer} from './ContextDrawer.js'
import {EmployeeAvatar} from './EmployeeAvatar.js'
import {employeeComputerUrl} from './employee-computer-navigation.js'
import {employeeComputerView,type EmployeeComputerDisplay} from './employee-computer-display.js'
import {ToolbarIconButton} from './ToolbarIconButton.js'
import {employeeCopy} from './employee-copy.js'
import {useI18n} from './i18n/provider.js'
import css from './EmployeeComputer.module.css'
import toolbarCss from './ToolbarIconButton.module.css'

/** 本批仅交付设备 UI；未接入服务不生成连接、地址或桌面回执。 */
export function EmployeeComputerLink({role,computer,variant='toolbar'}:{role:PreviewRole;computer?:EmployeeComputerDisplay|undefined;variant?:'toolbar'|'menu'}){
 const {locale}=useI18n(),copy=(key:Parameters<typeof employeeCopy>[1])=>employeeCopy(locale,key)
 const computerHref=typeof location==='undefined'?`?employeeComputer=${encodeURIComponent(role.id)}`:employeeComputerUrl(location.href,role.id)
 const view=employeeComputerView(role.id,computer)
 const status=view.state==='not-integrated'?'notIntegrated':view.state==='connected'?'computerConnected':view.state==='connecting'?'computerConnecting':view.state==='disconnected'?'computerDisconnected':'computerTemporarilyUnavailable'
 const label=`${role.name}${copy('computerNameSuffix')} · ${copy(status)}`
 if(variant==='menu')return <a className={css.menuItem} data-device-state={view.state} aria-label={label} title={label} href={computerHref} target="_blank" rel="noopener"><Monitor size={14} aria-hidden/><span>{role.name}{copy('computerNameSuffix')}</span><small>{copy(status)}</small></a>
 return <a className={`${toolbarCss.button} ${css.deviceIcon}`} data-teloa-toolbar-icon data-device-state={view.state} aria-label={label} title={label} href={computerHref} target="_blank" rel="noopener"><Monitor size={17} aria-hidden/></a>
}
/** 工作邮箱尚未接入：只说明状态，不生成地址。工具条与「⋯」菜单两种入口共用同一抽屉。 */
export function EmployeeMailDrawer({role,close}:{role:PreviewRole;close:()=>void}){
 const {locale}=useI18n(),copy=(key:Parameters<typeof employeeCopy>[1])=>employeeCopy(locale,key)
 return <ContextDrawer title={copy('email')} close={close}><div className={css.mail}>
   <div className={css.identity}><EmployeeAvatar avatarKey={role.avatarKey}/><div><strong>{role.name}</strong><small>{copy('notIntegrated')}</small></div></div>
   <div className={css.empty}><Mail size={28}/><h3>{copy('emailUnavailable')}</h3><p>{copy('mailPending')}</p></div>
  </div></ContextDrawer>
}
/** variant=menu 时渲染为「⋯」菜单项；邮箱抽屉由调用方放在菜单外打开（openMail），避免随收起的菜单一起隐藏。 */
export function EmployeeDevices({role,computer,variant='toolbar',openMail}:{role:PreviewRole;computer?:EmployeeComputerDisplay|undefined;variant?:'toolbar'|'menu';openMail?:()=>void}){
 const {locale}=useI18n(),[mail,setMail]=useState(false),copy=(key:Parameters<typeof employeeCopy>[1])=>employeeCopy(locale,key)
 if(variant==='menu')return <>
  <EmployeeComputerLink role={role} computer={computer} variant="menu"/>
  <button type="button" className={css.menuItem} aria-label={`${copy('email')} · ${copy('notIntegrated')}`} title={`${copy('email')} · ${copy('notIntegrated')}`} data-device-state="not-integrated" onClick={openMail}><Mail size={14} aria-hidden/><span>{copy('email')}</span><small>{copy('notIntegrated')}</small></button>
 </>
 return <>
  <EmployeeComputerLink role={role} computer={computer}/>
  <ToolbarIconButton label={`${copy('email')} · ${copy('notIntegrated')}`} icon={Mail} data-device-state="not-integrated" onClick={()=>setMail(true)}/>
  {mail&&<EmployeeMailDrawer role={role} close={()=>setMail(false)}/>}
 </>
}
