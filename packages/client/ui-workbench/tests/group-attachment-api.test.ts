import test from 'node:test'
import assert from 'node:assert/strict'
import {resolveObjectURL} from 'node:buffer'
import {createHash} from 'node:crypto'
import {groupAttachmentFileMaxBytes,groupAttachmentUploadInput,groupAttachmentUploadMaxBodyBytes,groupAttachmentUploadRoutePath} from '@teloa/contract'
import {createGroupAttachmentApi} from '../src/client/group-attachment-api.ts'

const groupId='11111111-1111-4111-8111-111111111111'
const requestId='22222222-2222-4222-8222-222222222222'
const attachmentId='33333333-3333-4333-8333-333333333333'
const resourceId='44444444-4444-4444-8444-444444444444'
const sha256='a'.repeat(64)
const at='2026-09-21T00:00:00.000Z'
/** 与 group-attachment-api.ts 里 sha256Hex 同一算法，测试侧用 node:crypto 现算，不硬编码哈希值。 */
const hashOf=(bytes:number[]):string=>createHash('sha256').update(Buffer.from(bytes)).digest('hex')

function attachment(patch:Partial<Record<string,unknown>>={}){
 return {attachmentId,ownerId:'self',version:1 as const,kind:'file' as const,mime:'application/pdf',bytes:4,sha256,name:'x.png',width:null,height:null,uploadedInGroupId:groupId,state:'active' as const,createdAt:at,withdrawnAt:null,...patch}
}
function bytesReply(patch:Partial<Record<string,unknown>>={}){
 return {attachmentId,version:1 as const,mime:'application/pdf',bytes:4,sha256,name:'x.png',dataBase64:'ZGF0YQ==',...patch}
}

/** 上传专用路由的假 fetch：记下地址与请求，按给定回包作答（与宿主路由同形：{ok,value}／{ok,error}）。 */
function uploadRoute(reply:(payload:Record<string,unknown>)=>{status?:number;body:unknown;raw?:string}){
 const posts:{url:string;init:RequestInit;payload:Record<string,unknown>}[]=[]
 const send=async(url:string,init:RequestInit)=>{
  const payload=JSON.parse(String(init.body)) as Record<string,unknown>
  posts.push({url,init,payload})
  const {status=200,body,raw}=reply(payload)
  return new Response(raw??JSON.stringify(body),{status,headers:{'content-type':raw===undefined?'application/json':'text/plain'}})
 }
 return {posts,send}
}
const noCall=async(endpoint:string):Promise<unknown>=>{throw Error('上传不得再走 /teloa：'+endpoint)}
const ok=(value:unknown)=>({body:{ok:true,value}})

test('upload 走 /api 专用路由：相对地址、POST、JSON，只提交契约白名单字段，回执核对本人身份',async()=>{
 const route=uploadRoute(()=>ok({attachment:attachment({sha256:hashOf([1,2,3,4])})}))
 const api=createGroupAttachmentApi(noCall,undefined,'self',route.send)
 const file=new File([new Uint8Array([1,2,3,4])],'x.png',{type:'application/pdf'})
 const result=await api.upload(groupId,3,file,requestId)
 assert.equal(result.attachmentId,attachmentId)
 assert.equal(route.posts.length,1)
 const [sent]=route.posts
 assert.equal(sent!.url,groupAttachmentUploadRoutePath.slice(1),'与 /teloa 同样按页面相对地址发出')
 assert.equal(sent!.init.method,'POST')
 assert.equal(new Headers(sent!.init.headers).get('content-type'),'application/json')
 const payload=sent!.payload
 assert.deepEqual(Object.keys(payload).sort(),['dataBase64','expectedVersion','groupId','mime','name','requestId'].sort())
 assert.equal(payload.requestId,requestId)
 assert.equal(payload.groupId,groupId)
 assert.equal(payload.expectedVersion,3)
 assert.equal(payload.mime,'application/pdf')
 assert.equal(payload.name,'x.png')
 assert.equal(Buffer.from(payload.dataBase64 as string,'base64').toString(),'\x01\x02\x03\x04')
})

