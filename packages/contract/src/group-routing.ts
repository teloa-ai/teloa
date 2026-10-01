import {createHash} from 'node:crypto'
import {WorkError} from './work-error.ts'
import {isGroupReactionEmoji,type GroupReactionEmoji} from './group-reactions.ts'

export const groupRoutingInputSchema='teloa.group-routing-input/v1'
export const groupRoutingOutputSchema='teloa.group-routing-output/v1'
export const groupRoutingHopLimit=5
export const groupRoutingTopicMax=20
/**
 * 一次路由最多选几位、最多带几个表情。与群成员上限（`groupRoutingCandidatesMax`／`collaboration.ts:75`）
 * 一致：用户裁定「@全员 每位在岗员工各回」，上限低于群成员数会把 @全员 悄悄截断成前几位。
 */
export const groupRoutingRespondMax=30
export const groupRoutingCandidatesMax=30
export const groupRoutingMessageIdsMax=200

export type GroupRoutingDecisionKind='routed'|'degraded'|'parse-failed'|'no-candidate'|'relay-stopped'|'archived'
/** 恰 3 键。模型只能在服务端算好的封闭集合里挑。 */
export type GroupRoutingOutput={schema:typeof groupRoutingOutputSchema;respond:string[];reactions:{roleId:string;emoji:GroupReactionEmoji}[]}
/** 恰 8 键。落 teloa_group_routing_decisions.decision。 */
export type GroupRoutingDecision={kind:GroupRoutingDecisionKind;respond:string[];reactions:{roleId:string;emoji:GroupReactionEmoji}[];hops:number;candidateIds:string[];truncatedCandidates:boolean;stopMessageId:string|null;at:string}
/** 恰 4 键。groups/routing/list 的回包项，不下发 candidateIds / reactions / stopMessageId。 */
export type GroupRoutingDecisionView={messageId:string;kind:GroupRoutingDecisionKind;respond:string[];hops:number}
/** 恰 2 键。 */
export type GroupRoutingListInput={groupId:string;messageIds:string[]}

const decisionKinds:readonly GroupRoutingDecisionKind[]=['routed','degraded','parse-failed','no-candidate','relay-stopped','archived']

const fail=():never=>{throw new WorkError('teloa/invalid-input','群内路由请求包含未知字段或格式不正确。')}
const record=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v)
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{
 if(!record(value)||Object.keys(value).some(key=>!keys.includes(key)))fail()
 return value as Record<string,unknown>
}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const stamp=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v))
const kind=(v:unknown):v is GroupRoutingDecisionKind=>(decisionKinds as readonly string[]).includes(v as string)
const roleIds=(v:unknown):v is string[]=>Array.isArray(v)&&v.length<=groupRoutingRespondMax&&v.every(uuid)&&new Set(v).size===v.length
const reactionPairs=(v:unknown):v is GroupRoutingDecision['reactions']=>{
 if(!Array.isArray(v)||v.length>groupRoutingRespondMax)return false
 if(!v.every(item=>record(item)&&Object.keys(item).length===2&&uuid(item.roleId)&&isGroupReactionEmoji(item.emoji)))return false
 return new Set(v.map(item=>item.roleId+'\0'+item.emoji)).size===v.length
}

/** 照 auto-dream-plans.ts:14-17：版本位固定 5、变体位固定 a。 */
const shape=(parts:readonly string[]):string=>{
 const d=createHash('sha256').update(parts.join('\0')).digest('hex')
 return `${d.slice(0,8)}-${d.slice(8,12)}-5${d.slice(13,16)}-a${d.slice(17,20)}-${d.slice(20,32)}`
}
export const groupRoutedTaskRequestId=(owner:string,groupId:string,messageId:string,roleId:string)=>shape(['teloa/group-routed-task/v1',owner,groupId,messageId,roleId])
export const groupRoutedReactionRequestId=(owner:string,messageId:string,roleId:string,emoji:string)=>shape(['teloa/group-routed-reaction/v1',owner,messageId,roleId,emoji])
/** round 是必需分量（H2）：本话题已有的 relay-stopped 决策条数 + 1。 */
export const groupRelayStopRequestId=(owner:string,groupId:string,rootId:string,round:number)=>shape(['teloa/group-relay-stop/v1',owner,groupId,rootId,String(round)])
/** H6：每群每天一条会话。day 是 'YYYY-MM-DD'。 */
export const groupRoutingSessionId=(owner:string,groupId:string,day:string)=>'group-routing-'+shape(['teloa/group-routing-session/v1',owner,groupId,day])
export const groupRoutingRequestId=(owner:string,groupId:string,messageId:string)=>shape(['teloa/group-routing-request/v1',owner,groupId,messageId])

