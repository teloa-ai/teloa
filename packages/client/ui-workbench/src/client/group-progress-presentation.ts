import type {GroupMessagePhase,GroupRoutingStatusView} from '@teloa/contract'

/**
 * 群消息处理状态的呈现分层（N46）。只读服务端 GroupRoutingStatusView 投影，不推断、不计时：
 * - active：真实排队/运行/交付/停止中，只在输入框附近聚合成一行动态状态，不逐条堆在历史消息下；
 * - attention：需要本人知道或处理（授权、核对、失败、未知提交、暂停、停止），留在原消息下可读；
 * - quiet：已完成/已记录，回帖本身就是结果，原消息下最多留一个「查看工作」图标。
 */
export type GroupStatusTone='active'|'attention'|'quiet'
const tones:Record<GroupMessagePhase,GroupStatusTone>={
 received:'active',routing:'active',queued:'active',running:'active',delivering:'active',stopping:'active',
 completed:'quiet',recorded:'quiet',
 'awaiting-approval':'attention','awaiting-review':'attention','publication-blocked':'attention','routing-failed':'attention',unavailable:'attention',blocked:'attention',unknown:'attention',paused:'attention',stopped:'attention',
}
export const groupStatusTone=(phase:GroupMessagePhase):GroupStatusTone=>tones[phase]

/** 聚合行按真实阶段分类；排队前后仅显示动态点，运行才是「正在处理」；没有逐 token 信号，不称「正在输入」。 */
export type GroupProgressBucket='routing'|'running'|'delivering'|'stopping'
const bucketOf=(phase:GroupMessagePhase):GroupProgressBucket|null=>phase==='received'||phase==='routing'||phase==='queued'?'routing':phase==='running'||phase==='delivering'||phase==='stopping'?phase:null
const bucketRank:Record<GroupProgressBucket,number>={running:3,delivering:2,stopping:1,routing:0}

export type GroupStatusRecipientRow={roleId:string;name:string;phase:GroupMessagePhase;taskId:string|null}
export type GroupMessageStatusPresentation={
 tone:GroupStatusTone
 /** 原消息下的阶段文案；active 由聚合行承担，completed 回帖即结果，二者都不重复。 */
 phase:GroupMessagePhase|null
 hintCode:GroupRoutingStatusView['hintCode']
 /** 需要逐位知道的接收者：只列 attention 阶段，避免把进行中/已完成的人逐个铺开。 */
 recipients:GroupStatusRecipientRow[]
 /** 不在 recipients 行内的原工作入口，按原 taskId 去重，保留各自归属的员工名。 */
 tasks:{taskId:string;name:string}[]
 canRetry:boolean
}

export function groupMessageStatusPresentation(status:GroupRoutingStatusView,archived:boolean):GroupMessageStatusPresentation{
 const tone=groupStatusTone(status.phase)
 const recipients=status.recipients.filter(item=>groupStatusTone(item.phase)==='attention'&&(item.phase!==status.phase||status.recipients.length>1)).map(({roleId,name,phase,taskId})=>({roleId,name,phase,taskId}))
 const listed=new Set(recipients.flatMap(item=>item.taskId?[item.taskId]:[])),tasks:{taskId:string;name:string}[]=[]
 for(const item of status.recipients)if(item.taskId&&!listed.has(item.taskId)){listed.add(item.taskId);tasks.push({taskId:item.taskId,name:item.name})}
 // 交付中的「结果正在贴回」由聚合行的「正在交付结果」表达；其余提示码都是真实原因，照常可读。
 const hintCode=tone==='active'&&status.hintCode==='result-pending'?null:status.hintCode
 return {tone,phase:tone==='attention'?status.phase:null,hintCode,recipients,tasks,canRetry:status.canRetry&&!archived}
}

export type GroupProgressPerson={roleId:string;name:string}
export type GroupProgressPresentation={bucket:GroupProgressBucket;mode:'reply'|'work'|null;people:GroupProgressPerson[];more:number}

/**
 * 当前会话的聚合进行中状态。`statuses` 按会话中消息先后排列且只含本会话的本人消息；
 * 最近的消息优先取人，最多前两位，其余只计数。尚未分配接收者的 active 消息也保留动态点；
 * 没有 active 消息或接收者时返回 null，所以终态（完成、记录、失败、停止……）一到即退出动态显示。
 */
export function groupProgressPresentation(statuses:readonly GroupRoutingStatusView[]):GroupProgressPresentation|null{
 let bucket:GroupProgressBucket|null=null
 const entries:{bucket:GroupProgressBucket;mode:'reply'|'work'|null;person:GroupProgressPerson|null}[]=[]
 const take=(next:GroupProgressBucket)=>{if(bucket===null||bucketRank[next]>bucketRank[bucket])bucket=next}
 for(const status of [...statuses].reverse()){
  // 尚无接收者的 active 消息仍参与聚合，只显示动态点，不猜测员工身份。
  if(status.recipients.length===0){const own=bucketOf(status.phase);if(own){take(own);entries.push({bucket:own,mode:null,person:null})}continue}
  for(const item of status.recipients){
   const own=bucketOf(item.phase)
   if(!own)continue
   take(own)
   entries.push({bucket:own,mode:item.executionMode,person:{roleId:item.roleId,name:item.name}})
  }
 }
 if(bucket===null)return null
 const active=entries.filter(item=>item.bucket===bucket),seen=new Map<string,GroupProgressPerson>()
 for(const item of active)if(item.person&&!seen.has(item.person.roleId))seen.set(item.person.roleId,item.person)
 const people=[...seen.values()],modes=new Set(active.map(item=>item.mode)),mode=modes.size===1?active[0]?.mode??null:null
 return {bucket,mode,people:people.slice(0,2),more:Math.max(0,people.length-2)}
}
