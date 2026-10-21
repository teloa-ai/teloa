import {useEffect,useRef,useState} from 'react'
import type {BusinessConversationBinding,BusinessConfigurationDraftResponseVersioned} from '@teloa/contract'
import type {BusinessBuilderFlow} from './business-builder-flow.js'
import {DangerConfirm} from './DangerConfirm.js'
import {useI18n} from './i18n/provider.js'

type Draft=Pick<BusinessConfigurationDraftResponseVersioned,'id'|'scope'|'revision'|'status'>
/** 目录与预览使用同一固定修订确认；取消只收起，未知回执重试仍提交原修订。 */
export function BusinessDraftDiscard({flow,binding,draft,disabled=false,onDiscarded}:{flow:BusinessBuilderFlow;binding:BusinessConversationBinding;draft:Draft;disabled?:boolean;onDiscarded?:()=>void}){
 const {t}=useI18n(),[target,setTarget]=useState<{flow:BusinessBuilderFlow;binding:BusinessConversationBinding;draft:Draft;epoch:number}>(),[busy,setBusy]=useState(false),[error,setError]=useState<string>()
 const mounted=useRef(false),location=useRef({flow,id:draft.id,epoch:0})
 if(location.current.flow!==flow||location.current.id!==draft.id)location.current={flow,id:draft.id,epoch:location.current.epoch+1}
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[])
 useEffect(()=>{setTarget(undefined);setBusy(false);setError(undefined)},[flow,draft.id])
 const active=target?.flow===flow&&target.draft.id===draft.id&&target.epoch===location.current.epoch
 const confirm=async()=>{
  if(!target||busy)return
  const current=()=>mounted.current&&location.current.flow===target.flow&&location.current.id===target.draft.id&&location.current.epoch===target.epoch
  setBusy(true);setError(undefined)
  try{await target.flow.discard(target.binding,target.draft);if(current()){setTarget(undefined);onDiscarded?.()}}
  catch(error){if(current())setError(t(error&&typeof error==='object'&&'code' in error&&error.code==='teloa/version-conflict'?'business.builder.conflict':'business.builder.discardUnknown'))}
  finally{if(current())setBusy(false)}
 }
 return <><button type="button" disabled={disabled||busy||draft.status!=='draft'} onClick={()=>{setError(undefined);setTarget({flow,binding:{...binding},draft:{...draft},epoch:location.current.epoch})}}>{t('business.builder.discard')}</button>
  {active&&<DangerConfirm title={t('business.builder.discardTitle')} intro={t('business.builder.discardNote')} confirmLabel={t('business.builder.discardConfirm')} busy={busy} error={error} confirm={()=>void confirm()} close={()=>{if(!busy)setTarget(undefined)}}/>}
 </>
}
