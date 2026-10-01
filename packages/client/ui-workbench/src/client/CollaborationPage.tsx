import { openDialog } from './dialog-focus.js'
import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { CollaborationGroup, CollaborationScope } from './collaboration-preview.js'
import { useBusinessScopes } from './business-scope-context.js'
import { rolePeople, type PreviewRole } from './role-preview.js'
import { twinDisplayName } from './team-presentation.js'
import css from './CollaborationPage.module.css'
import type { GroupRules } from '@teloa/contract'
import { SavedCollaborationPage, type SavedConversationDirectory } from './SavedCollaborationPage.js'
import type { GroupApi } from './group-api.js'
import type { GroupAttachmentApi } from './group-attachment-api.js'
import type { GroupReactionApi } from './group-reaction-api.js'
import type { GroupRoutingApi } from './group-routing-api.js'
import {useI18n} from './i18n/provider.js'

type Props={visible:boolean;target:{groupId:string;rootId:string}|null;roles:PreviewRole[];profileName:string;persistence:{api:GroupApi;attachments?:GroupAttachmentApi;reactions?:GroupReactionApi;routing?:GroupRoutingApi;directory?:SavedConversationDirectory}}
type RolePerson=ReturnType<typeof rolePeople>[number]
const memberKind=(t:ReturnType<typeof useI18n>['t'],value:RolePerson['kind']|undefined)=>value==='human'?t('collaboration.member.human'):value==='draft'?t('collaboration.member.draft'):value==='digital'?t('collaboration.member.digital'):value

/** 个人版协作群只有持久这一条线：目录、成员、消息与设置都来自群服务。 */
export function CollaborationPage({persistence,...props}:Props){
 // 共用目录切群时按身份重建详情，旧群的在途读取、资料选择和编辑表单不能落到新群。
 return <SavedCollaborationPage key={persistence.directory?props.target?.groupId:undefined} visible={props.visible} api={persistence.api} attachments={persistence.attachments} reactions={persistence.reactions} routing={persistence.routing} directory={persistence.directory} target={props.target} roles={props.roles} profileName={props.profileName}/>
}

export function GroupForm({group,rules,close,save,people,profileName,error}:{people:ReturnType<typeof rolePeople>;profileName:string;error:string|undefined;group:CollaborationGroup|undefined;rules:GroupRules;close:()=>void;save:(value:{name:string;scope:CollaborationScope;announcement:string;memberIds:string[];rules:GroupRules})=>void}){
  const {t}=useI18n()
  const collaborationScopes=useBusinessScopes()
  const dialog=useRef<HTMLDialogElement>(null),nameInput=useRef<HTMLInputElement>(null)
  const [name,setName]=useState(group?.name||''),[scope,setScope]=useState<CollaborationScope>(group?.scope||'general'),[announcement,setAnnouncement]=useState(group?.announcement||''),[members,setMembers]=useState<string[]>(group?.memberIds||['self'])
  const [groupRules,setGroupRules]=useState<GroupRules>(rules)
  useEffect(()=>openDialog(dialog.current,nameInput.current),[])
  // 本人与分身按个人版显示名呈现：本人行用显示名，分身行用「{显示名} 的分身 · 分身」，不再铺开岗位描述。
  const memberName=(person:RolePerson)=>person.id==='self'?profileName:person.kind==='draft'?twinDisplayName(profileName,t):person.name
  const memberCategory=(person:RolePerson)=>person.id==='self'?t('collaboration.message.selfRole'):person.kind==='draft'?t('collaboration.member.twin'):memberKind(t,person.kind)
  const memberDetail=(person:RolePerson)=>person.id!=='self'&&person.state==='retired'?memberCategory(person)+' · '+t('role.state.retired'):memberCategory(person)
  const title=t(group?'collaboration.form.edit':'collaboration.action.new')
  return <dialog ref={dialog} className={css.dialog} aria-label={title} onCancel={close}><form onSubmit={event=>{event.preventDefault();save({name,scope,announcement:group?announcement:'',memberIds:members,rules:groupRules})}}><header><h2>{title}</h2><button type="button" className={css.iconButton} aria-label={t('collaboration.form.close')} onClick={close}><X size={18}/></button></header>{error&&<p role="alert">{error}</p>}<label>{t('collaboration.form.name')}<input ref={nameInput} required maxLength={80} value={name} onChange={event=>setName(event.target.value)}/></label>{group?<label>{t('collaboration.form.announcement')}<textarea rows={3} maxLength={4000} value={announcement} onChange={event=>setAnnouncement(event.target.value)}/></label>:<label>{t('collaboration.form.scope')}<select value={scope} onChange={event=>setScope(event.target.value as CollaborationScope)}>{Object.entries(collaborationScopes).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>}<fieldset><legend>{t(group?'collaboration.form.members':'collaboration.form.memberLimit')}</legend>{people.map(person=><label className={css.memberChoice} key={person.id}><input type="checkbox" checked={members.includes(person.id)} disabled={person.id==='self'||(person.state==='retired'&&!members.includes(person.id))} onChange={event=>setMembers(event.target.checked?[...members,person.id]:members.filter(id=>id!==person.id))}/><span>{memberName(person)}<small>{memberDetail(person)}</small></span></label>)}</fieldset>{group?<>{([['historyVisibleToNewMembers','collaboration.form.rule.history'],['draftsVisibleInGroup','collaboration.form.rule.drafts'],['mentionAllAllowed','collaboration.form.rule.mentionAll']] as const).map(([key,label])=><label className={css.memberChoice} key={key}><input type="checkbox" checked={groupRules[key]} onChange={event=>setGroupRules(current=>({...current,[key]:event.target.checked}))}/><span>{t(label)}</span></label>)}<p className={css.boundary}>{t('collaboration.form.ruleBoundary')}</p></>:<p className={css.boundary}>{t('collaboration.form.memberBoundary')}</p>}<footer><button type="button" className={css.secondary} onClick={close}>{t('collaboration.form.cancel')}</button><button className={css.primary} type="submit" disabled={!name.trim()||members.length<2}>{t(group?'collaboration.form.saveSettings':'collaboration.action.new')}</button></footer></form></dialog>
}
