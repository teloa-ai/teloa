import type {ReactNode} from 'react'

export type TimelineEventKind='run'|'approval'|'artifact'|'completion'|'handoff'|'source'|'knowledge'|'change'|'attention'|'trigger'|'skip'|'revision'
/** 恰 10 键（可选键可缺省）。at 是 ISO 时间；pending 事件不合并，运行与结项表单按需展开；anchor 供状态框主按钮定位。 */
export type TimelineEvent={id:string;kind:TimelineEventKind;at:string;title:string;meta?:string;detail?:ReactNode;actions?:ReactNode;foldKey?:string;pending?:boolean;anchor?:string}
export type TimelineEntry={kind:'event';event:TimelineEvent}|{kind:'fold';foldKey:string;eventKind:TimelineEventKind;events:TimelineEvent[];at:string}

/** 倒序：at 降序；同 at 按 id 升序；稳定。 */
export function sortTimeline(events:readonly TimelineEvent[]):TimelineEvent[]{
 return [...events].sort((a,b)=>a.at===b.at?(a.id<b.id?-1:a.id>b.id?1:0):a.at<b.at?1:-1)
}

/** 先 sortTimeline，再把**相邻**且 foldKey 相同的事件折成一条（长度 >= minFold 才折；pending 事件打断折叠且自身不进折叠）。fold.at 取组内最新的 at。 */
export function foldTimeline(events:readonly TimelineEvent[],minFold=2):TimelineEntry[]{
 const sorted=sortTimeline(events),entries:TimelineEntry[]=[]
 let group:TimelineEvent[]=[]
 const flush=()=>{
  if(group.length===0)return
  const first=group[0]!
  if(group.length>=minFold&&first.foldKey)entries.push({kind:'fold',foldKey:first.foldKey,eventKind:first.kind,events:group,at:first.at})
  else for(const event of group)entries.push({kind:'event',event})
  group=[]
 }
 for(const event of sorted){
  if(event.pending||!event.foldKey){flush();entries.push({kind:'event',event});continue}
  if(group.length>0&&group[0]!.foldKey!==event.foldKey)flush()
  group.push(event)
 }
 flush()
 return entries
}
