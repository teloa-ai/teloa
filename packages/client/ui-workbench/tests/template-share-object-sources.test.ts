import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createHash} from 'node:crypto'
import {createRoleApi} from '../src/client/role-api.ts'
import {createResourceApi} from '../src/client/resource-api.ts'
import {createRoleToolGrantApi} from '../src/client/role-tool-grant-api.ts'
import {createTemplateShareObjectSources,readAppBundleSharePackage} from '../src/client/template-share-object-sources.ts'
import {buildSharePlan,sharePackageSummary,shareWorkCopy} from '../src/client/share-package-plan.ts'
import {readIndustryDirectory} from '../src/client/industry-directory.ts'
import type {MarketItem} from '../src/client/market-preview.ts'
import type {IndustryLoadRecord} from '../src/client/industry-load-api.ts'
import type {IndustryRoleInstance} from '../src/client/industry-role-api.ts'
import type {ManagedMcpConnectionRecord} from '../src/client/mcp-connections-api.ts'
import type {IndustryManifest} from '../src/client/industry-manifest.ts'

const id=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0')
const stamp='2026-10-26T00:00:00.000Z',hash=(text:string)=>createHash('sha256').update(text).digest('hex')
const responsibility={triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]}
async function fixture(){
 const markdown='# SOP\nVerify the supplied total.\n',knowledgeId=id(30),sourceId='knowledge_'+knowledgeId,sourceVersion=hash(markdown)
 const version={knowledgeId,ownerId:'self',sourceId:id(29),sourceType:'paste',version:1,contentHash:sourceVersion,bytes:Buffer.byteLength(markdown),createdAt:stamp,markdown}
 const resource={id:id(31),ownerId:'self',title:'Selected SOP',sourceId,sourceVersion,scopeIds:['general'],version:1,status:'active',createdAt:stamp,updatedAt:stamp}
 const reference={id:sourceId,title:resource.title,source:'Pasted knowledge',version:sourceVersion,bytes:Buffer.byteLength(markdown),knowledge:{knowledgeId,knowledgeVersion:1,workspaceId:id(32),category:'sop',topics:[],scopeIds:['general']}}
 const roles=[{id:id(1),ownerId:'self',version:1,state:'paused',createdAt:stamp,updatedAt:stamp,name:'Analyst',kind:'employee',scopes:['general'],duty:'Verify supplied amounts.',dataScope:'Provided sources.',executionScope:'Ask before external writes.',skills:[],knowledge:[resource.id],responsibility}]
 const reads:string[]=[],roleApi=createRoleApi(async endpoint=>{assert.equal(endpoint,'roles/list');return structuredClone(roles)})
 const resources=createResourceApi(async endpoint=>{reads.push(endpoint);if(endpoint==='resources/list')return {drafts:[],resources:[structuredClone(resource)]};if(endpoint==='resources/sources')return [structuredClone(reference)];if(endpoint==='knowledge/read-version')return structuredClone(version);throw Error('Unexpected call '+endpoint)})
 const instances:IndustryRoleInstance[]=[],loads=new Map<string,IndustryLoadRecord>(),contents=new Map<string,MarketItem>()
 const ports={roles:roleApi,resources,industryRoles:{list:async()=>structuredClone(instances)},loads:{get:async(loadId:string)=>{const load=loads.get(loadId);assert.ok(load);return structuredClone(load)}},contents:{hydrate:async(item:MarketItem)=>{const value=contents.get(item.contentStorage!.contentId);assert.ok(value);return structuredClone(value)}}}
 return {markdown,version,resource,reference,roles,reads,ports,instances,loads,contents,selected:await roleApi.list()}
}

test('F24 本人明确选取的 SOP 使用真实 decoder 读取完整版本，默认不读取正文且不带记忆/授权',async()=>{
 const f=await fixture(),draft=await createTemplateShareObjectSources(f.ports).prepare(f.selected,'general')
 assert.deepEqual(draft.candidates.map(c=>[c.kind,c.defaultSelected,c.available]),[['sop',false,true]])
 const excluded=await draft.compose([])
 assert.equal(f.reads.includes('knowledge/read-version'),false)
 const empty=buildSharePlan({subject:'employee',publisher:'Reviewer',roles:f.selected,skills:[],...excluded})
 assert.equal(sharePackageSummary(empty).knowledge.length,0)
 assert.ok(empty.requirements.some(value=>value.includes('Selected SOP')))
 const composition=await draft.compose([draft.candidates[0]!.key])
 const pkg=buildSharePlan({subject:'employee',publisher:'Reviewer',roles:f.selected,skills:[],...composition})
 assert.equal(sharePackageSummary(pkg).knowledge.length,1)
 assert.equal(pkg.files.find(file=>file.path.endsWith('.md'))?.text,f.markdown)
 assert.deepEqual(sharePackageSummary(pkg).roles[0]!.knowledge,['knowledge-0'])
 assert.equal(JSON.stringify(pkg).includes('memoryViewId'),false)
 assert.equal(JSON.stringify(pkg).includes('roleVersion'),false)
})

