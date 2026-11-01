import {useEffect,useState} from 'react'
import type {KnowledgeCopyOrigin as Origin} from '@teloa/contract'
import type {ResourceApi} from './resource-api.js'
import {knowledgeCopyText} from './knowledge-copy-text.js'
import {useI18n} from './i18n/provider.js'
import css from './KnowledgeDocument.module.css'
export function KnowledgeCopyOrigin({api,knowledgeId}:{api:ResourceApi;knowledgeId:string}){
 const {locale}=useI18n(),text=knowledgeCopyText(locale),[origin,setOrigin]=useState<Origin|null>(),[failed,setFailed]=useState(false)
 useEffect(()=>{let live=true;setOrigin(undefined);setFailed(false);if(api.knowledgeCopyOrigin)void api.knowledgeCopyOrigin(knowledgeId).then(value=>{if(live)setOrigin(value)}).catch(()=>{if(live)setFailed(true)});return()=>{live=false}},[api,knowledgeId])
 if(!origin&&!failed)return null
 return <section className={css.copyOrigin}><strong>{text.origin}</strong>{failed?<p role="alert">{locale.startsWith('en')?'Source record unavailable.':'来源记录暂不可读取。'}</p>:origin&&<KnowledgeCopyFacts origin={origin}/>}</section>
}
/** 可读来源事实直接呈现，完整摘要只在本人主动展开时核对。 */
export function KnowledgeCopyFacts({origin}:{origin:Origin}){
 const {locale}=useI18n(),text=knowledgeCopyText(locale)
 return <><dl className={css.pageFacts}><div><dt>{text.source}</dt><dd>{origin.sourceTitle}</dd></div><div><dt>{text.author}</dt><dd>{origin.publisher}</dd></div><div><dt>{text.version}</dt><dd>{origin.packageVersion}</dd></div><div><dt>{text.license}</dt><dd>{origin.license.status==='declared'?origin.license.value:text.missing}</dd></div></dl><details className={css.copyOrigin}><summary>{text.details}</summary><dl className={css.pageFacts}><div><dt>{text.bodyHash}</dt><dd><code>{origin.sourceVersion}</code></dd></div><div><dt>{text.packageHash}</dt><dd><code>{origin.contentHash}</code></dd></div></dl></details></>
}
