import {WorkError} from './work-error.ts'

/**
 * 单件上限按类型分两档，判的都是解码后的「上传字节」（编排者裁定 3）。
 * - 图片 8 MiB：防的是宿主逐张解码像素再归一化重编码的内存与耗时，以及图片进模型时挤占 `groupPromptImageBytes`
 *   的多图预算。一期取值不变：日常截图与照片远在其下，DSH 单张默认上限 20 MiB 仍留有余量。
 * - 文件 16 MiB（GIF 归文件档）：防的是单次请求在宿主里的常驻峰值——上传与读回都是整份 base64 进出一个 JSON RPC 包
 *   （约 4/3 倍），宿主的 HTTP 桥先整包缓冲，再经 JSON 解析、契约判定、两次解码与算摘要，同一份内容在堆里同时有好几份。
 *   判据是「单次上传的宿主 RSS 峰值增量不超过 256 MiB」（`tests/group-attachment-memory.mjs` 实测，2026-09-28，
 *   Apple M5 Pro／Node 24.15）：32 MiB 两轮实测 372／404 MiB 超线，16 MiB 为 200 MiB 在线内，故取 16 MiB。
 *   仍比一期 8 MiB 翻倍，覆盖多数扫描件与带图报告 PDF；满额文件 32 件到 512 MiB 总量，总量闸仍有意义。
 *   文件类不整份进提示词：文本类只取前 16000 字，其余只给句柄行。
 */
export const groupAttachmentImageMaxBytes=8*1024*1024
export const groupAttachmentFileMaxBytes=16*1024*1024
/**
 * 上传不走 `/teloa` 通道（那里的 HTTP 桥先把整包请求体缓冲进内存、JSON 解析完才轮到业务判档），
 * 改走 DSH 官方 `connection.fetch.register` 在 `/api` 下注册的精确路由，请求体以流交付（`requestBody:'streaming'`）：
 * 宿主先按 Content-Length 判长、再按本人串行、最后边读边计数，超额即停。路径以端点名结尾，便于按地址识别。
 */
export const groupAttachmentUploadRoutePath='/api/teloa/groups/attachments/upload'
/**
 * 上传请求体上限，防的是「超限的请求在被拒之前先吃掉宿主内存」：取满额文件档的 base64 长度，外加 64 KiB 字段余量
 * （requestId、groupId、版本、MIME、≤120 字文件名经 JSON 转义，远小于这个量）。超过即在读请求体之前拒绝。
 */
export const groupAttachmentUploadMaxBodyBytes=4*Math.ceil(groupAttachmentFileMaxBytes/3)+64*1024
/** @deprecated 单件上限已按类型拆成两档；这里保留为图片档的别名。新代码用 `groupAttachmentMaxBytesFor(mime)`。 */
export const groupAttachmentMaxBytes=groupAttachmentImageMaxBytes
export const groupAttachmentTotalBytes=512*1024*1024
export const groupReferenceMaxFiles=8
export const groupPromptImageCount=4
export const groupPromptImageBytes=16*1024*1024
// 编排者裁定 1：GIF 走文件通道，不在图片集合里
export const groupAttachmentImageMediaTypes=['image/png','image/jpeg','image/webp'] as const
export const groupAttachmentFileMediaTypes=['application/pdf','text/plain','text/markdown','text/csv','application/json','image/gif'] as const
export const groupAttachmentTextMediaTypes=['text/plain','text/markdown','text/csv','application/json'] as const
export const groupAttachmentExtensions={'image/png':['.png'],'image/jpeg':['.jpg','.jpeg'],'image/webp':['.webp'],'image/gif':['.gif'],'application/pdf':['.pdf'],'text/plain':['.txt','.log'],'text/markdown':['.md'],'text/csv':['.csv'],'application/json':['.json']} as const

export type GroupAttachmentKind='image'|'file'
/** 按 MIME 取单件上限：图片白名单走图片档，其余（含 GIF）走文件档。 */
export const groupAttachmentMaxBytesFor=(mime:string):number=>(groupAttachmentImageMediaTypes as readonly string[]).includes(mime)?groupAttachmentImageMaxBytes:groupAttachmentFileMaxBytes
/** 元数据行的 `sha256` 是**上传原字节**的摘要（去重、复活与快照哈希都按它）；图片归一化后的落盘字节摘要不等于它。 */
export type GroupAttachment={attachmentId:string;ownerId:string;version:1;kind:GroupAttachmentKind;mime:string;bytes:number;sha256:string;name:string;width:number|null;height:number|null;uploadedInGroupId:string|null;state:'active'|'withdrawn';createdAt:string;withdrawnAt:string|null}
/** 读回包的 `sha256` 是**本次实际回传字节**（`dataBase64` 解码后）的摘要，回包自洽可自校验；图片上它必然不等于元数据行的 `sha256`。 */
export type GroupAttachmentBytes={attachmentId:string;version:1;mime:string;bytes:number;sha256:string;name:string;dataBase64:string}

export type GroupAttachmentUploadInput={requestId:string;groupId:string;expectedVersion:number;mime:string;name:string;dataBase64:string}
export type GroupAttachmentListInput={groupId:string}
export type GroupAttachmentReadInput={attachmentId:string}
export type GroupAttachmentWithdrawInput={requestId:string;attachmentId:string}

const fail=():never=>{throw new WorkError('teloa/invalid-input','群附件请求包含未知字段或格式不正确。')}
const record=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value)
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{
  if(!record(value)||Object.keys(value).some(key=>!keys.includes(key)))fail()
  return value as Record<string,unknown>
}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const version=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0
const stamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))
/** 1..512、非空白、不匹配 blob:/data:/https?:/file:（逐字复用 artifact-messages.ts:14-15 的判据）。 */
const attachmentRefId=(value:unknown):value is string=>typeof value==='string'&&value.length>=1&&value.length<=512&&value.trim()===value&&!!value.trim()&&!/^(blob:|data:|https?:|file:)/i.test(value)

