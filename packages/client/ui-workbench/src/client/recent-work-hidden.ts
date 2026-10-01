type StorageLike={getItem(key:string):string|null;setItem(key:string,value:string):void;removeItem(key:string):void}
export type RecentWorkHiddenStore={read():readonly string[];hide(sessionId:string):void}

const storageKey='teloa.recent-work-hidden.v1'
/** 只是左栏「最近工作」的本地隐藏名单，不影响原始会话；上限防止名单无界增长。 */
const limit=200
const hasControlCharacter=(value:string)=>{
  for(let index=0;index<value.length;index++){const code=value.charCodeAt(index);if(code<32||code===127)return true}
  return false
}
const validId=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=256&&!hasControlCharacter(value)

/** 「移出最近」只隐藏左栏这一份展示列表，不归档、不删除原始会话；隐藏名单本地持久化，跨刷新保留。 */
export function createRecentWorkHiddenStore(storage:StorageLike|undefined):RecentWorkHiddenStore{
  const readAll=():string[]=>{
    if(!storage)return []
    try{
      const raw=storage.getItem(storageKey)
      if(!raw)return []
      const parsed:unknown=JSON.parse(raw)
      if(!Array.isArray(parsed))return []
      return parsed.filter(validId)
    }catch{return []}
  }
  const writeAll=(ids:readonly string[])=>{
    if(!storage)return
    try{
      if(ids.length)storage.setItem(storageKey,JSON.stringify(ids.slice(-limit)))
      else storage.removeItem(storageKey)
    }catch{/* 本机偏好不可用时仍可继续使用「最近工作」，只是不跨刷新保留隐藏名单。 */}
  }
  return {
    read:()=>readAll(),
    hide(sessionId){
      if(!validId(sessionId))return
      const ids=readAll()
      if(ids.includes(sessionId))return
      writeAll([...ids,sessionId])
    },
  }
}

export function browserRecentWorkHiddenStore():RecentWorkHiddenStore{
  let storage:StorageLike|undefined
  try{storage=globalThis.localStorage}catch{/* 受限浏览器环境回退为不持久隐藏。 */}
  return createRecentWorkHiddenStore(storage)
}
