import type { ArtifactRef } from './artifact-preview.js'
import { useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import {approvalText,type ApprovalRecord, type ApprovalDecision } from './approval-preview.js'
import { useApprovalNotes } from './ApprovalNotes.js'
import { useI18n } from './i18n/provider.js'
import css from './TaskPage.module.css'

const approvalStatusKeys={pending:'approvalCard.status.pending',approved:'approvalCard.status.approved',rejected:'approvalCard.status.rejected',changes:'approvalCard.status.changes',stale:'approvalCard.status.stale'} as const
const decisionKeys={changes:'approvalCard.action.changes',rejected:'approvalCard.action.rejected',approved:'approvalCard.action.approved'} as const

export function ApprovalCard({approval,onDecide,openArtifact}:{openArtifact?:(ref:ArtifactRef)=>void;approval:ApprovalRecord;onDecide:(change:ApprovalDecision)=>boolean}){
  const {t,dateTime}=useI18n()
  const notes=useApprovalNotes(approval.id)
  const expired=approval.status==='pending'&&Date.parse(approval.expiresAt)<=Date.now(),pending=approval.status==='pending'&&!expired
  const snapshot=approval.snapshot
  const stamp=(value:string)=>dateTime(value,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})
  return <section className={css.approval} aria-label={t('approvalCard.aria',{id:approval.id})}>
    <header><ShieldCheck size={21}/><h3>{t('approvalCard.title')}</h3><span className={css.badge}>{t(expired?'approvalCard.status.expired':approvalStatusKeys[approval.status])}</span></header>
    <h4>{snapshot.title}</h4><p>{t('approvalCard.submittedSubject',{object:approvalText(snapshot.object,t),subject:approvalText(snapshot.subjectLabel,t),version:snapshot.subjectVersion})}</p><div className={css.risk}>{approvalText(snapshot.risk,t)}</div>
    <h4>{t('approvalCard.goal')}</h4><p>{snapshot.goal}</p><h4>{t('approvalCard.recommendation')}</h4><p>{snapshot.result||t('approvalCard.noResult')}</p>
    {snapshot.artifact&&<details><summary>{t('approvalCard.artifact',{version:snapshot.artifact.version})}</summary><p>{snapshot.artifactText}</p>{openArtifact&&<button type="button" onClick={()=>openArtifact(snapshot.artifact!)}>{t('approvalCard.openArtifact',{version:snapshot.artifact.version})}</button>}</details>}
    <details><summary>{t('approvalCard.evidence',{count:snapshot.evidence.length})}</summary>{snapshot.evidence.map((item,index)=><p key={index}>{item}</p>)}</details>
    <p className={css.muted}>{approvalText(snapshot.effect,t)}</p><small>{t('approvalCard.validity',{submitted:stamp(approval.submittedAt),expires:stamp(approval.expiresAt)})}</small>
    {pending?<ApprovalInput key={JSON.stringify([approval.id,approval.version])} approval={approval} note={notes.entries.find(entry=>entry.version===approval.version)?.text||''} write={text=>notes.write(approval.version,text)} onDecide={onDecide}/>:approval.decision?<div className={css.record}><strong>{t(approvalStatusKeys[approval.decision.kind])} · {t(approval.decision.actorId==='self'?'approvalCard.actor.self':'approvalCard.actor.original')}</strong><p>{approval.decision.note}</p><small>{stamp(approval.decision.at)}</small></div>:<p>{t('approvalCard.unavailable')}</p>}
    {notes.entries.filter(entry=>!pending||entry.version!==approval.version).map(entry=><div className={css.record} key={entry.version}><strong>{t('approvalCard.unsavedTitle',{version:entry.version})}</strong><p>{entry.text}</p><small>{t('approvalCard.unsavedDescription')}</small></div>)}
  </section>
}

function ApprovalInput({approval,note,write,onDecide}:{approval:ApprovalRecord;note:string;write:(text:string)=>void;onDecide:(change:ApprovalDecision)=>boolean}){
  const {t}=useI18n()
  const [checked,setChecked]=useState(false)
  return <><label className={css.check}><input type="checkbox" checked={checked} onChange={event=>setChecked(event.target.checked)}/>{t('approvalCard.confirm')}</label><label className={css.form}>{t('approvalCard.note')}<textarea rows={3} maxLength={4000} value={note} onChange={event=>write(event.target.value)} placeholder={t('approvalCard.notePlaceholder')}/></label><small>{t('approvalCard.noteDescription')}</small><div className={css.buttons}>{(['changes','rejected','approved'] as const).map(decision=><button type="button" key={decision} disabled={!checked||!note.trim()} onClick={()=>{
    const accepted=onDecide({approvalId:approval.id,expectedVersion:approval.version,decision,note,now:new Date().toISOString()})
    setChecked(false)
    if(accepted)write('')
  }}>{t(decisionKeys[decision])}{t('approvalCard.demo')}</button>)}</div></>
}
