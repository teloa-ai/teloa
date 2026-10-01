import test from 'node:test'
import assert from 'node:assert/strict'
import {createSavedCollaborationDraftStore} from '../src/client/saved-collaboration-drafts.ts'

const group='11111111-1111-4111-8111-111111111111',resource='22222222-2222-4222-8222-222222222222'
function storage(){const data=new Map<string,string>();return {getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value)}}}
test('刷新后恢复文字与资料；需重新添加的文件不能留下隐藏引用',()=>{
 const persisted=storage(),first=createSavedCollaborationDraftStore(persisted)
 first.writeGroupDraftText(group,'main','未发送的工作草稿')
 first.writeGroupReferenceDrafts(group,'main',[{kind:'group-resource',id:resource,version:1},{kind:'attachment',id:resource,version:1}])
 const after=createSavedCollaborationDraftStore(persisted).readGroupDraftEntry(group)
 assert.equal(after.drafts.main,'未发送的工作草稿')
 assert.deepEqual(after.referenceDrafts.main,[{kind:'group-resource',id:resource,version:1}])
 assert.deepEqual(after.attachmentDrafts,{})
})
test('浏览器存储不可用或损坏时仍能编辑和发送内存草稿',()=>{
 for(const persisted of [{getItem:()=>'{broken',setItem:()=>{}},{getItem:()=>{throw Error('blocked')},setItem:()=>{throw Error('blocked')}}]){
  const store=createSavedCollaborationDraftStore(persisted)
  store.writeGroupDraftText(group,'main','内存草稿')
  assert.equal(store.readGroupDraftEntry(group).drafts.main,'内存草稿')
  store.clearGroupSentDraft(group,'main')
  assert.equal(store.readGroupDraftEntry(group).drafts.main,'')
 }
})
