import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {isGroupMessage,isGroupEmployeeResponse,type GroupMessage} from '../src/collaboration.ts'
import {isGroupRecipientStatus} from '../src/group-routing.ts'
import {readGroupMessageSources} from '../src/group-message-sources.ts'
import {isReservedExecutionSessionId} from '../src/execution-session-identity.ts'
import {readGroupMessagePage,readGroupMessageSearchResult} from '../src/group-messages.ts'
import {readGroupMentionsPage} from '../src/group-mentions.ts'

const reply=()=>({id:randomUUID(),groupId:randomUUID(),rootId:null,authorId:randomUUID(),replyExecutionId:randomUUID(),text:'你好',references:[],createdAt:new Date().toISOString()})
test('普通员工群回复具有独立证明，混入Task或Run身份被拒绝',()=>{
 const value=reply();assert.equal(isGroupMessage(value),true);assert.equal(isGroupEmployeeResponse(value as GroupMessage),true)
 assert.equal(isGroupMessage({...value,taskId:randomUUID()}),false);assert.equal(isGroupMessage({...value,runId:randomUUID()}),false)
 const {replyExecutionId,...base}=value;assert.equal(isGroupMessage(base),false)
 assert.equal(isGroupMessage({...base,taskId:randomUUID(),runId:randomUUID()}),true)
 assert.equal(isReservedExecutionSessionId('group-reply-'+replyExecutionId),true)
})
test('停止目标只接受具有reply证明的无Task回应，不把工作Run重标成reply',()=>{
 const value={roleId:randomUUID(),name:'同事',taskId:null,runId:null,phase:'running',resultMessageId:null,executionMode:'reply',replyExecutionId:randomUUID()}
 assert.equal(isGroupRecipientStatus(value),true)
 assert.equal(isGroupRecipientStatus({...value,taskId:randomUUID()}),false)
 assert.equal(isGroupRecipientStatus({...value,executionMode:'work'}),false)
})
test('来源导航允许reply证明携带固定来源，拒绝双证明与无证明来源',()=>{
 const message=reply(),value={schema:'teloa.group-message-sources/v1',groupId:message.groupId,messageId:randomUUID(),runId:null,replyExecutionId:randomUUID(),items:[{message,rootId:null,sha256:createHash('sha256').update(message.text).digest('hex')}],unavailableCount:0}
 assert.deepEqual(readGroupMessageSources(value),value)
 assert.throws(()=>readGroupMessageSources({...value,runId:randomUUID()}))
 const {replyExecutionId,...missing}=value;assert.throws(()=>readGroupMessageSources(missing))
})
test('主群分页接受reply执行的main回复，话题回复仍不能混入主群',()=>{
 const message={...reply(),rootId:randomUUID(),contextMode:'main'},page={schema:'teloa.group-message-page/v1',groupId:message.groupId,rootId:null,items:[message],older:null,newer:null,topics:[]}
 assert.deepEqual(readGroupMessagePage(page),page)
 assert.throws(()=>readGroupMessagePage({...page,items:[{...message,contextMode:'thread'}]}))
 const {replyExecutionId,...base}=message
 assert.deepEqual(readGroupMessagePage({...page,items:[{...base,taskId:randomUUID(),runId:randomUUID()}]}).items.length,1)
})
test('主群搜索保留reply执行身份与主群定位，拒绝错误话题定位',()=>{
 const message={...reply(),rootId:randomUUID(),contextMode:'main'},result={schema:'teloa.group-message-search/v1',groupId:message.groupId,rootId:null,query:'你好',items:[{message,rootId:null,excerpt:message.text}],next:null}
 assert.deepEqual(readGroupMessageSearchResult(result),result)
 assert.throws(()=>readGroupMessageSearchResult({...result,items:[{message:{...message,contextMode:'thread'},rootId:null,excerpt:message.text}]}))
 assert.throws(()=>readGroupMessageSearchResult({...result,items:[{message,rootId:randomUUID(),excerpt:message.text}]}))
})
test('本人提及目录接受reply执行的明确mentionSelf，仍拒绝推测提及及未读伪报',()=>{
 const message={...reply(),rootId:randomUUID(),contextMode:'main',mentionSelf:true},page={schema:'teloa.group-mentions/v1',groupId:message.groupId,rootId:null,unreadOnly:true,items:[{message,rootId:null,excerpt:message.text,unread:true}],next:null}
 assert.deepEqual(readGroupMentionsPage(page),page)
 const {mentionSelf,...unmentioned}=message
 assert.throws(()=>readGroupMentionsPage({...page,items:[{...page.items[0],message:unmentioned}]}))
 assert.throws(()=>readGroupMentionsPage({...page,items:[{...page.items[0],unread:false}]}))
})
