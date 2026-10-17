import {EmployeeAvatar} from './EmployeeAvatar.js'
import {employeeCopy} from './employee-copy.js'
import {StatusLabel} from './StatusLabel.js'
import { ChevronRight, Fingerprint, MessageCircle, Phone } from 'lucide-react';
import {sortRoster,type RosterSort} from './team-roster-grouping.js';
import {directoryChoiceCopy} from './directory-choice-copy.js';
import type { BusinessScopeLabel } from './business-directory.js';
import type { PreviewRole } from './role-preview.js';
import type { PreviewTask } from './task-preview.js';
import type { RosterFoldState } from './team-roster-fold.js';
import { useI18n } from './i18n/provider.js';
import { twinDisplayName } from './team-presentation.js';
import { defaultPersonalDisplayName, personalAvatarInitials, personalDisplayName } from './personal-profile.js';
import { TwinAvatar } from './TwinAvatar.js';
import rosterCss from './StaffRoster.module.css';

export type StaffRosterProps = {
    roles: readonly PreviewRole[];
    labels: readonly BusinessScopeLabel[];
    tasks: readonly PreviewTask[];
    focusScope?: string;
    fold: RosterFoldState;
    onFoldChange: (next: RosterFoldState) => void;
    searching: boolean;
    onSelect: (id: string) => void;
    onHire: () => void;
    onTalk?: ((id:string)=>void)|undefined;
    onPhone?: ((id:string)=>void)|undefined;
    onOpenTask?: ((id:string)=>void)|undefined;
    sort?:RosterSort;
    /** 本人用户名：分身在名单里按「{用户名} 的分身」显示，不用存储里第一人称的 role.name。 */
    profileName?: string;
    profileInitials?: string;
};

/** 分身是默认代拟身份，不进入数字员工的在岗状态机；数字员工才显示四档运行状态。 */
const rosterMemberStatus = (role: PreviewRole): 'twin' | 'retired' | 'paused' | 'active' =>
    role.kind === 'twin' ? 'twin' : role.state === 'retired' ? 'retired' : role.state === 'paused' ? 'paused' : 'active';

/** 成员行副文案取岗位一句话的首句：与个人主页身份栏同一口径，不再把 scopes 原值当人话展示。 */
export const dutyLead = (duty: string) => duty.split(/[。.!?！？\n]/)[0]?.trim() ?? '';

/**
 * 全局目录按员工身份展示可排序名录，跨业务关系只增加标签，不复制员工。
 * 当前工作及来源只读取调用方提供的目录快照，不另建会话或工作对象。
 */
export function StaffRoster({roles,labels,tasks,onSelect,onTalk,onPhone,onOpenTask,sort='name',profileName=defaultPersonalDisplayName,profileInitials=personalAvatarInitials(profileName)}:StaffRosterProps){
 const {t,locale,list}=useI18n()
 profileName=personalDisplayName(profileName,t('profile.account'))
 const copy=(key:Parameters<typeof directoryChoiceCopy>[1])=>directoryChoiceCopy(locale,key)
 const displayName=(role:PreviewRole)=>role.kind==='twin'?twinDisplayName(profileName,t):role.name
 const unique=sortRoster(roles,sort,locale,displayName)
 const scopeName=(scope:string)=>labels.find(label=>label.scope===scope)?.title??scope
 return <div className={rosterCss.rosterStack}><div className={rosterCss.tableViewport}><table className={rosterCss.rosterTable} aria-label={employeeCopy(locale,'employeeDirectory')}><thead><tr><th scope="col">{copy('name')} · {copy('duty')}</th><th scope="col">{copy('business')}</th><th scope="col">{copy('current')}</th><th scope="col">{copy('contact')}</th></tr></thead><tbody>{unique.map(item=>{
  const status=rosterMemberStatus(item),name=item.kind==='twin'?twinDisplayName(profileName,t):item.name
  const task=tasks.filter(task=>task.assigneeId===item.id&&!['completed','cancelled'].includes(task.state)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0]
  const statusLabel=t(status==='twin'?'team.roster.status.twin':status==='retired'?'team.roster.status.retired':status==='paused'?'team.roster.status.paused':'team.roster.status.active')
  return <tr key={item.id} data-roster-id={item.id}><td>
   <button type="button" data-teloa-entry={item.id} className={rosterCss.cardIdentity} onClick={()=>onSelect(item.id)}>
    {item.kind==='twin'?<TwinAvatar initials={profileInitials}/>:<EmployeeAvatar avatarKey={item.avatarKey}/>}
    <span className={rosterCss.personMain}><strong>{name}</strong><small>{dutyLead(item.duty)}</small></span>
    <ChevronRight size={15}/>
   </button></td><td><small className={rosterCss.cardScopes}>{list(item.scopes.map(scopeName))}</small></td><td>
   <span className={rosterCss.status} data-roster-status={status}>{status==='twin'?<><Fingerprint size={12}/>{statusLabel}</>:<StatusLabel label={statusLabel} mark={status==='active'?'enabled':status==='paused'?'paused':'retired'} tone={status==='active'?'good':'muted'}/>}</span>
   {task?<button type="button" className={rosterCss.workLink} onClick={()=>onOpenTask?onOpenTask(task.id):onSelect(item.id)} title={task.title}>{task.title}</button>:<small className={rosterCss.cardScopes}>{t('team.roster.idle')}</small>}
   </td><td><div className={rosterCss.contacts}>
   {onTalk&&item.storage==='persistent'&&<button type="button" title={t(item.state==='retired'?'team.profile.action.history':'team.profile.action.chat')} aria-label={name+' · '+t(item.state==='retired'?'team.profile.action.history':'team.profile.action.chat')} onClick={()=>onTalk(item.id)}><MessageCircle size={16}/></button>}
   {onPhone&&item.storage==='persistent'&&item.state!=='retired'&&<button type="button" title={copy('phone')} aria-label={name+' · '+copy('phone')} onClick={()=>onPhone(item.id)}><Phone size={16}/></button>}
   </div></td></tr>
 })}</tbody></table></div>
 </div>
}
