import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { encodeResourceReference,parseResourceReferences } from '@teloa/contract'
import type { ResourceApi } from './resource-api.js'
const source='teloa-resources'
function canonical(ref:string):string {
  const refs=parseResourceReferences(ref)
  if(refs.length!==1||encodeResourceReference(refs[0]!)!==ref)throw Error('资料引用格式不正确，请重新选择。')
  return ref
}
export function resourceSource(api:Pick<ResourceApi,'candidates'>):InputTriggerSource {
  return {
    trigger:'@',name:source,order:10,showGroupTitle:false,
    async candidates(session,{query,signal,quoted,drilled}){
      if(quoted||drilled)return []
      const rows=await api.candidates(session.sessionId,signal)
      if(signal.aborted)return []
      return rows.filter(row=>row.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(row=>({name:row.title,section:'资料',description:'本人 · '+row.scopeIds.map(scope=>scope==='general'?'通用':scope).join(' / ')+' · 版本 '+row.version,icon:'file',value:encodeResourceReference(row)}))
    },
    onPick({candidate}){
      if(!candidate.value)return undefined
      const ref=canonical(candidate.value)
      return {insert:{source,ref,label:candidate.name,appearance:'file',clipboardText:ref}}
    },
    codec:{clipboardText:canonical,serialize:async(ref,signal)=>{signal.throwIfAborted();return canonical(ref)}},
  }
}
