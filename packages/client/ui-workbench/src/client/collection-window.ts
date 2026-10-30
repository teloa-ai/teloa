import {useEffect,useState} from 'react'

export const COLLECTION_BATCH_SIZE=50

/** 分批挂载目录。搜索匹配全量数据，当前对象在第一批之外时仍保留；刷新相同目录不会收回已展开的条目。 */
export function useCollectionWindow<T>(items:readonly T[],keyOf:(item:T)=>string,selected?:string){
 const signature=JSON.stringify(items.map(keyOf))
 const [window,setWindow]=useState({signature,limit:COLLECTION_BATCH_SIZE})
 useEffect(()=>setWindow(current=>current.signature===signature?current:{signature,limit:COLLECTION_BATCH_SIZE}),[signature])
 const limit=window.signature===signature?window.limit:COLLECTION_BATCH_SIZE
 const visible=items.slice(0,limit)
 const current=selected?items.find(item=>keyOf(item)===selected):undefined
 if(current&&!visible.includes(current))visible.push(current)
 return {items:visible,shown:visible.length,total:items.length,more:limit<items.length,
  showMore:()=>setWindow({signature,limit:limit+COLLECTION_BATCH_SIZE})}
}
