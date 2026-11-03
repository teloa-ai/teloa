import {useRef,useState} from 'react'
import type {RoleResponsibility} from '@teloa/contract'
import type {BindingClient} from './binding-client.js'
import type {ResourceApi} from './resource-api.js'
import {skillDisplayTitle,type SkillDisplayTitle} from './capability-skill-runtime.js'
import {responsibilityGroups} from './role-runtime-config.js'
import {HomeSkillPicker} from './HomeSkillPicker.js'
import {RoleKnowledge} from './RoleKnowledge.js'
import {roleEditCopy} from './role-edit-copy.js'
import {useI18n} from './i18n/provider.js'
import css from './EmployeeEditDetails.module.css'

type ResponsibilityKey=keyof RoleResponsibility
const items=(text:string)=>[...new Set(text.split('\n').map(item=>item.trim()).filter(Boolean))]

/** 展开只阅读原五组；输入仍只更新本人的表单草稿，不从岗位说明推导授权。 */
export function EmployeeResponsibilityDetails({value,change}:{value:RoleResponsibility;change:(value:RoleResponsibility)=>void}){
 const {locale,t}=useI18n()
 const [editing,setEditing]=useState<{key:ResponsibilityKey;original:string[];text:string}>()
 const editButtons=useRef(new Map<ResponsibilityKey,HTMLButtonElement>())
 const finish=(key:ResponsibilityKey)=>{setEditing(undefined);requestAnimationFrame(()=>editButtons.current.get(key)?.focus())}
 return <dl className={css.responsibilities}>{responsibilityGroups(value).map(group=>{
  const label=t(group.labelKey),active=editing?.key===group.key
  return <div key={group.key}>
   <dt><span>{label}</span>{!active&&<button type="button" ref={button=>{if(button)editButtons.current.set(group.key,button);else editButtons.current.delete(group.key)}} aria-label={roleEditCopy(locale,'edit')+label} onClick={()=>setEditing({key:group.key,original:[...group.items],text:group.items.join('\n')})}>{roleEditCopy(locale,'edit')}</button>}</dt>
   <dd>{active?<div className={css.editor}>
    <textarea autoFocus aria-label={label} rows={3} maxLength={4000} value={editing.text} onChange={event=>{const text=event.target.value;setEditing({...editing,text});change({...value,[group.key]:items(text)})}}/>
    <small>{t('team.form.onePerLine')}</small>
    <div className={css.actions}><button type="button" onClick={()=>finish(group.key)}>{roleEditCopy(locale,'finishEdit')}</button><button type="button" onClick={()=>{change({...value,[group.key]:editing.original});finish(group.key)}}>{roleEditCopy(locale,'cancelEdit')}</button></div>
   </div>:group.items.length?<ul>{group.items.map((item,index)=><li key={index}>{item}</li>)}</ul>:<p className={css.empty}>{roleEditCopy(locale,'notSet')}</p>}</dd>
  </div>
 })}</dl>
}

export function EmployeeCapabilityDetails({work,resourceApi,skills,knowledge,scopes,skillTitles=[],query,changeQuery,changeSkills,changeKnowledge}:{work:BindingClient;resourceApi:ResourceApi;skills:readonly string[];knowledge:readonly string[];scopes:readonly string[];skillTitles?:readonly SkillDisplayTitle[]|undefined;query:string;changeQuery:(value:string)=>void;changeSkills:(skills:string[])=>void;changeKnowledge:(ids:string[])=>void}){
 const {locale}=useI18n()
 const [selectSkills,setSelectSkills]=useState(false),[selectKnowledge,setSelectKnowledge]=useState(false)
 return <div className={css.capabilities}>
  <section className={css.group} aria-label={roleEditCopy(locale,'skills')}>
   <header><h3>{roleEditCopy(locale,'skills')}</h3><button type="button" onClick={()=>setSelectSkills(value=>!value)}>{roleEditCopy(locale,selectSkills?'finishSkills':'chooseSkills')}</button></header>
   {selectSkills?<HomeSkillPicker embedded compact purpose="role" work={work} skillTitles={skillTitles} query={query} onQueryChange={changeQuery} selected={skills.map(name=>({name,source:'',provider:''}))} change={selected=>changeSkills(selected.map(skill=>skill.name))}/>:skills.length?<ul className={css.skillList}>{skills.map(name=><li key={name}>{skillDisplayTitle(skillTitles,{name})}</li>)}</ul>:<p className={css.empty}>{roleEditCopy(locale,'noSkills')}</p>}
  </section>
  <section className={css.group} aria-label={roleEditCopy(locale,'knowledge')}>
   <header><h3>{roleEditCopy(locale,'knowledge')}</h3><button type="button" onClick={()=>setSelectKnowledge(value=>!value)}>{roleEditCopy(locale,selectKnowledge?'finishKnowledge':'chooseKnowledge')}</button></header>
   {knowledge.length||selectKnowledge?<RoleKnowledge compact api={resourceApi} ids={knowledge} scopes={scopes} {...(selectKnowledge?{change:changeKnowledge}:{})}/>:<p className={css.empty}>{roleEditCopy(locale,'noKnowledge')}</p>}
  </section>
 </div>
}
