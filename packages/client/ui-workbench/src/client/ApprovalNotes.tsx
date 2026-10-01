import { createContext, useContext, useState, type ReactNode } from 'react'
import {useI18n} from './i18n/provider.js'

type Note={approvalId:string;version:number;text:string}
type Notes={entries:readonly Note[];write:(approvalId:string,version:number,text:string)=>void}
const Context=createContext<Notes|null>(null)

/** 只保存本页面内的文字草稿；核对勾选不进入共享状态或任何持久化。 */
export function ApprovalNotesProvider({children}:{children:ReactNode}){
  const [entries,setEntries]=useState<readonly Note[]>([])
  const write=(approvalId:string,version:number,text:string)=>setEntries(current=>{
    const others=current.filter(entry=>entry.approvalId!==approvalId||entry.version!==version)
    return text?[...others,{approvalId,version,text}]:others
  })
  return <Context.Provider value={{entries,write}}>{children}</Context.Provider>
}

export function useApprovalNotes(approvalId:string){
  const {t}=useI18n()
  const notes=useContext(Context)
  if(!notes)throw Error(t('p6.approvalNotes.unavailable'))
  return {entries:notes.entries.filter(entry=>entry.approvalId===approvalId),write:(version:number,text:string)=>notes.write(approvalId,version,text)}
}
