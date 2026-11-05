import type {Pool} from 'pg'
import {WorkError,isGroupEmployeeResponse,citedGroupMessageIds,groupMessageBodyInput,readGroupMessageSources,type GroupMessageSources} from '@teloa/contract'
import {groupMessageScope} from './group-message-scope.ts'
import {readGroupMessageBody,groupMessageTextHash} from './group-message-body.ts'
import {readStoredGroupMessage,presentGroupMessages} from './group-message-presentation.ts'
import {readStoredTaskRun,readRunGroupContinuation} from './task-runs.ts'
import {readStoredGroupTopic,topicText} from './group-topic.ts'
import {readTrustedGroupReplySource} from './group-reply-executions.ts'
import {groupPartialAttachFailedNotice} from './task-run-group-context.ts'

type Expected={text:string;kind:'full'|'source'|'topic';authorId?:string;createdAt?:string;sha256?:string}
const body=(row:Record<string,unknown>):string=>row.full_text_meta==null?String(row.text):readGroupMessageBody(row).text
/** 发布指纹保存原正文或其摘要；合法的附件失败前缀只按原声明件数逐字核对。 */
function matchesPublication(row:Record<string,unknown>,text:string):boolean{
 const spec=row.request_spec
 if(row.reply_execution_id)return !!spec&&typeof spec==='object'&&Reflect.get(spec,'kind')==='teloa.group-reply-message/v1'&&Reflect.get(spec,'replyExecutionId')===row.reply_execution_id&&Reflect.get(spec,'text')?.chars===text.length&&Reflect.get(spec,'text')?.sha256===groupMessageTextHash(text)
 if(!spec||typeof spec!=='object'||Array.isArray(spec)||Reflect.get(spec,'runId')!==row.run_id)return false
 const matches=(text:string)=>Reflect.get(spec,'kind')==='teloa.group-run-message/v1'?Reflect.get(spec,'text')===text:Reflect.get(spec,'kind')==='teloa.group-run-message/v2'&&Reflect.get(spec,'text')?.chars===text.length&&Reflect.get(spec,'text')?.sha256===groupMessageTextHash(text)
 if(matches(text))return true
 const files=Reflect.get(spec,'files')
 if(!Array.isArray(files)||files.length>8)return false
 for(let n=1;n<=files.length;n++){const prefix=groupPartialAttachFailedNotice(n)+'\n\n';if(text.startsWith(prefix)&&matches(text.slice(prefix.length)))return true}
 return false
}

