import {useEffect,useState} from 'react'
import type {WorkProject} from '@teloa/contract'
import type {ProjectApi} from './project-api.js'
import type {ProjectConversationBinding,ProjectMemoryMode} from './project-runtime-api.js'
import {ProjectContextPanel} from './ProjectContextPanel.js'
import {projectRuntimeCopy} from './project-runtime-copy.js'
import {useI18n} from './i18n/provider.js'
import css from './ProjectRuntimePanel.module.css'

export function ProjectConversationContext({sessionId,api,className,openProject,newConversation,resolved}:{sessionId:string;api:ProjectApi;className?:string|undefined;openProject:(project:WorkProject)=>void;newConversation:(project:WorkProject,mode:ProjectMemoryMode)=>void;resolved?:(value:{sessionId:string;project:WorkProject;memoryMode:ProjectMemoryMode}|undefined)=>void}){
 const {locale}=useI18n(),copy=projectRuntimeCopy(locale),runtime=api.runtime
 const [value,setValue]=useState<{sessionId:string;project:WorkProject;binding:ProjectConversationBinding}>(),[open,setOpen]=useState(false)
 useEffect(()=>{
  if(!runtime)return
  let active=true,request=0;setOpen(false);setValue(undefined);resolved?.(undefined)
  const update=async()=>{
   const token=++request
   try{
    const binding=await runtime.binding(sessionId)
    if(!binding?.projectId){if(active&&token===request){setValue(undefined);resolved?.(undefined)}return}
    const {project}=await api.get(binding.projectId)
    if(active&&token===request){setValue({sessionId,project,binding});resolved?.({sessionId,project,memoryMode:binding.memoryMode})}
   }catch{if(active&&token===request){setValue(undefined);resolved?.(undefined)}}
  }
  void update();const focus=()=>{if(document.visibilityState==='visible')void update()}
  window.addEventListener('focus',focus);const timer=setInterval(focus,15000)
  return()=>{active=false;window.removeEventListener('focus',focus);clearInterval(timer)}
 },[runtime,api,sessionId,resolved])
 if(!value||value.sessionId!==sessionId)return null
 return <section className={className} aria-label={copy.title}>
  <div className={css.actions}><button type="button" onClick={()=>openProject(value.project)}>{value.project.title}</button><button type="button" aria-expanded={open} onClick={()=>setOpen(true)}>{copy.title}</button><small>{value.binding.memoryMode==='off'?copy.off:copy.enabled}</small>{value.project.state!=='archived'&&<button type="button" onClick={()=>newConversation(value.project,value.binding.memoryMode)}>{copy.newConversation}</button>}</div>
  <ProjectContextPanel key={value.project.id} project={value.project} api={api} sessionId={sessionId} open={open} close={()=>setOpen(false)}/>
 </section>
}
