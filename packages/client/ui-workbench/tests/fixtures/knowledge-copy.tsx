import type {TeloaI18n,TeloaI18nSnapshot} from '../../src/client/i18n/index.js'
import {BusinessScopeProvider} from '../../src/client/business-scope-context.js'
import {useState,type CSSProperties} from 'react'
import {createRoot} from 'react-dom/client'
import {isRecord,isKnowledgeCopyResult,type KnowledgeCopyInput,type KnowledgeCopyResult,type WorkResource} from '@teloa/contract'
import {KnowledgeDocument} from '../../src/client/KnowledgeDocument.js'
import {createResourceApi} from '../../src/client/resource-api.js'
import {I18nProvider} from '../../src/client/i18n/provider.js'
import {translateMessage} from '../../src/client/i18n/messages.js'
import {prototypeThemes} from '../../src/brand/prototype-theme.js'
import tokens from '../../src/client/theme-tokens.module.css'
const id='11111111-1111-4111-8111-111111111111',newId='22222222-2222-4222-8222-222222222222',knowledgeId='33333333-3333-4333-8333-333333333333',nativeSourceId='44444444-4444-4444-8444-444444444444',contentId='55555555-5555-4555-8555-555555555555',stamp='2026-10-26T00:00:00Z',markdown='# 固定SOP\n\n保留固定来源。'
const digest=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),byte=>byte.toString(16).padStart(2,'0')).join('')
const withdrawn=new URLSearchParams(location.search).has('withdrawn'),scope=new URLSearchParams(location.search).has('custom-scope')?'risk-review':'general'
const sourceVersion='854180abe2358c28d0023e1cc90565517e34e1cb0bae4beba7b42ee52016ad6b',original:WorkResource={id,ownerId:'self',title:'分享SOP',sourceId:'industry_66666666-6666-4666-8666-666666666666_77777777-7777-4777-8777-777777777777',sourceVersion,scopeIds:[scope],version:withdrawn?2:1,status:withdrawn?'withdrawn':'active',createdAt:stamp,updatedAt:stamp}
const params=new URLSearchParams(location.search),missing=params.has('missing'),storageFail=params.has('storage-fail')
const origin={resourceId:id,resourceVersion:1,sourceId:original.sourceId,sourceTitle:'分享SOP',sourceVersion,contentId,contentHash:'a'.repeat(64),packageVersion:'1.0.0',localId:'sop',publisher:'合成作者',license:missing?{status:'missing' as const}:{status:'declared' as const,value:'MIT'}}
declare global {interface Window {__copy:{writes:KnowledgeCopyInput[];reads:string[];lose:()=>void;revoke:()=>void};__err?:unknown}}
const writes:KnowledgeCopyInput[]=[],reads:string[]=[],receipts=new Map<string,KnowledgeCopyResult>()
const saved:unknown=JSON.parse(sessionStorage.getItem('copy-server-receipts')??'[]')
if(!Array.isArray(saved))throw Error('Invalid fixture receipt store')
for(const row of saved){if(!Array.isArray(row)||row.length!==2||typeof row[0]!=='string'||!isKnowledgeCopyResult(row[1]))throw Error('Invalid fixture receipt');receipts.set(row[0],row[1])}
function copyInput(value:unknown):KnowledgeCopyInput{
 if(!isRecord(value)||typeof value.requestId!=='string'||typeof value.resourceId!=='string'||typeof value.expectedResourceVersion!=='number'||typeof value.sourceVersion!=='string'||typeof value.title!=='string'||typeof value.markdown!=='string')throw Error('Invalid fixture copy input')
 return {requestId:value.requestId,resourceId:value.resourceId,expectedResourceVersion:value.expectedResourceVersion,sourceVersion:value.sourceVersion,title:value.title,markdown:value.markdown}
}
let loseReply=false,revoked=withdrawn
const port=createResourceApi(async(endpoint,payload:unknown)=>{
 reads.push(endpoint)
 if(endpoint==='knowledge/copy-preview'){if(revoked)throw Object.assign(Error('已撤回'),{rejected:true,code:'teloa/resource-withdrawn'});return {origin,title:original.title,markdown,scopeIds:original.scopeIds}}
 if(endpoint==='knowledge/copy'){
  const input=copyInput(payload)
  writes.push(structuredClone(input));if(receipts.has(input.requestId)){const result=receipts.get(input.requestId)!;return {...result,origin:{...result.origin,license:{value:'MIT',status:'declared'}}}}
  if(revoked)throw Object.assign(Error('已撤回'),{rejected:true,code:'teloa/resource-withdrawn'})
  const body=input.markdown,contentHash=await digest(body),result:KnowledgeCopyResult={knowledge:{item:{id:knowledgeId,ownerId:'self',sourceId:nativeSourceId,sourceType:'paste',workspaceId:'default',title:input.title,category:'reference',topics:[],scopeIds:[scope],currentVersion:1,status:'active',createdAt:stamp,updatedAt:stamp},version:{knowledgeId,ownerId:'self',sourceId:nativeSourceId,sourceType:'paste',version:1,contentHash,bytes:new TextEncoder().encode(body).byteLength,createdAt:stamp,markdown:body}},resource:{...original,id:newId,title:input.title,sourceId:'knowledge_'+knowledgeId,sourceVersion:contentHash},origin}
  receipts.set(input.requestId,result);sessionStorage.setItem('copy-server-receipts',JSON.stringify([...receipts]))
  if(loseReply){loseReply=false;throw Error('lost reply')}
  return result
 }
 if(endpoint==='knowledge/copy-origin')return origin
 if(endpoint==='knowledge/list-versions')return [...receipts.values()].at(-1)?[[...receipts.values()].at(-1)!.knowledge.version]:[]
 if(endpoint==='knowledge/read-version')return [...receipts.values()].at(-1)!.knowledge.version
 throw Error('Unexpected fixture endpoint '+endpoint)
})
const api={...port,readContent:async()=>({resource:original,text:markdown})}
delete api.usage
const snapshot:TeloaI18nSnapshot={locale:'zh-CN',dshLocale:'zh-CN',revision:1}
const i18n:TeloaI18n={subscribe:()=>()=>{},getSnapshot:()=>snapshot,t:(key,params)=>translateMessage('zh-CN',key,params)}
const pageStyle:CSSProperties={...prototypeThemes.light,minHeight:'100vh',padding:30}
const storage={getItem:(key:string)=>localStorage.getItem(key),setItem:(key:string,value:string)=>{if(storageFail)throw Error('test storage unavailable');localStorage.setItem(key,value)},removeItem:(key:string)=>localStorage.removeItem(key)}
function App(){const [resource,setResource]=useState(original),[other,setOther]=useState(false),[notice,setNotice]=useState(''),[error,setError]=useState('')
 const result=[...receipts.values()].find(value=>value.resource.id===resource.id),source=result?{id:resource.sourceId,title:resource.title,source:'knowledge:'+knowledgeId+'@1',version:resource.sourceVersion,bytes:result.knowledge.version.bytes,knowledge:{knowledgeId,knowledgeVersion:1,workspaceId:'default',category:'reference' as const,topics:[],scopeIds:[scope]}}:undefined
 return <div className={tokens.tokens} style={pageStyle}><button onClick={()=>setOther(!other)}>切换验收身份</button>{other?<p>另一身份无原资料</p>:<KnowledgeDocument key={resource.id} api={api} storage={storage} resource={resource} source={source} onPublished={async id=>{const saved=[...receipts.values()].find(value=>value.resource.id===id);if(!saved)throw Error('missing copy');setResource(saved.resource)}} onCopy={()=>{}} onWithdraw={()=>{}} onNotice={setNotice} onError={setError}/>}<p role="status">{notice}</p>{error&&<p role="alert">{error}</p>}</div>
}
;window.__copy={writes,reads,lose:()=>{loseReply=true},revoke:()=>{revoked=true}}
createRoot(document.getElementById('root')!).render(<I18nProvider runtime={i18n}><BusinessScopeProvider labels={[{scope,title:scope==='general'?'通用工作':'风险研判业务',kind:scope==='general'?'builtin':'domain',loads:1,activeLoads:1,tasks:0,groups:0}]}><App/></BusinessScopeProvider></I18nProvider>)
