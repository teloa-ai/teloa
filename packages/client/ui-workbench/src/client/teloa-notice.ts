/**
 * Teloa 个人版预览声明的确认状态。
 *
 * 确认状态是本机浏览器级的（localStorage）：换浏览器或清站点数据会再次出现。
 * 单机安装包阶段再改成宿主级持久化，与 DSH 的 settings 文档落在同一层。
 */

/** 声明文案版本；文案实质变化时提升，旧确认自动失效并重新展示。 */
export const TELOA_NOTICE_VERSION='2026-09-14.1'

/** 保存已确认版本的本机键。 */
export const TELOA_NOTICE_STORAGE_KEY='teloa.notice/v1'

/** 只用到 localStorage 的读写两个方法，便于单测与宿主替换。 */
export type NoticeStorage={getItem:(key:string)=>string|null;setItem:(key:string,value:string)=>void}

/** 读取是否已确认当前版本；存储不可用（隐私模式、被宿主禁用）时按未确认处理。 */
export function readNoticeAcknowledged(storage:NoticeStorage|undefined,version:string):boolean{
  if(!storage)return false
  try{return storage.getItem(TELOA_NOTICE_STORAGE_KEY)===version}catch{return false}
}

/** 写入已确认版本；写入失败不抛出，调用方照常完成引导步骤，只是下次仍会看到声明。 */
export function writeNoticeAcknowledged(storage:NoticeStorage|undefined,version:string):boolean{
  if(!storage)return false
  try{storage.setItem(TELOA_NOTICE_STORAGE_KEY,version);return true}catch{return false}
}

/** 取当前运行域的 localStorage；访问本身可能抛错（被宿主禁用或跨域受限）。 */
export function noticeStorage():NoticeStorage|undefined{
  try{return globalThis.localStorage??undefined}catch{return undefined}
}
