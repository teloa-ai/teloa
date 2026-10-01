import {WorkError} from './work-error.ts'

/** lark 为飞书国际版（open.larksuite.com）：与 feishu 共用同一适配器，只按种类切换官方域名常量；两者应用、账号、租户互不相通，可同时启用。 */
export const imChannelKinds=['feishu','lark','telegram','slack'] as const
/** 验收桩渠道：契约层认得，宿主只在浏览器验收环境（TELOA_BROWSER_ACCEPTANCE=1 且设 TELOA_IM_STUB_PORT）接受，正式环境一律拒绝。 */
export const imStubChannelKind='stub'
export type ImChannelKind=typeof imChannelKinds[number]|typeof imStubChannelKind
/** 一期一渠道一实例：channelId 恒等于 kind；字段保留以便团队版多实例不改结构。 */
/** 渠道状态错误码（审查 L4）：宿主只回码，前端按码本地化，不透出适配器或平台原文。app-id-unsupported：App ID 能保存，但飞书 SDK 长连接只接受 cli_+16 位十六进制。 */
export const imChannelErrorCodes=['app-id-unsupported','another-host','credentials-invalid','credentials-missing','reconnecting','sdk-missing','sdk-install-failed','start-failed','unknown'] as const
export type ImChannelErrorCode=typeof imChannelErrorCodes[number]
export type ImChannelStatus={connected:boolean;lastEventAt?:string;error?:ImChannelErrorCode}
export type ImDefaultTarget={kind:'assistant'}|{kind:'role';roleId:string}
export type ImChannelSummary={channelId:string;kind:ImChannelKind;label:string;enabled:boolean;credentialsSaved:boolean;status:ImChannelStatus;bindings:number;groups:number}
export type ImBindingSummary={channelId:string;imUserId:string;displayName:string;boundAt:string;target:ImDefaultTarget}
export type ImGroupBindingSummary={channelId:string;chatId:string;groupId:string;boundAt:string}
export type ImPairingCode={code:string;expiresAt:string}

/** 每渠道允许的凭据 env 键（POSIX 标识符）；FEISHU_ENCRYPT_KEY、LARK_ENCRYPT_KEY 可选。没有域名字段：Lark 的域名由种类决定，不由用户填写。 */
export const imCredentialFields:Readonly<Record<ImChannelKind,readonly {key:string;required:boolean}[]>>={
 feishu:[{key:'FEISHU_APP_ID',required:true},{key:'FEISHU_APP_SECRET',required:true},{key:'FEISHU_ENCRYPT_KEY',required:false}],
 lark:[{key:'LARK_APP_ID',required:true},{key:'LARK_APP_SECRET',required:true},{key:'LARK_ENCRYPT_KEY',required:false}],
 telegram:[{key:'TELEGRAM_BOT_TOKEN',required:true}],
 slack:[{key:'SLACK_BOT_TOKEN',required:true},{key:'SLACK_APP_TOKEN',required:true}],
 stub:[{key:'STUB_TOKEN',required:true}],
}

export const imChannelEndpoints=['im/channels/list','im/channels/save','im/channels/enable','im/channels/disable','im/channels/remove','im/pairing/create','im/bindings/list','im/bindings/remove','im/bindings/change','im/groups/list','im/groups/bind','im/groups/unbind'] as const
export const imChannelWriteEndpoints=['im/channels/save','im/channels/enable','im/channels/disable','im/channels/remove','im/pairing/create','im/bindings/remove','im/bindings/change','im/groups/bind','im/groups/unbind'] as const

export const imCredentialValueMaxChars=512
export const imIdentifierMaxChars=128

const fail=():never=>{throw new WorkError('teloa/invalid-input','IM 通道请求包含未知字段或格式不正确。')}
const record=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v)
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{
 if(!record(value)||Object.keys(value).some(key=>!keys.includes(key)))fail()
 return value as Record<string,unknown>
}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const stamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))
const kind=(value:unknown):value is ImChannelKind=>value===imStubChannelKind||(imChannelKinds as readonly unknown[]).includes(value)
/** 凭据值：1..512 字符，不含任何空白（含换行、制表）与控制／格式字符（NUL、零宽等）。 */
const credentialValue=(value:unknown):value is string=>typeof value==='string'&&value.length<=imCredentialValueMaxChars&&/^[^\s\p{C}]+$/u.test(value)
/** IM 侧标识（imUserId／chatId）：1..128 可见字符，不含空白与控制字符。 */
const identifier=(value:unknown):value is string=>typeof value==='string'&&value.length<=imIdentifierMaxChars&&/^[^\s\p{C}]+$/u.test(value)
/** 一期写侧 channelId 只认 kind 值（一渠道一实例）；团队版多实例时再放开为标识校验。 */
const requestHead=(row:Record<string,unknown>):{requestId:string;channelId:string}=>{
 if(!uuid(row.requestId)||!kind(row.channelId))fail()
 return {requestId:row.requestId as string,channelId:row.channelId as string}
}

