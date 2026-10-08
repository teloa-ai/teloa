import type {Group,GroupMember} from '@teloa/contract'
import {roleSupportsScope} from '@teloa/contract'
import {canReceiveTask,type PreviewRole} from './role-preview.ts'
import type {TeloaTranslate} from './i18n/index.js'

export function visibleSavedGroups(rows:readonly Group[],query:string,scope:string,archived:boolean):Group[]{
 const needle=query.trim().toLocaleLowerCase()
 return rows.filter(group=>group.archived===archived&&(scope==='all'||group.scope===scope)&&(!needle||[group.name,group.id,group.announcement].some(value=>value.toLocaleLowerCase().includes(needle))))
}

// 员工沿现有成员资格；分身必须同时具备当前委托、本人回执和本群范围。
function activeGroupWorkers(members:readonly GroupMember[],roles:readonly PreviewRole[]):PreviewRole[]{
 return members.flatMap(member=>{
  const role=member.roleId?roles.find(item=>item.id===member.roleId):undefined
  return role&&role.state==='active'&&(role.kind==='employee'||role.workAccess?.delegations.some(delegation=>canReceiveTask(role,delegation.scope,member.groupId)))?[role]:[]
 })
}

// 用户裁定 B：群成员不限业务范围，范围只作「从群建任务时的默认范围」。
// 负责人必须支持该群业务范围才能接任务（tasks.ts:107、task-run-group-context.ts:39），
// 不支持的成员不列入候选，否则要到 prepare 才撞 teloa/conflict。
export function groupTaskAssignees(members:readonly GroupMember[],roles:readonly PreviewRole[],scope:string):PreviewRole[]{
 return activeGroupWorkers(members,roles).filter(role=>roleSupportsScope(role.scopes,scope)&&canReceiveTask(role,scope,members.find(member=>member.roleId===role.id)?.groupId))
}

/** @ 不按群业务范围过滤；分身仍须有本人确认的本群执行资格。 */
export function groupMentionCandidates(members:readonly GroupMember[],roles:readonly PreviewRole[]):PreviewRole[]{
 return activeGroupWorkers(members,roles)
}

/** 新回传作者取已验证服务端消息的执行快照；旧消息沿既有历史身份回退。 */
export function groupMessageIdentity(message:{authorId:string;runId?:string;source?:unknown},roleNames:Readonly<Record<string,string>>,t:TeloaTranslate):{name:string;kind:'human'|'employee'|'twin'}{
 if(!message.runId)return {name:t('collaboration.message.self'),kind:'human'}
 if(message.source&&typeof message.source==='object'){
  const source=message.source as Record<string,unknown>
  if(source.schema==='teloa.group-run-source/v2'&&source.roleId===message.authorId&&Number.isSafeInteger(source.roleVersion)&&Number(source.roleVersion)>0&&(source.roleKind==='employee'||source.roleKind==='twin')&&typeof source.roleName==='string'&&source.roleName.trim())return {name:source.roleName,kind:source.roleKind}
 }
 return {name:roleNames[message.authorId]??t('collaboration.message.historicalMember'),kind:'employee'}
}

export function savedMemberLabel(t:TeloaTranslate,member:GroupMember,roles:readonly PreviewRole[]):{name:string;detail:string}{
 if(member.roleId===null)return {name:t('collaboration.message.self'),detail:t('collaboration.message.selfRole')}
 const role=roles.find(item=>item.id===member.roleId)
 if(!role)return {name:t('presentation.collaboration.formerRole'),detail:member.roleId}
 const stateKey=role.state==='active'?'role.state.active':role.state==='paused'?'role.state.paused':'role.state.retired'
 return {name:role.name,detail:t('presentation.collaboration.memberState',{kind:t('presentation.collaboration.digitalEmployee'),state:t(stateKey)})}
}

/** 同名同事按岗位后缀区分；候选项标签与正文 @token 同一口径，删 token 才能精确对上一位同事。 */
export function groupMentionLabel(role:PreviewRole,candidates:readonly PreviewRole[]):string{
 return candidates.some(item=>item.id!==role.id&&item.name===role.name)?role.name+'·'+(role.duty||role.id):role.name
}

/**
 * 正文里光标前那段「行首或空白后的 @前缀」；没有就返回 undefined。
 * 只用来决定弹不弹候选与过滤词，绝不据此推断 roleId——提及一律由选择动作产生。
 */
export function groupMentionQuery(text:string,caret:number):{start:number;query:string}|undefined{
 const before=text.slice(0,caret),start=before.lastIndexOf('@')
 if(start<0)return undefined
 const previous=start>0?before[start-1]:undefined
 if(previous!==undefined&&!/\s/.test(previous))return undefined
 const query=before.slice(start+1)
 return /[\s@]/.test(query)?undefined:{start,query}
}
