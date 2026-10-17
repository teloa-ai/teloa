import {useEffect,useRef,useState} from 'react'
import type {PendingRequest,PendingRequestApi,PendingRequestPreview} from './pending-request-api.js'
import {pendingRequestCopy,pendingRequestFieldLabel,pendingRequestOperation} from './pending-request-copy.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './PendingRequestReview.module.css'

type Target={title:string;open:()=>void}
export function PendingRequestReview({request,api,busy,continueRequest,resolveTarget}:{request:PendingRequest;api:PendingRequestApi;busy:boolean;continueRequest:()=>Promise<string|undefined>;resolveTarget?:(key:string,id:string)=>Target|undefined}){
 const {locale}=useI18n(),copy=pendingRequestCopy(locale),[preview,setPreview]=useState<PendingRequestPreview>(),[error,setError]=useState<string>(),[notice,setNotice]=useState<string>(),[retry,setRetry]=useState(0),[submitting,setSubmitting]=useState(false),inFlight=useRef(false),generation=useRef(0)
 useEffect(()=>{
  const controller=new AbortController(),current=++generation.current
  setPreview(undefined);setError(undefined);setNotice(undefined)
  void api.preview(request.requestId,controller.signal).then(value=>{
   if(controller.signal.aborted||generation.current!==current)return
   if(value.endpoint!==request.endpoint)throw Error(copy.unavailable)
   setPreview(value)
  }).catch(error=>{if(!controller.signal.aborted&&generation.current===current)setError(localizeWorkError(locale,error))})
  return()=>{controller.abort();generation.current++}
 },[api,request.requestId,request.endpoint,retry,locale])
 const submit=async()=>{
  if(!preview||busy||inFlight.current)return
  inFlight.current=true;setSubmitting(true);setError(undefined);setNotice(undefined)
  const current=generation.current
  try{const result=await continueRequest();if(generation.current===current)setNotice(result)}
  catch(error){if(generation.current===current)setError(localizeWorkError(locale,error))}
  finally{inFlight.current=false;if(generation.current===current)setSubmitting(false)}
 }
 const record=(value:unknown)=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined
 const body=preview?.payload,content=record(body?.content)
 const facts=[body,record(body?.fields),content,record(body?.definition)].flatMap(source=>source?Object.entries(source).flatMap(([key,value])=>pendingRequestFieldLabel(locale,key)&&['string','number','boolean'].includes(typeof value)?[{key,label:pendingRequestFieldLabel(locale,key)!,value:String(value)}]:[]):[])
 if(Array.isArray(content?.sections))content.sections.forEach((entry,index)=>{const section=record(entry);if(typeof section?.title==='string'&&typeof section.text==='string')facts.push({key:'section'+index,label:section.title,value:section.text})})
 const targets=body?Object.entries(body).filter(([key,value])=>['groupId','taskId','roleId','planId'].includes(key)&&typeof value==='string').map(([key,id])=>({key,target:resolveTarget?.(key,id as string),title:undefined as string|undefined})):[]
 const source=record(body?.source)
 if(source&&['session','task'].includes(String(source.kind))&&typeof source.id==='string')targets.push({key:'source',target:resolveTarget?.(source.kind==='session'?'sessionId':'taskId',source.id),title:typeof source.title==='string'?source.title:undefined})
 return <section className={css.review} aria-label={copy.original} aria-busy={!preview&&!error}>
  {preview?<><h3>{pendingRequestOperation(locale,preview.endpoint)}</h3>{targets.length>0&&<div className={css.targets}><span>{copy.target}</span>{targets.map(({key,target,title})=>target?<button type="button" key={key} onClick={target.open}>{target.title}</button>:<span key={key}>{title?title+' · ':''}{copy.missingTarget}</span>)}</div>}<dl className={css.facts}>{facts.map((fact,index)=><div key={fact.key+index}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl><details className={css.parameters}><summary>{copy.parameters}</summary><pre>{JSON.stringify(body,null,2)}</pre></details></>:!error&&<p role="status">{copy.loading}</p>}
  <p className={css.boundary}>{copy.boundary}</p>
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  <div className={css.actions}>{error&&!preview?<button type="button" onClick={()=>setRetry(value=>value+1)}>{copy.retry}</button>:<button type="button" disabled={!preview||busy||submitting} onClick={()=>{void submit()}}>{busy||submitting?copy.continuing:copy.continue}</button>}</div>
 </section>
}