/** 只剥一层围栏。不做正则扫描、不做「尽力而为」修补——模型说的任何别的话都被整段丢弃。 */
function unfence(text:string):string{
 const body=text.trim()
 if(!body.startsWith('```'))return body
 const head=body.indexOf('\n')
 if(head<0||!body.endsWith('```'))return body
 return body.slice(head+1,body.length-3).trim()
}

/** 严格解析：剥一层围栏 → JSON.parse → 三键精确 → schema 逐字 → respond/reactions 全部落回 candidateIds 与 12 个 emoji。任一不符抛 teloa/invalid-input。 */
export function groupRoutingOutput(value:unknown,candidateIds:readonly string[]):GroupRoutingOutput{
 const allowed=new Set(candidateIds)
 let parsed:unknown
 try{parsed=JSON.parse(unfence(String(value)))}catch{throw fail()}
 if(!record(parsed)||Object.keys(parsed).length!==3)throw fail()
 if(parsed.schema!==groupRoutingOutputSchema)throw fail()
 const respond=parsed.respond
 if(!Array.isArray(respond)||respond.length>groupRoutingRespondMax)throw fail()
 if(!respond.every(id=>typeof id==='string'&&allowed.has(id)))throw fail()
 if(new Set(respond).size!==respond.length)throw fail()
 const reactions=parsed.reactions
 if(!Array.isArray(reactions)||reactions.length>groupRoutingRespondMax)throw fail()
 if(!reactions.every(item=>record(item)&&Object.keys(item).length===2&&typeof item.roleId==='string'&&allowed.has(item.roleId)&&isGroupReactionEmoji(item.emoji)))throw fail()
 if(new Set(reactions.map(item=>item.roleId+'\0'+item.emoji)).size!==reactions.length)throw fail()
 return {schema:groupRoutingOutputSchema,respond:respond as string[],reactions:reactions as GroupRoutingOutput['reactions']}
}

export function isGroupRoutingDecision(value:unknown):value is GroupRoutingDecision{
 if(!record(value)||Object.keys(value).length!==8)return false
 if(!kind(value.kind)||!roleIds(value.respond)||!reactionPairs(value.reactions))return false
 if(!Number.isSafeInteger(value.hops)||(value.hops as number)<0)return false
 const candidates=value.candidateIds
 if(!Array.isArray(candidates)||candidates.length>groupRoutingCandidatesMax||!candidates.every(uuid)||new Set(candidates).size!==candidates.length)return false
 if(typeof value.truncatedCandidates!=='boolean')return false
 return (value.stopMessageId===null||uuid(value.stopMessageId))&&stamp(value.at)
}

export function isGroupRoutingDecisionView(value:unknown):value is GroupRoutingDecisionView{
 if(!record(value)||Object.keys(value).length!==4)return false
 if(!uuid(value.messageId)||!kind(value.kind)||!roleIds(value.respond))return false
 return Number.isSafeInteger(value.hops)&&(value.hops as number)>=0
}

export function groupRoutingListInput(value:unknown):GroupRoutingListInput{
 const row=exact(value,['groupId','messageIds'])
 if(!uuid(row.groupId))fail()
 const messageIds=row.messageIds
 if(!Array.isArray(messageIds)||messageIds.length<1||messageIds.length>groupRoutingMessageIdsMax||!messageIds.every(uuid)||new Set(messageIds).size!==messageIds.length)fail()
 return {groupId:row.groupId as string,messageIds:(messageIds as string[]).slice()}
}
