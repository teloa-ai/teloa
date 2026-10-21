import {useMemo,useRef,useState} from 'react'

export type BusinessShareMetadata={packageId:string;packageVersion:string;title:string;description:string;english?:{title:string;description:string}}
const drafts=new WeakMap<object,Map<string,BusinessShareMetadata>>()
function valid(value:unknown):value is BusinessShareMetadata{
 if(!value||typeof value!=='object'||Array.isArray(value))return false
 const row=value as Record<string,unknown>,keys=['packageId','packageVersion','title','description','english']
 if(Object.keys(row).some(key=>!keys.includes(key))||keys.slice(0,4).some(key=>typeof row[key]!=='string'||(row[key] as string).length>16384))return false
 if(row.english!==undefined){const e=row.english;if(!e||typeof e!=='object'||Array.isArray(e)||Object.keys(e).length!==2||!('title'in e)||!('description'in e)||typeof e.title!=='string'||typeof e.description!=='string'||e.title.length>16384||e.description.length>16384)return false}
 return true
}
const storageKey=(key:string)=>'teloa.business-share-metadata/v1/'+key
const cacheKey=(scope:string,key:string|undefined)=>JSON.stringify([scope,key??null])
function read(identity:object,scope:string,key:string|undefined,fallback:BusinessShareMetadata):BusinessShareMetadata{
 const current=drafts.get(identity)?.get(cacheKey(scope,key))
 if(current)return current
 if(key)try{const raw=localStorage.getItem(storageKey(key));if(raw&&raw.length<=100000){const value:unknown=JSON.parse(raw);if(valid(value))return value}}catch{/* 浏览器未开放存储时，仍按原 API 身份保留当前会话草稿。 */}
 return fallback
}
/** 只保存可编辑门面信息；本人宿主键来自工作台，声明、快照和凭据不进入草稿。 */
export function useBusinessShareMetadata(identity:object,scope:string,key:string|undefined,initial:()=>BusinessShareMetadata){
 const origin=useMemo(()=>({}),[identity,scope,key]),saved=useMemo(()=>read(identity,scope,key,initial()),[origin])
 const [state,setState]=useState({origin,metadata:saved}),metadata=state.origin===origin?state.metadata:saved
 const current=useRef({origin,metadata});current.current={origin,metadata}
 const update=<K extends keyof BusinessShareMetadata>(field:K,value:BusinessShareMetadata[K])=>{
  if(current.current.origin!==origin)return
  const next={...current.current.metadata,[field]:value}
  current.current={origin,metadata:next};setState({origin,metadata:next})
  let scoped=drafts.get(identity);if(!scoped){scoped=new Map();drafts.set(identity,scoped)}scoped.set(cacheKey(scope,key),next)
  if(key)try{localStorage.setItem(storageKey(key),JSON.stringify(next))}catch{/* 同一 API/业务的内存草稿继续可恢复。 */}
 }
 return {metadata,update}
}
