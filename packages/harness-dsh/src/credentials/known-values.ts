import type {CredentialRecord} from '@deepseek-ai/dsh-credentials'
import {encodedForms,minKnownSecretLength,skillSecretBindingSlot} from '@teloa/contract'

/** 已存凭据中的秘密值（贴密钥闸、守卫、脱敏共用）。日期、client_id、公钥与元数据不收，避免误伤。最小长度与比对统一取 minKnownSecretLength（8）。 */
const mcpNonSecretSlots=new Set(['oauth_token_expiry','oauth_client_info','oauth_as_metadata','oauth_client_id','oauth_token_client_id'])
/** 受管 MCP Basic 鉴权槽前缀（managed-mcp-connections.ts 派生：basic_user_<serverName>、basic_pass_<serverName>）。 */
const basicUserSlotPrefix='basic_user_',basicPassSlotPrefix='basic_pass_'
const secretSegment=/^(?:token|tokens|secret|secrets|password|passwd|pwd|cookie|cookies|session|key|keys|apikey|credential|credentials|passphrase|auth)$/
/** 字段名按 camelCase、`_`、`-`、`.` 分段后逐段比对：`monkey`、`keyboard` 不收，含 `public` 段（`publicKey`）也不收。 */
export function isSecretField(field:string):boolean{
 const segments=field.replace(/([a-z0-9])([A-Z])/g,'$1_$2').toLowerCase().split(/[_\-.\s]+/).filter(Boolean)
 return !segments.includes('public')&&segments.some(segment=>secretSegment.test(segment))
}
const long=(value:unknown):value is string=>typeof value==='string'&&value.length>=minKnownSecretLength
export function secretValuesOf(key:string,record:CredentialRecord):string[]{
 // 只有技能密钥记录（teloa-skill/*、共享密钥组 teloa-skill-group/*）里形如 sha256 十六进制的指纹槽才不算已存值；其他记录或非指纹取值仍按已存值保护。
 if(record.kind==='api-key')return [record.key,...Object.entries(record.env??{}).filter(([slot,value])=>!(slot===skillSecretBindingSlot&&(key.startsWith('teloa-skill/')||key.startsWith('teloa-skill-group/'))&&typeof value==='string'&&/^[0-9a-f]{64}$/.test(value))).map(([,value])=>value)].filter(long)
 const out:string[]=[]
 const payload=record.payload
 if(key.startsWith('teloa-managed-mcp/')&&payload&&typeof payload==='object'&&!Array.isArray(payload)){
  const slots=payload as Record<string,unknown>
  for(const [slot,value] of Object.entries(slots)){
   if(slot.startsWith(basicUserSlotPrefix)){
    // 设计约束：Basic 用户名（常为邮箱）本身不收，仍随记录加密存储。审查修复 M-1：线上发出的是 base64(用户名:密码)，
    // 密码只有在「用户名:」字节数恰为 3 的倍数时才与合成值对齐，故另收合成值及其常见编码形态（脱敏与贴密钥闸都按已存值比对）。
    const pass=slots[basicPassSlotPrefix+slot.slice(basicUserSlotPrefix.length)]
    if(typeof value==='string'&&typeof pass==='string'&&pass){
     const pair=`${value}:${pass}`,wire=Buffer.from(pair,'utf8').toString('base64')
     out.push(...new Set([...encodedForms(pair),...encodedForms(wire)]))
    }
    continue
   }
   if(long(value)&&!mcpNonSecretSlots.has(slot))out.push(value)
  }
  return out
 }
 const visit=(value:unknown,field:string):void=>{
  if(typeof value==='string'){if(long(value)&&isSecretField(field))out.push(value);return}
  if(Array.isArray(value)){for(const item of value)visit(item,field);return}
  if(value&&typeof value==='object')for(const [name,item] of Object.entries(value))visit(item,name)
 }
 visit(payload,'')
 return out
}
/** 从 ctx.credentials 取已存值；不是 Teloa 提供方即抛错，由调用方按失败关闭处理。 */
export function knownSecretValues(provider:unknown):readonly string[]{
 const source=provider as {secretValues?:()=>readonly string[]}|undefined
 if(typeof source?.secretValues!=='function')throw new Error('credential provider does not expose secret values')
 return source.secretValues()
}