test('upload 路由回 ok:false（含 413 等协议拒绝）按原码抛出且标 rejected；非 JSON 故障不标 rejected',async()=>{
 const file=new File([new Uint8Array([1])],'x.pdf',{type:'application/pdf'})
 const conflict=createGroupAttachmentApi(noCall,undefined,'self',uploadRoute(()=>({body:{ok:false,error:{code:'teloa/conflict',message:'附件总量已达上限，请先撤回不再需要的附件。',details:{}}}})).send)
 await assert.rejects(conflict.upload(groupId,3,file,requestId),(error:{code?:string;rejected?:boolean;message:string})=>error.code==='teloa/conflict'&&error.rejected===true&&error.message==='附件总量已达上限，请先撤回不再需要的附件。')
 const tooLarge=createGroupAttachmentApi(noCall,undefined,'self',uploadRoute(()=>({status:413,body:{ok:false,error:{code:'teloa/invalid-input',message:'群附件超过单件上限。',details:{}}}})).send)
 await assert.rejects(tooLarge.upload(groupId,3,file,requestId),(error:{code?:string;rejected?:boolean})=>error.code==='teloa/invalid-input'&&error.rejected===true)
 const gateway=createGroupAttachmentApi(noCall,undefined,'self',uploadRoute(()=>({status:502,body:null,raw:'bad gateway'})).send)
 await assert.rejects(gateway.upload(groupId,3,file,requestId),(error:{code?:string;rejected?:boolean;message:string})=>error.rejected===undefined&&/HTTP 502/.test(error.message))
})

test('upload 满额文件档 PDF：整份编码后过契约入参判定、请求体不超路由上限，字节逐一还原',async()=>{
 const original=Buffer.alloc(groupAttachmentFileMaxBytes,0x41)
 for(let index=0;index<original.length;index+=4099)original[index]=index%251
 let bodyBytes=0
 const route=uploadRoute(payload=>{groupAttachmentUploadInput(payload);return ok({attachment:attachment({bytes:original.length,sha256:createHash('sha256').update(original).digest('hex')})})})
 const send=async(url:string,init:RequestInit)=>{bodyBytes=Buffer.byteLength(String(init.body));return route.send(url,init)}
 await createGroupAttachmentApi(noCall,undefined,'self',send).upload(groupId,3,new File([original],'满额.pdf',{type:'application/pdf'}),requestId)
 assert.equal(Buffer.from(route.posts[0]!.payload.dataBase64 as string,'base64').equals(original),true)
 assert.ok(bodyBytes<=groupAttachmentUploadMaxBodyBytes,'满额合法请求必须在路由上限之内：'+bodyBytes)
})

test('upload 回执缺键或 ownerId 非 self 时抛本地文案，不透传服务端原样对象',async()=>{
 const file=new File([new Uint8Array([1])],'x.png',{type:'application/pdf'})
 const missingKey=createGroupAttachmentApi(noCall,undefined,'self',uploadRoute(()=>ok({attachment:attachment(),extra:1})).send)
 await assert.rejects(missingKey.upload(groupId,3,file,requestId),/回执格式不正确/)
 const foreignOwner=createGroupAttachmentApi(noCall,undefined,'self',uploadRoute(()=>ok({attachment:attachment({ownerId:'other'})})).send)
 await assert.rejects(foreignOwner.upload(groupId,3,file,requestId),/回执格式不正确/)
})

test('upload 回执按状态与原字节摘要核对，归一化后 mime 变化或去重后文件名变化但摘要相等时接受',async()=>{
 const bytes=[9,9]
 const digest=hashOf(bytes)
 const file=new File([new Uint8Array(bytes)],'photo.png',{type:'image/png'})
 const via=(value:Record<string,unknown>)=>createGroupAttachmentApi(noCall,undefined,'self',uploadRoute(()=>ok({attachment:attachment(value)})).send)
 // 回执 sha256 与本地重算的上传原字节摘要不等 → 拒绝，即便 mime/kind 都对得上。
 await assert.rejects(via({sha256:'f'.repeat(64),kind:'image',mime:'image/png',width:10,height:10}).upload(groupId,3,file,requestId),/回执与原请求不一致/)
 // 回执状态非 active（例如撤回复活边界之外的异常态）→ 拒绝，即便摘要相等。
 await assert.rejects(via({sha256:digest,kind:'image',mime:'image/png',width:10,height:10,state:'withdrawn',withdrawnAt:at}).upload(groupId,3,file,requestId),/回执与原请求不一致/)
 // 宿主把 PNG 归一化重编码为 webp：mime 变化但仍属图片大类，摘要对得上 → 接受。
 assert.equal((await via({sha256:digest,kind:'image',mime:'image/webp',width:10,height:10}).upload(groupId,3,file,requestId)).mime,'image/webp')
 // 附件仓按内容寻址去重：同字节第二次上传回执带首次落盘时的文件名，摘要仍对得上 → 接受。
 assert.equal((await via({sha256:digest,kind:'image',mime:'image/png',width:10,height:10,name:'first-upload-name.png'}).upload(groupId,3,file,requestId)).name,'first-upload-name.png')
 // mime 大类判得出时仍核对：图片却回执 kind:'file'，即使摘要相等也拒绝。
 await assert.rejects(via({sha256:digest,kind:'file',mime:'image/png'}).upload(groupId,3,file,requestId),/回执与原请求不一致/)
})

