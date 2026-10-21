import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createGroupApi} from '../src/client/group-api.ts'
import {createGroupAttachmentApi} from '../src/client/group-attachment-api.ts'
import {createDashboardGroupShare} from '../src/client/dashboard-share-group.ts'

const groupId='11111111-1111-4111-8111-111111111111',messageId='22222222-2222-4222-8222-222222222222',at='2026-10-21T10:00:00.000Z'
const file=new File(['original raw CSV'],'dashboard.csv',{type:'text/csv'})
const request={scope:'SOC',snapshotHash:'a'.repeat(64),groupId,text:'固定看板\n7d\nSHA-256 '+ 'a'.repeat(64),files:[file]}
function fixture(){
 const group={id:groupId,ownerId:'self',version:1,name:'SOC业务组',scope:'SOC',announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},pinned:false,archived:false,createdAt:at,updatedAt:at}
 const messages=new Map<string,unknown>(),uploads=new Map<string,unknown>(),calls:{endpoint:string;payload:any}[]=[],posts:any[]=[]
 let journal:string|null=null,unknownSend=false,unknownUpload=false,counter=10
 const newId=()=>String(counter++).padStart(8,'0')+'-1111-4111-8111-111111111111'
 const groups=createGroupApi(async(endpoint,payload:any)=>{
  calls.push({endpoint,payload})
  if(endpoint==='groups/get')return {group:{...group},members:[{groupId,roleId:null,createdAt:at}]}
  if(endpoint==='groups/list')return [{...group}]
  if(endpoint==='groups/messages/send'){
   const existing=messages.get(payload.requestId)
   if(existing)return existing
   const value={id:messageId,groupId,rootId:null,authorId:'self',text:payload.text,references:payload.references??[],mentions:[],createdAt:at}
   messages.set(payload.requestId,value)
   if(unknownSend){unknownSend=false;throw Error('模拟已保存但回包丢失')}
   return value
  }
  throw Error(endpoint)
 },{read:()=>journal,write:value=>{journal=value},clear:()=>{journal=null}},newId,'self')
 const attachments=createGroupAttachmentApi(async()=>{throw Error('不得经普通RPC上传')},newId,'self',async(_url,init)=>{
  const payload=JSON.parse(String(init.body));posts.push(payload)
  const bytes=Buffer.from(payload.dataBase64,'base64')
  let value=uploads.get(payload.requestId)
  if(!value){value={attachmentId:newId(),ownerId:'self',version:1,kind:'file',mime:payload.mime,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),name:payload.name,width:null,height:null,uploadedInGroupId:groupId,state:'active',createdAt:at,withdrawnAt:null};uploads.set(payload.requestId,value)}
  if(unknownUpload){unknownUpload=false;return new Response('lost',{status:502})}
  return new Response(JSON.stringify({ok:true,value:{attachment:value}}),{headers:{'content-type':'application/json'}})
 })
 return {group,groups,attachments,calls,posts,messages,uploads,newId,unknownSend:()=>{unknownSend=true},unknownUpload:()=>{unknownUpload=true}}
}

test('真实Group/Attachment适配器分享原始CSV，群消息未知回执只重放原request且不重传附件',async()=>{
 const f=fixture(),flow=createDashboardGroupShare(f.groups,f.attachments,f.newId)
 assert.equal(f.calls.length,0,'创建分享意图不自动读取或发送')
 f.unknownSend();await assert.rejects(flow.send(request),/回包丢失/)
 assert.ok(f.groups.pending());assert.equal(flow.canRestart(),false);assert.equal(f.messages.size,1);assert.equal(f.posts.length,1)
 const pending=f.groups.pending()!
 const result=await flow.send(request)
 assert.equal(result.id,messageId);assert.equal(f.groups.pending(),undefined);assert.equal(flow.canRestart(),true)
 assert.equal(f.messages.size,1);assert.equal(f.posts.length,1)
 const sends=f.calls.filter(c=>c.endpoint==='groups/messages/send')
 assert.equal(sends.length,2);assert.deepEqual(sends[0]!.payload,sends[1]!.payload)
 assert.equal(sends[0]!.payload.requestId,pending.request.requestId)
 assert.equal(Buffer.from(f.posts[0].dataBase64,'base64').toString(),'original raw CSV')
 assert.deepEqual(result.references,[{kind:'attachment',id:(f.uploads.values().next().value as {attachmentId:string}).attachmentId,version:1}])
 assert.equal((await flow.send(request)).id,messageId)
 assert.equal(f.calls.filter(c=>c.endpoint==='groups/messages/send').length,2,'收到正式回执后再点击不创建第二条消息')
})

test('上传未知后保留同一个附件requestId，重试只准备一个附件和一条群消息',async()=>{
 const f=fixture(),flow=createDashboardGroupShare(f.groups,f.attachments,f.newId)
 f.unknownUpload();await assert.rejects(flow.send(request),/HTTP 502/)
 assert.equal(f.messages.size,0);assert.equal(flow.canRestart(),true)
 await flow.send(request)
 assert.equal(f.posts.length,2);assert.equal(f.posts[0].requestId,f.posts[1].requestId)
 assert.equal(f.uploads.size,1);assert.equal(f.messages.size,1)
})

test('跨业务、已归档、版本改变及未知请求冲突均在发送前拒绝',async()=>{
 for(const patch of [{scope:'other'},{archived:true}]){
  const f=fixture();Object.assign(f.group,patch)
  await assert.rejects(createDashboardGroupShare(f.groups,f.attachments,f.newId).send(request),{code:'teloa/dashboard-share-group-changed'})
  assert.equal(f.posts.length,0);assert.equal(f.messages.size,0)
 }
 const f=fixture(),flow=createDashboardGroupShare(f.groups,f.attachments,f.newId)
 f.unknownUpload();await assert.rejects(flow.send(request))
 f.group.version=2
 await assert.rejects(flow.send(request),{code:'teloa/dashboard-share-group-changed'})
 assert.equal(f.messages.size,0)
 const g=fixture();g.unknownSend();await assert.rejects(g.groups.send(groupId,1,'另一条本人消息'))
 await assert.rejects(createDashboardGroupShare(g.groups,g.attachments,g.newId).send(request),{code:'teloa/dashboard-share-pending'})
 assert.equal(g.posts.length,0);assert.equal(g.messages.size,1)
})

test('已发起意图的快照、正文或文件变化不能覆盖原发送',async()=>{
 const f=fixture(),flow=createDashboardGroupShare(f.groups,f.attachments,f.newId)
 f.unknownSend();await assert.rejects(flow.send(request))
 for(const change of [{snapshotHash:'b'.repeat(64)},{text:'different'},{files:[new File(['modified'],'dashboard.csv',{type:'text/csv'})]}])await assert.rejects(flow.send({...request,...change}),{code:'teloa/dashboard-share-intent-changed'})
 assert.equal(f.messages.size,1);assert.equal(f.posts.length,1)
})
