import test from 'node:test'
import assert from 'node:assert/strict'
import {createGroupApi} from '../src/client/group-api.ts'
import {mergeGroupMessageWindow,loadGroupMessageWindow} from '../src/client/group-message-window.ts'
import type {GroupMessage,GroupMessagePage} from '@teloa/contract'
const id=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0'),groupId=id(999)
const message=(n:number):GroupMessage=>({id:id(n),groupId,rootId:null,authorId:'self',text:'消息'+n,mentions:[],references:[],createdAt:new Date(Date.UTC(2026,9,15,0,0,n)).toISOString()})
const page=(numbers:number[],older:number|null,newer:number|null):GroupMessagePage=>({schema:'teloa.group-message-page/v1',groupId,rootId:null,items:numbers.map(message),older:older===null?null:id(older),newer:newer===null?null:id(newer),topics:[]})
test('分页合并保留旧页与搜索定位段，明确历史间隙，前后补页连接后去重',()=>{
 let window=mergeGroupMessageWindow(undefined,page([50,51],50,null))
 window=mergeGroupMessageWindow(window,page([1,2],1,2),{around:id(1)})
 assert.deepEqual(window.items.map(m=>m.id),[1,2,50,51].map(id));assert.deepEqual(window.gaps,[id(2)])
 window=mergeGroupMessageWindow(window,page([3,4],3,4),{after:id(2)})
 assert.deepEqual(window.gaps,[id(4)])
 window=mergeGroupMessageWindow(window,page([5,50],5,50),{after:id(4)})
 assert.deepEqual(window.gaps,[]);assert.equal(window.items.filter(m=>m.id===id(50)).length,1)
 window=mergeGroupMessageWindow(window,page([],null,null),{after:id(51)})
 assert.equal(window.items.length,7);assert.equal(window.older,id(1))
})
test('旧尾页的newer为空不能抹掉后来最新页或搜索定位段之间的间隙',()=>{
 for(const topic of [false,true])for(const around of [false,true]){
  const target=(numbers:number[],older:number|null,newer:number|null):GroupMessagePage=>{
   const value=page(numbers,older,newer)
   return topic?{...value,rootId:id(0),items:[message(0),...value.items.map(row=>({...row,rootId:id(0)}))]}:value
  }
  let window=mergeGroupMessageWindow(undefined,target([1,2],null,null))
  window=mergeGroupMessageWindow(window,target([50,51],50,null),around?{around:id(50)}:{})
  assert.deepEqual(window.gaps,[id(2)],'旧快照当时已到尾部，不能证明现在与新段之间没有消息')
  window=mergeGroupMessageWindow(window,target([3,4],3,4),{after:id(2)});assert.deepEqual(window.gaps,[id(4)])
  window=mergeGroupMessageWindow(window,target([5,50],5,50),{after:id(4)});assert.deepEqual(window.gaps,[])
  assert.deepEqual(window.items.map(row=>row.id),[...(topic?[0]:[]),1,2,3,4,5,50,51].map(id))
 }
})
test('真实API只调用有界分页/检索，坏目标和坏顺序拒绝且不回退全量目录',async()=>{
 const calls:unknown[]=[],api=createGroupApi(async(endpoint,input)=>{calls.push([endpoint,input]);return endpoint.endsWith('page')?page([4,5],4,null):{schema:'teloa.group-message-search/v1',groupId,rootId:null,query:'目标',items:[{message:message(1),rootId:null,excerpt:'目标'}],next:null}})
 assert.equal((await api.messagePage(groupId,undefined,{before:id(6),limit:2})).items.length,2)
 assert.equal((await api.searchMessages(groupId,'目标')).items[0]!.message.id,id(1))
 assert.deepEqual((calls as any[]).map(([endpoint])=>endpoint),['groups/messages/page','groups/messages/search'])
 const wrong=createGroupApi(async()=>({...page([4,5],4,null),groupId:id(998)}));await assert.rejects(wrong.messagePage(groupId))
 const disorder=createGroupApi(async()=>page([5,4],5,null));await assert.rejects(disorder.messagePage(groupId))
})
test('初次阅读水位落在尾页之外时补原水位窗口，保留最新页并明确未加载间隙',async()=>{
 const calls:any[]=[],api=createGroupApi(async(endpoint,input:any)=>{calls.push([endpoint,input]);if(endpoint==='groups/reading/get')return {schema:'teloa.group-reading/v1',groupId,rootId:null,cursor:{messageId:id(2),createdAt:message(2).createdAt},latest:{messageId:id(51),createdAt:message(51).createdAt},unreadCount:5};return input.around?page([1,2],1,2):page([50,51],50,null)})
 const window=await loadGroupMessageWindow(api,groupId)
 assert.deepEqual(window.items.map(row=>row.id),[1,2,50,51].map(id));assert.ok('gaps'in window);assert.deepEqual(window.gaps,[id(2)]);assert.equal(calls.filter(([endpoint])=>endpoint==='groups/messages/page').length,2)
})
test('初次水位读取较慢时，迟到窗口不能覆盖同群已取得的增量',async()=>{
 let release:((value:unknown)=>void)|undefined,started:()=>void=()=>{}
 const readingStarted=new Promise<void>(resolve=>{started=resolve}),api=createGroupApi(async(endpoint,input:any)=>{if(endpoint==='groups/reading/get'){started();return new Promise(resolve=>{release=resolve})}return input.after?page([52],52,null):page([50,51],50,null)})
 const initial=loadGroupMessageWindow(api,groupId);await readingStarted
 await loadGroupMessageWindow(api,groupId,undefined,{after:id(51)})
 release!({schema:'teloa.group-reading/v1',groupId,rootId:null,cursor:null,latest:{messageId:id(52),createdAt:message(52).createdAt},unreadCount:0})
 assert.deepEqual((await initial).items.map(row=>row.id),[50,51,52].map(id))
})
