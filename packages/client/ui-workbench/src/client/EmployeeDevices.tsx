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
export function EmployeeComputerLink({role,computer}:{role:PreviewRole;computer?:EmployeeComputerDisplay|undefined}){
 const {locale}=useI18n(),copy=(key:Parameters<typeof employeeCopy>[1])=>employeeCopy(locale,key)
 const computerHref=typeof location==='undefined'?`?employeeComputer=${encodeURIComponent(role.id)}`:employeeComputerUrl(location.href,role.id)
 const view=employeeComputerView(role.id,computer)
 const status=view.state==='not-integrated'?'notIntegrated':view.state==='connected'?'computerConnected':view.state==='connecting'?'computerConnecting':view.state==='disconnected'?'computerDisconnected':'computerTemporarilyUnavailable'
 const label=`${role.name}${copy('computerNameSuffix')} · ${copy(status)}`
 return <a className={`${toolbarCss.button} ${css.deviceIcon}`} data-teloa-toolbar-icon data-device-state={view.state} aria-label={label} title={label} href={computerHref} target="_blank" rel="noopener"><Monitor size={17} aria-hidden/></a>
}
export function EmployeeDevices({role,computer}:{role:PreviewRole;computer?:EmployeeComputerDisplay|undefined}){
 const {locale}=useI18n(),[mail,setMail]=useState(false),copy=(key:Parameters<typeof employeeCopy>[1])=>employeeCopy(locale,key)
 return <>
  <EmployeeComputerLink role={role} computer={computer}/>
  <ToolbarIconButton label={`${copy('email')} · ${copy('notIntegrated')}`} icon={Mail} data-device-state="not-integrated" onClick={()=>setMail(true)}/>
  {mail&&<ContextDrawer title={copy('email')} close={()=>setMail(false)}><div className={css.mail}>
   <div className={css.identity}><EmployeeAvatar avatarKey={role.avatarKey}/><div><strong>{role.name}</strong><small>{copy('notIntegrated')}</small></div></div>
   <div className={css.empty}><Mail size={28}/><h3>{copy('emailUnavailable')}</h3><p>{copy('mailPending')}</p></div>
  </div></ContextDrawer>}
 </>
}
