import {useCallback,useEffect,useRef,useState} from 'react'

/**
 * 轻窗口未提交草稿：按「入口 + 原对象」键只保留在本页会话内存，不落盘。
 * 外点、Esc、关闭与取消只收起窗口，再打开同一对象时恢复；明确提交成功后由调用方 clear()。
 */
const drafts=new Map<string,unknown>()
const limit=50

export function useLightDraft<T>(key:string,initial:()=>T){
 const [value,setValue]=useState<T>(()=>drafts.has(key)?drafts.get(key) as T:initial())
 const touched=useRef(false),cleared=useRef(false)
 useEffect(()=>{
  if(!touched.current||cleared.current)return
  drafts.delete(key);drafts.set(key,value)
  if(drafts.size>limit)drafts.delete(drafts.keys().next().value!)
 },[key,value])
 const change=useCallback((next:T|((current:T)=>T))=>{touched.current=true;cleared.current=false;setValue(next)},[])
 const clear=useCallback(()=>{cleared.current=true;drafts.delete(key)},[key])
 return [value,change,clear] as const
}
