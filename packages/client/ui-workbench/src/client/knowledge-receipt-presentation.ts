import {isKnowledgeSaveReceipt,type KnowledgeCategory} from '@teloa/contract'
import type {TeloaTranslate} from './i18n/index.js'
import type {MessageKey} from './i18n/messages.js'

const categoryKeys:Record<KnowledgeCategory,MessageKey>={
 'business-context':'knowledgeReceipt.category.business-context','policy':'knowledgeReceipt.category.policy','sop':'knowledgeReceipt.category.sop','criteria':'knowledgeReceipt.category.criteria','reference':'knowledgeReceipt.category.reference','template-asset':'knowledgeReceipt.category.template-asset','system-data-guide':'knowledgeReceipt.category.system-data-guide',
}
const stageKeys={prepared:'knowledgeReceipt.stage.prepared','knowledge-saved':'knowledgeReceipt.stage.knowledge-saved','resource-applying':'knowledgeReceipt.stage.resource-applying'} as const satisfies Record<string,MessageKey>

export type KnowledgeReceiptPresentation=
 |{kind:'active';title:string;category:string;topics:string[];scope:string;knowledgeVersion:number;resourceVersion:number;contentHash:string;resourceId:string}
 |{kind:'needs-recovery';title:string;category:string;topics:string[];scope:string;stage:string}
 |{kind:'failed';title:string;category:string;topics:string[];scope:string;stage:string}

export function knowledgeReceiptPresentation(text:string,t:TeloaTranslate):KnowledgeReceiptPresentation|null{
 let value:unknown
 try{value=JSON.parse(text)}catch{return null}
 if(!isKnowledgeSaveReceipt(value))return null
 const base={title:value.title,category:t(categoryKeys[value.category]),topics:[...value.topics],scope:value.scopeIds.map(scope=>scope==='general'?t('knowledgeReceipt.scope.general'):scope).join(' · ')}
 if(value.status==='active')return {...base,kind:'active',knowledgeVersion:value.knowledge.version,resourceVersion:value.resource.version,contentHash:value.knowledge.contentHash.slice(0,12),resourceId:value.resource.id}
 if(value.status==='needs-recovery')return {...base,kind:'needs-recovery',stage:t(stageKeys[value.stage])}
 return {...base,kind:'failed',stage:t(stageKeys[value.stage])}
}