test('F24 选取后撤回、角色变更、版本正文损坏均拒绝原导出，不借同名资料替代',async t=>{
 for(const change of ['withdraw','role','hash'] as const)await t.test(change,async()=>{
  const f=await fixture(),draft=await createTemplateShareObjectSources(f.ports).prepare(f.selected,'general')
  if(change==='withdraw')f.resource.status='withdrawn';else if(change==='role')f.roles[0]!.version++;else f.version.markdown='X'.repeat(f.version.bytes)
  await assert.rejects(draft.compose([draft.candidates[0]!.key]),{code:'teloa/source-unavailable'})
 })
})

test('F24 两成员同连接的工具子集精确分开，不携带无关全局连接或授权规则',async()=>{
 const f=await fixture();f.roles[0]!.knowledge=[];f.roles.push({...structuredClone(f.roles[0]!),id:id(2),name:'Reviewer'})
 const managed:ManagedMcpConnectionRecord[]=[{id:id(80),catalogId:'example',serverName:'example',status:'connected',createdAt:stamp,updatedAt:stamp,tools:[{name:'read',fullName:'mcp__example__read',readOnly:true},{name:'write',fullName:'mcp__example__write',readOnly:false}]},{id:id(81),catalogId:'unrelated',serverName:'unrelated',status:'connected',createdAt:stamp,updatedAt:stamp,tools:[{name:'send',fullName:'mcp__unrelated__send',readOnly:false}]}]
 const tools=createRoleToolGrantApi(async(endpoint,input)=>{assert.equal(endpoint,'role-tools/get');const roleId=(input as {roleId:string}).roleId;return {roleVersion:1,grant:{roleId,roleVersion:1,state:'active',rules:[{name:roleId===id(1)?'mcp__example__read':'mcp__example__write',allowed:[{target:'private-argument-marker'}]}],createdAt:stamp}}},{read:()=>null,write:()=>{},clear:()=>{}})
 const ports={...f.ports,tools,mcp:{list:async()=>structuredClone(managed),getCustom:async()=>{throw Error('Not a custom connection')}}}
 const selected=await f.ports.roles.list(),draft=await createTemplateShareObjectSources(ports).prepare(selected,'general'),composition=await draft.compose([])
 const pkg=buildSharePlan({subject:'team',publisher:'Reviewer',roles:selected,skills:[],...composition}),summary=sharePackageSummary(pkg)
 assert.deepEqual(summary.connections.map(c=>c.tools),[['read'],['write']])
 assert.ok(summary.roles[0]!.connections[0]!==summary.roles[1]!.connections[0])
 assert.equal(JSON.stringify(pkg).includes('unrelated'),false);assert.equal(JSON.stringify(pkg).includes('private-argument-marker'),false)
 managed[0]!.tools=[]
 await assert.rejects(draft.assertCurrent(),{code:'teloa/source-unavailable'})
})

