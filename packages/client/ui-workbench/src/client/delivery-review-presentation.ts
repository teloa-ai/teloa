/** 宿主交付复核的来源种类；与 harness-dsh 的 deliveryReviewSource 同一常量值。 */
export const deliveryReviewSourceKind='plugin:teloa.delivery-review'
/** 宿主按复核编辑计划应用后追加的交付 notice 摘要。 */
export const hostReviewDeliverySummary='复核后交付'

/** 会话中可直接阅读与复制的宿主复核交付：正文就是任务结果正文；编辑数与摘要来自同一条宿主来源记录。 */
export type HostReviewDelivery=Readonly<{text:string;edits:number|null;deliverySha256:string|null;planMessageId:string|null}>

const isRecord=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null

/**
 * 只认宿主交付复核来源、摘要为「复核后交付」且带正文的上下文消息；编辑计划、待校正草稿、复核要求等其他
 * notice 与任何其他来源一律返回 null，交给原生呈现。正文按原文本块拼接，不做改写。
 */
export function readHostReviewDelivery(node:{source:unknown;content:readonly unknown[]}):HostReviewDelivery|null{
 const source=node.source
 if(!isRecord(source)||source.kind!==deliveryReviewSourceKind||source.summary!==hostReviewDeliverySummary)return null
 const text=node.content.flatMap(part=>isRecord(part)&&part.type==='text'&&typeof part.text==='string'?[part.text]:[]).join('\n')
 if(!text.trim())return null
 return {
  text,
  edits:typeof source.edits==='number'&&Number.isInteger(source.edits)&&source.edits>=0?source.edits:null,
  deliverySha256:typeof source.deliverySha256==='string'&&/^[0-9a-f]{64}$/.test(source.deliverySha256)?source.deliverySha256:null,
  planMessageId:typeof source.planMessageId==='string'?source.planMessageId:null,
 }
}

/** 浏览器内的 SHA-256（hex）。 */
export async function sha256Hex(text:string):Promise<string>{
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))
 return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('')
}

/** 展示正文是否与宿主记录的交付摘要一致；记录没有摘要时为 null（无法核对，不假称一致）。 */
export async function verifyHostReviewDelivery(delivery:HostReviewDelivery,digest:(text:string)=>Promise<string>=sha256Hex):Promise<boolean|null>{
 return delivery.deliverySha256===null?null:await digest(delivery.text)===delivery.deliverySha256
}
