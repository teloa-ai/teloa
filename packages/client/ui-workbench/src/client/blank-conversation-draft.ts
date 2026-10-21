import type {Conversation} from '@teloa/contract'
import type {InputState} from '@deepseek-ai/dsh-client-ui-conversation/client'

type Storage=Pick<globalThis.Storage,'getItem'|'setItem'|'removeItem'>
const key='teloa.blank-new-conversation/v1'

/** 左栏「新建工作会话」打开的空白会话：只记身份与业务语境，正文、引用和附件仍归官方输入按会话保存。 */
export type BlankNewConversation={sessionId:string;scope?:string}
export function readBlankNewConversation(storage:Storage):BlankNewConversation|undefined{
 try{
  const value=JSON.parse(storage.getItem(key)??'null') as unknown
  if(value&&typeof value==='object'&&typeof (value as BlankNewConversation).sessionId==='string'){
   const {sessionId,scope}=value as BlankNewConversation
   if(scope===undefined||typeof scope==='string')return {sessionId,...(scope===undefined?{}:{scope})}
  }
 }catch{/* 损坏记录按无记录处理，不影响新建。 */}
 return undefined
}
/** 只是导航便利：存储不可用时不影响已成功的创建，下次新建按常规另建。 */
export function rememberBlankNewConversation(storage:Storage,value:BlankNewConversation|undefined):void{
 try{if(value)storage.setItem(key,JSON.stringify(value));else storage.removeItem(key)}catch{/* 见上 */}
}

/** 只认仍在工作目录、未归档、原生确认尚未开始的普通会话；业务语境须与本次请求一致。已有历史的会话从不当作空白会话。 */
export function blankNewConversation(input:{entry:BlankNewConversation|undefined;rows:readonly Conversation[];archived:readonly string[];blank:(sessionId:string)=>boolean|undefined;scope?:string|undefined}):Conversation|undefined{
 const {entry}=input
 if(!entry||entry.scope!==input.scope)return
 const row=input.rows.find(item=>item.sessionId===entry.sessionId)
 if(!row||row.status!=='ready'||row.purpose!==undefined||input.archived.includes(row.sessionId)||input.blank(row.sessionId)!==true)return
 return row
}

/** 创建时固定的位置或原生登记归属任一与目标一致，即视为同一执行位置。 */
export function conversationAtLocation(row:Conversation,workspaceId:string|undefined,workspaces:readonly {workspaceId:string;sessionIds:readonly string[]}[]):boolean{
 return row.requestedWorkspaceId===workspaceId||workspaces.find(item=>item.sessionIds.includes(row.sessionId))?.workspaceId===workspaceId
}

/** 官方公开输入门面中迁移所需的部分。 */
export type DraftInputPort={state:{getSnapshot:()=>Pick<InputState,'draft'|'attachmentIds'|'phase'|'occurrences'|'queue'>};setDraft:(text:string)=>void;notify:(level:'info'|'error',text:string)=>void;focus?:()=>void}
/**
 * 公开门面只能整段写入纯文本：引用 chip 的结构化写入与附件改投（rebindDraftFiles）未在固定版 DSH 公开，
 * 因此引用与附件不迁移，由调用方保留原会话并说明；排队或提交中的输入也不打断。
 */
export function draftCarry(state:ReturnType<DraftInputPort['state']['getSnapshot']>):'empty'|'text'|'structured'|'busy'{
 if(state.phase!=='plain'||state.queue.length>0)return 'busy'
 if(state.occurrences.length>0||state.attachmentIds.length>0)return 'structured'
 return state.draft?'text':'empty'
}
/** 与 DSH 空白会话换位置的原生顺序一致：目标确认收到后才清空来源；只写草稿，从不提交。 */
export function moveTextDraft(source:DraftInputPort,target:DraftInputPort):void{
 const before=source.state.getSnapshot()
 if(draftCarry(before)!=='text')throw Error('原输入不是可迁移的纯文本草稿。')
 if(draftCarry(target.state.getSnapshot())!=='empty')throw Error('新会话输入已有内容，未覆盖。')
 target.setDraft(before.draft)
 if(target.state.getSnapshot().draft!==before.draft)throw Error('新会话未接受草稿，原草稿已保留。')
 source.setDraft('')
}
