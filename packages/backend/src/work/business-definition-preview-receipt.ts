import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto'

/**
 * 预览回执只活在当前后端进程：密钥从不落库、不进入 RPC 回包，也不接受外部注入。
 * 进程重启后旧回执自然失效，确认者必须重新取得同一份只读预览。
 */
const secret=randomBytes(32)
const receiptPattern=/^[a-f0-9]{64}$/

export type BusinessDefinitionPreviewReceiptBinding={
 ownerId:string;scope:string;draftId:string;definitionHash:string;currentVersion:number
}

function encoded(binding:BusinessDefinitionPreviewReceiptBinding):string{
 return JSON.stringify([
  'teloa.business-definition-preview-receipt/v1',
  binding.ownerId,binding.scope,binding.draftId,binding.definitionHash,binding.currentVersion,
 ])
}

function signed(binding:BusinessDefinitionPreviewReceiptBinding):string{
 return createHmac('sha256',secret).update(encoded(binding)).digest('hex')
}

/** 只由真实预览路径调用；调用者只能拿到不可反推的 HMAC 值。 */
export function issueBusinessDefinitionPreviewReceipt(binding:BusinessDefinitionPreviewReceiptBinding):string{
 return signed(binding)
}

/** 常量时间比较，避免把某一位签名是否命中的信息暴露给确认端。 */
export function verifiesBusinessDefinitionPreviewReceipt(receipt:unknown,binding:BusinessDefinitionPreviewReceiptBinding):boolean{
 if(typeof receipt!=='string'||!receiptPattern.test(receipt))return false
 return timingSafeEqual(Buffer.from(receipt,'hex'),Buffer.from(signed(binding),'hex'))
}

export function isBusinessDefinitionPreviewReceipt(value:unknown):value is string{
 return typeof value==='string'&&receiptPattern.test(value)
}
