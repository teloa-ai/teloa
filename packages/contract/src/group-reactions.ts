import {WorkError} from './work-error.ts'

export const groupReactionEmojis=['👍','👎','✅','❌','👀','🎉','❤️','🙏','🤔','🚀','⚠️','📌'] as const
export type GroupReactionEmoji=typeof groupReactionEmojis[number]
export type GroupReactionActorKind='self'|'role'
/** 恰 2 键。self 时 actorId 恒为 'self'；role 时 actorId 是 uuid。 */
export type GroupReactionActor={actorKind:GroupReactionActorKind;actorId:string}
/** 恰 5 键。 */
export type GroupReaction={messageId:string;emoji:GroupReactionEmoji;actorKind:GroupReactionActorKind;actorId:string;createdAt:string}
/** 恰 5 键。count 是真数，actors 超 64 位时截断，故 count>=actors.length。 */
export type GroupReactionSummary={messageId:string;emoji:GroupReactionEmoji;count:number;mine:boolean;actors:GroupReactionActor[]}
/** 恰 2 键。 */
export type GroupReactionListInput={groupId:string;messageIds:string[]}
/** 恰 4 键。 */
export type GroupReactionToggleInput={requestId:string;groupId:string;messageId:string;emoji:GroupReactionEmoji}
/** 恰 2 键。 */
export type GroupReactionToggleResult={messageId:string;items:GroupReactionSummary[]}

export const groupReactionMessageIdsMax=200
export const groupReactionActorsMax=64

const fail=():never=>{throw new WorkError('teloa/invalid-input','群表情回应请求包含未知字段或格式不正确。')}
const record=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v)
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{
  if(!record(value)||Object.keys(value).some(key=>!keys.includes(key)))fail()
  return value as Record<string,unknown>
}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const stamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))

export function isGroupReactionEmoji(value:unknown):value is GroupReactionEmoji{
  return (groupReactionEmojis as readonly string[]).includes(value as string)
}

export function isGroupReactionActor(value:unknown):value is GroupReactionActor{
 if(!record(value)||Object.keys(value).length!==2)return false
 if(value.actorKind==='self')return value.actorId==='self'
 return value.actorKind==='role'&&uuid(value.actorId)
}

export function isGroupReaction(value:unknown):value is GroupReaction{
  if(!record(value)||Object.keys(value).length!==5)return false
  if(!uuid(value.messageId)||!isGroupReactionEmoji(value.emoji))return false
  if(!isGroupReactionActor({actorKind:value.actorKind,actorId:value.actorId}))return false
  return stamp(value.createdAt)
}

export function isGroupReactionSummary(value:unknown):value is GroupReactionSummary{
 if(!record(value)||Object.keys(value).length!==5)return false
 if(!uuid(value.messageId)||!isGroupReactionEmoji(value.emoji))return false
 if(!Number.isSafeInteger(value.count)||(value.count as number)<1||typeof value.mine!=='boolean')return false
 const actors=value.actors
 if(!Array.isArray(actors)||actors.length>groupReactionActorsMax||!actors.every(isGroupReactionActor))return false
 if(new Set(actors.map(a=>a.actorKind+'\0'+a.actorId)).size!==actors.length)return false
 // actors 超 64 位时截断，count 仍是真数，因此只能单向大于等于。
 return (value.count as number)>=actors.length
}

export function groupReactionListInput(value:unknown):GroupReactionListInput{
  const row=exact(value,['groupId','messageIds'])
  if(!uuid(row.groupId))fail()
  const messageIds=row.messageIds
  if(!Array.isArray(messageIds)||messageIds.length<1||messageIds.length>groupReactionMessageIdsMax||!messageIds.every(uuid)||new Set(messageIds).size!==messageIds.length)fail()
  return {groupId:row.groupId as string,messageIds:(messageIds as string[]).slice()}
}

export function groupReactionToggleInput(value:unknown):GroupReactionToggleInput{
  const row=exact(value,['requestId','groupId','messageId','emoji'])
  if(!uuid(row.requestId)||!uuid(row.groupId)||!uuid(row.messageId)||!isGroupReactionEmoji(row.emoji))fail()
  return {requestId:row.requestId as string,groupId:row.groupId as string,messageId:row.messageId as string,emoji:row.emoji as GroupReactionEmoji}
}
