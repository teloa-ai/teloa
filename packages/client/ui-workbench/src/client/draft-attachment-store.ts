/** 只持久保存浏览器已选择的 File；不保存凭据、路径或服务器上传回执。 */
export type SavedDraftFile={id:string;file:File;inflight:boolean;needsReview?:boolean}
export type SavedDraftAttachments={namespace:string;sessionId:string;afterSeq:number;draftFingerprint?:string;files:SavedDraftFile[]}
export type DraftAttachmentStore={read:(namespace:string,sessionId:string)=>Promise<SavedDraftAttachments|null>;write:(value:SavedDraftAttachments)=>Promise<void>;remove:(namespace:string,sessionId:string)=>Promise<void>}
export function validDraftFile(file:unknown):file is File{
 return typeof File!=='undefined'&&file instanceof File&&!!file.name&&!/[\\/\0]/.test(file.name)&&Number.isSafeInteger(file.size)&&file.size>=0&&Number.isFinite(file.lastModified)&&(!file.type||/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(file.type))
}
export function createDraftAttachmentStore(factory:IDBFactory=globalThis.indexedDB):DraftAttachmentStore{
 let opening:Promise<IDBDatabase>|undefined
 const database=()=>opening??=(new Promise<IDBDatabase>((resolve,reject)=>{
  if(!factory){reject(Error('附件草稿存储不可用。'));return}
  const request=factory.open('teloa-draft-attachments',1)
  request.onupgradeneeded=()=>request.result.createObjectStore('drafts')
  request.onerror=()=>reject(request.error)
  request.onblocked=()=>reject(Error('附件草稿存储正由其他页面升级。'))
  request.onsuccess=()=>{request.result.onversionchange=()=>request.result.close();resolve(request.result)}
 }))
 const key=(namespace:string,sessionId:string)=>{if(!namespace||!sessionId)throw Error('附件草稿身份未确认。');return JSON.stringify([namespace,sessionId])}
 async function transaction<T>(mode:IDBTransactionMode,run:(store:IDBObjectStore)=>IDBRequest<T>):Promise<T>{
  const db=await database()
  return new Promise<T>((resolve,reject)=>{
   const tx=db.transaction('drafts',mode),request=run(tx.objectStore('drafts'))
   tx.oncomplete=()=>resolve(request.result)
   tx.onabort=()=>reject(tx.error??request.error??Error('附件草稿未能保存。'))
   tx.onerror=()=>reject(tx.error??request.error??Error('附件草稿存储失败。'))
  })
 }
 return {
  async read(namespace,sessionId){
   const value:unknown=await transaction('readonly',store=>store.get(key(namespace,sessionId)))
   if(value===undefined)return null
   const row=value as SavedDraftAttachments
   if(!row||row.namespace!==namespace||row.sessionId!==sessionId||!Number.isSafeInteger(row.afterSeq)||row.afterSeq< -1||row.draftFingerprint!==undefined&&(typeof row.draftFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(row.draftFingerprint))||!Array.isArray(row.files)||new Set(row.files.map(f=>f?.id)).size!==row.files.length||row.files.some(f=>!f||typeof f.id!=='string'||typeof f.inflight!=='boolean'||f.needsReview!==undefined&&typeof f.needsReview!=='boolean'||!validDraftFile(f.file)))throw Error('附件草稿内容无效，未自动恢复。')
   return row
  },
  async write(value){if(value.files.some(f=>!validDraftFile(f.file)))throw Error('附件草稿文件无效。');await transaction('readwrite',store=>store.put(value,key(value.namespace,value.sessionId)))},
  async remove(namespace,sessionId){await transaction('readwrite',store=>store.delete(key(namespace,sessionId)))},
 }
}
