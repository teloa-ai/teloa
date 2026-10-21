import type {GroupWorkResourcePort} from './group-work-resources.js'
import type {IndustryTeamMaterialsPort} from './industry-team-materials.js'
import {RoleProfileDrawer} from './RoleProfileDrawer.js'
import { ContextDrawer } from './ContextDrawer.js'
import { useEffect, useRef, useState } from 'react'
import type { CollaborationGroup, CollaborationScope } from './collaboration-preview.js'
import { useBusinessScopes } from './business-scope-context.js'
import { rolePeople, type PreviewRole } from './role-preview.js'
import { twinDisplayName } from './team-presentation.js'
import css from './CollaborationPage.module.css'
import type { GroupRules,GroupWorkLinkItem } from '@teloa/contract'
import { SavedCollaborationPage, type SavedConversationDirectory,type GroupWorkContext,type GroupCreationForm,type GroupPanelPort,type GroupArtifactRailPort } from './SavedCollaborationPage.js'
export type { GroupPanelPort } from './SavedCollaborationPage.js'
import type { GroupApi } from './group-api.js'
import type { GroupAttachmentApi } from './group-attachment-api.js'
import type { GroupReactionApi } from './group-reaction-api.js'
import type {GroupChannelContext} from './GroupChannelBindings.js'
import type { GroupRoutingApi } from './group-routing-api.js'
import {useI18n} from './i18n/provider.js'
import type {WorkbenchNavigationStorage} from './workbench-navigation-state.js'

type Props={artifactRail?:GroupArtifactRailPort|undefined;artifactOpen?:boolean;work?:GroupWorkContext|undefined;visible:boolean;panel?:GroupPanelPort|undefined;target:{groupId:string;rootId:string;messageId?:string}|null;roles:PreviewRole[];profileName:string;persistence:{workResources?:GroupWorkResourcePort;templateMaterials?:IndustryTeamMaterialsPort;preferences?:WorkbenchNavigationStorage;api:GroupApi;attachments?:GroupAttachmentApi;reactions?:GroupReactionApi;routing?:GroupRoutingApi;channels?:GroupChannelContext;directory?:SavedConversationDirectory}}
type RolePerson=ReturnType<typeof rolePeople>[number]
const memberKind=(t:ReturnType<typeof useI18n>['t'],value:RolePerson['kind']|undefined)=>value==='human'?t('collaboration.member.human'):value==='draft'?t('collaboration.member.draft'):value==='digital'?t('collaboration.member.digital'):value

/** 个人版协作群只有持久这一条线：目录、成员、消息与设置都来自群服务。 */
export function CollaborationPage({persistence,...props}:Props){
 const {t}=useI18n()
 const [createForms,setCreateForms]=useState<GroupCreationForm[]>([])
 const [roleDetail,setRoleDetail]=useState<string>()
 const [workDetail,setWorkDetail]=useState<GroupWorkLinkItem>()
 useEffect(()=>setRoleDetail(undefined),[props.target?.groupId,props.visible])
 useEffect(()=>setWorkDetail(undefined),[props.target?.groupId,props.visible])
 const lastRoleId=useRef<string>(),roleOrigin=useRef<{groupId:string|undefined;api:GroupApi}>();if(roleDetail)lastRoleId.current=roleDetail
 const profileVisible=props.visible&&!!roleDetail&&roleOrigin.current?.groupId===props.target?.groupId&&roleOrigin.current?.api===persistence.api
 const role=props.roles.find(row=>row.id===lastRoleId.current)
 const closeRole=()=>setRoleDetail(undefined)
 // 群内身份沿用平台详情装配，不能借全局导航卸载群设置、话题和输入。
 const work=props.work?{...props.work,...(props.work.renderRole?{openRole:(id:string)=>{roleOrigin.current={groupId:props.target?.groupId,api:persistence.api};setRoleDetail(id)}}:{}),...(props.work.renderLink?{openLink:(item:GroupWorkLinkItem)=>setWorkDetail(item)}:{})}:undefined
 // 共用目录切群时按身份重建详情，旧群的在途读取、资料选择和编辑表单不能落到新群。
 // 创建草稿属于来源业务，放在群详情身份外侧，保存或切群只清当前来源。
 const page=<SavedCollaborationPage workResources={persistence.workResources} artifactRail={props.artifactRail} creationForms={{items:createForms,change:setCreateForms}} work={work} key={persistence.directory?props.target?.groupId:undefined} visible={props.visible} panel={props.panel} templateMaterials={persistence.templateMaterials} preferences={persistence.preferences} api={persistence.api} attachments={persistence.attachments} reactions={persistence.reactions} routing={persistence.routing} channels={persistence.channels} directory={persistence.directory} target={props.target} roles={props.roles} profileName={props.profileName}/>
 return props.work?.renderRole||props.work?.renderLink?<>{page}{props.work.renderRole&&<RoleProfileDrawer key={'profile:'+props.target?.groupId} open={profileVisible&&!!role} kind={role?.kind} title={role?.kind==='twin'?twinDisplayName(props.profileName,t):role?.name??t('navigation.team')} close={closeRole}>{lastRoleId.current&&props.work.renderRole(lastRoleId.current,closeRole,profileVisible&&!!role)}</RoleProfileDrawer>}{props.visible&&workDetail?.available&&props.work.renderLink&&<ContextDrawer open={!props.artifactOpen} title={workDetail.title!} close={()=>setWorkDetail(undefined)}>{props.work.renderLink(workDetail,()=>setWorkDetail(undefined))}</ContextDrawer>}</>:page
}