async function fixed(withMcp=false,scope='general'){

 const f=await fixture();f.roles[0]!.knowledge=[];f.roles[0]!.scopes=[scope]
 const skill='---\nname: verify\ndescription: Verify supplied data.\n---\nRead the supplied data.\n'
 const manifest={format:'teloa.business-package/v2',id:'fixed-app',title:'Fixed app',description:'Reusable workflow.',version:'1.0.0',domain:scope,scope,resources:[{id:'analyst',kind:'role',title:'Analyst',version:'1.0.0',required:true,source:{kind:'local',path:'role.json'}},{id:'verify',kind:'skill',title:'Verify',version:'1.0.0',required:true,source:{kind:'local',path:'verify/SKILL.md'}},{id:'work',kind:'work-template',title:'Verify method',version:'1.0.0',required:false,source:{kind:'local',path:'work.json'}},{id:'routine',kind:'plan',title:'Routine',version:'1.0.0',required:false,source:{kind:'local',path:'routine.json'}}],relations:[{kind:'role-work',from:'analyst',to:'routine'}],entrypoints:['work']}
 if(withMcp){manifest.resources.push({id:'connector',kind:'mcp',title:'Example',version:'1.0.0',required:false,source:{kind:'local',path:'connector.json'}});manifest.relations.push({kind:'role-connection',from:'analyst',to:'connector'})}
 const definitions=[{path:'bundle/teloa.json',text:JSON.stringify(manifest)},{path:'bundle/role.json',text:JSON.stringify({name:'Analyst',kind:'employee',duty:'Verify supplied amounts.',dataScope:'Provided sources.',executionScope:'Ask before external writes.',responsibility})},{path:'bundle/verify/SKILL.md',text:skill},{path:'bundle/verify/reference.md',text:'Exact reference.\r\n'},{path:'bundle/work.json',text:JSON.stringify({format:'teloa.work-template/v1',id:'work',title:'Verify method',version:'1.0.0',domain:scope,description:'Read supplied data.',requirements:['Provide data.'],output:'A checked result.',skills:[{id:'verify',title:'Verify',version:'1.0.0'}]})},{path:'bundle/routine.json',text:JSON.stringify({format:'teloa.plan/v1',version:'1.0.0',title:'Routine',workTemplate:'work',dataScope:'Provided data.',trigger:{kind:'event',source:'Supplied materials',event:'New supplied materials'}})}]
 if(withMcp)definitions.push({path:'bundle/connector.json',text:JSON.stringify({format:'teloa.mcp-connection/v1',serverName:'example',tools:['read','write']})})
 const item=await readIndustryDirectory(definitions.map(file=>{const bytes=new TextEncoder().encode(file.text);return {path:file.path,size:bytes.length,read:async()=>bytes}}),'bundle/teloa.json','Fixed app')
 item.contentStorage={contentId:id(50),createdAt:stamp,loaded:true};item.trust={publisher:'Original author',repository:null,license:{status:'declared',value:'MIT'},signature:{status:'unverified',signer:null},compatibility:{teloa:'undeclared',dsh:'undeclared'},plugins:[],externalCapabilities:[],permissions:[],review:{conclusion:'needs-review',summary:'Local file'}}
 const load={id:id(51),ownerId:'self',contentId:id(50),contentHash:item.packageContent!.hash,templateId:manifest.id,templateVersion:manifest.version,scope,createdAt:stamp,mappingHash:'a'.repeat(64),status:'active',items:manifest.resources.map((r,index)=>({localId:r.id,instanceId:id(60+index),kind:r.kind,version:r.version,status:'pending-adapter'}))} as IndustryLoadRecord
 f.instances.push({id:id(70),ownerId:'self',loadId:load.id,itemInstanceId:id(60),itemLocalId:'analyst',scope,definitionHash:'a'.repeat(64),revision:1,state:'paused',role:(await f.ports.roles.list())[0]!,knowledge:[],omittedKnowledge:[],declarations:[],failure:null,createdAt:stamp,updatedAt:stamp})
 f.loads.set(load.id,load);f.contents.set(id(50),item)
 return {...f,item,load}
}

test('F24 原包宽连接声明不能覆盖当前员工精确工具子集，未知工具明确留为配置条件',async()=>{
 const f=await fixed(true),managed:ManagedMcpConnectionRecord={id:id(80),catalogId:'example',serverName:'example',status:'connected',createdAt:stamp,updatedAt:stamp,tools:[{name:'read',fullName:'mcp__example__read',readOnly:true},{name:'write',fullName:'mcp__example__write',readOnly:false}]}
 const tools=createRoleToolGrantApi(async()=>({roleVersion:1,grant:{roleId:id(1),roleVersion:1,state:'active',rules:[{name:'mcp__example__read',allowed:[{}]},{name:'native-tool',allowed:[{}]}],createdAt:stamp}}),{read:()=>null,write:()=>{},clear:()=>{}})
 const draft=await createTemplateShareObjectSources({...f.ports,tools,mcp:{list:async()=>[structuredClone(managed)],getCustom:async()=>{throw Error('Not custom')}}}).prepare(await f.ports.roles.list(),'general')
 assert.equal(draft.candidates.some(c=>c.kind==='mcp'),false,'宽原声明由实际成员绑定取代')
 const pkg=buildSharePlan({subject:'employee',publisher:'Reviewer',roles:await f.ports.roles.list(),skills:[],...await draft.compose(draft.candidates.filter(c=>c.defaultSelected).map(c=>c.key))})
 assert.deepEqual(sharePackageSummary(pkg).connections.map(c=>c.tools),[['read']]);assert.ok(pkg.requirements.some(value=>value.includes('native-tool')))
})