/** 冷读固定 Run 与消息来源；事务禁止写入，不 ensure、start、follow，也不读取执行凭据。 */
export async function readMessageSources(pool:Pool,owner:string,input:unknown):Promise<GroupMessageSources>{
 const request=groupMessageBodyInput(input),db=await pool.connect()
 try{
  await db.query('begin isolation level repeatable read read only')
  await groupMessageScope(db,owner,{groupId:request.groupId})
  const original=(await db.query('select * from teloa_group_messages where owner_id=$1 and group_id=$2 and id=$3',[owner,request.groupId,request.messageId])).rows[0]
  if(!original)throw new WorkError('teloa/forbidden','消息不存在或不属于当前本人群。')
  const cited=citedGroupMessageIds(body(original)),empty=(runId:string|null=null)=>readGroupMessageSources({schema:'teloa.group-message-sources/v1',...request,runId,items:[],unavailableCount:cited.length})
  if(original.author_id==='self'){await db.query('commit');return empty()}
  if(!cited.length){const reply=original.reply_execution_id?await readTrustedGroupReplySource(db,owner,request):null;await db.query('commit');return reply?readGroupMessageSources({schema:'teloa.group-message-sources/v1',...request,runId:null,replyExecutionId:reply.id,items:[],unavailableCount:0}):empty()}
  const {readTrustedGroupMessageRunSource}=await import('./group-routing-outbox.ts')
  // 复用已持久化的源 hash、owner/Task/Run/作者及冻结谱系核验；导航不重新取得当前执行许可。
  const source=await readTrustedGroupMessageRunSource(db,owner,request)
  const reply=source?null:await readTrustedGroupReplySource(db,owner,request)
  if(!source&&!reply){await db.query('commit');return empty()}
  if(!matchesPublication(original,body(original)))throw new WorkError('teloa/source-unavailable','原回复正文与固定发布记录不一致。')
  const available=new Map<string,Expected[]>(),add=(id:string,expected:Expected)=>available.set(id,[...(available.get(id)??[]),expected])
  let runId:string|null=null
  if(reply){
   const snapshot=reply.snapshot,fixed=snapshot.ownerRequest
   for(const item of [...(fixed.priorRequests??[]),fixed])add(item.messageId,{text:item.text,sha256:item.sha256,kind:'full',authorId:'self'})
   add(snapshot.messageId,{text:snapshot.source.text,kind:'source',authorId:snapshot.source.authorId,createdAt:snapshot.source.createdAt})
   for(const item of snapshot.topic?.messages??[])if(item.messageId)add(item.messageId,{text:item.text,kind:'topic',authorId:item.authorId,createdAt:item.createdAt})
  }else{
   const raw=(await db.query('select * from teloa_task_runs where owner_id=$1 and id=$2',[owner,source!.runId])).rows[0],run=readStoredTaskRun(raw)
   if(run.evidence?.state!=='ended'||run.evidence.reason!=='completed'||run.groupContext?.groupId!==request.groupId||!(await db.query('select 1 from teloa_tasks where owner_id=$1 and id=$2',[owner,run.taskId])).rowCount)throw new WorkError('teloa/source-unavailable','原消息的完整运行来源暂不可用。')
   runId=run.id
   const snapshot=JSON.parse(run.inputText) as Record<string,unknown>,fixed=run.groupContext.ownerRequest
   if(fixed)for(const item of [...(fixed.priorRequests??[]),fixed])add(item.messageId,{text:item.text,sha256:item.sha256,kind:'full',authorId:'self'})
   const origin=run.groupContext.source
   add(origin.messageId,{text:origin.text,kind:'source',createdAt:origin.createdAt})
   if(snapshot.groupContinuation!==undefined){const item=readRunGroupContinuation(snapshot.groupContinuation);add(item.messageId,{text:item.text,kind:'full',authorId:'self',createdAt:item.createdAt})}
   if(snapshot.groupTopic!==undefined)for(const item of readStoredGroupTopic(snapshot.groupTopic).messages)if(item.messageId)add(item.messageId,{text:item.text,kind:'topic',authorId:item.authorId,createdAt:item.createdAt})
  }
  const selected=cited.filter(id=>id!==request.messageId&&available.has(id)),rows=selected.length?(await db.query('select * from teloa_group_messages where owner_id=$1 and group_id=$2 and id=any($3::uuid[])',[owner,request.groupId,selected])).rows:[]
  const verified:Record<string,unknown>[]=[]
  for(const id of selected){
   const row=rows.find(row=>row.id===id);if(!row)continue
   const text=body(row),stamp=(row.created_at as Date).toISOString(),expected=available.get(id)!
   if(expected.some(item=>item.authorId!==undefined&&item.authorId!==row.author_id||item.createdAt!==undefined&&item.createdAt!==stamp||item.sha256!==undefined&&item.sha256!==groupMessageTextHash(text)||item.kind==='full'&&item.text!==text||item.kind==='source'&&item.text!==text&&item.text!==row.text||item.kind==='topic'&&item.text!==topicText(String(row.text))))continue
   if(row.author_id!=='self'&&(!matchesPublication(row,text)||!(await readTrustedGroupMessageRunSource(db,owner,{groupId:request.groupId,messageId:id})??await readTrustedGroupReplySource(db,owner,{groupId:request.groupId,messageId:id}))))continue
   verified.push(row)
  }
  const messages=await presentGroupMessages(db,owner,verified.map(readStoredGroupMessage)),result=readGroupMessageSources({schema:'teloa.group-message-sources/v1',...request,runId,...(reply?{replyExecutionId:reply.id}:{}),items:messages.map((message,index)=>({message,rootId:message.rootId===null||isGroupEmployeeResponse(message)&&message.contextMode==='main'?null:message.rootId,sha256:groupMessageTextHash(body(verified[index]!))})),unavailableCount:cited.length-messages.length})
  await db.query('commit');return result
 }catch(error){await db.query('rollback');throw error}finally{db.release()}
}
