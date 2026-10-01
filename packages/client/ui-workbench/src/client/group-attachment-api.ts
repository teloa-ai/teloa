import {isGroupAttachment,isGroupAttachmentBytes,isArtifactFile,isGroupResourceVersion,groupAttachmentUploadRoutePath,groupAttachmentImageMediaTypes,groupAttachmentFileMediaTypes,type GroupAttachment,type GroupAttachmentBytes,type GroupAttachmentKind,type ArtifactFile,type MessageReference} from '@teloa/contract'
import {fileBytes,fileImageType} from './artifact-files.ts'
import {read as savedArtifactVersion} from './artifact-api.ts'

type Call=(endpoint:string,payload:unknown)=>Promise<unknown>
/** 上传专用路由的发送口，形同全局 fetch；测试注入假实现。 */
export type UploadSend=(url:string,init:RequestInit)=>Promise<Response>

/**
 * 上传不走 /teloa（那里先整包缓冲再判档），改走宿主在 `/api` 下注册的专用流式路由：与 /teloa 一样按页面相对地址、
 * 同一个浏览器 Cookie、JSON 请求头。回包与 RPC 结果同形：`{ok:true,value}` 或 `{ok:false,error}`；
 * 413 等协议拒绝也带同形 JSON，按原码抛出并标 rejected，与其余端点的错误口径一致。
 */
async function postUpload(send:UploadSend,payload:unknown):Promise<unknown>{
 const response=await send(groupAttachmentUploadRoutePath.slice(1),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})
 let result:unknown
 try{result=await response.json()}catch{throw Error('群附件上传通道暂不可用（HTTP '+response.status+'）。')}
 const record=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value)
 if(record(result)&&result.ok===true&&response.ok)return result.value
 if(record(result)&&result.ok===false&&record(result.error)&&typeof result.error.code==='string'&&typeof result.error.message==='string')throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code})
 throw Error('群附件上传回执格式不正确。')
}
/** 群消息附件面板里的一行待发送状态；requestId 在失败重试时原样重用，不重新生成。 */
export type PendingAttachment={key:string;name:string;mime:string;state:'uploading'|'ready'|'failed';attachmentId?:string;bytes?:number;width?:number;height?:number;requestId:string;message?:string}
export type OpenedAttachment={blobUrl:string;revoke:()=>void;name:string;mime:string}
export type OpenedResource={kind:'resource';markdown:string;title:string}
/** artifact 引用的 id 是成果 artifactId、version 是成果版本号；见 openReference 下方注释。 */
export type ArtifactReference={kind:'artifact';id:string;version:number}
/** describeArtifact 的回执：成果标题、版本号与该版本关联的文件清单（只有 snapshotId，字节留给 openArtifactFile 按需取）。 */
export type ArtifactSummary={title:string;version:number;files:{snapshotId:string}[]}

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const exact=(value:unknown,keys:readonly string[],label:string):Record<string,unknown>=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw Error(label)
 return value as Record<string,unknown>
}
const clone=<T>(value:T):T=>structuredClone(value)

function savedAttachment(value:unknown,label:string,ownerId:string):GroupAttachment{
 try{if(!isGroupAttachment(value)||value.ownerId!==ownerId)throw Error();return clone(value)}catch{throw Error(label)}
}
function savedAttachmentBytes(value:unknown,label:string):GroupAttachmentBytes{
 try{if(!isGroupAttachmentBytes(value))throw Error();return clone(value)}catch{throw Error(label)}
}

const encode=(bytes:Uint8Array):string=>{let out='';for(let offset=0;offset<bytes.length;offset+=0x8000)out+=String.fromCharCode(...bytes.subarray(offset,offset+0x8000));return btoa(out)}
const decode=(value:string):Uint8Array<ArrayBuffer>=>{const raw=atob(value),bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);return bytes}

/** 上传原字节的 sha256 摘要（hex）；用于核对上传回执，不依赖宿主是否对图片做归一化重编码。 */
async function sha256Hex(bytes:Uint8Array<ArrayBuffer>):Promise<string>{
 const digest=await crypto.subtle.digest('SHA-256',bytes)
 return Array.from(new Uint8Array(digest)).map(byte=>byte.toString(16).padStart(2,'0')).join('')
}
/** 按契约白名单判出的图片/文件大类；mime 不在任一清单里时判不出，回 undefined（调用方据此跳过该项核对）。 */
const mediaCategory=(mime:string):GroupAttachmentKind|undefined=>
 (groupAttachmentImageMediaTypes as readonly string[]).includes(mime)?'image'
 :(groupAttachmentFileMediaTypes as readonly string[]).includes(mime)?'file'
 :undefined

