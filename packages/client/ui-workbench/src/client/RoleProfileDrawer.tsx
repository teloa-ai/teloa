import type {ReactNode} from 'react'
import {ContextDrawer} from './ContextDrawer.js'
import teamCss from './TeamPage.module.css'
import twinCss from './TwinProfile.module.css'

/** 员工目录、市场与会话共用同一身份容器；分身保留专用布局。 */
export function RoleProfileDrawer({open=true,kind,title,close,children}:{open?:boolean;kind?:'employee'|'twin'|undefined;title:string;close:()=>void;children:ReactNode}){
 return <ContextDrawer open={open} padded={!kind} titleHidden={kind==='employee'} title={title} close={close} className={(kind==='employee'?teamCss.profileDrawer:kind==='twin'?twinCss.detailDrawer:'')??''}>
  <div className={kind==='employee'?teamCss.employeeDrawer:undefined}>{children}</div>
 </ContextDrawer>
}
