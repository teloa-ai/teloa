import {useEffect,useMemo,useRef,useState} from 'react'
import {useI18n} from './i18n/provider.js'
import {useToast} from './Toast.js'
import {sessionDiagnosticCopy} from './session-diagnostic-copy.js'
import type {SessionDiagnosticDownloader} from './session-diagnostic-download.js'

export function SessionDiagnosticMenuItem({sessionId,download}:{sessionId:string;download:SessionDiagnosticDownloader}){
 const {locale}=useI18n(),toast=useToast(),owner=useMemo(()=>({sessionId,download}),[sessionId,download])
 const current=useRef(owner);current.current=owner
 const active=useRef<{owner:typeof owner;controller:AbortController}>(),alive=useRef(true)
 const [pending,setPending]=useState<typeof owner>()
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;active.current?.controller.abort()}},[])
 useEffect(()=>()=>{if(active.current?.owner===owner)active.current.controller.abort()},[owner])
 const copy=(key:Parameters<typeof sessionDiagnosticCopy>[1])=>sessionDiagnosticCopy(locale,key)
 const run=()=>{
  if(active.current){active.current.controller.abort();if(active.current.owner===owner)return}
  const controller=new AbortController(),request={owner,controller};active.current=request;setPending(owner)
  void download(sessionId,controller.signal).then(result=>{
   if(!alive.current||current.current!==owner||active.current!==request||controller.signal.aborted)return
   const url=URL.createObjectURL(result.blob),link=document.createElement('a')
   try{link.href=url;link.download=result.filename;link.click()}finally{setTimeout(()=>URL.revokeObjectURL(url),1000)}
   toast.show({tone:result.incomplete?'warning':'success',message:copy(result.incomplete?'incomplete':'saved')})
  }).catch(error=>{
   if(!alive.current||current.current!==owner||active.current!==request)return
   const code=(error as {code?:unknown})?.code
   const cancelled=controller.signal.aborted||(error as {name?:unknown})?.name==='AbortError'
   toast.show({tone:cancelled?'info':'error',message:copy(cancelled?'cancelled':code==='diagnostic/forbidden'?'forbidden':code==='diagnostic/not-found'?'missing':'failed')})
  }).finally(()=>{if(active.current===request)active.current=undefined;if(alive.current&&current.current===owner)setPending(undefined)})
 }
 return <button type="button" role="menuitem" onClick={run} title={copy('description')}>{copy(pending===owner?'cancel':'download')}</button>
}
