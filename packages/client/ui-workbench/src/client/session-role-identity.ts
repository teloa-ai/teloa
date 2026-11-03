import type {SavedObjectLink} from './object-conversation-api.js'

type IdentityPort={
  links:(sessionId:string)=>Promise<readonly Pick<SavedObjectLink,'kind'|'sessionId'|'objectId'|'active'|'readOnly'|'displayTitle'>[]>
  roles:()=>Promise<readonly {id:string;name:string}[]>
}

/** 会话头部只读取这条会话明确关联的岗位，不从父会话或当前主视图继承。 */
export async function readSessionRoleIdentity(sessionId:string,port:IdentityPort):Promise<string|undefined>{
  const links=await port.links(sessionId)
  const link=links.find(row=>row.active&&row.sessionId===sessionId&&row.kind==='role')
  if(!link)return undefined
  return (await port.roles()).find(role=>role.id===link.objectId)?.name
}


/** 目录只使用本人可见原会话的正式关联，失败或歧义保持未知，不从当前主会话继承。 */
export async function readDirectoryRoleIdentities<T extends {id:string;name:string}>(sessionIds:readonly string[],links:IdentityPort['links'],roles:readonly T[],options:{signal?:AbortSignal;onResolved?:(sessionId:string,role:(T&{conversationTitle?:string})|undefined)=>void}={}):Promise<Record<string,T&{conversationTitle?:string}>>{
 const ids=[...new Set(sessionIds)],items:Record<string,T&{conversationTitle?:string}>={},byId=new Map(roles.map(role=>[role.id,role]))
 let next=0
 await Promise.all(Array.from({length:Math.min(6,ids.length)},async()=>{
  while(next<ids.length&&!options.signal?.aborted){
   const sessionId=ids[next++]!
   let role:(T&{conversationTitle?:string})|undefined
   try{
    const matches=(await links(sessionId)).filter(link=>link.kind==='role'&&link.active&&link.sessionId===sessionId)
    if(matches.length===1){const original=byId.get(matches[0]!.objectId),title=matches[0]!.readOnly===true?matches[0]!.displayTitle:undefined;role=original?(title?{...original,conversationTitle:title}:original):undefined}
   }catch{/* 单条失败保持未确认身份，不阻塞其他员工。 */}
   if(options.signal?.aborted)return
   if(role)items[sessionId]=role
   options.onResolved?.(sessionId,role)
  }
 }))
 return items
}
