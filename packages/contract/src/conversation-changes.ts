import {isRecord,resourceId,resourceScopes,resourceVersion} from './resources.ts'
import {knowledgeCategories,type KnowledgeCategory} from './knowledge.ts'

export type ConversationMessagePointer={messageId:string;seq:number;selectionHash:string}
export type SaveKnowledgeMessageToolInput={message:ConversationMessagePointer;title:string;category:KnowledgeCategory;topics:string[]}
export type ConversationKnowledgeCommand={
 schema:'teloa.conversation-knowledge-command/v1';requestId:string
 origin:ConversationMessagePointer&{sessionId:string}
 subject:ConversationMessagePointer&{sessionId:string;role:'user'|'assistant';at:string;markdown:string}
 target:{workspaceId:'default';title:string;category:KnowledgeCategory;topics:string[];scopeIds:['general']}
}
export type KnowledgeSaveReceiptBase={
 schema:'teloa.knowledge-save-receipt/v1';requestId:string;title:string;category:KnowledgeCategory;topics:string[];workspaceId:'default';scopeIds:['general']
 source:ConversationMessagePointer&{sessionId:string}
}
export type KnowledgeSaveReceipt=KnowledgeSaveReceiptBase&(
 |{status:'active';knowledge:{id:string;version:number;contentHash:string};resource:{id:string;version:number}}
 |{status:'needs-recovery';stage:'prepared'|'knowledge-saved'|'resource-applying'}
 |{status:'failed';stage:'prepared'|'knowledge-saved'|'resource-applying';error:{code:string;message:string}}
)

const stable=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value)
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const timestamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{
 if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw Error('会话资料请求格式不正确或包含未知字段。')
 return value
}
const title=(value:unknown):string=>{if(typeof value!=='string'||!value.trim()||value.length>200)throw Error('工作资料标题格式不正确。');return value.trim()}
const topicList=(value:unknown):string[]=>{
 if(!Array.isArray(value)||value.length>20)throw Error('工作资料主题标签格式不正确。')
 const result=value.map(topic=>typeof topic==='string'?topic.trim():'')
 if(result.some(topic=>!topic||topic.length>80)||new Set(result).size!==result.length)throw Error('工作资料主题标签格式不正确。')
 return result
}
const category=(value:unknown):KnowledgeCategory=>{if(!knowledgeCategories.includes(value as KnowledgeCategory))throw Error('工作资料主分类格式不正确。');return value as KnowledgeCategory}
const pointer=(value:unknown):ConversationMessagePointer=>{
 const row=exact(value,['messageId','seq','selectionHash'])
 if(!stable(row.messageId)||!Number.isSafeInteger(row.seq)||Number(row.seq)<0||!hash(row.selectionHash))throw Error('消息指针格式不正确。')
 return {messageId:row.messageId,seq:Number(row.seq),selectionHash:row.selectionHash}
}

export function parseSaveKnowledgeMessageToolInput(value:unknown):SaveKnowledgeMessageToolInput{
 const row=exact(value,['message','title','category','topics'])
 return {message:pointer(row.message),title:title(row.title),category:category(row.category),topics:topicList(row.topics)}
}

export function parseConversationKnowledgeCommand(value:unknown):ConversationKnowledgeCommand{
 const row=exact(value,['schema','requestId','origin','subject','target'])
 if(row.schema!=='teloa.conversation-knowledge-command/v1'||!resourceId(row.requestId))throw Error('会话资料命令格式不正确。')
 const originRow=exact(row.origin,['sessionId','messageId','seq','selectionHash']),originPointer=pointer({messageId:originRow.messageId,seq:originRow.seq,selectionHash:originRow.selectionHash})
 const subjectRow=exact(row.subject,['sessionId','messageId','seq','role','at','selectionHash','markdown']),subjectPointer=pointer({messageId:subjectRow.messageId,seq:subjectRow.seq,selectionHash:subjectRow.selectionHash})
 const targetRow=exact(row.target,['workspaceId','title','category','topics','scopeIds'])
 if(!stable(originRow.sessionId)||!stable(subjectRow.sessionId)||originRow.sessionId!==subjectRow.sessionId||(subjectRow.role!=='user'&&subjectRow.role!=='assistant')||!timestamp(subjectRow.at)||typeof subjectRow.markdown!=='string'||!subjectRow.markdown.trim()||targetRow.workspaceId!=='default'||!Array.isArray(targetRow.scopeIds)||targetRow.scopeIds.length!==1||targetRow.scopeIds[0]!=='general')throw Error('会话资料命令格式不正确。')
 return {schema:row.schema,requestId:row.requestId,origin:{sessionId:originRow.sessionId,...originPointer},subject:{sessionId:subjectRow.sessionId,...subjectPointer,role:subjectRow.role,at:subjectRow.at,markdown:subjectRow.markdown},target:{workspaceId:'default',title:title(targetRow.title),category:category(targetRow.category),topics:topicList(targetRow.topics),scopeIds:['general']}}
}

export function isKnowledgeSaveReceipt(value:unknown):value is KnowledgeSaveReceipt{
 if(!isRecord(value))return false
 const common=['schema','requestId','title','category','topics','workspaceId','scopeIds','source']
 const stateKeys=value.status==='active'?[...common,'status','knowledge','resource']:value.status==='needs-recovery'?[...common,'status','stage']:value.status==='failed'?[...common,'status','stage','error']:[]
 if(!stateKeys.length||Object.keys(value).some(key=>!stateKeys.includes(key))||value.schema!=='teloa.knowledge-save-receipt/v1'||!resourceId(value.requestId)||value.workspaceId!=='default'||!resourceScopes(value.scopeIds)||value.scopeIds.length!==1||value.scopeIds[0]!=='general')return false
 try{title(value.title);category(value.category);topicList(value.topics)}catch{return false}
 try{const source=exact(value.source,['sessionId','messageId','seq','selectionHash']);if(!stable(source.sessionId))return false;pointer({messageId:source.messageId,seq:source.seq,selectionHash:source.selectionHash})}catch{return false}
 if(value.status==='active'){
  if(!isRecord(value.knowledge)||!isRecord(value.resource)||Object.keys(value.knowledge).some(key=>!['id','version','contentHash'].includes(key))||Object.keys(value.resource).some(key=>!['id','version'].includes(key)))return false
  return resourceId(value.knowledge.id)&&resourceVersion(value.knowledge.version)&&hash(value.knowledge.contentHash)&&resourceId(value.resource.id)&&resourceVersion(value.resource.version)
 }
 if(!['prepared','knowledge-saved','resource-applying'].includes(String(value.stage)))return false
 if(value.status==='needs-recovery')return true
 return isRecord(value.error)&&Object.keys(value.error).every(key=>['code','message'].includes(key))&&typeof value.error.code==='string'&&/^teloa\/[a-z0-9-]+$/.test(value.error.code)&&typeof value.error.message==='string'&&!!value.error.message
}
