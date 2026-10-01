import {useEffect,useRef,useState} from 'react'
import type {SkillInstallApi,SkillInstallationRecord,SkillInstallObservation,SkillInstallPreview,SkillInstallSourceInput} from './skill-install-api.js'
import {SkillInstallationStatus} from './SkillInstallationStatus.js'
import {mergeSkillInstallation,selectSkillInstallation,skillPendingForSource,recoverSkillForSource,uniqueSkillInstallations} from './skill-install-state.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
export function SkillInstallControl({api,source,title,changed}:{api:SkillInstallApi;source:SkillInstallSourceInput;title:string;changed?:()=>void}){
  const {locale,t}=useI18n()
  const [preview,setPreview]=useState<SkillInstallPreview>(),[record,setRecord]=useState<SkillInstallationRecord>(),[observation,setObservation]=useState<{id:string;version:number;value:SkillInstallObservation}>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0),[linked,setLinked]=useState(source.kind==='atomic'),[discarded,setDiscarded]=useState(false)
  const loadGeneration=useRef(0),actionGeneration=useRef(0),operation=useRef(false),recordRef=useRef(record)
  recordRef.current=record
  useEffect(()=>()=>{loadGeneration.current++;actionGeneration.current++},[])
  useEffect(()=>{
    let live=true
    const token=++loadGeneration.current
    setError('')
    void Promise.all([api.preview(source),api.list()]).then(([fixed,directory])=>{
      if(!live||token!==loadGeneration.current)return
      setPreview(fixed)
      const selected=selectSkillInstallation(source,fixed,directory.items,directory.usages)
      setLinked(selected.linked)
      setRecord(current=>mergeSkillInstallation(current,selected.record))
    },()=>{if(live&&token===loadGeneration.current)setError(t('market.skill.status.readFailed'))})
    return()=>{live=false;loadGeneration.current++}
  },[api,JSON.stringify(source),revision])
  const observe=async()=>{
    if(!record||operation.current)return
    const id=record.id,version=record.version,token=++actionGeneration.current
    operation.current=true;setBusy(true);setError('')
    try{
      const value=await api.observe(id)
      const current=recordRef.current
      if(token===actionGeneration.current&&current?.id===id&&current.version===version){setObservation({id,version,value});changed?.()}
    }catch{if(token===actionGeneration.current)setError(t('market.skill.status.observeFailed'))}
    finally{if(token===actionGeneration.current){operation.current=false;setBusy(false)}}
  }
  const run=async(action:()=>Promise<SkillInstallationRecord>)=>{
    if(operation.current)return
    const token=++actionGeneration.current
    operation.current=true;setBusy(true);setError('')
    try{
      const saved=await action()
      if(token!==actionGeneration.current)return
      setRecord(current=>mergeSkillInstallation(current,saved));setRevision(x=>x+1);changed?.()
    }catch{if(token===actionGeneration.current)setError(t('market.skill.status.actionFailed'))}
    finally{if(token===actionGeneration.current){operation.current=false;setBusy(false)}}
  }
  const pending=api.pending(),recoveryError=api.recoveryMessage(),pendingHere=skillPendingForSource(pending,source),blockedByOther=!!pending&&!pendingHere
  const installRequest=()=>({requestId:crypto.randomUUID(),source,expectedBundleHash:preview!.bundleHash,...(preview!.trustHash?{expectedTrustHash:preview!.trustHash}:{})})
  return <section aria-label={t('market.skill.control.aria',{title})}>{preview&&<><p>{t('market.skill.control.nativeSummary',{name:preview.native.name,count:preview.files.length})}</p><details><summary>{t('market.skill.control.reviewFiles')}</summary><ul>{preview.files.map(file=><li key={file.path}>{file.path} · {file.size} {t('market.skill.file.bytes')} · {file.hash}</li>)}</ul></details></>}{blockedByOther&&<p role="status">{t('market.skill.control.otherPending')}</p>}<SkillInstallationStatus {...(record?{record}:{})} {...(record&&observation?.id===record.id&&observation.version===record.version?{observation:observation.value}:{})} pending={pendingHere} {...(source.kind==='industry'&&record&&!linked&&!busy&&preview&&!blockedByOther?{reuse:()=>void run(()=>api.install(installRequest())),reuseLabel:t('market.skill.control.reuse',{title})}:{})} {...(error||recoveryError?{error:error?error:localizeWorkError(locale,recoveryError)+' '+t('recovery.nextStep')}:{})} refresh={()=>setRevision(x=>x+1)} {...(preview&&!busy&&!blockedByOther?{install:()=>void run(()=>api.install(installRequest()))}:{})} {...(record?.state==='preparing'&&linked&&preview&&!pending&&!busy?{continueInstall:()=>void run(()=>api.install(installRequest()))}:{})} {...(!busy&&pendingHere?{recover:()=>void run(()=>recoverSkillForSource(api,source))}:{})} {...(record?.state==='installed'&&!busy?{observe:()=>void observe()}:{})}/>{recoveryError&&<button type="button" onClick={()=>{api.discard();setDiscarded(true)}}>{t('recovery.discard')}</button>}{discarded&&<p role="status">{t('recovery.discarded')}</p>}</section>
}
export function SkillInstallDirectory({api}:{api:SkillInstallApi}){
  const {t}=useI18n()
  const [items,setItems]=useState<SkillInstallationRecord[]>([]),[error,setError]=useState(''),[revision,setRevision]=useState(0),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true)
  useEffect(()=>{let live=true;setLoading(true);void api.list().then(x=>{if(live){setItems(uniqueSkillInstallations(x.items));setError('')}},()=>{if(live)setError(t('market.skill.directory.readFailed'))}).finally(()=>{if(live)setLoading(false)});return()=>{live=false}},[api,revision,t])
  const recover=async()=>{setBusy(true);setError('');try{await api.recover();setRevision(x=>x+1)}catch{setError(t('market.skill.status.actionFailed'))}finally{setBusy(false)}}
  return <section aria-label={t('market.skill.control.directoryAria')}><h3>{t('market.skill.control.directoryTitle')}</h3>{items.map(item=><p key={item.id}>{item.native.name} · {item.state==='installed'?t('market.skill.control.installedUnverified'):t('market.skill.state.review')}</p>)}{loading&&<p role="status">{t('market.skill.directory.loading')}</p>}{!loading&&!items.length&&!error&&<p>{t('market.skill.control.empty')}</p>}{error&&<p role="alert">{error} <button onClick={()=>setRevision(x=>x+1)}>{t('market.skill.control.refreshDirectory')}</button></p>}{api.pending()&&<p role="status">{t('market.skill.control.pending')} <button type="button" disabled={busy||!!api.recoveryMessage()} onClick={()=>void recover()}>{t('market.skill.status.recover')}</button></p>}</section>
}
