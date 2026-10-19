import {useEffect,useState} from 'react'
import {RefreshCw,Settings2,Share2} from 'lucide-react'
import type {BusinessResponsibility as Responsibility} from '@teloa/contract'
import type {BusinessResponsibilityProps} from './BusinessResponsibility.js'
import {BusinessResponsibility} from './BusinessResponsibility.js'
import type {PreviewRole} from './role-preview.js'
import {EmployeeAvatar} from './EmployeeAvatar.js'
import {ContextDrawer} from './ContextDrawer.js'
import {ToolbarIconButton} from './ToolbarIconButton.js'
import {TeamTemplateShare,useTemplateShare} from './EmployeeTemplateShare.js'
import {useI18n} from './i18n/provider.js'
import {businessWorkspaceText} from './business-workspace-copy.js'
import css from './BusinessWorkspace.module.css'

/** 员工名单的轻量操作：协调员工只在确有负责关系时显示摘要，沿用业务负责关系，不创建人类 lead、第二员工或层级；团队分享的协调者取当前负责关系。 */
export function BusinessTeamOrganization({scope,title,roles,responsibility,openRole}:{scope:string;title:string;roles:readonly PreviewRole[];responsibility?:Omit<BusinessResponsibilityProps,'scope'>|undefined;openRole:(id:string)=>void}){
 const {locale,t}=useI18n(),text=(key:Parameters<typeof businessWorkspaceText>[1])=>businessWorkspaceText(locale,key),sharing=useTemplateShare()
 const [current,setCurrent]=useState<Responsibility|null>(null),[status,setStatus]=useState<'loading'|'ready'|'failed'>('loading'),[editing,setEditing]=useState(false),[revision,setRevision]=useState(0),[sharingTeam,setSharingTeam]=useState(false)
 const [saving,setSaving]=useState(false)
 useEffect(()=>{let live=true;setCurrent(null);setStatus('loading');if(!responsibility){setStatus('ready');return}
  void responsibility.api.read({scope}).then(value=>{if(live){setCurrent(value);setStatus('ready')}},()=>{if(live)setStatus('failed')});return()=>{live=false}
 },[scope,responsibility?.api,revision])
 const lead=current?.roleId?roles.find(role=>role.id===current.roleId):undefined
 const shareable=!!sharing&&roles.some(role=>role.storage==='persistent'&&role.kind==='employee'&&role.state!=='retired')
 return <>
  {responsibility&&(status==='failed'?<span className={css.coordinatorSummary}><span className={css.mutedLabel}>{text('coordinator')} · {text('failed')}</span><ToolbarIconButton label={text('retry')} icon={RefreshCw} onClick={()=>setRevision(value=>value+1)}/></span>
   :lead?<span className={css.coordinatorSummary}><span className={css.mutedLabel}>{text('coordinator')}</span><button type="button" className={css.coordinatorIdentity} onClick={()=>openRole(lead.id)}><EmployeeAvatar avatarKey={lead.avatarKey} size="sm"/><strong>{lead.name}</strong>{current?.availability!=='ready'&&<small>{text('unavailable')}</small>}</button><ToolbarIconButton label={text('configureCoordinator')} icon={Settings2} onClick={()=>setEditing(true)}/></span>
   :status==='ready'&&<>{current?.roleId&&<span className={css.mutedLabel}>{text('coordinator')} · {text('unavailable')}</span>}<ToolbarIconButton label={text('configureCoordinator')} icon={Settings2} onClick={()=>setEditing(true)}/></>)}
  {shareable&&<ToolbarIconButton label={t('templateShare.shareTeam')} icon={Share2} onClick={()=>setSharingTeam(true)}/>}
  {editing&&responsibility&&<ContextDrawer padded title={text('configureCoordinator')} canClose={!saving} close={()=>{if(saving)return;setEditing(false);setRevision(value=>value+1)}}><p className={css.mutedLabel}>{text('coordinatorHint')}</p><BusinessResponsibility {...responsibility} scope={scope} onSavingChange={setSaving} onChanged={()=>{setRevision(value=>value+1);responsibility.onChanged?.()}}/></ContextDrawer>}
  {sharingTeam&&<TeamTemplateShare roles={roles.filter(role=>role.storage==='persistent')} open close={()=>setSharingTeam(false)} scope={scope} title={title} coordinatorRoleId={lead?.id}/>}
 </>
}