/** 保存渠道凭据：channelId===kind；credentials 键 ⊆ imCredentialFields[kind]，必填齐全，值过 credentialValue。 */
export function imChannelSaveInput(v:unknown):{requestId:string;channelId:string;kind:ImChannelKind;credentials:Record<string,string>}{
 const row=exact(v,['requestId','channelId','kind','credentials'])
 const head=requestHead(row)
 if(!kind(row.kind)||row.kind!==head.channelId)fail()
 const channelKind=row.kind as ImChannelKind
 const fields=imCredentialFields[channelKind]
 const credentials=exact(row.credentials,fields.map(field=>field.key))
 if(fields.some(field=>field.required&&!(field.key in credentials)))fail()
 if(Object.values(credentials).some(value=>!credentialValue(value)))fail()
 return {...head,kind:channelKind,credentials:credentials as Record<string,string>}
}

/** enable／disable／remove／pairing-create 共用：恰好 requestId+channelId 两键。 */
export function imChannelIdInput(v:unknown):{requestId:string;channelId:string}{
 return requestHead(exact(v,['requestId','channelId']))
}

export function imBindingRemoveInput(v:unknown):{requestId:string;channelId:string;imUserId:string}{
 const row=exact(v,['requestId','channelId','imUserId'])
 if(!identifier(row.imUserId))fail()
 return {...requestHead(row),imUserId:row.imUserId as string}
}

const defaultTarget=(value:unknown):ImDefaultTarget=>{
 if(!record(value))fail()
 const target=value as Record<string,unknown>
 if(target.kind==='assistant'){exact(target,['kind']);return {kind:'assistant'}}
 if(target.kind==='role'){
  const row=exact(target,['kind','roleId'])
  if(!uuid(row.roleId))fail()
  return {kind:'role',roleId:row.roleId as string}
 }
 return fail()
}

export function imBindingChangeInput(v:unknown):{requestId:string;channelId:string;imUserId:string;target:ImDefaultTarget}{
 const row=exact(v,['requestId','channelId','imUserId','target'])
 if(!identifier(row.imUserId))fail()
 return {...requestHead(row),imUserId:row.imUserId as string,target:defaultTarget(row.target)}
}

export function imGroupBindInput(v:unknown):{requestId:string;channelId:string;chatId:string;groupId:string}{
 const row=exact(v,['requestId','channelId','chatId','groupId'])
 if(!identifier(row.chatId)||!uuid(row.groupId))fail()
 return {...requestHead(row),chatId:row.chatId as string,groupId:row.groupId as string}
}

export function imGroupUnbindInput(v:unknown):{requestId:string;channelId:string;chatId:string}{
 const row=exact(v,['requestId','channelId','chatId'])
 if(!identifier(row.chatId))fail()
 return {...requestHead(row),chatId:row.chatId as string}
}

/** 读侧防回显：回包任何层级（含数组元素）出现以 TOKEN／SECRET／KEY 结尾的键即视为凭据泄露，不看值直接拒收。 */
const secretKey=/(token|secret|key)$/i
export function rejectSecretKeys(value:unknown):void{
 if(Array.isArray(value)){for(const child of value)rejectSecretKeys(child);return}
 if(!record(value))return
 for(const [key,child] of Object.entries(value)){
  if(secretKey.test(key))fail()
  rejectSecretKeys(child)
 }
}
const nonNegativeInt=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>=0

/** 客户端读侧严格校验：多字段、缺字段、类型错误、凭据键回显 → throw。 */
export function readImChannelSummary(v:unknown):ImChannelSummary{
 rejectSecretKeys(v)
 const row=exact(v,['channelId','kind','label','enabled','credentialsSaved','status','bindings','groups'])
 if(!kind(row.kind)||!identifier(row.channelId))fail()
 if(typeof row.label!=='string'||!row.label||row.label.length>imIdentifierMaxChars)fail()
 if(typeof row.enabled!=='boolean'||typeof row.credentialsSaved!=='boolean')fail()
 if(!nonNegativeInt(row.bindings)||!nonNegativeInt(row.groups))fail()
 const statusRow=exact(row.status,['connected','lastEventAt','error'])
 if(typeof statusRow.connected!=='boolean')fail()
 if('lastEventAt' in statusRow&&!stamp(statusRow.lastEventAt))fail()
 if('error' in statusRow&&!imChannelErrorCodes.includes(statusRow.error as ImChannelErrorCode))fail()
 const status:ImChannelStatus={connected:statusRow.connected as boolean}
 if('lastEventAt' in statusRow)status.lastEventAt=statusRow.lastEventAt as string
 if('error' in statusRow)status.error=statusRow.error as ImChannelErrorCode
 return {channelId:row.channelId as string,kind:row.kind as ImChannelKind,label:row.label as string,enabled:row.enabled as boolean,credentialsSaved:row.credentialsSaved as boolean,status,bindings:row.bindings as number,groups:row.groups as number}
}
