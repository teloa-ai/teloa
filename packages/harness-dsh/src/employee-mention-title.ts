import {encodeEmployeeMention,singleEmployeeMention} from '@teloa/contract'

type Event={readonly seq:number;readonly type:string;readonly data:unknown}
type Row=Record<string,unknown>
const row=(value:unknown):Row|undefined=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Row:undefined
const data=(event:Event)=>row(event.data)
const source=(event:Event)=>row(data(event)?.source)
const ownerMessage=(event:Event)=>event.type==='user/message'&&source(event)?.kind==='user'
const text=(event:Event)=>{
 const content=data(event)?.content
 return Array.isArray(content)?content.flatMap(block=>{const item=row(block);return item?.type==='text'&&typeof item.text==='string'?[item.text]:[]}).join(' '):''
}

/** 官方 name 是补丁命中守卫；用正常 disable + insert 保留原行语义，不能把 name 当重命名。 */
export function employeeMentionTitlePatches(rows:readonly unknown[]):Record<string,unknown>[]{
 const sourceId='session-title-llm',sourceName='@deepseek-ai/dsh-session-title-first-prompt-llm'
 const targetId='teloa-employee-title',targetName='@teloa/harness-dsh/employee-mention-title'
 const entries:{entry:Row;parent:string|undefined}[]=[],ids=new Map<string,number>()
 const visit=(list:readonly unknown[],parent:string|undefined)=>{
  for(const value of list){
   const entry=row(value)
   if(!entry)throw Error('员工标题组合行格式无效。')
   if(typeof entry.id==='string')ids.set(entry.id,(ids.get(entry.id)??0)+1)
   entries.push({entry,parent})
   if(entry.group&&Array.isArray(entry.config)){
    if(typeof entry.id!=='string'||!entry.id)throw Error('员工标题组合父组编号无效。')
    visit(entry.config,entry.id)
   }
  }
 }
 if(!Array.isArray(rows))throw Error('员工标题组合树格式无效。')
 visit(rows,undefined)
 if(entries.some(({entry})=>entry.id===targetId||entry.name===targetName))throw Error('员工标题组合已存在包装行，拒绝重复或冲突。')
 const matches=entries.filter(({entry})=>entry.id===sourceId||entry.name===sourceName)
 if(!matches.length)return [] // 无标题功能的 headless 组合不新增依赖。
 if(matches.length!==1||matches[0]!.entry.id!==sourceId||matches[0]!.entry.name!==sourceName)throw Error('员工标题官方行不唯一或来源不符。')
 const {entry,parent}=matches[0]!
 if(entry.group||parent!==undefined&&ids.get(parent)!==1)throw Error('员工标题官方行或父组存在歧义。')
 if(entry.disabled===true)return [] // 可选 all-prompts 正常停用默认行，不能再启用第二个 provider。
 return [
  {id:sourceId,name:sourceName,disabled:true},
  {...parent===undefined?{}:{id:parent},insert:[{...structuredClone(entry),id:targetId,name:targetName}]},
 ]
}

/** 只从本条本人消息后的宿主快照取冻结姓名，不用最新员工目录改写历史身份。 */
export function employeeMentionTitleInput(events:readonly Event[],messageSeq:number):string|undefined{
 const at=events.findIndex(event=>event.seq===messageSeq&&ownerMessage(event))
 if(at<0)return
 const original=text(events[at]!)
 let mention:ReturnType<typeof singleEmployeeMention>
 try{mention=singleEmployeeMention(original)}catch{return}
 if(!mention)return
 const marker=encodeEmployeeMention(mention)
 let name:string|undefined
 for(const event of events.slice(at+1)){
  if(ownerMessage(event)||['turn/start','turn/end','request/header'].includes(event.type))break
  const origin=source(event)
  if(event.type!=='user/message'||origin?.kind!=='runtime-context'||origin.form!=='snapshot'||!Array.isArray(origin.sections))continue
  for(const value of origin.sections){
   const section=row(value)
   if(section?.name!=='teloa/employee-mention')continue
   if(typeof section.text!=='string')return
   try{
    const identity=row(JSON.parse(section.text))
    if(!identity||identity.schema!=='teloa.employee-mention/v1'||identity.boundTo!=='current-owner-message'||identity.roleId!==mention.roleId||identity.roleVersion!==mention.roleVersion||typeof identity.name!=='string'||!identity.name.trim()||identity.name.length>120||typeof identity.scopeId!=='string'||!identity.scopeId||!['active','paused'].includes(String(identity.state)))return
    if(name!==undefined&&name!==identity.name)return
    name=identity.name
   }catch{return}
  }
 }
 if(name===undefined)return
 const question=original.split(marker).join(' ').replace(/\s+/gu,' ').trim()
 return '@'+name.trim()+(question?' '+question:'')
}

/** 只修复确实由该输入派生的自动 marker 标题；本人标题和普通标题保持原样。 */
export function employeeMentionReadableTitle(events:readonly Event[],title:{title:string;messageSeqs:readonly number[];source:{kind:string}}):string|undefined{
 if(!['fallback','provider'].includes(title.source.kind)||!title.title.startsWith('[teloa-employee:'))return
 const candidates=new Set<string>()
 for(const seq of title.messageSeqs){
  const event=events.find(event=>event.seq===seq&&ownerMessage(event))
  if(!event)continue
  let mention:ReturnType<typeof singleEmployeeMention>
  try{mention=singleEmployeeMention(text(event))}catch{continue}
  if(!mention)continue
  const marker=encodeEmployeeMention(mention)
  if(!marker.startsWith(title.title)&&!title.title.startsWith(marker))continue
  const readable=employeeMentionTitleInput(events,seq)
  if(readable)candidates.add(readable)
 }
 return candidates.size===1?[...candidates][0]:undefined
}
