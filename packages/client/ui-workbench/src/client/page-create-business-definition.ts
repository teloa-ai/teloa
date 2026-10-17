import {WorkError,type BusinessDefinitionPreview} from '@teloa/contract'
import type {BusinessCustomizationApi} from './business-customization-api.js'

/** 复用原定制的CAS写口，业务页面和固定来源待办不得改用当前导航范围。 */
export async function applyPageCreatedBusinessDefinition(api:BusinessCustomizationApi,scope:string,preview:BusinessDefinitionPreview):Promise<string>{
 if(preview.draft.scope!==scope)throw new WorkError('teloa/conflict','业务草稿与原范围不一致。')
 const directory=await api.directory({scope})
 const current=directory.entries.find(entry=>entry.kind===preview.draft.kind&&entry.localId===preview.draft.localId)?.current?.version??0
 const entry=await api.apply({requestId:crypto.randomUUID(),draftId:preview.draft.id,expectedDefinitionHash:preview.draft.definitionHash,expectedCurrentVersion:current,previewReceipt:preview.receipt})
 return entry.kind+':'+entry.localId+':'+String(entry.current?.version??0)
}
