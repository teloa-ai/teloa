import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import type {DigitalRole,EmployeeKnowledgeContent} from '@teloa/contract'
import {CompleteBusinessExportForm} from '../../src/client/CompleteBusinessExportForm.js'
import {createBusinessShareApi,type BusinessShareApi} from '../../src/client/business-share-flow.js'
import type {CompleteBusinessSnapshot} from '../../src/client/complete-business-source.js'
import {readIndustryDirectory} from '../../src/client/industry-directory.js'
import type {MarketContentApi} from '../../src/client/market-content-api.js'
import {I18nProvider} from '../../src/client/i18n/provider.js'
import {translateMessage} from '../../src/client/i18n/messages.js'
import {prototypeThemes} from '../../src/brand/prototype-theme.js'
import tokens from '../../src/client/theme-tokens.module.css'

type Stage='source'|'plan'|'download'
const trace:Array<Record<string,unknown>>=[],archives:Array<{api:number;scope:string;name:string;sha256:string;bytes:number}>=[],snapshots=new Map<string,Promise<CompleteBusinessSnapshot>>(),encoder=new TextEncoder(),at='2026-10-29T00:00:00.000Z'
let nextStage:Stage|undefined
const held=new Map<Stage,{resolve:()=>void;reject:(reason:unknown)=>void}>()
const hash=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(bytes))),byte=>byte.toString(16).padStart(2,'0')).join('')
const gate=async(stage:Stage,api:number,scope:string)=>{
 if(nextStage!==stage)return
 nextStage=undefined
 await new Promise<void>((resolve,reject)=>{held.set(stage,{resolve,reject});trace.push({kind:'held',stage,api,scope})})
}
const emptyDeclarations=()=>({objectTypes:[],views:[],actions:[],sources:[],available:{workTemplates:[],executionTools:[]}})
async function snapshot(scope:string,api:number):Promise<CompleteBusinessSnapshot>{
 const key=api+':'+scope,existing=snapshots.get(key);if(existing)return structuredClone(await existing)
 const request=(async()=>{
  const roleId='10000000-0000-4000-8000-000000000001',resourceId='20000000-0000-4000-8000-000000000001',knowledgeId='30000000-0000-4000-8000-000000000001',skillText='---\nname: export-review\ndescription: Review evidence\nlicense: MIT\n---\n\nRead references/guide.md',markdown='# 员工当前手册 '+scope+' API '+api+'\n\n导出当前正文。',contentHash=await hash(encoder.encode(markdown))
  const resources=[
   {id:'analyst',kind:'role',title:'分析员工模板',path:'employees/analyst.json',body:{format:'teloa.role/v1',name:'分析员工模板',kind:'employee',duty:'核对证据',dataScope:'获准告警',executionScope:'只读'}},
   {id:'playbook',kind:'knowledge',title:'原始手册',path:'knowledge/playbook.md',body:'# 原始手册'},
   {id:'method',kind:'skill',title:'核对方法',path:'skills/method/SKILL.md',body:skillText},
   {id:'reference',kind:'mcp',title:'参考连接',path:'connections/reference.json',body:{format:'teloa.mcp-connection/v1',serverName:'reference',tools:['read_reference']}},
   {id:'visualize',kind:'plugin',title:'展示应用',path:'plugins/visualize.json',body:{format:'teloa.plugin/v1',registry:'npm',packageName:'dsh-visualize',version:'1.0.0'}},
   {id:'review',kind:'work-template',title:'告警核对',path:'work/review.json',body:{format:'teloa.work-template/v1',id:'review',title:'告警核对',version:'1.0.0',domain:scope,description:'核对告警证据',requirements:['告警证据'],output:'核对结果',skills:[]}},
   {id:'daily',kind:'plan',title:'日常核对计划',path:'plans/daily.json',body:{format:'teloa.plan/v1',version:'1.0.0',title:'日常核对计划',workTemplate:'review',dataScope:'获准告警',trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Shanghai'}}},
  ],manifest={format:'teloa.business-package/v4',id:'source-business',title:'完整业务模板',version:'1.0.0',domain:scope,scope,description:'完整业务导出浏览器验收。',resources:resources.map(row=>({id:row.id,kind:row.kind,title:row.title,version:'1.0.0',required:true,source:{kind:'local',path:row.path}})),relations:[{kind:'role-knowledge',from:'analyst',to:'playbook'},{kind:'role-skill',from:'analyst',to:'method'},{kind:'role-connection',from:'analyst',to:'reference'},{kind:'role-connection',from:'analyst',to:'visualize'},{kind:'role-work',from:'analyst',to:'daily'}],entrypoints:['review']}
  const files=[{path:'teloa.json',bytes:encoder.encode(JSON.stringify(manifest))},...resources.map(row=>({path:row.path,bytes:encoder.encode(typeof row.body==='string'?row.body:JSON.stringify(row.body))})),{path:'skills/method/references/guide.md',bytes:encoder.encode('静态参考资料')},{path:'assets/figure.png',bytes:new Uint8Array([137,80,78,71,13,10,26,10,255,0])}],item=await readIndustryDirectory(files.map(row=>({path:row.path,size:row.bytes.length,read:async()=>row.bytes})),'teloa.json','完整业务浏览器验收')
  const role:DigitalRole={id:roleId,ownerId:'self',version:2,state:'active',name:'当前员工 '+scope+' API '+api,kind:'employee',scopes:[scope],duty:'核对当前业务证据',dataScope:'获准告警',executionScope:'只读',skills:['native-review'],knowledge:[resourceId],createdAt:at,updatedAt:at,responsibility:{triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]}}
  const document:EmployeeKnowledgeContent={roleId,resourceId,documentId:'industry_fixture',knowledgeId,title:'员工当前手册',bodyVersion:5,contentHash,bytes:encoder.encode(markdown).length,resource:{id:resourceId,ownerId:'self',title:'员工当前手册',sourceId:'knowledge_'+knowledgeId,sourceVersion:contentHash,scopeIds:[scope],version:1,status:'active',createdAt:at,updatedAt:at},origin:{resourceId,sourceId:'industry_fixture',sourceVersion:'a'.repeat(64)},editing:'employee-copy',indexState:'ready',markdown}
  const extra='# 业务通用资料 '+scope+' API '+api
  return {scope,packages:[{loadId:'fixture-load',loadScope:scope,item}],roles:[{role,origin:{loadId:'fixture-load',localId:'analyst'},documents:[document],skills:[{name:'native-review',resourceId:'method',title:'核对方法',version:'1.0.0',text:skillText,files:[{path:'SKILL.md',text:skillText},{path:'references/guide.md',text:'静态参考资料'}]}]}],knowledge:[{title:'未绑定员工的业务资料',markdown:extra,contentHash:await hash(encoder.encode(extra))}],declarations:emptyDeclarations()}
 })()
 snapshots.set(key,request);return structuredClone(await request)
}
const apis=[0,1].map(api=>{
 const source={async read(scope:string){trace.push({kind:'start',stage:'source',api,scope});const value=await snapshot(scope,api);await gate('source',api,scope);trace.push({kind:'finish',stage:'source',api,scope});return value}},core=createBusinessShareApi({read:async()=>emptyDeclarations()},{} as MarketContentApi,source).complete!
 const complete:NonNullable<BusinessShareApi['complete']>={source,async plan(input){trace.push({kind:'start',stage:'plan',api,scope:input.scope});const value=await core.plan(input);await gate('plan',api,input.scope);trace.push({kind:'finish',stage:'plan',api,scope:input.scope,digest:value.inspection.digest,counts:value.counts});return value},async download(item,digest,purpose){const scope=item.manifest?.format.startsWith('teloa.business-package/')?'scope'in item.manifest?String(item.manifest.scope):'unknown':'unknown';trace.push({kind:'start',stage:'download',api,scope,digest,purpose});const value=await core.download(item,digest,purpose);archives.push({api,scope,name:value.name,sha256:await hash(value.bytes),bytes:value.bytes.length});await gate('download',api,scope);trace.push({kind:'finish',stage:'download',api,scope});return value}}
 return complete
})
const locale={locale:'zh-CN',dshLocale:'zh-CN',revision:1},i18n={subscribe:()=>()=>{},getSnapshot:()=>locale,t:(key:any,params:any)=>translateMessage('zh-CN',key,params)}
function App(){
 const [scope,setScope]=useState('SOC'),[api,setApi]=useState(0)
 Object.assign(window,{completeExportFixture:{trace,archives,scope:()=>scope,api:()=>api,setScope,setApi,holdNext:(stage:Stage)=>{nextStage=stage},held:()=>[...held.keys()],release:(stage:Stage,reject:boolean|'pending'=false)=>{const pending=held.get(stage);held.delete(stage);if(reject)pending?.reject(Object.assign(Error('Delayed fixture rejection'),{code:reject==='pending'?'teloa/conflict':'teloa/source-unavailable',...(reject==='pending'?{details:{reason:'employee-knowledge-import-pending'}}:{})}));else pending?.resolve()}}})
 return <main className={tokens.tokens} style={{...prototypeThemes.light,minHeight:'100vh',padding:'clamp(12px,3vw,40px)',background:'var(--teloa-background)',color:'var(--teloa-text)'} as any}><div style={{maxWidth:1200,margin:'0 auto'}}><CompleteBusinessExportForm scope={scope} api={apis[api]!} draftKey={'complete-export-fixture-'+api+'-'+scope}/></div></main>
}
createRoot(document.getElementById('root')!).render(<I18nProvider runtime={i18n as any}><App/></I18nProvider>)
