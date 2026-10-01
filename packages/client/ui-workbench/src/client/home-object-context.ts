import type {ObjectConversationApi,SavedObjectLink} from './object-conversation-api.js'
import type {ConversationObject} from './object-conversations.js'

/** 原会话已关联就核对，不把已完成的 link 当作另一条新命令重复写入。 */
export async function ensureHomeObjectContext(api:ObjectConversationApi,object:ConversationObject,sessionId:string,scopeId?:string):Promise<SavedObjectLink>{
 const matches=(row:SavedObjectLink)=>row.kind===object.kind&&row.objectId===object.id&&row.sessionId===sessionId&&row.objectVersion===object.version&&row.scopeId===scopeId&&row.active
 const pending=api.pending()
 if(pending){
  if(pending.kind!==object.kind||pending.objectId!==object.id||pending.sessionId!==sessionId||pending.expectedObjectVersion!==object.version||pending.scopeId!==scopeId||pending.action!=='link')throw Error('请先核对原请求，再改变会话关联。')
  const recovered=await api.recover();if(!matches(recovered))throw Error('会话关联已变化，请回到原对象核对。');return recovered
 }
 const rows=await api.list(object.kind,object.id),existing=rows.find(row=>row.sessionId===sessionId)
 if(existing?.active){if(!matches(existing))throw Error('会话已关联其他对象版本或业务，请核对。');return existing}
 return api.change({kind:object.kind,objectId:object.id,expectedObjectVersion:object.version,sessionId,expectedLinkVersion:existing?.version??0,action:'link',...(scopeId?{scopeId}:{})})
}