export function GroupForm({group,rules,close,save,people,profileName,error}:{people:ReturnType<typeof rolePeople>;profileName:string;error:string|undefined;group:CollaborationGroup|undefined;rules:GroupRules;close:()=>void;save:(value:{name:string;scope:CollaborationScope;announcement:string;memberIds:string[];rules:GroupRules})=>void}){
  const {t}=useI18n()
  const collaborationScopes=useBusinessScopes()
  const nameInput=useRef<HTMLInputElement>(null)
  const [name,setName]=useState(group?.name||''),[scope,setScope]=useState<CollaborationScope>(group?.scope||'general'),[announcement,setAnnouncement]=useState(group?.announcement||''),[members,setMembers]=useState<string[]>(group?.memberIds||['self'])
  const [groupRules,setGroupRules]=useState<GroupRules>(rules)
  // 本人与分身按个人版显示名呈现：本人行用显示名，分身行用「{显示名} 的分身 · 分身」，不再铺开岗位描述。
  const memberName=(person:RolePerson)=>person.id==='self'?profileName:person.kind==='draft'?twinDisplayName(profileName,t):person.name
  const memberCategory=(person:RolePerson)=>person.id==='self'?t('collaboration.message.selfRole'):person.kind==='draft'?t('collaboration.member.twin'):memberKind(t,person.kind)
  const memberDetail=(person:RolePerson)=>person.id!=='self'&&person.state==='retired'?memberCategory(person)+' · '+t('role.state.retired'):memberCategory(person)
  const title=t(group?'collaboration.form.edit':'collaboration.action.new')
  return <ContextDrawer title={title} close={close} initialFocus={nameInput} className={css.dialog+' '+css.lightDrawer}><form onSubmit={event=>{event.preventDefault();save({name,scope,announcement:group?announcement:'',memberIds:members,rules:groupRules})}}>{error&&<p role="alert">{error}</p>}<label>{t('collaboration.form.name')}<input ref={nameInput} required maxLength={80} value={name} onChange={event=>setName(event.target.value)}/></label>{group?<label>{t('collaboration.form.announcement')}<textarea rows={3} maxLength={4000} value={announcement} onChange={event=>setAnnouncement(event.target.value)}/></label>:<label>{t('collaboration.form.scope')}<select value={scope} onChange={event=>setScope(event.target.value as CollaborationScope)}>{Object.entries(collaborationScopes).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>}<fieldset><legend>{t(group?'collaboration.form.members':'collaboration.form.memberLimit')}</legend>{people.map(person=><label className={css.memberChoice} key={person.id}><input type="checkbox" checked={members.includes(person.id)} disabled={person.id==='self'||(person.state==='retired'&&!members.includes(person.id))} onChange={event=>setMembers(event.target.checked?[...members,person.id]:members.filter(id=>id!==person.id))}/><span>{memberName(person)}<small>{memberDetail(person)}</small></span></label>)}</fieldset>{group?<>{([['historyVisibleToNewMembers','collaboration.form.rule.history'],['draftsVisibleInGroup','collaboration.form.rule.drafts'],['mentionAllAllowed','collaboration.form.rule.mentionAll']] as const).map(([key,label])=><label className={css.memberChoice} key={key}><input type="checkbox" checked={groupRules[key]} onChange={event=>setGroupRules(current=>({...current,[key]:event.target.checked}))}/><span>{t(label)}</span></label>)}<p className={css.boundary}>{t('collaboration.form.ruleBoundary')}</p></>:<p className={css.boundary}>{t('collaboration.form.memberBoundary')}</p>}<footer><button type="button" className={css.secondary} onClick={close}>{t('collaboration.form.cancel')}</button><button className={css.primary} type="submit" disabled={!name.trim()||members.length<2}>{t(group?'collaboration.form.saveSettings':'collaboration.action.new')}</button></footer></form></ContextDrawer>
}
