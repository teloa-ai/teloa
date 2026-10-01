import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto'
import {businessConfigurationHash,type BusinessConfigurationCurrent} from './business-configuration-store.ts'

/** 仅当前进程有效，与独立叶子预览使用不同域和密钥。 */
const secret=randomBytes(32)
export type BusinessConfigurationPreviewReceiptBinding={ownerId:string;draftId:string;scope:string;revision:number;candidateHash:string;baseVersion:number;dependencyHash:string}
/** 正式 manifest 摘要已覆盖所有固定叶子引用，不纳入无关市场变化。 */
export function businessConfigurationDependencyHash(current:BusinessConfigurationCurrent|undefined):string{
 return businessConfigurationHash({baseVersion:current?.version??0,configurationHash:current?.hash??null})
}
function sign(binding:BusinessConfigurationPreviewReceiptBinding):string{
 return createHmac('sha256',secret).update(JSON.stringify(['teloa.business-configuration-preview-receipt/v1',binding.ownerId,binding.draftId,binding.scope,binding.revision,binding.candidateHash,binding.baseVersion,binding.dependencyHash])).digest('hex')
}
export function issueBusinessConfigurationPreviewReceipt(binding:BusinessConfigurationPreviewReceiptBinding):string{return sign(binding)}
export function verifiesBusinessConfigurationPreviewReceipt(receipt:unknown,binding:BusinessConfigurationPreviewReceiptBinding):boolean{
 return typeof receipt==='string'&&/^[a-f0-9]{64}$/.test(receipt)&&timingSafeEqual(Buffer.from(receipt,'hex'),Buffer.from(sign(binding),'hex'))
}