test('list 只提交 groupId，逐项核对本人身份与所属群，拒绝越权或跨群行',async()=>{
 const calls:{endpoint:string;payload:unknown}[]=[]
 const api=createGroupAttachmentApi(async(endpoint,payload)=>{calls.push({endpoint,payload});return {items:[attachment()]}})
 const items=await api.list(groupId)
 assert.equal(items.length,1)
 assert.deepEqual(calls,[{endpoint:'groups/attachments/list',payload:{groupId}}])
 const foreignOwner=createGroupAttachmentApi(async()=>({items:[attachment({ownerId:'other'})]}))
 await assert.rejects(foreignOwner.list(groupId),/目录格式不正确/)
 const otherGroup=createGroupAttachmentApi(async()=>({items:[attachment({uploadedInGroupId:'55555555-5555-4555-8555-555555555555'})]}))
 await assert.rejects(otherGroup.list(groupId),/目录格式不正确/)
})

test('withdraw 只提交 requestId 与 attachmentId，回执须已撤回且身份一致',async()=>{
 const calls:{endpoint:string;payload:unknown}[]=[]
 const api=createGroupAttachmentApi(async(endpoint,payload)=>{calls.push({endpoint,payload});return {attachment:attachment({state:'withdrawn',withdrawnAt:at})}})
 const result=await api.withdraw(attachmentId,requestId)
 assert.equal(result.state,'withdrawn')
 assert.deepEqual(calls,[{endpoint:'groups/attachments/withdraw',payload:{requestId,attachmentId}}])
 const notWithdrawn=createGroupAttachmentApi(async()=>({attachment:attachment()}))
 await assert.rejects(notWithdrawn.withdraw(attachmentId,requestId),/回执与原请求不一致/)
})

test('openReference 对 attachment 引用打到 groups/attachments/read，blob 的 type 只取回包 mime',async()=>{
 const calls:{endpoint:string;payload:unknown}[]=[]
 const api=createGroupAttachmentApi(async(endpoint,payload)=>{
  calls.push({endpoint,payload})
  // 故意喂 name:'x.png' 但 mime:'application/pdf'，断言 blob 类型绝不从文件名推断。
  return {bytes:bytesReply({name:'x.png',mime:'application/pdf'})}
 })
 const opened=await api.openReference({kind:'attachment',id:attachmentId,version:1})
 assert.deepEqual(calls,[{endpoint:'groups/attachments/read',payload:{attachmentId}}])
 if(!('blobUrl' in opened))throw Error('附件引用应返回 blob 结果。')
 assert.equal(opened.mime,'application/pdf')
 assert.equal(opened.name,'x.png')
 assert.ok(opened.blobUrl.startsWith('blob:'))
 let revoked:string|undefined
 const originalRevoke=URL.revokeObjectURL
 URL.revokeObjectURL=(url:string)=>{revoked=url}
 try{opened.revoke()}finally{URL.revokeObjectURL=originalRevoke}
 assert.equal(revoked,opened.blobUrl)
})