test('F24 真实固定 role-work 图闭合 plan→work-template→版本技能及支持正文，不猜手工计划',async()=>{
 const f=await fixed(),selected=await f.ports.roles.list(),draft=await createTemplateShareObjectSources(f.ports).prepare(selected,'general')
 const choice=draft.candidates.find(c=>c.kind==='plan')!;assert.equal(choice.defaultSelected,true)
 const composition=await draft.compose([choice.key]),pkg=buildSharePlan({subject:'employee',publisher:'Reviewer',roles:selected,skills:[],...composition}),summary=sharePackageSummary(pkg)
 assert.equal(summary.plans.length,1);assert.equal(summary.workTemplates.length,1);assert.equal(summary.skills.length,1)
 assert.equal(pkg.files.find(file=>file.path.endsWith('reference.md'))?.text,'Exact reference.\r\n')
 assert.equal(JSON.stringify(pkg).includes('enabled'),false)
 f.load.mappingHash='b'.repeat(64)
 await assert.rejects(draft.assertCurrent(),{code:'teloa/source-unavailable'})
})

test('F24 复杂应用沿原 v2 全文件分享，拒绝缺许可/员工包/不支持文件，不伪造完整原子应用',async()=>{
 const f=await fixed(),manifest=f.item.manifest as any
 manifest.resources=manifest.resources.filter((r:any)=>!['role','plan'].includes(r.kind));manifest.relations=[]
 const root=f.item.packageContent!.files.find(file=>file.path==='bundle/teloa.json')!;root.bytes=new TextEncoder().encode(JSON.stringify(manifest));root.hash=hash(JSON.stringify(manifest));f.item.packageContent!.files=f.item.packageContent!.files.filter(file=>!['bundle/role.json','bundle/routine.json'].includes(file.path))
 const pkg=await readAppBundleSharePackage(f.item,'Reviewer')
 assert.equal(pkg.subject,'app');assert.equal(sharePackageSummary(pkg).workTemplates.length,1)
 assert.equal(pkg.files.find(file=>file.path==='verify/reference.md')?.text,'Exact reference.\r\n')
 f.item.packageContent!.files.push({path:'bundle/run.sh',bytes:new TextEncoder().encode('echo unsafe'),hash:hash('echo unsafe')})
 await assert.rejects(readAppBundleSharePackage(f.item,'Reviewer'))
 f.item.packageContent!.files.pop();f.item.trust!.license={status:'missing'}
 await assert.rejects(readAppBundleSharePackage(f.item,'Reviewer'),{code:'teloa/source-unavailable'})
})

test('F24 双语 localized 的完整应用与固定流程规范为既有分享字段，并逐字保留原清单',async()=>{
 const f=await fixed(),manifest=f.item.manifest as IndustryManifest
 manifest.localized={title:{original:'Fixed app',defaultLocale:'en',locales:{'zh-CN':'固定流程应用',en:'Fixed workflow app'}}}
 manifest.resources.find(resource=>resource.id==='work')!.localized={title:{original:'Verify method',defaultLocale:'en',locales:{'zh-CN':'核对方法',en:'Verification method'}}}
 const original=JSON.stringify(manifest,null,2),files=f.item.packageContent!.files.map(file=>({path:file.path,bytes:file.path==='bundle/teloa.json'?new TextEncoder().encode(original):file.bytes}))
 const read=await readIndustryDirectory(files.map(file=>({path:file.path,size:file.bytes.length,read:async()=>file.bytes})),'bundle/teloa.json','Fixed app')
 f.item.packageContent=read.packageContent!;f.load.contentHash=read.packageContent!.hash
 const draft=await createTemplateShareObjectSources(f.ports).prepare(await f.ports.roles.list(),'general'),composition=await draft.compose(draft.candidates.filter(candidate=>candidate.defaultSelected).map(candidate=>candidate.key))
 const employee=buildSharePlan({subject:'employee',publisher:'Reviewer',roles:await f.ports.roles.list(),skills:[],...composition}),sharedManifest=JSON.parse(employee.files.find(file=>file.path==='teloa.json')!.text)
 assert.equal(sharedManifest.resources.some((resource:any)=>resource.localized!==undefined),false)
 assert.equal(employee.files.find(file=>employee.sourceFiles.includes(file.path))!.text,original)
 const appManifest={...manifest,resources:manifest.resources.filter(resource=>!['role','plan'].includes(resource.kind)),relations:[],entrypoints:['work']},appOriginal=JSON.stringify(appManifest,null,2)
 const appFiles=files.filter(file=>!['bundle/role.json','bundle/routine.json'].includes(file.path)).map(file=>({...file,bytes:file.path==='bundle/teloa.json'?new TextEncoder().encode(appOriginal):file.bytes}))
 const appItem=await readIndustryDirectory(appFiles.map(file=>({path:file.path,size:file.bytes.length,read:async()=>file.bytes})),'bundle/teloa.json','Fixed app');appItem.contentStorage=f.item.contentStorage!;appItem.trust=f.item.trust!
 const app=await readAppBundleSharePackage(appItem,'Reviewer'),appShared=JSON.parse(app.files.find(file=>file.path==='teloa.json')!.text)
 assert.equal(appShared.localized,undefined);assert.equal(appShared.resources.some((resource:any)=>resource.localized!==undefined),false)
 assert.equal(app.files.find(file=>app.sourceFiles.includes(file.path))!.text,appOriginal)
 assert.equal(hash(app.files.find(file=>app.sourceFiles.includes(file.path))!.text),hash(appOriginal))
})


