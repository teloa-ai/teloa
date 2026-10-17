import {WorkError} from './work-error.ts'

export const externalHarnessEndpoints=['external-harness/list','external-harness/stop'] as const
export const externalHarnessStatuses=['reserved','running','stopping','completed','failed','aborted','unknown'] as const
export type ExternalHarnessWorkStatus=typeof externalHarnessStatuses[number]
/** 只读业务投影；opaque activationId 不被当成本地 Session 地址。 */
export type ExternalHarnessWorkView={activationId:string;provider:'codex'|'claude-code';status:ExternalHarnessWorkStatus;canStop:boolean;observedAt:number}
export function readExternalHarnessWorkView(value:unknown):ExternalHarnessWorkView{
 const row=value as Record<string,unknown>
 if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).sort().join(',')!=='activationId,canStop,observedAt,provider,status'||typeof row.activationId!=='string'||!row.activationId||row.activationId.length>512||/[\u0000-\u001f]/.test(row.activationId)||!['codex','claude-code'].includes(row.provider as string)||!externalHarnessStatuses.includes(row.status as ExternalHarnessWorkStatus)||typeof row.canStop!=='boolean'||row.canStop&&row.status!=='running'||!Number.isSafeInteger(row.observedAt)||(row.observedAt as number)<0)throw new WorkError('teloa/invalid-input','外部工作状态格式不正确。')
 return {...row} as ExternalHarnessWorkView
}
