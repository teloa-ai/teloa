import {useEffect,useRef,useState} from 'react'
import {LoaderCircle,MessageSquare,Plus,Search,ShieldCheck} from 'lucide-react'
import type {GroupAgentGrantRead} from '@teloa/contract'
import type {PreviewRole} from './role-preview.js'
import type {PreviewTask} from './task-preview.js'
import {EmployeeAvatar} from './EmployeeAvatar.js'
import {roleFieldText,twinDisplayName} from './team-presentation.js'
import {personalAvatarInitials} from './personal-profile.js'
import {TwinAvatar} from './TwinAvatar.js'
import {useI18n} from './i18n/provider.js'
import css from './GroupMembersPanel.module.css'

type Props={groupId:string;grantBlocks?:Readonly<Record<string,'scope'|'inactive'>>|undefined;members:readonly string[];roles:readonly PreviewRole[];tasks:readonly PreviewTask[];profileName:string;blocked:boolean;addMembers:()=>void;openRole?:((id:string)=>void)|undefined;talkRole?:((id:string)=>Promise<boolean>)|undefined;grants?:Readonly<Record<string,GroupAgentGrantRead>>|undefined;configureGrant?:((id:string)=>void)|undefined}

/** 成员身份与单聊均走平台原端口；群内授权只使用当前群的真实读取结果。 */
export function GroupMembersPanel({groupId,grantBlocks,members,roles,tasks,profileName,blocked,addMembers,openRole,talkRole,grants,configureGrant}:Props){
 const {t}=useI18n(),[query,setQuery]=useState(''),[opening,setOpening]=useState<string>(),[error,setError]=useState<string>()
 const active=useRef(true),context=useRef({groupId,epoch:0}),openingLock=useRef(false)
 if(context.current.groupId!==groupId)context.current={groupId,epoch:context.current.epoch+1}
 useEffect(()=>{active.current=true;return()=>{active.current=false}},[])
 useEffect(()=>{setQuery('');setError(undefined);setOpening(undefined);openingLock.current=false},[groupId])
 const chat=async(id:string)=>{
  if(!talkRole||openingLock.current)return
  const current=context.current
  openingLock.current=true;setOpening(id);setError(undefined)
  try{const opened=await talkRole(id);if(active.current&&context.current===current&&!opened)setError(t('team.profile.historyEmpty'))}
  catch{if(active.current&&context.current===current)setError(t('group.members.chatFailed'))}
  finally{if(active.current&&context.current===current){openingLock.current=false;setOpening(undefined)}}
 }
 // 真实授权状态（已授权、已失效等）原样保留；岗位不服务本群业务或不在岗时补上原因，未授权只因不服务本群业务时直接显示原因。
 const grantText=(role:PreviewRole,read:GroupAgentGrantRead|undefined)=>{
  const block=grantBlocks?.[role.id],reason=block&&t(block==='scope'?'group.members.notServing':'group.members.inactive')
  const status=block==='scope'&&(!read||read.status==='not-granted')?undefined:read?t(`collaboration.agentGrant.status.${read.status}`):block?undefined:t('group.members.grantUnknown')
  return [status,reason].filter(Boolean).join(' · ')
 }
 const needle=query.trim().toLocaleLowerCase()
 const rows=members.map(id=>{const role=roles.find(item=>item.id===id),name=id==='self'?profileName:role?.kind==='twin'?twinDisplayName(profileName,t):role?.name??t('collaboration.message.historicalMember');return {id,role,name,duty:role?roleFieldText(role,'duty',t):''}}).filter(row=>[row.name,row.duty].some(value=>value.toLocaleLowerCase().includes(needle)))
 return <section className={css.panel} aria-label={t('group.panel.members')}>
  <header className={css.header}><h3>{t('group.panel.members')} <span>{members.length}</span></h3><button type="button" aria-label={t('collaboration.form.addMembers')} title={t('collaboration.form.addMembers')} disabled={blocked} onClick={addMembers}><Plus size={17} aria-hidden/></button></header>
  <label className={css.search}><Search size={15} aria-hidden/><input value={query} aria-label={t('group.members.search')} placeholder={t('group.members.search')} onChange={event=>setQuery(event.target.value)}/></label>
  {error&&<p className={css.error} role="alert">{error}</p>}
  <div className={css.rows}>{rows.map(({id,role,name,duty})=>{const read=grants?.[id],assigned=tasks.filter(task=>task.assigneeId===id),person=<>{role?.kind==='employee'?<EmployeeAvatar avatarKey={role.avatarKey} size="md"/>:role?.kind==='twin'?<TwinAvatar initials={personalAvatarInitials(profileName)}/>:<span className={css.human} aria-hidden>{name.slice(0,1)}</span>}<span className={css.identity}><strong>{name}</strong><small className={css.duty} title={role?duty:undefined}>{id==='self'?t('collaboration.message.selfRole'):role?duty:undefined}</small>{role&&<small>{assigned.length?t('collaboration.view.employeeWork',{count:assigned.length}):t('collaboration.view.employeeNoWork')}</small>}{role&&configureGrant&&<small>{grantText(role,read)}</small>}</span></>;return <article className={css.row} key={id}>
   {role&&openRole?<button type="button" className={css.person} aria-label={name} onClick={()=>openRole(id)}>{person}</button>:<div className={css.person}>{person}</div>}
   {role&&<div className={css.actions}>{talkRole&&<button type="button" aria-label={t('group.members.chatAria',{name})} title={t('group.members.chatAria',{name})} disabled={!!opening} onClick={()=>void chat(id)}>{opening===id?<LoaderCircle size={14} aria-hidden className={css.loading}/>:<MessageSquare size={14} aria-hidden/>}{t('group.members.chat')}</button>}{configureGrant&&<button type="button" aria-label={t('group.members.grantAria',{name})} title={t('group.members.grantAria',{name})} disabled={blocked||!read} onClick={()=>configureGrant(id)}><ShieldCheck size={14} aria-hidden/>{t('group.members.grant')}</button>}</div>}
  </article>})}</div>
  {!rows.length&&<p className={css.empty}>{t(needle?'collaboration.form.noMemberMatch':'collaboration.view.employeesEmpty')}</p>}
  {talkRole&&<p className={css.hint}>{t('group.members.chatHint')}</p>}
 </section>
}
