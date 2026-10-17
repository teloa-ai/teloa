import {useMemo,useState} from 'react'
import {ArrowLeft,Library} from 'lucide-react'
import type {PageCreateDraft} from '@teloa/contract'
import {ContextDrawer} from './ContextDrawer.js'
import {CreateEntry} from './CreateEntry.js'
import type {PageCreateApi} from './page-create-api.js'
import {useTemplateShare} from './EmployeeTemplateShare.js'
import {readSharePackage,sharePackageSummary} from './share-package-plan.js'
import {useI18n} from './i18n/provider.js'
import {ToolbarIconButton} from './ToolbarIconButton.js'
import css from './MarketTemplateCreator.module.css'

export type MarketTemplateKind='employee'|'team'|'app'
export type MarketTemplateCreation={api:PageCreateApi;prepare:(prompt:{sourceId:string;title:string;text:string})=>void|Promise<void>}
const readDraftPackage=(draft:Pick<PageCreateDraft,'body'>)=>readSharePackage((JSON.parse(draft.body) as {package:unknown}).package)

/** 市场创建复用既有静态模板草案、校验和分享预览，不先创建真实员工或自动发布。 */
export function MarketTemplateCreator({kind,open,close,creation}:{kind:MarketTemplateKind;open:boolean;close:()=>void;creation:MarketTemplateCreation}){
 const {t}=useI18n(),sharing=useTemplateShare()
 const [showOther,setShowOther]=useState(false),[otherCount,setOtherCount]=useState(0)
 const api=useMemo<PageCreateApi>(()=>({...creation.api,directory:async(request,signal)=>{
  const directory=await creation.api.directory(request,signal)
  const matches=(draft:PageCreateDraft)=>{try{return sharePackageSummary(readDraftPackage(draft)).subject===kind}catch{return false}}
  if(!signal?.aborted)setOtherCount(directory.drafts.filter(draft=>!matches(draft)).length)
  return {...directory,drafts:directory.drafts.filter(draft=>matches(draft)!==showOther)}
 }}),[creation.api,kind,showOther])
 return <ContextDrawer open={open} title={t(kind==='app'?'market.apps.createApp':kind==='employee'?'market.create.employee':'market.create.team')} close={close}>
  <div className={css.body}>
  {(otherCount>0||showOther)&&<ToolbarIconButton label={t(showOther?'market.create.current':'market.create.others',{count:otherCount})} icon={showOther?ArrowLeft:Library} onClick={()=>setShowOther(value=>!value)}/>}
  <CreateEntry entity="share" embedded active={open} descriptionPlaceholderKey={kind==='app'?'create.sentence.placeholder.app':kind==='employee'?'create.sentence.placeholder.employee':'create.sentence.placeholder.team'} {...(sharing?{sentenceDraft:{key:'teloa.market-creation-input/v1/'+kind,storage:sharing.storage}}:{})} {...(kind==='app'?{submitLabelKey:'market.apps.continue' as const}:{})} titleKey={showOther?'market.create.otherTitle':'market.create.describe'} directSentence hideSentence={showOther} api={api} prepare={prompt=>
   creation.prepare({...prompt,sourceId:'market-template:'+kind,text:t(kind==='app'?'market.apps.appPrompt':kind==='employee'?'market.create.employeePrompt':'market.create.teamPrompt')+'\n'+prompt.text})
  } onPrepared={close} renderConfirmation={({preview})=>{
   try{
    const pkg=readDraftPackage(preview.draft)
    if(sharePackageSummary(pkg).subject!==kind)return <p role="note">{t('market.create.otherHint')}</p>
    return <button type="button" disabled={!sharing} onClick={()=>sharing?.openDraft(pkg)}>{t('templateShare.previewShare')}</button>
   }catch{return <p role="alert">{t('templateShare.invalid')}</p>}
  }}/>
  </div>
 </ContextDrawer>
}
