import {projectDefinition,projectInput,projectUuid,readProject,type ProjectDefinition,type WorkProject} from '@teloa/contract'
import type {WorkbenchNavigationStorage} from './workbench-navigation-state.js'

export type ProjectCreationContext={owner:string;origin:string}
export type ProjectCreationTicket=ProjectCreationContext&{generation:unknown}
export type ProjectEditTicket={owner:string;projectId:string;version:number;generation:unknown}
type Draft={fields:ProjectDefinition;ack:boolean;titleEdited?:boolean}
type EditDraft={ticket:ProjectEditTicket;project:WorkProject;draft:Draft}
const editFields=['title','goal','dueDate','state'] as const
export type ProjectEditField=typeof editFields[number]
export type ProjectEditReview={ticket:ProjectEditTicket;base:WorkProject;latest:WorkProject;draft:Draft;conflicts:ProjectEditField[]}
type Options={storage:WorkbenchNavigationStorage;identity:()=>Promise<string>;generation:()=>unknown}
const currentFields=({scope,title,goal,dueDate,state,links,references}:ProjectDefinition):ProjectDefinition=>({scope,title,goal,dueDate,state,links,references})
const failure=(code:string)=>Object.assign(Error('项目草稿恢复不可用。'),{code,origin:'browser-recovery'})
export function readProjectCreationContext(value:unknown):ProjectCreationContext{
 const row=projectInput(value,['owner','origin'])
 if(!projectUuid(row.owner)||typeof row.origin!=='string')throw failure('teloa/storage-corrupt')
 const origin:unknown=JSON.parse(row.origin)
 if(!Array.isArray(origin)||origin.length!==2||!['overview','workspace'].includes(origin[0])||(origin[1]!==null&&(typeof origin[1]!=='string'||! /^[a-zA-Z0-9_-]{1,64}$/.test(origin[1]))))throw failure('teloa/storage-corrupt')
 return {owner:row.owner,origin:JSON.stringify(origin)}
}
function formDraftValue(value:unknown):Draft{
 const row=projectInput(value,['fields','titleEdited']),fields=projectInput(row.fields,['scope','title','goal','dueDate','state','links','references'])
 if(typeof fields.title!=='string'||fields.title.length>120||typeof fields.goal!=='string'||fields.goal.length>8000||(row.titleEdited!==undefined&&typeof row.titleEdited!=='boolean'))throw failure('teloa/storage-corrupt')
 // 草稿允许未填名称/描述；完成确认只属于当前窗口，不落盘恢复。
 const checked=projectDefinition({...fields,title:fields.title.trim()?fields.title:'_',goal:fields.goal.trim()?fields.goal:'_'})
 return {fields:{...checked,title:fields.title,goal:fields.goal},ack:false,...(row.titleEdited===undefined?{}:{titleEdited:row.titleEdited})}
}
function draftValue(value:unknown):Draft{
 const draft=formDraftValue(value)
 if(draft.fields.state!=='planning'||draft.fields.links.length||draft.fields.references.length)throw failure('teloa/storage-corrupt')
 return draft
}
function editDraftValue(value:unknown,project:WorkProject):Draft{
 const draft=formDraftValue(value),fields=draft.fields
 if(fields.scope!==project.scope||fields.state==='archived'||JSON.stringify(fields.links)!==JSON.stringify(project.links)||JSON.stringify(fields.references)!==JSON.stringify(project.references))throw failure('teloa/storage-corrupt')
 return draft
}
export function createProjectCreationDrafts(options:Options){
 const key=(context:ProjectCreationContext)=>'teloa.project-creation-draft/v1/'+context.owner+'/'+encodeURIComponent(context.origin)
 const memory=new Map<string,{ticket:ProjectCreationTicket;draft:Draft}>()
 const reviews=new WeakMap<ProjectEditReview,{ticket:ProjectEditTicket;cached:string;saved:string|undefined;view:string}>()
 const edits=new Map<string,EditDraft>()
 const editKey=(ticket:Pick<ProjectEditTicket,'owner'|'projectId'>)=>'teloa.project-edit-draft/v1/'+ticket.owner+'/'+ticket.projectId
 const sameFields=(a:ProjectDefinition,b:ProjectDefinition)=>{try{return JSON.stringify(projectDefinition(a))===JSON.stringify(projectDefinition(b))}catch{return false}}
 const sameEditFields=(a:ProjectDefinition,b:ProjectDefinition)=>{try{return JSON.stringify(formDraftValue({fields:a}).fields)===JSON.stringify(formDraftValue({fields:b}).fields)}catch{return false}}
 const identity=async()=>{
  const generation=options.generation()
  if(generation===undefined)throw failure('teloa/conflict')
  const owner=await options.identity()
  if(!projectUuid(owner)||generation!==options.generation())throw failure('teloa/conflict')
  return {owner,generation}
 }
 const read=(context:ProjectCreationContext)=>{
  let raw:string|null
  try{raw=options.storage.getItem(key(context))}catch{throw failure('teloa/storage-unavailable')}
  if(raw===null)return undefined
  try{const row=projectInput(JSON.parse(raw),['version','draft']);if(row.version!==1)throw Error();return draftValue(row.draft)}catch{throw failure('teloa/storage-corrupt')}
 }
 const readEdit=(ticket:ProjectEditTicket)=>{
  let raw:string|null
  try{raw=options.storage.getItem(editKey(ticket))}catch{throw failure('teloa/storage-unavailable')}
  if(raw===null)return undefined
  try{
   const row=projectInput(JSON.parse(raw),['version','project','draft']),project=readProject(row.project)
   if(row.version!==1||project.id!==ticket.projectId)throw Error()
   return {project,draft:editDraftValue(row.draft,project)}
  }catch{throw failure('teloa/storage-corrupt')}
 }
 const checkEdit=async(ticket:ProjectEditTicket)=>{
  const current=await identity()
  if(current.owner!==ticket.owner||current.generation!==ticket.generation)throw failure('teloa/conflict')
 }
 return {
  async openEdit(value:WorkProject):Promise<EditDraft>{
   const current=readProject(value),ticket={...await identity(),projectId:current.id,version:current.version},key=editKey(ticket)
   const cached=edits.get(key),saved=cached?.ticket.generation===ticket.generation?cached:readEdit(ticket)
   if(saved&&(saved.project.ownerId!==current.ownerId||saved.project.scope!==current.scope))throw failure('teloa/storage-corrupt')
   const opened={ticket:{...ticket,version:saved?.project.version??current.version},project:saved?.project??current,draft:saved?.draft??editDraftValue({fields:currentFields(current)},current)}
   edits.set(key,opened);return opened
  },
  writeEdit(ticket:ProjectEditTicket,draft:Draft){
   const key=editKey(ticket),opened=edits.get(key)
   if(ticket.generation!==options.generation()||!opened||opened.ticket.generation!==ticket.generation||opened.project.version!==ticket.version)throw failure('teloa/conflict')
   const value=editDraftValue({fields:draft.fields,...(draft.titleEdited===undefined?{}:{titleEdited:draft.titleEdited})},opened.project)
   // 写失败仍保留本窗口的新输入，重新打开不能用旧存储覆盖它。
   edits.set(key,{...opened,draft:{...value,ack:draft.ack}})
   const saved=readEdit(ticket)
   if(saved&&saved.project.version!==ticket.version)throw failure('teloa/version-conflict')
   try{options.storage.setItem(key,JSON.stringify({version:1,project:opened.project,draft:{fields:value.fields,...(value.titleEdited===undefined?{}:{titleEdited:value.titleEdited})}}))}catch{throw failure('teloa/recovery-write-failed')}
  },
  checkEdit,
  async reviewEdit(ticket:ProjectEditTicket,value:WorkProject):Promise<ProjectEditReview>{
   await checkEdit(ticket)
   const cached=edits.get(editKey(ticket)),latest=readProject(value)
   if(!cached||cached.ticket.generation!==ticket.generation||cached.project.version!==ticket.version||latest.id!==ticket.projectId||latest.ownerId!==cached.project.ownerId||latest.scope!==cached.project.scope||latest.version<=ticket.version||latest.state==='archived')throw failure('teloa/conflict')
   const saved=readEdit(ticket)
   if(saved&&saved.project.version!==ticket.version)throw failure('teloa/version-conflict')
   const base=readProject(cached.project),draft=editDraftValue({fields:cached.draft.fields,...(cached.draft.titleEdited===undefined?{}:{titleEdited:cached.draft.titleEdited})},base)
   const conflicts=editFields.filter(field=>draft.fields[field]!==base[field]&&latest[field]!==base[field]&&draft.fields[field]!==latest[field])
   const review={ticket:{...ticket},base,latest,draft,conflicts}
   reviews.set(review,{ticket:{...ticket},cached:JSON.stringify({project:cached.project,draft:cached.draft}),saved:JSON.stringify(saved),view:JSON.stringify(review)})
   return review
  },
  async resumeEdit(review:ProjectEditReview,choices:Partial<Record<ProjectEditField,'draft'|'latest'>>):Promise<EditDraft>{
   const checked=reviews.get(review)
   if(!checked||JSON.stringify(review)!==checked.view)throw failure('teloa/conflict')
   await checkEdit(checked.ticket)
   const key=editKey(checked.ticket),cached=edits.get(key)
   if(JSON.stringify(review)!==checked.view||!cached||cached.ticket.generation!==checked.ticket.generation||cached.project.version!==checked.ticket.version||JSON.stringify({project:cached.project,draft:cached.draft})!==checked.cached||JSON.stringify(readEdit(checked.ticket))!==checked.saved)throw failure('teloa/conflict')
   try{projectInput(choices,review.conflicts)}catch{throw failure('teloa/conflict')}
   if(Object.keys(choices).length!==review.conflicts.length||review.conflicts.some(field=>!['draft','latest'].includes(choices[field]??'')))throw failure('teloa/conflict')
   const select=<K extends ProjectEditField>(field:K):ProjectDefinition[K]=>review.conflicts.includes(field)?choices[field]==='draft'?review.draft.fields[field]:review.latest[field]:review.draft.fields[field]!==review.base[field]?review.draft.fields[field]:review.latest[field]
   const draft=editDraftValue({fields:{...currentFields(review.latest),title:select('title'),goal:select('goal'),dueDate:select('dueDate'),state:select('state')},...(review.draft.titleEdited===undefined?{}:{titleEdited:review.draft.titleEdited})},review.latest)
   // 先保存明确审阅的新基线；写入失败时原版本和原稿仍可继续读取。
   try{options.storage.setItem(key,JSON.stringify({version:1,project:review.latest,draft:{fields:draft.fields,...(draft.titleEdited===undefined?{}:{titleEdited:draft.titleEdited})}}))}catch{throw failure('teloa/recovery-write-failed')}
   const resumed={ticket:{...checked.ticket,version:review.latest.version},project:review.latest,draft}
   edits.set(key,resumed);reviews.delete(review);return resumed
  },
  async clearEdit(ticket:ProjectEditTicket,fields:ProjectDefinition){
   await checkEdit(ticket)
   const key=editKey(ticket),saved=readEdit(ticket)
   if(saved?.project.version===ticket.version&&sameEditFields(saved.draft.fields,fields))try{options.storage.removeItem(key)}catch{throw failure('teloa/recovery-clear-failed')}
   const cached=edits.get(key)
   if(cached?.project.version===ticket.version&&sameEditFields(cached.draft.fields,fields))edits.delete(key)
  },
  async open(view:'overview'|'workspace',scope:string|null,initial:ProjectDefinition){
   const ticket={...await identity(),origin:JSON.stringify([view,scope])}
   readProjectCreationContext({owner:ticket.owner,origin:ticket.origin})
   // 同一连接内未能持久化的输入仍由原窗口持有，不能用旧存储覆盖。
   const cached=memory.get(key(ticket))
   if(cached?.ticket.generation===ticket.generation)return cached
   const opened={ticket,draft:read(ticket)??draftValue({fields:initial})};memory.set(key(ticket),opened);return opened
  },
  write(ticket:ProjectCreationTicket,draft:Draft){
   if(ticket.generation!==options.generation())throw failure('teloa/conflict')
   memory.set(key(ticket),{ticket,draft})
   const value=draftValue({fields:draft.fields,...(draft.titleEdited===undefined?{}:{titleEdited:draft.titleEdited})})
   try{options.storage.setItem(key(ticket),JSON.stringify({version:1,draft:{fields:value.fields,...(value.titleEdited===undefined?{}:{titleEdited:value.titleEdited})}}))}catch{throw failure('teloa/recovery-write-failed')}
  },
  async check(context:ProjectCreationContext,ticket?:ProjectCreationTicket){
   const current=await identity()
   if(current.owner!==context.owner||(ticket&&ticket.generation!==current.generation))throw failure('teloa/conflict')
   return {...context,generation:current.generation}
  },
  clear(context:ProjectCreationContext,fields:ProjectDefinition){
   const draft=read(context)
   if(draft&&sameFields(draft.fields,fields))try{options.storage.removeItem(key(context))}catch{throw failure('teloa/recovery-clear-failed')}
   const cached=memory.get(key(context))
   if(cached&&sameFields(cached.draft.fields,fields))memory.delete(key(context))
  },
 }
}
export type ProjectCreationDrafts=ReturnType<typeof createProjectCreationDrafts>