test('openReference 读回满额文件档：16 MiB 回包过契约判定，blob 字节数与原件一致（审查 L6）',async()=>{
 const original=Buffer.alloc(groupAttachmentFileMaxBytes,0x42)
 const digest=createHash('sha256').update(original).digest('hex')
 const api=createGroupAttachmentApi(async()=>({bytes:bytesReply({bytes:original.length,sha256:digest,dataBase64:original.toString('base64'),name:'满额.pdf'})}))
 const opened=await api.openReference({kind:'attachment',id:attachmentId,version:1})
 if(!('blobUrl' in opened))throw Error('附件引用应返回 blob 结果。')
 assert.equal(resolveObjectURL(opened.blobUrl)?.size,groupAttachmentFileMaxBytes)
 assert.equal(opened.name,'满额.pdf')
 opened.revoke()
})

test('openReference 对 attachment 引用核对回包身份，不一致即拒绝',async()=>{
 const api=createGroupAttachmentApi(async()=>({bytes:bytesReply({attachmentId:'66666666-6666-4666-8666-666666666666'})}))
 await assert.rejects(api.openReference({kind:'attachment',id:attachmentId,version:1}),/字节与引用身份不一致/)
})

// artifact 引用的 id 是成果 artifactId（uuid）+ version 是成果版本号，不是文件快照 snapshotId（sha256）；
// 既有读法是两步：artifacts/versions 按 artifactId 取版本清单，挑出目标版本，再用它的 snapshotIds 去
// artifacts/snapshot 读实际文件（与 artifact-api.ts 的 hydrate() 同一条路）。
const artifactId='77777777-7777-4777-8777-777777777777'
const otherArtifactId='99999999-9999-4999-8999-999999999999'
const snapshotId='b'.repeat(64)
const otherSnapshotId='c'.repeat(64)
function artifactVersion(number:number,snapshotIds:string[],patch:Partial<Record<string,unknown>>={}){
 return {artifactId,ownerId:'self',number,source:{kind:'session',id:'session-1',scope:'general',version:'v1',title:'调查会话'},content:{title:'调查报告',sections:[],snapshotIds,note:'固定说明'},createdAt:at,...patch}
}
function artifactFile(id:string,path:string){
 return {schema:'teloa.file-snapshot/v1',sessionId:'session-1',id,path,sha256:id,bytes:4,capturedAt:at,contentBase64:'ZGF0YQ=='}
}

test('openReference 对 artifact 引用先按 artifactId 取版本清单，挑出目标版本再打到 artifacts/snapshot',async()=>{
 const calls:{endpoint:string;payload:unknown}[]=[]
 const artifactRef={kind:'artifact' as const,id:artifactId,version:2}
 const api=createGroupAttachmentApi(async(endpoint,payload)=>{
  calls.push({endpoint,payload})
  if(endpoint==='artifacts/versions')return [artifactVersion(1,[otherSnapshotId]),artifactVersion(2,[snapshotId])]
  if(endpoint==='artifacts/snapshot')return artifactFile(snapshotId,'reports/prod-03.pdf')
  throw Error('unexpected endpoint')
 })
 const opened=await api.openReference(artifactRef)
 assert.deepEqual(calls,[
  {endpoint:'artifacts/versions',payload:{artifactId}},
  {endpoint:'artifacts/snapshot',payload:{snapshotId}},
 ])
 if(!('blobUrl' in opened))throw Error('成果引用应返回 blob 结果。')
 assert.equal(opened.name,'prod-03.pdf')
})

test('openReference 对 artifact 引用在版本不存在、跨成果、或文件数量无法消歧时拒绝',async()=>{
 const missingVersion=createGroupAttachmentApi(async()=>[artifactVersion(1,[snapshotId])])
 await assert.rejects(missingVersion.openReference({kind:'artifact',id:artifactId,version:2}),/版本不存在或不唯一/)
 const foreignArtifact=createGroupAttachmentApi(async()=>[{...artifactVersion(1,[snapshotId]),artifactId:otherArtifactId}])
 await assert.rejects(foreignArtifact.openReference({kind:'artifact',id:artifactId,version:1}),/版本目录与引用身份不一致/)
 const noFile=createGroupAttachmentApi(async()=>[{...artifactVersion(1,[]),content:{...artifactVersion(1,[]).content,sections:[{id:'summary',title:'摘要',text:'固定文本，纯文字成果不关联任何文件。'}]}}])
 await assert.rejects(noFile.openReference({kind:'artifact',id:artifactId,version:1}),/未关联恰好一个可打开的文件/)
 const multipleFiles=createGroupAttachmentApi(async()=>[artifactVersion(1,[snapshotId,otherSnapshotId])])
 await assert.rejects(multipleFiles.openReference({kind:'artifact',id:artifactId,version:1}),/未关联恰好一个可打开的文件/)
})

