import {applicationPresentation} from './application-presentation.ts'
export type DialogueEntry={kind:'session'|'group';id:string}
/** N48：会话（通用助手与普通会话）｜员工（与 AI 员工或分身的单聊）｜群；不再提供混合视图。 */
export type DialogueType='session'|'employee'|'group'
const dialogueTypes:readonly string[]=['session','employee','group']
export type DialogueFolder={id:string;name:string;collapsed:boolean}
type Data={assistantName:string;type:DialogueType;folders:DialogueFolder[];placements:Record<string,string>}
type Snapshot=Data&{error?:Error}
type Storage={getItem:(key:string)=>string|null;setItem:(key:string,value:string)=>void}
const key='teloa.dialogue-organization/v1'
const empty=():Data=>({assistantName:'Teloa',type:'session',folders:[],placements:{}})
const name=(value:string,allowDefault=false)=>{const text=value.trim().replace(/\s+/g,' ').normalize('NFC');if(!text&&allowDefault)return 'Teloa';if(!text||[...text].length>40||/[\u0000-\u001f\u007f]/.test(text))throw Error('名称需为 1～40 个字符。');return text}
export const dialogueEntryKey=(entry:DialogueEntry)=>JSON.stringify([entry.kind,entry.id])
function read(raw:string|null):Data{
 if(raw===null)return empty()
 const data=JSON.parse(raw)
 if(!data||typeof data!=='object'||Object.keys(data).sort().join(',')!=='assistantName,folders,placements,schema,type'||data.schema!==key||typeof data.assistantName!=='string'||name(data.assistantName)!==data.assistantName||!['all',...dialogueTypes].includes(data.type)||!Array.isArray(data.folders)||!data.placements||typeof data.placements!=='object'||Array.isArray(data.placements))throw Error('助手姓名或目录分组记录无法读取。')
 const folders:DialogueFolder[]=data.folders.map((row:DialogueFolder)=>{if(!row||Object.keys(row).sort().join(',')!=='collapsed,id,name'||typeof row.id!=='string'||!row.id||typeof row.name!=='string'||name(row.name)!==row.name||typeof row.collapsed!=='boolean')throw Error('目录分组记录无法读取。');return {...row}})
 if(new Set(folders.map(row=>row.id)).size!==folders.length)throw Error('目录分组身份重复。')
 const placements:Record<string,string>={}
 for(const [entry,folder]of Object.entries(data.placements)){
  const identity=JSON.parse(entry)
  if(!Array.isArray(identity)||identity.length!==2||!['session','group'].includes(identity[0])||typeof identity[1]!=='string'||!identity[1]||entry!==JSON.stringify(identity)||typeof folder!=='string'||!folders.some(row=>row.id===folder))throw Error('目录分组中的原对话关联无法读取。')
  placements[entry]=folder
 }
 // 旧混合视图 `all` 迁移为默认会话分类；旧 `session` 原样沿用。只改读出的显示偏好，下次保存时写入新值。
 return {assistantName:data.assistantName,type:data.type==='all'?'session':data.type,folders,placements}
}
/** 仅本人显示偏好；不写执行位置、业务、成员、原会话或原群。 */
export function createDialogueOrganization(storage:Storage){
 const listeners=new Set<()=>void>();let snapshot:Snapshot
 const load=():Snapshot=>{try{return read(storage.getItem(key))}catch(cause){return {...empty(),error:cause instanceof Error?cause:Error('目录分组记录无法读取。')}}}
 snapshot=load()
 const publish=(next:Snapshot)=>{snapshot=next;for(const listener of listeners)listener()}
 const change=(update:(current:Data)=>Data)=>{const current=load();if(current.error)throw current.error;const next=update(current);read(JSON.stringify({schema:key,...next}));storage.setItem(key,JSON.stringify({schema:key,...next}));publish(next)}
 return {
  getSnapshot:()=>snapshot,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}},refresh:()=>{const next=load();if(JSON.stringify(next)!==JSON.stringify(snapshot))publish(next)},
  renameAssistant:(value:string)=>change(current=>({...current,assistantName:name(value,true)})),
  selectType:(type:DialogueType)=>{if(!dialogueTypes.includes(type))throw Error('目录分组已变化或存在同名分组。');change(current=>({...current,type}))},
  createFolder:(value:string)=>{const id=crypto.randomUUID(),label=name(value);change(current=>{if(current.folders.some(row=>row.name===label))throw Error('已有同名目录分组。');return {...current,folders:[...current.folders,{id,name:label,collapsed:false}]}});return id},
  renameFolder:(id:string,value:string)=>change(current=>{const label=name(value);if(!current.folders.some(row=>row.id===id)||current.folders.some(row=>row.id!==id&&row.name===label))throw Error('目录分组已变化或存在同名分组。');return {...current,folders:current.folders.map(row=>row.id===id?{...row,name:label}:row)}}),
  toggleFolder:(id:string)=>change(current=>({...current,folders:current.folders.map(row=>row.id===id?{...row,collapsed:!row.collapsed}:row)})),
  removeFolder:(id:string)=>change(current=>({...current,folders:current.folders.filter(row=>row.id!==id),placements:Object.fromEntries(Object.entries(current.placements).filter(([,folder])=>folder!==id))})),
  move:(entry:DialogueEntry,folder:string|null)=>change(current=>{if(!entry.id||!['session','group'].includes(entry.kind)||folder!==null&&!current.folders.some(row=>row.id===folder))throw Error('原对话或目录分组已变化。');const placements={...current.placements},entryKey=dialogueEntryKey(entry);if(folder===null)delete placements[entryKey];else placements[entryKey]=folder;return {...current,placements}}),
 }
}
export type DialogueOrganization=ReturnType<typeof createDialogueOrganization>
export function browserDialogueOrganization(){
 const scope=applicationPresentation.getNavigationStorageScope(),local=applicationPresentation.getSnapshot().product==='Free'||scope!==undefined
 const memory=new Map<string,string>(),prefix=scope?'teloa.personal-presentation/'+scope+'/':''
 return createDialogueOrganization({getItem:entry=>local?window.localStorage.getItem(prefix+entry):memory.get(entry)??null,setItem:(entry,value)=>{if(local)window.localStorage.setItem(prefix+entry,value);else memory.set(entry,value)}})
}