test('F24 非general固定流程从真实员工来源完整组包保留原scope，再映射本人目标',async()=>{
 const f=await fixed(false,'SOC'),roles=await f.ports.roles.list(),draft=await createTemplateShareObjectSources(f.ports).prepare(roles,'SOC')
 const composition=await draft.compose(draft.candidates.filter(candidate=>candidate.defaultSelected).map(candidate=>candidate.key))
 const pkg=buildSharePlan({subject:'employee',publisher:'Reviewer',roles,skills:[],...composition}),before=structuredClone(pkg)
 assert.equal(sharePackageSummary(pkg).scope,'SOC','collector不能把真实SOC固定流程组装成general来源')
 const originalWork=pkg.files.find(file=>file.path.endsWith('/work.json'))!
 assert.equal(JSON.parse(originalWork.text).domain,'SOC')
 const mapped=shareWorkCopy(pkg,'general','copy-target')
 assert.deepEqual(mapped.mappings,[{resourceId:'work',from:'SOC',to:'general'}])
 assert.equal(sharePackageSummary(mapped.copy).scope,'general')
 assert.equal(JSON.parse(mapped.copy.files.find(file=>file.path===originalWork.path)!.text).domain,'general')
 assert.deepEqual(pkg,before,'原固定源保持原文和摘要')
})

test('F24 团队选择两个不相容业务范围的固定流程时明确拒绝，不猜测原scope',async()=>{
 const first=await fixed(false,'SOC'),second=await fixed(false,'AppSec')
 const manifest=structuredClone(second.item.manifest) as IndustryManifest
 manifest.id='appsec-workflow'
 manifest.resources=manifest.resources.map(resource=>({...resource,id:'appsec-'+resource.id}))
 manifest.relations=manifest.relations.map(link=>({...link,from:'appsec-'+link.from,to:'appsec-'+link.to}))
 manifest.entrypoints=manifest.entrypoints.map(value=>'appsec-'+value)
 const files=second.item.packageContent!.files.map(file=>{
  let text=new TextDecoder().decode(file.bytes)
  if(file.path==='bundle/teloa.json')text=JSON.stringify(manifest)
  if(file.path==='bundle/work.json'){const value=JSON.parse(text);text=JSON.stringify({...value,id:'appsec-'+value.id,skills:value.skills.map((skill:{id:string})=>({...skill,id:'appsec-'+skill.id}))})}
  if(file.path==='bundle/routine.json')text=JSON.stringify({...JSON.parse(text),workTemplate:'appsec-work'})
  const bytes=new TextEncoder().encode(text);return {path:file.path,size:bytes.length,read:async()=>bytes}
 })
 const item=await readIndustryDirectory(files,'bundle/teloa.json','AppSec workflow')
 item.contentStorage={contentId:id(150),createdAt:stamp,loaded:true};item.trust=second.item.trust!
 const load={...second.load,id:id(151),contentId:id(150),contentHash:item.packageContent!.hash,templateId:manifest.id,items:second.load.items.map((value,index)=>({...value,localId:'appsec-'+value.localId,instanceId:id(160+index)}))}
 first.roles.push({...second.roles[0]!,id:id(2),name:'AppSec analyst'})
 first.instances.push({...second.instances[0]!,id:id(170),loadId:load.id,itemInstanceId:id(160),itemLocalId:'appsec-analyst',role:(await first.ports.roles.list())[1]!})
 first.loads.set(load.id,load);first.contents.set(id(150),item)
 const roles=await first.ports.roles.list(),draft=await createTemplateShareObjectSources(first.ports).prepare(roles,'general')
 assert.equal(draft.candidates.filter(candidate=>candidate.kind==='plan').length,2)
 await assert.rejects(draft.compose(draft.candidates.filter(candidate=>candidate.defaultSelected).map(candidate=>candidate.key)),{code:'teloa/source-unavailable'})
})