/** 唯一构造 blobUrl 的落点：type 一律来自调用方给定的 mime，绝不从文件名推断。 */
function openedBlob(dataBase64:string,mime:string,name:string):OpenedAttachment{
 const blobUrl=URL.createObjectURL(new Blob([decode(dataBase64)],{type:mime}))
 return {blobUrl,revoke:()=>URL.revokeObjectURL(blobUrl),name,mime}
}

export type GroupAttachmentApi=ReturnType<typeof createGroupAttachmentApi>
/**
 * newId 与既有 api 工厂（group-api.ts、role-daily-log-api.ts）同形状保留，供调用方在未来接入
 * 恢复队列时复用；本期 upload/withdraw 的 requestId 由调用方给定（跨挂载草稿持有，重试原样重用）。
 */
export function createGroupAttachmentApi(call:Call,newId:()=>string=()=>crypto.randomUUID(),ownerId='self',send:UploadSend=(url,init)=>globalThis.fetch(url,init)){
 void newId
 return {
  async upload(groupId:string,expectedVersion:number,file:File,requestId:string):Promise<GroupAttachment>{
   if(!uuid(requestId)||!uuid(groupId))throw Error('群附件上传请求身份不正确。')
   const bytes=new Uint8Array(await file.arrayBuffer())
   const dataBase64=encode(bytes)
   const payload={requestId,groupId,expectedVersion,mime:file.type,name:file.name,dataBase64}
   const row=exact(await postUpload(send,payload),['attachment'],'群附件上传回执格式不正确。')
   const attachment=savedAttachment(row.attachment,'群附件上传回执格式不正确。',ownerId)
   /*
    * mime/name 不再全等核对：宿主会把 PNG/JPEG 归一化重编码（mime 可合法变化），附件仓按内容寻址去重时
    * name/mime 以首次落盘为准（同字节不同文件名的第二次上传回执带旧文件名）。改核对状态与原字节摘要——
    * 元数据行的 sha256 恒为上传原字节摘要，不受归一化或去重影响。mime 大类（图片/文件）仍可判的话顺带核对。
    */
   const category=mediaCategory(payload.mime)
   if(attachment.state!=='active'||attachment.sha256!==await sha256Hex(bytes)||(category!==undefined&&attachment.kind!==category))throw Error('群附件上传回执与原请求不一致。')
   return attachment
  },
  async list(groupId:string):Promise<GroupAttachment[]>{
   if(!uuid(groupId))throw Error('群身份格式不正确。')
   const row=exact(await call('groups/attachments/list',{groupId}),['items'],'群附件目录格式不正确。')
   if(!Array.isArray(row.items))throw Error('群附件目录格式不正确。')
   const items=row.items.map(item=>{
    const attachment=savedAttachment(item,'群附件目录格式不正确。',ownerId)
    if(attachment.uploadedInGroupId!==groupId)throw Error('群附件目录格式不正确。')
    return attachment
   })
   if(new Set(items.map(item=>item.attachmentId)).size!==items.length)throw Error('群附件目录包含重复身份。')
   return items
  },
  async withdraw(attachmentId:string,requestId:string):Promise<GroupAttachment>{
   if(!uuid(requestId))throw Error('群附件撤回请求身份不正确。')
   const row=exact(await call('groups/attachments/withdraw',{requestId,attachmentId}),['attachment'],'群附件撤回回执格式不正确。')
   const attachment=savedAttachment(row.attachment,'群附件撤回回执格式不正确。',ownerId)
   if(attachment.attachmentId!==attachmentId||attachment.state!=='withdrawn'||attachment.withdrawnAt===null)throw Error('群附件撤回回执与原请求不一致。')
   return attachment
  },
  /**
   * 三类引用的取字节路由；attachment→groups/attachments/read，group-resource→既有 groups/resources/get。
   * 群资料按群归属存取，group-resource 分支需要调用方传入当前所在群身份（SavedCollaborationPage 渲染时
   * 已持有该值）。
   *
   * artifact 引用的 id 是成果 artifactId（uuid）+ version 是该成果的版本号，**不是**文件快照 snapshotId
   * （sha256）；不存在「按 artifactId+version 直接读文件」的单一端点，只能走既有两步：先 artifacts/versions
   * 按 artifactId 取全部版本清单、挑出 number===version 的那一版，再用该版 content.snapshotIds 里的
   * 快照身份去 artifacts/snapshot 读实际文件（与 artifact-api.ts 的 hydrate() 同一条既有读法）。单文件时
   * 这里的结果与 openArtifactFile(reference,snapshotIds[0]) 等价，只是省了调用方自己拆 describeArtifact
   * 两步；零个（纯文字成果）或多个文件都无法在此消歧，暂不支持，改用 describeArtifact+openArtifactFile。
   */
  async openReference(reference:MessageReference,groupId?:string):Promise<OpenedAttachment|OpenedResource>{
   if(reference.kind==='attachment'){
    const row=exact(await call('groups/attachments/read',{attachmentId:reference.id}),['bytes'],'群附件字节格式不正确。')
    const bytes=savedAttachmentBytes(row.bytes,'群附件字节格式不正确。')
    if(bytes.attachmentId!==reference.id||bytes.version!==reference.version)throw Error('群附件字节与引用身份不一致。')
    return openedBlob(bytes.dataBase64,bytes.mime,bytes.name)
   }
   if(reference.kind==='artifact'){
    const version=await artifactVersion({kind:'artifact',id:reference.id,version:reference.version})
    const snapshotIds=version.content.snapshotIds
    if(snapshotIds.length!==1)throw Error('成果引用未关联恰好一个可打开的文件。')
    const file=await readArtifactSnapshot(snapshotIds[0]!)
    return openedArtifactFile(file)
   }
   if(!groupId||!uuid(groupId))throw Error('群资料引用缺少所属群身份。')
   const version=await call('groups/resources/get',{groupId,resourceId:reference.id,resourceVersion:reference.version})
   if(!isGroupResourceVersion(version)||version.resourceId!==reference.id||version.groupId!==groupId||version.version!==reference.version)throw Error('群资料版本格式不正确。')
   return {kind:'resource',markdown:version.markdown,title:version.title}
  },
  /** 成果卡的元数据：标题、版本号与该版本关联的文件清单；不取字节，供群消息里的成果卡渲染标题与「N 个文件」。 */
  async describeArtifact(reference:ArtifactReference):Promise<ArtifactSummary>{
   const version=await artifactVersion(reference)
   return {title:version.content.title,version:version.number,files:version.content.snapshotIds.map(snapshotId=>({snapshotId}))}
  },
  /** 成果卡展开后逐个文件懒取字节；snapshotId 必须属于该版本的 snapshotIds，否则拒绝（不信任调用方缓存）。 */
  async openArtifactFile(reference:ArtifactReference,snapshotId:string):Promise<OpenedAttachment>{
   const version=await artifactVersion(reference)
   if(!version.content.snapshotIds.includes(snapshotId))throw Error('成果文件快照不属于该版本。')
   const file=await readArtifactSnapshot(snapshotId)
   return openedArtifactFile(file)
  },
 }

 /** artifacts/versions 两步读法的第一步：取版本清单、挑出目标版本；describeArtifact/openArtifactFile/openReference 共用。 */
 async function artifactVersion(reference:ArtifactReference){
  const rows=await call('artifacts/versions',{artifactId:reference.id})
  if(!Array.isArray(rows))throw Error('成果版本目录格式不正确。')
  const versions=rows.map(row=>{try{return savedArtifactVersion(row)}catch{throw Error('成果版本目录格式不正确。')}})
  if(versions.some(row=>row.artifactId!==reference.id))throw Error('成果版本目录与引用身份不一致。')
  const matches=versions.filter(row=>row.number===reference.version)
  if(matches.length!==1)throw Error('成果引用指向的版本不存在或不唯一。')
  return matches[0]!
 }
 /** 两步读法的第二步：按 snapshotId 读实际文件（与 artifact-api.ts 的 hydrate() 同一条既有读法）。 */
 async function readArtifactSnapshot(snapshotId:string):Promise<ArtifactFile>{
  const file=await call('artifacts/snapshot',{snapshotId})
  if(!isArtifactFile(file)||file.id!==snapshotId)throw Error('成果文件快照格式不正确。')
  return file
 }
}
/**
 * 成果文件快照没有 name/mime 字段（contract 的 ArtifactFile 只有 path），文件名按既有单文件读法用路径
 * 最后一段；mime 按既有读法从文件头猜测，猜不出退到 application/octet-stream。若回包本身带了 name/mime
 * （contract 未来扩展该形状）就直接采用，不再猜测。
 */
function openedArtifactFile(file:ArtifactFile):OpenedAttachment{
 const loose=file as unknown as {name?:unknown;mime?:unknown}
 const name=typeof loose.name==='string'&&loose.name?loose.name:(file.path.split('/').pop()||file.path)
 const mime=typeof loose.mime==='string'&&loose.mime?loose.mime:(fileImageType(fileBytes(file))??'application/octet-stream')
 return openedBlob(file.contentBase64,mime,name)
}
