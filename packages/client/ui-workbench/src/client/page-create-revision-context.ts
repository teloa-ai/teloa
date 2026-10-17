import {createContext} from 'react'
import {encodePageCreateDraftReference,type PageCreateDraft} from '@teloa/contract'
import type {TeloaTranslate} from './i18n/index.js'

/** 各创建页复用原会话准备；只有外壳负责导航，不把“修改”变成新建会话。 */
export const PageCreateRevisionContext=createContext<((draft:PageCreateDraft,signal:AbortSignal)=>Promise<void>)|undefined>(undefined)

export function pageCreateDraftRevisionText(draft:PageCreateDraft,t:TeloaTranslate):string{
 return (draft.entity==='skill'?'/teloa-skill-creator\n':'')+t('create.revise.prompt',{draft:encodePageCreateDraftReference(draft)})
}

/** 打开前受导航取消约束；成功打开后，原生 selectPanel(null) 的自取消不撤销已提交的身份。 */
export function pageCreateDraftRevisionNavigation(input:{cancelSignal:AbortSignal;navigationSignal?:AbortSignal;current:()=>boolean;location:()=>string;isNativeConversation:()=>boolean;mainSession:()=>string|undefined;boundSession:()=>string|undefined}){
 const {cancelSignal,navigationSignal}=input,signal=navigationSignal?AbortSignal.any([cancelSignal,navigationSignal]):cancelSignal
 const location=input.location(),previous=input.mainSession()
 return {
  signal,
  mayOpen:()=>input.current()&&!signal.aborted&&input.location()===location&&input.mainSession()===previous,
  isOpened:(sessionId:string)=>input.current()&&!cancelSignal.aborted&&(input.location()===location||input.isNativeConversation())&&input.mainSession()===sessionId&&input.boundSession()===sessionId,
 }
}
