import type {ToolCallViewProps} from '@deepseek-ai/dsh-client-ui-tool/client'
import {AlertCircle,CheckCircle2,FolderOpen,RefreshCw} from 'lucide-react'
import {knowledgeReceiptPresentation} from './knowledge-receipt-presentation.js'
import {useI18n} from './i18n/provider.js'
import css from './KnowledgeSaveReceiptCard.module.css'

export function KnowledgeSaveReceiptCard({block,inspect,openResources}:ToolCallViewProps&{openResources:(resourceId?:string)=>void}){
 const {t}=useI18n()
 const settled='kind' in block
 const text=settled?block.content.filter(item=>item.type==='text').map(item=>item.text).join('\n'):''
 const receipt=settled&&!block.isError?knowledgeReceiptPresentation(text,t):null
 const state=!settled?'saving':block.isError?'tool-error':receipt?.kind??'invalid'
 const headingKeys={saving:'knowledgeReceipt.heading.saving',active:'knowledgeReceipt.heading.active','needs-recovery':'knowledgeReceipt.heading.needs-recovery',failed:'knowledgeReceipt.heading.failed',invalid:'knowledgeReceipt.heading.invalid','tool-error':'knowledgeReceipt.heading.tool-error'} as const
 const heading=t(headingKeys[state])
 return <section className={css.card} data-state={state} aria-label={t('knowledgeReceipt.aria')}>
  <header>{state==='active'?<CheckCircle2 size={17}/>:state==='saving'||state==='needs-recovery'?<RefreshCw size={17}/>:<AlertCircle size={17}/>}<strong>{heading}</strong></header>
  {receipt&&<><h4>{receipt.title}</h4><dl><dt>{t('knowledgeReceipt.scope')}</dt><dd>{receipt.scope}</dd><dt>{t('knowledgeReceipt.category')}</dt><dd>{receipt.category}</dd><dt>{t('knowledgeReceipt.topics')}</dt><dd>{receipt.topics.length?receipt.topics.join(' · '):t('knowledgeReceipt.unset')}</dd>{receipt.kind==='active'&&<><dt>{t('knowledgeReceipt.pinnedVersion')}</dt><dd>{t('knowledgeReceipt.version',{knowledge:receipt.knowledgeVersion,resource:receipt.resourceVersion,hash:receipt.contentHash})}</dd></>}{receipt.kind!=='active'&&<><dt>{t('knowledgeReceipt.stage')}</dt><dd>{receipt.stage}</dd></>}</dl></>}
  {receipt?.kind==='needs-recovery'&&<p>{t('knowledgeReceipt.recovery')}</p>}
  {receipt?.kind==='failed'&&<p role="alert">{t('knowledgeReceipt.failed')}</p>}
  {state==='tool-error'&&<p role="alert">{t('knowledgeReceipt.toolError')}</p>}
  {state==='invalid'&&<p role="alert">{t('knowledgeReceipt.invalid')}</p>}
  {settled&&<div className={css.actions}><button type="button" onClick={()=>receipt?.kind==='active'?openResources(receipt.resourceId):openResources()}><FolderOpen size={14}/>{t('knowledgeReceipt.open')}</button>{inspect&&<button type="button" onClick={inspect}>{t('knowledgeReceipt.inspect')}</button>}</div>}
 </section>
}
