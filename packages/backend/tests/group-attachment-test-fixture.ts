import {createHash,randomUUID} from 'node:crypto'
import type {Pool} from 'pg'
import type {GroupAttachmentBytePorts,GroupAttachmentService} from '../src/work/group-attachments.ts'

/** 内存桩端口，与 `group-attachments.test.ts` 同口径：按原字节内容寻址，真端口在 T9／T13 接。 */
export function attachmentPorts():GroupAttachmentBytePorts{
 const store=new Map<string,Buffer>()
 const put=(dataBase64:string)=>{const bytes=Buffer.from(dataBase64,'base64'),attachmentId='sha256:'+createHash('sha256').update(bytes).digest('hex');store.set(attachmentId,bytes);return {attachmentId,bytes:bytes.length}}
 return {
  async saveImage(dataBase64:string){return {...put(dataBase64),width:8,height:8,mediaType:'image/png'}},
  async saveFile(dataBase64:string,name:string){return {...put(dataBase64),name}},
  async readBytes(row:{attachmentId:string}){const found=store.get(row.attachmentId);if(!found)throw Error('missing attachment');return new Uint8Array(found)}
 }
}

/** 直接写一条成果版本行：引用与授权判据只查 `teloa_artifact_versions` 的存在与归属，不需要完整定版链路。 */
export async function artifactVersion(pool:Pool,owner:string,createdAt:string):Promise<string>{
 const id=randomUUID()
 await pool.query('insert into teloa_artifacts values($1,$2,$3,$4,$5,1)',[id,owner,randomUUID(),'{}','teloa/test-source'])
 await pool.query('insert into teloa_artifact_versions(owner_id,artifact_id,number,source,content,created_at) values($1,$2,1,$3,$4,$5)',[owner,id,'{}','{}',createdAt])
 return id
}

/** 上传一件文件原件；原件仓按内容寻址，所以每次用不同正文避免复用同一条行。 */
export async function uploadFile(attachments:GroupAttachmentService,owner:string,groupId:string,groupVersion:number,body:string){
 return attachments.upload(owner,{requestId:randomUUID(),groupId,expectedVersion:groupVersion,mime:'text/plain',name:'证据.txt',dataBase64:Buffer.from(body).toString('base64')})
}
