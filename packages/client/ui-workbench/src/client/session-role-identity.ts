import type {SavedObjectLink} from './object-conversation-api.js'

type IdentityPort={
  links:(sessionId:string)=>Promise<readonly Pick<SavedObjectLink,'kind'|'sessionId'|'objectId'|'active'>[]>
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
export async function readDirectoryRoleIdentities<T extends {id:string;name:string}>(sessionIds:readonly string[],links:IdentityPort['links'],roles:readonly T[]):Promise<Record<string,T>>{
 const results=await Promise.allSettled(sessionIds.map(async sessionId=>{
  const matches=(await links(sessionId)).filter(link=>link.kind==='role'&&link.active&&link.sessionId===sessionId)
  if(matches.length!==1)return undefined
  const role=roles.find(role=>role.id===matches[0]!.objectId)
  return role?[sessionId,role] as const:undefined
 }))
 return Object.fromEntries(results.flatMap(result=>result.status==='fulfilled'&&result.value?[result.value]:[]))
}
