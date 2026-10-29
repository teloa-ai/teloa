import {useEffect,useState} from 'react'
import {createRoot} from 'react-dom/client'
import type {EmployeeKnowledgeContent,EmployeeKnowledgeRevision,EmployeeKnowledgeVersion,WorkResource} from '@teloa/contract'
import {createResourceApi} from '../../src/client/resource-api.js'
import {ResourceKnowledgeDocument} from '../../src/client/ResourceKnowledgeDocument.js'
import {RoleKnowledge} from '../../src/client/RoleKnowledge.js'
import {I18nProvider} from '../../src/client/i18n/provider.js'
import {translateMessage} from '../../src/client/i18n/messages.js'
import {prototypeThemes} from '../../src/brand/prototype-theme.js'
import tokens from '../../src/client/theme-tokens.module.css'
const roleA='10000000-0000-4000-8000-000000000001',roleB='10000000-0000-4000-8000-000000000002',resourceId='20000000-0000-4000-8000-000000000001',at='2026-10-29T00:00:00.000Z',text='# 调查操作手册\n\n核对设备与告警时间，并保留调查依据。\n\n## 处理步骤\n\n1. 阅读告警摘要。\n2. 核对原始日志。\n3. 记录结论与依据。',calls:Array<{endpoint:string;input:any}>=[]
const roles=[{id:roleA,name:'调查员工甲'},{id:roleB,name:'调查员工乙'}]
const hash=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),byte=>byte.toString(16).padStart(2,'0')).join('')
let original:WorkResource,documents:Record<string,EmployeeKnowledgeContent[]>={},mode='success',ready=false
const removed=new Set<string>(),pendingImports=new Set<string>(),bindingChanges:string[][]=[]
const receipts:Record<string,EmployeeKnowledgeRevision>=JSON.parse(localStorage.getItem('fixture-receipts')??'{}')
const store=()=>{localStorage.setItem('fixture-documents',JSON.stringify(documents));localStorage.setItem('fixture-receipts',JSON.stringify(receipts))}
const initial=async()=>{
 const contentHash=await hash(text)
 original={id:resourceId,ownerId:'self',title:'调查操作手册',sourceId:'industry_fixture',sourceVersion:contentHash,scopeIds:['general'],version:1,status:'active',createdAt:at,updatedAt:at}
 documents=JSON.parse(localStorage.getItem('fixture-documents')??'null')??Object.fromEntries(roles.map(role=>[role.id,[{roleId:role.id,resourceId,documentId:original.sourceId,knowledgeId:null,title:original.title,bodyVersion:1,contentHash,bytes:new TextEncoder().encode(text).byteLength,resource:original,origin:{resourceId,sourceId:original.sourceId,sourceVersion:contentHash},editing:'fork-on-write',indexState:'not-enrolled',markdown:text}]]))
}
const saveVersion=async(roleId:string,markdown:string)=>{
 const rows=documents[roleId]!,prior=rows.at(-1)!,contentHash=await hash(markdown),id=crypto.randomUUID(),knowledgeId=prior.knowledgeId??crypto.randomUUID()
 const next:EmployeeKnowledgeContent={...prior,knowledgeId,bodyVersion:prior.bodyVersion+1,contentHash,bytes:new TextEncoder().encode(markdown).byteLength,editing:'employee-copy',indexState:'pending',resource:{...prior.resource,id,sourceId:'knowledge_'+knowledgeId,sourceVersion:contentHash},markdown}
 rows.push(next);store();return next
}
const api=createResourceApi(async(endpoint,input:any)=>{
 calls.push({endpoint,input})
 if(endpoint==='resources/list')return {drafts:[],resources:[original]}
 if(endpoint==='resources/sources')return [{id:original.sourceId,title:original.title,source:'市场模板',version:original.sourceVersion,bytes:new TextEncoder().encode(text).byteLength}]
 if(endpoint==='resources/read-content')return {resource:original,text}
 const rows=documents[input.roleId]??[],head=rows.at(-1)!
 if(endpoint==='employee-knowledge/list'){
  if(input.requireReady&&pendingImports.has(input.roleId))throw Object.assign(Error('Import pending'),{code:'teloa/conflict',rejected:true,details:{reason:'employee-knowledge-import-pending'}})
  if(removed.has(input.roleId))return []
  const {markdown:_markdown,...document}=head;return [ready?{...document,indexState:'ready'}:document]
 }
 if(endpoint==='employee-knowledge/read'){const row=input.version?rows.find(row=>row.bodyVersion===input.version):head;return ready&&row?{...row,indexState:'ready'}:row}
 if(endpoint==='employee-knowledge/versions')return rows.map(row=>({version:row.bodyVersion,contentHash:row.contentHash,bytes:row.bytes,resourceId:row.resource.id,createdAt:at} satisfies EmployeeKnowledgeVersion))
 if(endpoint==='employee-knowledge/status'){if(mode==='status-conflict')throw Object.assign(Error('Receipt unavailable'),{code:'teloa/version-conflict',rejected:true});return receipts[input.requestId]??null}
 if(endpoint==='employee-knowledge/revise'||endpoint==='employee-knowledge/restore'){
  if(receipts[input.requestId])return receipts[input.requestId]
  if(mode==='offline')throw Error('Connection lost before save')
  if(head?.bodyVersion!==input.expectedBodyVersion||head.contentHash!==input.expectedContentHash)throw Object.assign(Error('Version changed'),{code:'teloa/version-conflict',rejected:true})
  const markdown=endpoint.endsWith('/restore')?rows.find(row=>row.bodyVersion===input.restoreVersion)!.markdown:input.markdown,next=await saveVersion(input.roleId,markdown),receipt:EmployeeKnowledgeRevision={requestId:input.requestId,operation:endpoint.endsWith('/restore')?'restore':'revise',forked:head.editing==='fork-on-write',document:next}
  receipts[input.requestId]=receipt;store();if(mode==='lost')throw Error('Connection lost after save');return receipt
 }
 throw Error(endpoint)
},undefined,localStorage)
const snapshot={locale:'zh-CN',dshLocale:'zh-CN',revision:1},i18n={subscribe:()=>()=>{},getSnapshot:()=>snapshot,t:(key:any,params:any)=>translateMessage('zh-CN',key,params)}
function App(){
 const [loaded,setLoaded]=useState(false),[view,setView]=useState<'global'|'role'>('global'),[role,setRole]=useState(roles[0]!),[mounted,setMounted]=useState(true),[editable,setEditable]=useState(false),[ids,setIds]=useState([resourceId]),[editorWidth,setEditorWidth]=useState<number>()
 useEffect(()=>{void initial().then(()=>setLoaded(true))},[])
 Object.assign(window,{fixture:{calls,roles,documents,bindingChanges,width:setEditorWidth,editable:setEditable,pending:(value:boolean)=>{if(value)pendingImports.add(role.id);else pendingImports.delete(role.id)},removed:(value:boolean)=>{if(value)removed.add(role.id);else removed.delete(role.id)},retitle:(title:string)=>{const document=documents[role.id]!.at(-1)!;document.title=title;document.resource={...document.resource,title}},mode:(value:string)=>{mode=value},bump:()=>saveVersion(role.id,'# 远端更新\n\n新版本正文'),ready:()=>{ready=true},mount:setMounted,role:(id:string)=>{setRole(roles.find(row=>row.id===id)!)},view:setView}})
 return <main className={tokens.tokens} style={{...prototypeThemes.light,minHeight:'100vh',padding:'clamp(12px,3vw,40px)',background:'var(--teloa-background)',color:'var(--teloa-text)'} as any}><div data-editor-host style={{width:editorWidth??'100%',maxWidth:'100%',minWidth:0,margin:'0 auto',padding:editorWidth===432?'24px 28px':0}}>{loaded&&mounted&&(view==='global'?<ResourceKnowledgeDocument api={api} resource={original} employees={roles} beforeLeave={action=>action()} source={undefined} onPublished={()=>{}} onCopy={()=>{}} onWithdraw={()=>{}} onNotice={()=>{}} onError={()=>{}}/>:<RoleKnowledge key={role.id} compact api={api} role={role} ids={ids} scopes={['general']} {...(editable?{change:(value:string[])=>{bindingChanges.push(value);setIds(value)}}:{})}/>)}</div></main>
}
createRoot(document.getElementById('root')!).render(<I18nProvider runtime={i18n as any}><App/></I18nProvider>)
