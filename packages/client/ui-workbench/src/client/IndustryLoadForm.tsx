import {isIndustryManifest} from './industry-manifest.ts'
import clsx from 'clsx'
import {useMemo,useState} from 'react'
import type {IndustryLoadCreateInput} from './industry-load-api.js'
import type {WorkError} from '@teloa/contract'
import type {BusinessSpaceRecord} from './business-directory.js'
import {useBusinessScopes} from './business-scope-context.js'
import type {MarketItem} from './market-preview.js'
import base from './TaskPage.module.css'
import marketCss from './MarketPage.module.css'
import css from './IndustryLoadForm.module.css'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import {localizedMarketItemCopy} from './market-home-presentation.js'
import {industryResourceDestinationGroups,isBusinessDeclarationPackage} from './industry-template-presentation.js'
import {inspectIndustryContent} from './industry-content.js'

type Props={
 embedded?:boolean
 item:MarketItem
 /** 个人版唯一的工作空间；读不到时不允许提交，避免猜一个 spaceId。 */
 space:BusinessSpaceRecord|undefined
 pending:IndustryLoadCreateInput|undefined
 recoveryError:WorkError|string|undefined
 load:(input:IndustryLoadCreateInput)=>Promise<void>
 recover:()=>Promise<void>
}

/** 个人版只有本空间一个目的地：首屏即核对摘要，显式「加载」才写入；不再有空的选择位置步骤。 */
export function IndustryLoadForm({embedded=false,item,space,pending,recoveryError,load,recover}:Props){
 const {locale,t}=useI18n()
 const scopeNames=useBusinessScopes()
 const [requestId,setRequestId]=useState(()=>crypto.randomUUID())
 const [busy,setBusy]=useState(false)
 const [error,setError]=useState('')
 const contentId=item.contentStorage?.contentId
 const itemCopy=localizedMarketItemCopy(item,locale)
 const contentHash=item.packageContent?.hash??(item.contentStorage?item.contentStorage.loaded?'':item.hash??'':item.id.startsWith('directory-')?item.id.slice(10):'')
 // 个人版没有目的地可选：加载一律进本空间，业务范围取模板清单声明的 scope。
 const scope=isIndustryManifest(item.manifest)?item.manifest.scope:''
 // 范围名与切换器、已保存目录的组标题同源：标签目录里有标题就用标题；首次加载的新范围还没有标签，
 // 用模板标题（加载后业务空间也以它命名），不把内部 scope 代码露给用户。
 const destination=t('market.industry.load.personalDestination',{domain:scopeNames[scope]??(itemCopy.title||scope)})
 const targetReady=!!space
 const summary=useMemo(()=>({target:destination,effect:t('market.industry.load.existingEffect')}),[destination,t])
 const resources=isIndustryManifest(item.manifest)?item.manifest.resources:[]
 const destinations=useMemo(()=>industryResourceDestinationGroups.map(row=>({key:row.key as Parameters<typeof t>[0],count:resources.filter(resource=>(row.kinds as readonly string[]).includes(resource.kind)).length})).filter(row=>row.count),[resources])
 const declarationOnly=isBusinessDeclarationPackage(resources)
 const declarationSourceIds=useMemo(()=>{
  if(!declarationOnly||!isIndustryManifest(item.manifest)||!item.packageContent)return []
  return [...new Set(inspectIndustryContent(item.manifest,item.packageContent).flatMap(row=>row.definition?.kind==='object-type'?[row.definition.definition.sourceId]:[]))]
 },[declarationOnly,item.manifest,item.packageContent])

 const run=async(operation:()=>Promise<void>)=>{
  if(busy)return
  setBusy(true)
  setError('')
  try{await operation()}catch{setError(t('market.industry.load.failed'))}finally{setBusy(false)}
 }
 const submit=()=>run(async()=>{
  if(!contentId||!/^[0-9a-f]{64}$/.test(contentHash))throw Error(t('market.industry.load.contentNotReady'))
  if(!space)throw Error(t('market.industry.load.failed'))
  const target:IndustryLoadCreateInput['target']={kind:'existing',spaceId:space.id,expectedVersion:space.version}
  await load({requestId,contentId,contentHash,target})
  setRequestId(crypto.randomUUID())
 })

 return <section className={clsx(css.panel,embedded?marketCss.actionPanel:marketCss.sheet)} aria-label={t('market.industry.load.aria')}>
  <header className={css.header}>
   <div><span className={marketCss.eyebrow}>{t('market.industry.load.eyebrow')}</span><h3>{t('market.industry.load.review')}</h3></div>
  </header>
  <p className={css.intro}>{t('market.industry.load.introReview')}</p>
  {(error||recoveryError)&&<div className={base.error} role="alert">{error?error:localizeWorkError(locale,recoveryError)+' '+t('recovery.nextStep')}</div>}
  {pending&&<div className={css.recovery} role="status"><div><strong>{t('market.industry.load.pending')}</strong><span>{t('market.industry.load.pendingHelp')}</span></div><button type="button" disabled={busy} onClick={()=>void run(recover)}>{busy?t('market.industry.load.reviewing'):t('market.industry.load.reviewResult')}</button></div>}
  <div className={css.review}>
   <dl><div><dt>{t('market.industry.load.template')}</dt><dd>{itemCopy.title}</dd></div><div><dt>{t('market.industry.load.destination')}</dt><dd>{summary.target}</dd></div><div><dt>{t('market.industry.load.effect')}</dt><dd>{summary.effect}</dd></div></dl>
   <section className={css.destinations} aria-label={t('market.industry.destination.aria')}><h4>{t('market.industry.load.destinations')}</h4><ul>{destinations.map(row=><li key={row.key}><span>{t(row.key)}</span><strong>{t(row.count===1?'market.industry.contents.count.one':'market.industry.contents.count',{count:row.count})}</strong></li>)}</ul><p>{t('market.industry.load.destinationHelp')}</p></section>
   {declarationOnly&&<section className={css.declarationNotice} aria-label={t('market.industry.load.declarationPackageAria')}><p>{t('market.industry.load.declarationPackage')}</p>{declarationSourceIds.map(sourceId=><p key={sourceId}>{t('market.industry.load.declarationSource',{sourceId})}</p>)}</section>}
   {!space&&<p className={css.note} role="status">{t('market.industry.load.spaceUnavailable')}</p>}
   <p className={css.note}>{t('market.industry.load.boundary')}</p>
   <div className={css.actions}><button type="button" disabled={busy||!!pending||!contentId||!targetReady||!/^[0-9a-f]{64}$/.test(contentHash)} onClick={()=>void submit()}>{busy?t('market.industry.load.loading'):t('market.industry.load.confirm')}</button></div>
  </div>
  {!contentId&&<p className={css.note}>{t('market.industry.load.incomplete')}</p>}
 </section>
}
