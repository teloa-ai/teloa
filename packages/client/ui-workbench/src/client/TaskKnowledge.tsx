import {useCallback,useEffect,useRef,useState} from 'react'
import {BookOpen,RefreshCw} from 'lucide-react'
import type {WorkResource,WorkTask} from '@teloa/contract'
import type {PreviewTask} from './task-preview.js'
import type {ResourceApi} from './resource-api.js'
import type {TaskMaterial,TaskMaterialApi} from './task-material-api.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import {oversizedResources} from './resource-full-text.js'
import css from './TaskKnowledge.module.css'

type TaskTarget=Pick<PreviewTask,'id'|'version'|'scope'|'storage'>
type Props={task:TaskTarget;api:TaskMaterialApi;resources:ResourceApi;changed?:(task:WorkTask)=>void;face?:'rail';onMaterials?:(rows:TaskMaterial[])=>void}

export function TaskKnowledge({task,api,resources,changed,face,onMaterials}:Props){
  const {locale,t,dateTime}=useI18n(),stamp=(value:string)=>dateTime(value,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})
  const [materials,setMaterials]=useState<TaskMaterial[]>(),[directory,setDirectory]=useState<WorkResource[]>(),[oversized,setOversized]=useState<Map<string,number>>(new Map()),[selected,setSelected]=useState<string>(),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[error,setError]=useState<string>(),[notice,setNotice]=useState<string>()
  const onMaterialsRef=useRef(onMaterials);onMaterialsRef.current=onMaterials
  const load=useCallback(async()=>{
    setLoading(true);setError(undefined)
    try{
      // 来源目录读不到时不置灰，添加时宿主仍会按同一上限拒绝。
      const [rows,resourceDirectory,sources]=await Promise.all([api.list(task.id),resources.directory(),resources.sources().catch(()=>[])])
      setMaterials(rows);setDirectory(resourceDirectory.resources);setOversized(oversizedResources(resourceDirectory.resources,sources));onMaterialsRef.current?.(rows)
    }catch(cause){setError(localizeWorkError(locale,cause))}
    finally{setLoading(false)}
  },[api,resources,task.id,locale])
  useEffect(()=>{void load()},[load])
  if(task.storage!=='persistent')return null
  const candidates=(directory??[]).filter(row=>row.status==='active'&&row.scopeIds.every(scope=>scope===task.scope))
  const choice=candidates.find(row=>row.id===selected)
  const pending=api.pending()
  const submit=async()=>{
    if(!choice||saving)return
    setSaving(true);setError(undefined);setNotice(undefined)
    try{
      const result=await api.add(task.id,task.version,choice.id,choice.version)
      changed?.(result.task);setSelected(undefined);setNotice(t('taskKnowledge.saved',{title:result.material.title,version:result.material.resourceVersion}))
      await load()
    }catch(cause){setError(localizeWorkError(locale,cause))}
    finally{setSaving(false)}
  }
  const recover=async()=>{
    if(saving)return
    setSaving(true);setError(undefined);setNotice(undefined)
    try{
      const result=await api.recover()
      changed?.(result.task);setNotice(t('taskKnowledge.recovered',{title:result.material.title,version:result.material.resourceVersion}))
      await load()
    }catch(cause){setError(localizeWorkError(locale,cause))}
    finally{setSaving(false)}
  }
  const rail=face==='rail',refresh=<button type="button" className={css.refresh} disabled={loading||saving} onClick={()=>void load()} aria-label={t('taskKnowledge.refresh')}><RefreshCw size={15}/></button>
  return <section className={css.panel} aria-label={t('taskKnowledge.title')} title={rail?t('taskKnowledge.title')+' · '+t('taskKnowledge.description'):undefined}><header className={css.header}>{!rail&&<><span className={css.icon}><BookOpen size={17}/></span><div><strong>{t('taskKnowledge.title')}</strong><p>{t('taskKnowledge.description')}</p></div></>}{refresh}</header>
    {!rail&&<p className={css.notice}>{t('taskKnowledge.pinning')}</p>}
    {error&&<p className={css.error} role="alert">{error}</p>}{notice&&<p className={css.success} role="status">{notice}</p>}
    {pending&&<div className={css.pending}><span>{t('taskKnowledge.pending',{taskVersion:pending.expectedTaskVersion,resourceVersion:pending.expectedResourceVersion})}</span><button type="button" disabled={saving} onClick={()=>void recover()}>{t(saving?'taskKnowledge.reviewing':'taskKnowledge.recover')}</button></div>}
    {loading?<p className={css.muted} role="status">{t('taskKnowledge.loading')}</p>:<>
      <div className={css.materials} aria-label={t('taskKnowledge.pinnedAria')}>{materials?.map(material=><article key={material.id} className={css.material}><div><strong>{material.title}</strong><small>{t('taskKnowledge.materialMeta',{version:material.resourceVersion,source:material.sourceId,sourceVersion:material.sourceVersion.slice(0,12)})}</small><small>{t('taskKnowledge.scopeMeta',{scope:material.scopeIds.join(' · '),at:stamp(material.createdAt)})}</small></div><em data-available={material.available}>{t(material.available?'taskKnowledge.available':'taskKnowledge.unavailable')}</em></article>)}</div>
      {materials?.length===0&&<p className={css.muted}>{t('taskKnowledge.empty')}</p>}
      <div className={css.add} title={rail?t('taskKnowledge.pinning'):undefined}><div><strong>{t('taskKnowledge.addTitle')}</strong><p>{t('taskKnowledge.addDescription')}</p></div>{candidates.length?<div className={css.candidates}>{candidates.map(resource=>{const fixed=materials?.some(material=>material.resourceId===resource.id),size=oversized.get(resource.id);return <label key={resource.id} className={css.candidate} title={size===undefined?undefined:t('knowledge.fullTextTooLarge',{size})}><input type="radio" name={`task-knowledge-${task.id}`} checked={selected===resource.id} disabled={saving||fixed||size!==undefined} onChange={()=>setSelected(resource.id)}/><span><strong>{resource.title}</strong><small>{t('taskKnowledge.candidateMeta',{version:resource.version,sourceVersion:resource.sourceVersion.slice(0,12)})}</small></span>{fixed?<em>{t('taskKnowledge.pinned')}</em>:size!==undefined&&<em>{t('knowledge.fullTextTooLarge',{size})}</em>}</label>})}</div>:<p className={css.muted}>{t('taskKnowledge.noCandidates')}</p>}
      {choice&&<div className={css.confirm}><span>{t('taskKnowledge.confirm',{title:choice.title,version:choice.version,sourceVersion:choice.sourceVersion.slice(0,12)})}</span><button type="button" disabled={saving} onClick={()=>void submit()}>{t(saving?'taskKnowledge.submitting':'taskKnowledge.submit')}</button></div>}</div>
    </>}
  </section>
}
