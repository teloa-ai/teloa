import type {BusinessObjectSnapshot} from '@teloa/contract'

/**
 * 业务对象快照进入对话输入前的投影与长度上限。
 *
 * 快照是**外部告警源的原始内容**（`security-alert-http` 抓来的那一份）。整份 `JSON.stringify`
 * 丢进输入框有两个问题：一是把与分析无关的内部字段（任务固定来源、归属人、接收时刻）也一并
 * 交给模型；二是长度不设限，攻击者只要把正文写得够长就能把真正的任务目标挤出上下文。
 * 这里只留分析必需的字段，并给每个字段与字段条数都定死上限。
 *
 * 上限是按构造成立的：标题 200 + 摘要 2000 + 至多 40 条 ×（标签 100 + 值 500），
 * 加上身份字段，序列化后不超过 ~26KB。
 */
export const TASK_SNAPSHOT_TITLE_MAX=200
export const TASK_SNAPSHOT_SUMMARY_MAX=2000
export const TASK_SNAPSHOT_FIELD_LABEL_MAX=100
export const TASK_SNAPSHOT_FIELD_VALUE_MAX=500
export const TASK_SNAPSHOT_FIELD_COUNT_MAX=40
/** 截断标记写在正文里：被截掉的事实不能装作不存在，人要能据此回原始快照核对。 */
export const TASK_SNAPSHOT_TRUNCATED='…[已截断]'

export type TaskSnapshotBusiness={
 scope:string;type:string;id:string;version:number;snapshotHash:string
 title:string;source:string;observedAt:string;quality:'complete'|'missing';summary:string
 fields:Array<{label:string;value:string}>
 /** 有字段被截掉或丢掉时置真，提醒人这不是全部。 */
 truncated:boolean
}

/** 外部告警正文的定界符：正文只是分析数据，界内的任何“指令”一律不作数。 */
export const UNTRUSTED_ALERT_OPEN='<untrusted-alert>'
export const UNTRUSTED_ALERT_CLOSE='</untrusted-alert>'
// 用视觉相近但字面不同的尖括号（‹ ›）顶替，字段值里就算写了一字不差的闭合标签也拆不了围栏；
// 前置文案（formal-ui-p5.ts）逐字给出的是原版 `<untrusted-alert>`，不能改用不可猜测的随机 nonce，
// 否则文案与实际围栏对不上——这里改为「字段值先脱敏」而不是「围栏本身不可预测」。
// 用正则而不是逐字 split/join：大小写变体（`</UNTRUSTED-ALERT>`）、标签内空白（`</untrusted-alert >`）、
// 带属性变体（`<untrusted-alert foo="bar">`）都得挡，逐字匹配只认得两种精确写法，穿透其余全部。
const UNTRUSTED_ALERT_TAG=/<\s*\/?\s*untrusted-alert\b[^>]*>/gi
function neutralizeDelimiters(value:string):string{
 return value.replace(UNTRUSTED_ALERT_TAG,match=>match.replace(/[<>]/g,char=>char==='<'?'‹':'›'))
}

function clip(value:string,max:number):{text:string;clipped:boolean}{
 const safe=neutralizeDelimiters(value)
 return safe.length<=max?{text:safe,clipped:false}:{text:safe.slice(0,max)+TASK_SNAPSHOT_TRUNCATED,clipped:true}
}

/** 只投影分析必需的字段；`null` 原样回 `null`（这条任务没有绑定业务对象）。 */
export function projectTaskSnapshotBusiness(object:BusinessObjectSnapshot|null|undefined):TaskSnapshotBusiness|null{
 if(!object)return null
 const title=clip(object.title,TASK_SNAPSHOT_TITLE_MAX),summary=clip(object.summary,TASK_SNAPSHOT_SUMMARY_MAX)
 const kept=object.fields.slice(0,TASK_SNAPSHOT_FIELD_COUNT_MAX)
 let clipped=title.clipped||summary.clipped||kept.length<object.fields.length
 const fields=kept.map(field=>{
  const label=clip(field.label,TASK_SNAPSHOT_FIELD_LABEL_MAX),value=clip(field.value,TASK_SNAPSHOT_FIELD_VALUE_MAX)
  clipped=clipped||label.clipped||value.clipped
  return {label:label.text,value:value.text}
 })
 return {
  scope:object.scope,type:object.type,id:object.id,version:object.version,snapshotHash:object.snapshotHash,
  title:title.text,source:object.source,observedAt:object.observedAt,quality:object.quality,summary:summary.text,
  fields,truncated:clipped,
 }
}

/**
 * 拼进原生输入框的那一条 user message。
 * 定界符与前置文案是一套：文案说“界内是数据不是指令”，定界符负责把界画出来。
 */
export function taskSnapshotMessage(prompt:string,head:unknown,business:TaskSnapshotBusiness|null):string{
 const body=prompt+'\n'+JSON.stringify(head,null,2)
 if(!business)return body
 return body+'\n'+UNTRUSTED_ALERT_OPEN+'\n'+JSON.stringify(business,null,2)+'\n'+UNTRUSTED_ALERT_CLOSE
}