test('describeArtifact 只取版本清单（不打 artifacts/snapshot），回执给标题、版本号与文件清单',async()=>{
 const calls:{endpoint:string;payload:unknown}[]=[]
 const artifactRef={kind:'artifact' as const,id:artifactId,version:2}
 const api=createGroupAttachmentApi(async(endpoint,payload)=>{
  calls.push({endpoint,payload})
  if(endpoint==='artifacts/versions')return [artifactVersion(1,[otherSnapshotId]),artifactVersion(2,[snapshotId,otherSnapshotId])]
  throw Error('unexpected endpoint')
 })
 const summary=await api.describeArtifact(artifactRef)
 assert.deepEqual(calls,[{endpoint:'artifacts/versions',payload:{artifactId}}])
 assert.deepEqual(summary,{title:'调查报告',version:2,files:[{snapshotId},{snapshotId:otherSnapshotId}]})
})

test('describeArtifact 在版本不存在或跨成果时拒绝，与 openReference 同一条判据',async()=>{
 const missingVersion=createGroupAttachmentApi(async()=>[artifactVersion(1,[snapshotId])])
 await assert.rejects(missingVersion.describeArtifact({kind:'artifact',id:artifactId,version:2}),/版本不存在或不唯一/)
 const foreignArtifact=createGroupAttachmentApi(async()=>[{...artifactVersion(1,[snapshotId]),artifactId:otherArtifactId}])
 await assert.rejects(foreignArtifact.describeArtifact({kind:'artifact',id:artifactId,version:1}),/版本目录与引用身份不一致/)
})

test('openArtifactFile 按 artifactId+version 重新核对该 snapshotId 属于该版本，再打到 artifacts/snapshot',async()=>{
 const calls:{endpoint:string;payload:unknown}[]=[]
 const artifactRef={kind:'artifact' as const,id:artifactId,version:2}
 const api=createGroupAttachmentApi(async(endpoint,payload)=>{
  calls.push({endpoint,payload})
  if(endpoint==='artifacts/versions')return [artifactVersion(1,[otherSnapshotId]),artifactVersion(2,[snapshotId,otherSnapshotId])]
  if(endpoint==='artifacts/snapshot')return artifactFile(otherSnapshotId,'reports/appendix.csv')
  throw Error('unexpected endpoint')
 })
 const opened=await api.openArtifactFile(artifactRef,otherSnapshotId)
 assert.deepEqual(calls,[
  {endpoint:'artifacts/versions',payload:{artifactId}},
  {endpoint:'artifacts/snapshot',payload:{snapshotId:otherSnapshotId}},
 ])
 assert.equal(opened.name,'appendix.csv')
})

test('openArtifactFile 拒绝不属于该版本的 snapshotId，不打 artifacts/snapshot',async()=>{
 const calls:{endpoint:string;payload:unknown}[]=[]
 const api=createGroupAttachmentApi(async(endpoint,payload)=>{
  calls.push({endpoint,payload})
  return [artifactVersion(1,[snapshotId])]
 })
 await assert.rejects(api.openArtifactFile({kind:'artifact',id:artifactId,version:1},otherSnapshotId),/成果文件快照不属于该版本/)
 assert.deepEqual(calls,[{endpoint:'artifacts/versions',payload:{artifactId}}])
})

test('openReference 对 group-resource 引用打到 groups/resources/get，需要调用方传入所属群身份',async()=>{
 const calls:{endpoint:string;payload:unknown}[]=[]
 const reference={kind:'group-resource' as const,id:resourceId,version:2}
 const api=createGroupAttachmentApi(async(endpoint,payload)=>{
  calls.push({endpoint,payload})
  return {resourceId,groupId,version:2,title:'研判依据',markdown:'# 固定证据',createdAt:at}
 })
 const opened=await api.openReference(reference,groupId)
 assert.deepEqual(calls,[{endpoint:'groups/resources/get',payload:{groupId,resourceId,resourceVersion:2}}])
 assert.deepEqual(opened,{kind:'resource',markdown:'# 固定证据',title:'研判依据'})
 await assert.rejects(api.openReference(reference),/缺少所属群身份/)
})