/** 显示名永不参与落盘路径；这里只保证它作为元数据安全可显示。 */
export function attachmentName(value:unknown):string{
  if(typeof value!=='string')fail()
  let name=(value as string).normalize('NFC')
  name=name.replace(/[\x00-\x1f\x7f]/g,'')
  name=name.replace(/[/\\]/g,'')
  if(name.startsWith('.'))name=name.slice(1)
  if(name.includes('..'))fail()
  name=name.trim()
  if(name.length>120){
    const dot=name.lastIndexOf('.')
    const ext=dot>0?name.slice(dot):''
    const stem=dot>0?name.slice(0,dot):name
    name=stem.slice(0,Math.max(0,120-ext.length))+ext
  }
  if(!name)fail()
  return name
}

/** 逐字复用 isArtifactFile 的规范形四条（artifact-files.ts:13）。 */
export function attachmentBase64(value:unknown,bytes:number):string{
  if(typeof value!=='string')fail()
  const content=value as string
  if(content.length!==4*Math.ceil(bytes/3)||content.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(content)||content.length/4*3-(content.endsWith('==')?2:content.endsWith('=')?1:0)!==bytes)fail()
  return content
}

export function groupAttachmentUploadInput(value:unknown):GroupAttachmentUploadInput{
  const row=exact(value,['requestId','groupId','expectedVersion','mime','name','dataBase64'])
  const mime=String(row.mime)
  if(!uuid(row.requestId)||!uuid(row.groupId)||!version(row.expectedVersion)||!Object.hasOwn(groupAttachmentExtensions,mime))fail()
  const name=attachmentName(row.name),lower=name.toLowerCase()
  // MIME 与扩展名双向一致：不一致直接拒，绝不从文件名推断 MIME。
  if(!(groupAttachmentExtensions[mime as keyof typeof groupAttachmentExtensions] as readonly string[]).some(ext=>lower.endsWith(ext)))fail()
  if(typeof row.dataBase64!=='string')fail()
  const encoded=row.dataBase64 as string
  // 编排者裁定 3：单件上限判的是解码后的「上传字节」，不是归一化后的落盘字节；档位按已判过白名单的 MIME 取。
  const bytes=encoded.length/4*3-(encoded.endsWith('==')?2:encoded.endsWith('=')?1:0)
  if(!Number.isSafeInteger(bytes)||bytes<1||bytes>groupAttachmentMaxBytesFor(mime))fail()
  attachmentBase64(encoded,bytes)
  return {requestId:row.requestId as string,groupId:row.groupId as string,expectedVersion:row.expectedVersion as number,mime,name,dataBase64:encoded}
}

export function groupAttachmentListInput(value:unknown):GroupAttachmentListInput{
  const row=exact(value,['groupId'])
  if(!uuid(row.groupId))fail()
  return {groupId:row.groupId as string}
}

export function groupAttachmentReadInput(value:unknown):GroupAttachmentReadInput{
  const row=exact(value,['attachmentId'])
  if(!attachmentRefId(row.attachmentId))fail()
  return {attachmentId:row.attachmentId as string}
}

export function groupAttachmentWithdrawInput(value:unknown):GroupAttachmentWithdrawInput{
  const row=exact(value,['requestId','attachmentId'])
  if(!uuid(row.requestId)||!attachmentRefId(row.attachmentId))fail()
  return {requestId:row.requestId as string,attachmentId:row.attachmentId as string}
}

export function isGroupAttachment(value:unknown):value is GroupAttachment{
  if(!record(value)||Object.keys(value).length!==14)return false
  if(value.version!==1||!['image','file'].includes(String(value.kind))||!['active','withdrawn'].includes(String(value.state)))return false
  if(typeof value.attachmentId!=='string'||!value.attachmentId||value.attachmentId.length>512)return false
  if(typeof value.ownerId!=='string'||!value.ownerId||value.ownerId.length>128)return false
  if(typeof value.mime!=='string'||!value.mime)return false
  if(typeof value.bytes!=='number'||!Number.isSafeInteger(value.bytes)||value.bytes<0)return false
  if(typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256))return false
  if(typeof value.name!=='string'||!value.name||value.name.length>120)return false
  const dims=(item:unknown):item is number|null=>item===null||(typeof item==='number'&&Number.isSafeInteger(item)&&item>0)
  if(!dims(value.width)||!dims(value.height))return false
  const hasDims=value.width!==null&&value.height!==null
  if(value.kind==='image'&&!hasDims)return false
  if(value.kind==='file'&&hasDims)return false
  if(value.uploadedInGroupId!==null&&!uuid(value.uploadedInGroupId))return false
  if(!stamp(value.createdAt))return false
  const withdrawn=value.state==='withdrawn'
  if(withdrawn){if(value.withdrawnAt===null||!stamp(value.withdrawnAt))return false}
  else if(value.withdrawnAt!==null)return false
  return true
}

export function isGroupAttachmentBytes(value:unknown):value is GroupAttachmentBytes{
  if(!record(value)||Object.keys(value).length!==7)return false
  if(value.version!==1)return false
  if(typeof value.attachmentId!=='string'||!value.attachmentId||value.attachmentId.length>512)return false
  if(typeof value.mime!=='string'||!value.mime)return false
  if(typeof value.bytes!=='number'||!Number.isSafeInteger(value.bytes)||value.bytes<0)return false
  if(typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256))return false
  if(typeof value.name!=='string'||!value.name||value.name.length>120)return false
  try{attachmentBase64(value.dataBase64,value.bytes as number)}catch{return false}
  return true
}
