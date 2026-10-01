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
