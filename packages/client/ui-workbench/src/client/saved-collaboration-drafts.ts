import {isGroupMention,isMessageReference,type GroupMention,type MessageReference} from '@teloa/contract'
import type {PendingAttachment} from './group-attachment-api.ts'

export type GroupDraftEntry={drafts:Record<string,string>;referenceDrafts:Record<string,MessageReference[]>;mentionDrafts:Record<string,GroupMention[]>;attachmentDrafts:Record<string,PendingAttachment[]>}
export type SavedCollaborationDraftStore={
 readGroupDraftEntry(groupId:string):GroupDraftEntry
 writeGroupDraftText(groupId:string,key:string,text:string):void
 writeGroupReferenceDrafts(groupId:string,key:string,references:readonly MessageReference[]):void
 writeGroupMentionDrafts(groupId:string,key:string,mentions:readonly GroupMention[]):void
 writeGroupAttachmentDrafts(groupId:string,key:string,items:readonly PendingAttachment[]):void
 clearGroupSentDraft(groupId:string,key:string,expected?:GroupDraftEntry):boolean
}

const emptyEntry=():GroupDraftEntry=>({drafts:{},referenceDrafts:{},mentionDrafts:{},attachmentDrafts:{}})
type DraftStorage=Pick<Storage,'getItem'|'setItem'>
const storageKey='teloa.group-drafts/v1'
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
const validMap=(value:unknown,valid:(item:unknown)=>boolean)=>record(value)&&Object.values(value).every(valid)
const browserStorage=()=>{try{return typeof window==='undefined'?undefined:window.sessionStorage}catch{return undefined}}

/**
 * 「返回来源话题」这类导航会把 SavedCollaborationPage 整段卸载再重挂，正文/引用/提及/附件四种草稿
 * 原本都挂在组件 useState 上，一并清空——未发送的草稿本不该因为看了一眼别处就丢。上传中／已上传
 * 待发送的附件尤其不能挂 useState：它是跨视图存活的状态。
 * 四者按 groupId 与话题分别保存，切群只切读取目标，不清理另一群的未发送内容。
 * 附件标签必须与引用一起保留，避免附件仍会发送但界面已不可见。
 */
export function createSavedCollaborationDraftStore(storage?:DraftStorage):SavedCollaborationDraftStore{
 const table=new Map<string,GroupDraftEntry>()
 // 仅在当前标签页恢复文字、资料与提及；文件仍需重新添加，不持久化原始字节或附件引用。
 try{
  const raw=storage?.getItem(storageKey)
  if(raw&&raw.length<=1_000_000){
   const rows:unknown=JSON.parse(raw)
   if(record(rows))for(const [id,item] of Object.entries(rows)){
    if(!record(item)||!validMap(item.drafts,value=>typeof value==='string'&&value.length<=8000)||!validMap(item.referenceDrafts,value=>Array.isArray(value)&&value.length<=8&&value.every(ref=>isMessageReference(ref)&&ref.kind!=='attachment'))||!validMap(item.mentionDrafts,value=>Array.isArray(value)&&value.length<=8&&value.every(isGroupMention)))continue
    table.set(id,{...emptyEntry(),drafts:item.drafts as GroupDraftEntry['drafts'],referenceDrafts:item.referenceDrafts as GroupDraftEntry['referenceDrafts'],mentionDrafts:item.mentionDrafts as GroupDraftEntry['mentionDrafts']})
   }
  }
 }catch{/* 损坏或禁用存储不阻断当前输入。 */}
 const read=(groupId:string):GroupDraftEntry=>table.get(groupId)??emptyEntry()
 const write=(groupId:string,patch:Partial<GroupDraftEntry>):void=>{
  table.set(groupId,{...read(groupId),...patch})
  try{storage?.setItem(storageKey,JSON.stringify(Object.fromEntries([...table].map(([id,entry])=>[id,{drafts:entry.drafts,mentionDrafts:entry.mentionDrafts,referenceDrafts:Object.fromEntries(Object.entries(entry.referenceDrafts).map(([key,refs])=>[key,refs.filter(ref=>ref.kind!=='attachment')]))}]))))}catch{/* 配额不足时仍保留内存草稿。 */}
 }
 return {
  readGroupDraftEntry:read,
  writeGroupDraftText(groupId,key,text){write(groupId,{drafts:{...read(groupId).drafts,[key]:text}})},
  writeGroupReferenceDrafts(groupId,key,references){write(groupId,{referenceDrafts:{...read(groupId).referenceDrafts,[key]:[...references]}})},
  writeGroupMentionDrafts(groupId,key,mentions){write(groupId,{mentionDrafts:{...read(groupId).mentionDrafts,[key]:[...mentions]}})},
  writeGroupAttachmentDrafts(groupId,key,items){write(groupId,{attachmentDrafts:{...read(groupId).attachmentDrafts,[key]:[...items]}})},
  clearGroupSentDraft(groupId,key,expected){
   const entry=read(groupId)
   // 回包只能清理发出时的草稿；发送期间继续编辑的正文、引用、提及或附件必须保留。
   if(expected&&((entry.drafts[key]??'')!==(expected.drafts[key]??'')||(['referenceDrafts','mentionDrafts','attachmentDrafts'] as const).some(field=>JSON.stringify(entry[field][key]??[])!==JSON.stringify(expected[field][key]??[]))))return false
   write(groupId,{drafts:{...entry.drafts,[key]:''},referenceDrafts:{...entry.referenceDrafts,[key]:[]},mentionDrafts:{...entry.mentionDrafts,[key]:[]},attachmentDrafts:{...entry.attachmentDrafts,[key]:[]}})
   return true
  },
 }
}

/** 全应用共用一份，随页面生命周期存活；跨组件挂载/卸载不重置。 */
export const savedCollaborationDrafts=createSavedCollaborationDraftStore(browserStorage())
