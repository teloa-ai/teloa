import type {CapabilitySnapshot} from '@teloa/contract'
import {useEffect,useRef,useState} from 'react'
import {Blocks,Check,Plus,RefreshCw,Search,X} from 'lucide-react'
import type {BindingClient} from './binding-client.js'
import type {HomeSkillSelection} from './prompt-preparation.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './HomeResourcePicker.module.css'
import {skillDisplayTitle,type SkillDisplayTitle} from './capability-skill-runtime.js'

export function HomeSkillPicker({work,selected,change,purpose='home',embedded=false,compact=false,query:controlledQuery,onQueryChange,skillTitles=[]}:{work:BindingClient;purpose?:'home'|'role';selected:readonly HomeSkillSelection[];change:(value:HomeSkillSelection[])=>void;embedded?:boolean;compact?:boolean;query?:string;onQueryChange?:(query:string)=>void;skillTitles?:readonly SkillDisplayTitle[]|undefined}){
 const {locale,t}=useI18n()
 const [catalog,setCatalog]=useState<CapabilitySnapshot['skills']>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[localQuery,setLocalQuery]=useState('')
 const query=controlledQuery??localQuery
 const request=useRef<AbortController|null>(null)
 const refresh=async()=>{
  request.current?.abort();const controller=new AbortController();request.current=controller
  setLoading(true);setError('');setCatalog([])
  try{const rows=await work.readHomeSkills(controller.signal);if(!controller.signal.aborted)setCatalog(rows)}
  catch(cause){if(!controller.signal.aborted)setError(localizeWorkError(locale,cause))}
  finally{if(!controller.signal.aborted)setLoading(false)}
 }
 useEffect(()=>{void refresh();return ()=>request.current?.abort()},[work,locale])
 const role=purpose==='role',maximum=role?30:8
 const skills=catalog.filter(skill=>role?skill.modelInvocable:skill.userInvocable)
 const display=(skill:HomeSkillSelection)=>{if(!skill.source&&!skill.provider){const matches=skills.filter(row=>row.name===skill.name);return matches.length===1?skillDisplayTitle(skillTitles,matches[0]!):skill.name}return skillDisplayTitle(skillTitles,skill)}
 const needle=query.trim().toLocaleLowerCase(),visible=needle?skills.filter(skill=>[skill.name,skill.description,display(skill)].some(value=>value.toLocaleLowerCase().includes(needle))):skills
 return <section className={[css.picker,embedded?css.embedded:'',compact?css.compact:''].filter(Boolean).join(' ')} aria-label={t(role?'homeSkill.roleAria':'homeSkill.homeAria')}>{!embedded&&<><div className={css.heading}><strong>{t(role?'homeSkill.default':'homeSkill.title')}</strong><button type="button" className={css.refresh} disabled={loading} onClick={()=>void refresh()} aria-label={t(role?'homeSkill.refreshRole':'homeSkill.refreshHome')}><RefreshCw size={15}/></button></div><p className={css.notice}>{t(role?'homeSkill.roleNotice':'homeSkill.homeNotice')}</p></>}
 <div className={css.filterRow}><label className={css.filter}><Search size={14}/><span className={css.srOnly}>{t('homeSkill.search')}</span><input value={query} onChange={event=>{if(controlledQuery===undefined)setLocalQuery(event.target.value);onQueryChange?.(event.target.value)}} placeholder={t('homeSkill.search')}/></label>{embedded&&<button type="button" className={css.refresh} disabled={loading} onClick={()=>void refresh()} aria-label={t('homeSkill.refreshHome')}><RefreshCw size={15}/></button>}</div>
 {loading&&<p role="status">{t('homeSkill.loading')}</p>}{error&&<p role="alert">{error}</p>}
 {selected.length>0&&<ul className={css.selected} aria-label={t(role?'homeSkill.selectedRole':'homeSkill.selectedHome')}>{selected.map(skill=><li key={skill.name}><span className={css.resourceIcon}><Check size={14}/></span><span className={css.resourceCopy}><strong title={display(skill)!==skill.name?skill.name:undefined}>{display(skill)===skill.name?'/'+skill.name:display(skill)}</strong><small>{t(loading?'homeSkill.loading':skills.some(value=>value.name===skill.name&&(role||(value.source===skill.source&&value.provider===skill.provider)))?'homeSkill.review':'homeSkill.unavailable')}</small></span><button type="button" onClick={()=>change(selected.filter(value=>value.name!==skill.name))} aria-label={t('homeSkill.removeAria',{title:display(skill)})}><X size={14}/>{t('homeSkill.remove')}</button></li>)}</ul>}
 <div className={css.directory}>{visible.map(skill=>{const chosen=selected.some(value=>value.name===skill.name);return <div key={skill.provider+':'+skill.source+':'+skill.name} className={css.resource}><span className={css.resourceIcon}><Blocks size={15}/></span><span className={css.resourceCopy}><strong title={display(skill)!==skill.name?skill.name:undefined}>{display(skill)}</strong><small title={skill.description}>{skill.description}</small></span><button type="button" disabled={selected.length>=maximum||chosen} onClick={()=>change([...selected,{name:skill.name,source:skill.source,provider:skill.provider}])} aria-label={t('homeSkill.selectAria',{title:display(skill)})}>{chosen?<><Check size={14}/>{t('homeSkill.added')}</>:<><Plus size={14}/>{t('homeSkill.add')}</>}</button></div>})}</div>
 {!loading&&!error&&!visible.length&&<p className={css.muted}>{t(needle?'homeSkill.noMatch':role?'homeSkill.emptyRole':'homeSkill.emptyHome')}</p>}
 </section>
}
