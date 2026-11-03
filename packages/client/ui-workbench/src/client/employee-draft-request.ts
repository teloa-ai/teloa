import type {PageCreateDraft} from '@teloa/contract'
import {sha256Hex} from './delivery-review-presentation.ts'

/** 同一员工草案的固定正文沿用一个创建请求；草案身份按契约是字符串，不假定为 UUID。 */
export async function employeeDraftRequestId(draft:Pick<PageCreateDraft,'entity'|'ownerId'|'id'|'bodyHash'>):Promise<string>{
 if(draft.entity!=='role'||typeof draft.ownerId!=='string'||!draft.ownerId.trim()||draft.ownerId.length>200||typeof draft.id!=='string'||!draft.id.trim()||draft.id.length>200||!/^[a-f0-9]{64}$/.test(draft.bodyHash))throw Error('员工草案身份或固定摘要不正确。')
 const hash=await sha256Hex(JSON.stringify(['teloa.employee-draft-create/v1',draft.ownerId,draft.id,draft.bodyHash]))
 // 沿用宿主固定请求的 UUID 形状；摘要复用浏览器内既有 SHA-256，不包含职责正文或凭据。
 return hash.slice(0,8)+'-'+hash.slice(8,12)+'-5'+hash.slice(13,16)+'-a'+hash.slice(17,20)+'-'+hash.slice(20,32)
}
