import {useState} from 'react'
import {Monitor} from 'lucide-react'
import type {EmployeeComputerView} from './employee-computer-display.js'
import {employeeCopy} from './employee-copy.js'
import {useI18n} from './i18n/provider.js'
import css from './EmployeeComputer.module.css'

export function EmployeeComputerStatus({view}:{view:EmployeeComputerView}){
 const {locale}=useI18n()
 const key=view.state==='not-integrated'?'notIntegrated':view.state==='connected'?'computerConnected':view.state==='connecting'?'computerConnecting':view.state==='disconnected'?'computerDisconnected':'computerTemporarilyUnavailable'
 return <span className={css.status} data-device-state={view.state}><span className={css.statusDot} aria-hidden="true"/>{employeeCopy(locale,key)}</span>
}

/** 同一可信截图用于小预览和独立页；缺失或解码失败时明确给出占位。 */
export function EmployeeComputerPreview({view,name,thumbnail=false}:{view:EmployeeComputerView;name:string;thumbnail?:boolean}){
 const {locale}=useI18n(),[failed,setFailed]=useState<string>()
 const src=view.previewDataUrl,available=src&&failed!==src
 const alt=`${name}${employeeCopy(locale,'computerNameSuffix')}${employeeCopy(locale,'desktopImageSuffix')}`
 return <div className={thumbnail?css.thumbnail:css.desktopPreview}>
  {available?<img src={src} alt={alt} onError={()=>setFailed(src)}/>:thumbnail?<><Monitor size={18} strokeWidth={1.5}/><small>{employeeCopy(locale,'previewUnavailable')}</small></>:<div className={css.desktopEmpty}><Monitor size={38} strokeWidth={1.3}/><h2>{employeeCopy(locale,'desktopPending')}</h2><p>{employeeCopy(locale,view.state==='not-integrated'?'computerUnavailable':view.state==='connected'?'desktopFramePending':view.state==='connecting'?'computerConnectingHint':view.state==='disconnected'?'computerDisconnectedHint':'computerUnavailableHint')}</p></div>}
 </div>
}
