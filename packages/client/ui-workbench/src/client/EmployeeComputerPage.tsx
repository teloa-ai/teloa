import {useEffect,useRef,useState} from 'react'
import {ArrowLeft,ArrowUpRight,Maximize,Minimize,Monitor,MessageSquare} from 'lucide-react'
import type {PreviewRole} from './role-preview.js'
import {EmployeeAvatar} from './EmployeeAvatar.js'
import {ToolbarIconButton} from './ToolbarIconButton.js'
import {employeeComputerUrl} from './employee-computer-navigation.js'
import {employeeComputerView,type EmployeeComputerDisplay} from './employee-computer-display.js'
import {EmployeeComputerPreview,EmployeeComputerStatus} from './EmployeeComputerPreview.js'
import {employeeCopy} from './employee-copy.js'
import {useI18n} from './i18n/provider.js'
import tokens from './theme-tokens.module.css'
import css from './EmployeeComputer.module.css'

/** 完整工作环境使用独立页面；放大仅影响布局，不创建连接或改变设备控制权。 */
export function EmployeeComputerPage({role,computer,loading,error,retry,back,talk,openEmployee,scopes}:{role?:PreviewRole|undefined;computer?:EmployeeComputerDisplay|undefined;loading:boolean;error?:string|undefined;retry:()=>void;back:()=>void;talk:(id:string)=>Promise<boolean>;openEmployee:(id:string)=>void;scopes:Record<string,string>}){
 const {locale,t}=useI18n(),copy=(key:Parameters<typeof employeeCopy>[1])=>employeeCopy(locale,key)
 const [expanded,setExpanded]=useState(()=>new URL(location.href).searchParams.get('computerWindow')==='1'),expandButton=useRef<HTMLButtonElement>(null),[opening,setOpening]=useState(false),[failed,setFailed]=useState(false)
 const view=employeeComputerView(role?.id??'',computer)
 useEffect(()=>{
  if(!expanded)return
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();setExpanded(false);requestAnimationFrame(()=>expandButton.current?.focus())}}
  document.addEventListener('keydown',escape);return()=>document.removeEventListener('keydown',escape)
 },[expanded])
 const chat=async()=>{if(!role||opening)return;setOpening(true);setFailed(false);try{if(!await talk(role.id))setFailed(true)}catch{setFailed(true)}finally{setOpening(false)}}
 const popout=()=>{if(role)window.open(employeeComputerUrl(location.href,role.id,true),'_blank','popup,width=1280,height=900,noopener')}
 return <main className={`${tokens.tokens} ${css.page} ${expanded?css.expanded:''}`}>
  {!expanded&&<header className={css.pageHeader}><ToolbarIconButton label={copy('employeeDirectory')} icon={ArrowLeft} onClick={back}/><span>{copy('computer')}</span><small><EmployeeComputerStatus view={view}/></small></header>}
  {loading?<div className={css.empty} role="status">{t('team.loading')}</div>:error?<div className={css.empty} role="alert"><p>{error}</p><button type="button" onClick={retry}>{t('common.retry')}</button></div>:!role?<div className={css.empty} role="status"><p>{copy('employeeMissing')}</p><button type="button" onClick={back}>{copy('employeeDirectory')}</button></div>:<div className={css.layout}>
   {!expanded&&<aside className={css.profile}>
    <div className={css.identity}><EmployeeAvatar avatarKey={role.avatarKey}/><div><h1>{role.name}</h1><small>{copy('computer')}</small></div></div>
    <p className={css.duty}>{role.duty}</p>
    <div className={css.contact}><ToolbarIconButton label={copy('chat')} icon={MessageSquare} disabled={opening||role.state==='retired'} onClick={()=>void chat()}/><ToolbarIconButton label={copy('employeeDetail')} icon={ArrowUpRight} onClick={()=>openEmployee(role.id)}/></div>
    {failed&&<p role="alert">{copy('chatFailed')}</p>}
    <section><h2>{copy('businessMembership')}</h2><div className={css.scopeTags}>{role.scopes.map(scope=><span key={scope}>{scopes[scope]??scope}</span>)}</div></section>
   </aside>}
   <section className={css.desktop} aria-label={`${role.name}${copy('computerNameSuffix')}`}>
    <header className={css.desktopHeader}><Monitor size={18}/><strong>{role.name}{copy('computerNameSuffix')}</strong><EmployeeComputerStatus view={view}/><div className={css.viewActions}>
     <button ref={expandButton} type="button" aria-label={copy(expanded?'restoreLayout':'enlarge')} title={copy(expanded?'restoreLayout':'enlarge')} aria-pressed={expanded} onClick={()=>setExpanded(value=>!value)}>{expanded?<Minimize size={18}/>:<Maximize size={18}/>}</button>
     <button type="button" aria-label={copy('popout')} title={copy('popout')} onClick={popout}><ArrowUpRight size={18}/></button>
    </div></header>
    <div className={css.canvas}><EmployeeComputerPreview view={view} name={role.name}/></div>
    <footer className={css.desktopFooter}><span>{copy(view.state==='connected'?'controlPending':'controlUnavailable')}</span><button type="button" disabled title={copy(view.state==='connected'?'controlPending':'computerUnavailable')}>{copy('takeControl')}</button></footer>
   </section>
  </div>}
 </main>
}
