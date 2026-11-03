import {useEffect,useRef,useState} from 'react'
import type {WorkProject} from '@teloa/contract'
import type {ProjectApi} from './project-api.js'
import type {ProjectConversationBinding,ProjectMemoryMode} from './project-runtime-api.js'
import {ProjectContextPanel} from './ProjectContextPanel.js'
import {projectRuntimeCopy} from './project-runtime-copy.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './ProjectRuntimePanel.module.css'

type ConversationContextProps={sessionId:string;api:ProjectApi;generation?:unknown;className?:string|undefined;openProject:(project:WorkProject)=>void;newConversation:(project:WorkProject,mode:ProjectMemoryMode)=>void;resolved?:(value:{sessionId:string;project:WorkProject;memoryMode:ProjectMemoryMode}|undefined)=>void}
export function ProjectConversationContext(props:ConversationContextProps){
 const origin=useRef({sessionId:props.sessionId,api:props.api,generation:props.generation,key:0})
 if(origin.current.sessionId!==props.sessionId||origin.current.api!==props.api||origin.current.generation!==props.generation)origin.current={sessionId:props.sessionId,api:props.api,generation:props.generation,key:origin.current.key+1}
 return <CurrentProjectConversationContext key={origin.current.key} {...props}/>
}
function CurrentProjectConversationContext({sessionId,api,className,openProject,newConversation,resolved}:ConversationContextProps){
 const {locale}=useI18n(),copy=projectRuntimeCopy(locale),runtime=api.runtime
 const [value,setValue]=useState<{sessionId:string;project:WorkProject;binding:ProjectConversationBinding}>(),[open,setOpen]=useState(false)
 const [mode,setMode]=useState<ProjectMemoryMode>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
 const active=useRef(true),mutating=useRef(false),request=useRef(0)
 useEffect(()=>{active.current=true;return()=>{active.current=false}},[])
 useEffect(()=>{
  if(!runtime)return
  let current=true;setOpen(false);setValue(undefined);resolved?.(undefined)
  const update=async()=>{
   if(mutating.current)return
   const token=++request.current
   try{
    const binding=await runtime.binding(sessionId)
    if(!binding?.projectId){if(current&&token===request.current){setValue(undefined);resolved?.(undefined)}return}
    const {project}=await api.get(binding.projectId)
    if(current&&token===request.current){setValue({sessionId,project,binding});resolved?.({sessionId,project,memoryMode:binding.memoryMode})}
   }catch{if(current&&token===request.current){setValue(undefined);resolved?.(undefined)}}
  }
  void update();const focus=()=>{if(document.visibilityState==='visible')void update()}
  window.addEventListener('focus',focus);const timer=setInterval(focus,15000)
  return()=>{current=false;window.removeEventListener('focus',focus);clearInterval(timer)}
 },[runtime,api,sessionId,resolved])
 if(!value||value.sessionId!==sessionId)return null
 const pending=runtime?.pending(value.project.id),recoverable=pending?.endpoint==='bind'&&pending.input.sessionId===sessionId
 const save=async(recover=false)=>{
  if(!runtime||mutating.current||!active.current)return
  mutating.current=true;++request.current;setBusy(true);setError('');setNotice('')
  try{
   const binding=recover?(await runtime.recover(value.project.id),await runtime.binding(sessionId)):await runtime.bind({sessionId,projectId:value.project.id,expectedVersion:value.binding.version,memoryMode:mode??value.binding.memoryMode})
   if(!active.current)return
   if(!binding||binding.projectId!==value.project.id)throw Error(copy.stale)
   ++request.current;setValue({...value,binding});setMode(undefined);setNotice(copy.saved);resolved?.({sessionId,project:value.project,memoryMode:binding.memoryMode})
  }catch(cause){if(active.current)setError(localizeWorkError(locale,cause))}finally{mutating.current=false;if(active.current)setBusy(false)}
 }
 return <section className={className} aria-label={copy.title}>
  <div className={css.actions}><button type="button" onClick={()=>openProject(value.project)}>{value.project.title}</button><button type="button" aria-expanded={open} onClick={()=>setOpen(true)}>{copy.title}</button><small>{value.binding.memoryMode==='off'?copy.off:copy.enabled}</small>{value.project.state!=='archived'&&<button type="button" onClick={()=>newConversation(value.project,value.binding.memoryMode)}>{copy.newConversation}</button>}</div>
  <ProjectContextPanel key={value.project.id} project={value.project} api={api} sessionId={sessionId} conversationSettings={<section aria-label={copy.memoryMode}>  {value.project.state!=='archived'&&<div className={css.conversationMemory}><label>{copy.memoryMode}<select aria-label={copy.memoryMode} value={mode??value.binding.memoryMode} disabled={busy||!!pending||!!runtime?.recoveryError()} onChange={event=>{setMode(event.target.value as ProjectMemoryMode);setNotice('')}}><option value="enabled">{copy.enabled}</option><option value="off">{copy.off}</option></select></label><button type="button" disabled={busy||!!pending||!!runtime?.recoveryError()||!mode||mode===value.binding.memoryMode} onClick={()=>void save()}>{copy.save}</button></div>}
  {pending&&<p role="status">{copy.pending}{recoverable&&<button type="button" disabled={busy||!!runtime?.recoveryError()} onClick={()=>void save(true)}>{copy.recover}</button>}</p>}
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
</section>} open={open} close={()=>setOpen(false)}/>
 </section>
}
