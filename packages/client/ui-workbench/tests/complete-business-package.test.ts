import assert from 'node:assert/strict'
import test from 'node:test'
import {createHash} from 'node:crypto'
import {readFile,readdir} from 'node:fs/promises'
import {buildCompleteBusinessPackage,type CompleteBusinessPackageInput} from '../src/client/complete-business-package.ts'
import {readIndustryDirectory} from '../src/client/industry-directory.ts'
import {readIndustryArchive} from '../src/client/industry-archive.ts'
import {exportIndustryArchive} from '../src/client/industry-export.ts'
import {inspectIndustryContent} from '../src/client/industry-content.ts'
import {isIndustryManifest} from '../src/client/industry-manifest.ts'
import {dashboardResourceFixture} from './fixtures/business-dashboard-resource.ts'
import type {DigitalRole,EmployeeKnowledgeContent} from '@teloa/contract'

const encode=(value:string)=>new TextEncoder().encode(value),decode=(value:Uint8Array)=>new TextDecoder().decode(value),json=(value:unknown)=>encode(JSON.stringify(value)),at='2026-10-29T00:00:00.000Z',roleId='10000000-0000-4000-8000-000000000001',resourceId='20000000-0000-4000-8000-000000000001',knowledgeId='30000000-0000-4000-8000-000000000001'
const readDirectory=async(root:URL,prefix=''):Promise<{path:string;bytes:Uint8Array}[]>=>{const result:{path:string;bytes:Uint8Array}[]=[];for(const entry of await readdir(root,{withFileTypes:true})){const path=prefix+entry.name;if(entry.isDirectory())result.push(...await readDirectory(new URL(entry.name+'/',root),path+'/'));else result.push({path,bytes:new Uint8Array(await readFile(new URL(entry.name,root)))})}return result}
async function fixture():Promise<CompleteBusinessPackageInput>{
 const files=await readDirectory(new URL('../../../../tests/fixtures/业务定制层/SOC/',import.meta.url)),manifest=JSON.parse(decode(files.find(row=>row.path==='teloa.json')!.bytes)),skillText='---\nname: investigate\ndescription: Review evidence\n---\n\nUse references/guide.md',dependency={catalogId:'teloa.model.sensevoice',version:'1.0.0',usage:'speech-to-text',required:true}
 manifest.format='teloa.business-package/v4'
 const additions=[
  {id:'analyst',kind:'role',path:'employees/analyst.json',body:{format:'teloa.role/v1',kind:'employee',name:'原始分析员工',duty:'原始职责',dataScope:'告警',executionScope:'核对'}},
  {id:'playbook',kind:'knowledge',path:'knowledge/playbook.md',body:'# 原包手册'},
  {id:'investigate',kind:'skill',path:'skills/investigate/SKILL.md',body:skillText,modelDependencies:[dependency]},
  {id:'docs',kind:'mcp',path:'connections/docs.json',body:{format:'teloa.mcp-connection/v1',serverName:'reference',tools:['read_reference']}},
  {id:'visualize',kind:'plugin',path:'plugins/visualize.json',body:{format:'teloa.plugin/v1',registry:'npm',packageName:'dsh-visualize',version:'1.0.0'}},
  {id:'daily',kind:'plan',path:'plans/daily.json',body:{format:'teloa.plan/v1',version:'1.0.0',title:'日常告警核对',workTemplate:'alert-triage-review',dataScope:'获准告警',trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Shanghai'}}},
  {id:'soc-overview',kind:'business-configuration',path:'dashboards/soc.json',body:dashboardResourceFixture()},
 ]
 for(const row of additions){manifest.resources.push({id:row.id,kind:row.kind,title:row.id,version:'1.0.0',required:true,source:{kind:'local',path:row.path},...('modelDependencies'in row?{modelDependencies:row.modelDependencies}:{})});files.push({path:row.path,bytes:typeof row.body==='string'?encode(row.body):json(row.body)})}
 files.push({path:'skills/investigate/references/guide.md',bytes:encode('原始技能附件')},{path:'assets/diagram.png',bytes:new Uint8Array([0,255,13,77])})
 manifest.relations.push({kind:'role-knowledge',from:'analyst',to:'playbook'},{kind:'role-skill',from:'analyst',to:'investigate'},{kind:'role-connection',from:'analyst',to:'docs'},{kind:'role-connection',from:'analyst',to:'visualize'},{kind:'role-work',from:'analyst',to:'daily'})
 files.find(row=>row.path==='teloa.json')!.bytes=json(manifest)
 const item=await readIndustryDirectory(files.map(row=>({path:row.path,size:row.bytes.length,read:async()=>row.bytes})),'teloa.json','完整业务模板'),markdown='# 员工现行独立手册\n\n仅导当前正文，不导历史。',contentHash=createHash('sha256').update(markdown).digest('hex')
 const role:DigitalRole={id:roleId,ownerId:'self',version:4,state:'active',createdAt:at,updatedAt:at,name:'当前分析员工',kind:'employee',scopes:['SOC'],duty:'按当前职责核对并交付',dataScope:'获准告警',executionScope:'只读核对',skills:['native-investigate'],knowledge:[resourceId],responsibility:{triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]}}
 const resource={id:resourceId,ownerId:'self',title:'现行手册',sourceId:'knowledge_'+knowledgeId,sourceVersion:contentHash,scopeIds:['SOC'],version:1,status:'active' as const,createdAt:at,updatedAt:at}
 const document:EmployeeKnowledgeContent={roleId,resourceId,documentId:'industry_fixture',knowledgeId,title:'现行手册',bodyVersion:7,contentHash,bytes:encode(markdown).length,resource,origin:{resourceId,sourceId:'industry_fixture',sourceVersion:'a'.repeat(64)},editing:'employee-copy',indexState:'ready',markdown}
 const object=JSON.parse(decode(files.find(row=>row.path==='object-types/asset.json')!.bytes));delete object.localized;object.title='当前生效资产类型';object.version='2.0.0'
 return {scope:'SOC',packageId:'complete-soc',packageVersion:'2.0.0',title:'完整安全业务',description:'包含员工、当前知识与全部静态依赖的可导入业务包。',packages:[{loadId:'load-one',item}],roles:[{role,origin:{loadId:'load-one',localId:'analyst'},documents:[document],skills:[{name:'native-investigate',resourceId:'investigate',version:'1.0.0',text:skillText,files:[{path:'SKILL.md',text:skillText},{path:'references/guide.md',text:'当前技能附件'}]}]}],declarations:{objectTypes:[{localId:object.id,version:object.version,body:object}],views:[],actions:[],sources:[],available:{workTemplates:[],executionTools:[]}}}
}

test('完整业务包ZIP往返保留全部13类静态资源、当前员工与正文，动作和默认引用闭合',async()=>{
 const input=await fixture(),result=await buildCompleteBusinessPackage(input)
 assert.equal(Object.keys(result.counts).length,13)
 assert.equal(result.counts['business-action'],2);assert.equal(result.counts['work-template'],2);assert.equal(result.counts['knowledge'],2)
 assert.ok(isIndustryManifest(result.item.manifest));const manifest=result.item.manifest,content=result.item.packageContent!
 assert.equal(manifest.format,'teloa.business-package/v4')
 const rows=inspectIndustryContent(manifest,content),role=rows.find(row=>row.id==='analyst')!,asset=rows.find(row=>row.id==='asset')!
 assert.ok(role.definition?.kind==='role');assert.equal(role.definition.fields.name,'当前分析员工');assert.equal(role.definition.fields.duty,'按当前职责核对并交付')
 assert.ok(asset.definition?.kind==='object-type');assert.equal(asset.definition.definition.title,'当前生效资产类型')
 const binding=manifest.relations.find(row=>row.kind==='role-knowledge'&&row.from==='analyst')!,knowledge=rows.find(row=>row.id===binding.to)!
 assert.ok(knowledge.definition?.kind==='knowledge');assert.equal(knowledge.definition.text,input.roles[0]!.documents[0]!.markdown)
 assert.deepEqual(manifest.resources.find(row=>row.id==='investigate')!.modelDependencies,input.packages[0]!.item.manifest&&isIndustryManifest(input.packages[0]!.item.manifest)?input.packages[0]!.item.manifest.resources.find(row=>row.id==='investigate')!.modelDependencies:undefined)
 assert.deepEqual(content.files.find(row=>row.path==='packages/package-1/assets/diagram.png')!.bytes,new Uint8Array([0,255,13,77]))
 assert.ok(content.files.some(row=>row.path.endsWith('source-manifest.json.txt')))
 const currentTexts=content.files.filter(row=>row.path.startsWith('current/')).map(row=>decode(row.bytes)).join('\n');assert.doesNotMatch(currentTexts,/bodyVersion|ownerId|createdAt|10000000-0000|20000000-0000/)
 const archive=await exportIndustryArchive(result.item),restored=await readIndustryArchive(archive.bytes,archive.name)
 assert.equal(restored.length,1);assert.equal(restored[0]!.error,undefined);assert.deepEqual(restored[0]!.item!.manifest,manifest);assert.deepEqual(restored[0]!.item!.packageContent!.files,content.files)
})
test('手动员工与各自知识进入包，原共享知识保留且绑定互不混用',async()=>{
 const input=await fixture(),original=input.roles[0]!,manualId='40000000-0000-4000-8000-000000000001',role={...original.role,id:manualId,name:'手动员工',skills:[]},document={...original.documents[0]!,roleId:manualId}
 const result=await buildCompleteBusinessPackage({...input,roles:[original,{role,documents:[document],skills:[]}]});assert.equal(result.counts.role,2);assert.equal(result.counts.knowledge,3)
 assert.ok(isIndustryManifest(result.item.manifest));const links=result.item.manifest.relations.filter(row=>row.kind==='role-knowledge');assert.equal(links.length,2);assert.notEqual(links[0]!.to,links[1]!.to)
})
test('原SOC模板加载到新业务实例后，完整ZIP按可信loadScope重定向静态业务域并保持内部引用',async()=>{
 const input=await fixture(),scope='business_50000000-0000-4000-8000-000000000001',source=input.roles[0]!,local=input.declarations.objectTypes[0]!
 const current={...input,scope,packages:input.packages.map(row=>({...row,loadScope:scope})),roles:[{...source,role:{...source.role,scopes:[scope]},documents:source.documents.map(row=>({...row,resource:{...row.resource,scopeIds:[scope]}}))}],declarations:{...input.declarations,objectTypes:[{...local,body:{...(local.body as object),domain:scope}}]}}
 const result=await buildCompleteBusinessPackage(current);assert.ok(isIndustryManifest(result.item.manifest));const manifest=result.item.manifest,content=result.item.packageContent!
 assert.equal(manifest.scope,scope);assert.equal(manifest.domain,scope)
 const rows=inspectIndustryContent(manifest,content)
 for(const row of rows){
  const value=row.definition
  if(value?.kind==='object-type'||value?.kind==='business-view'||value?.kind==='business-action')assert.equal(value.definition.domain,scope)
  if(value?.kind==='work-template')assert.equal(value.manifest.domain,scope)
  if(value?.kind==='data-source')assert.deepEqual(value.definition.scopes,[scope])
  if(value?.kind==='business-configuration'){assert.equal(value.definition.configuration.scope,scope);assert.ok(value.definition.configuration.definitions.every(row=>row.definition.domain===scope));assert.equal(value.definition.configuration.pages[0]!.id,'alerts')}
 }
 const action=rows.find(row=>row.id==='assign-alert-review')!;assert.ok(action.definition?.kind==='business-action');assert.deepEqual(action.definition.definition.target,{kind:'work-template',localId:'alert-triage-review'});assert.equal(action.definition.definition.objectType,'alert-ticket')
 const originalManifest=JSON.parse(decode(content.files.find(row=>row.path==='packages/package-1/source-manifest.json.txt')!.bytes));assert.equal(originalManifest.scope,'SOC')
 const archive=await exportIndustryArchive(result.item),restored=await readIndustryArchive(archive.bytes,archive.name);assert.equal(restored.length,1);assert.deepEqual(restored[0]!.item!.manifest,manifest);assert.deepEqual(restored[0]!.item!.packageContent!.files,content.files)
 await assert.rejects(buildCompleteBusinessPackage({...current,packages:input.packages}),/可信加载归属/)
 await assert.rejects(buildCompleteBusinessPackage({...current,roles:current.roles.map(row=>({...row,origin:{loadId:'unrelated-load',localId:'analyst'}})),packages:current.packages.map(row=>({...row,loadScope:'unrelated-business'}))}),/可信来源关联/)
})
test('未绑定员工的业务知识校验当前正文摘要并作为v1基线进入ZIP，无历史字段',async()=>{
 const input=await fixture(),markdown='# 业务通用资料\n\n这份资料没有绑定员工。',knowledge={title:'未绑定员工的业务知识',markdown,contentHash:createHash('sha256').update(markdown).digest('hex')}
 const result=await buildCompleteBusinessPackage({...input,knowledge:[knowledge]});assert.equal(result.counts.knowledge,3)
 assert.ok(isIndustryManifest(result.item.manifest));const resource=result.item.manifest.resources.find(row=>row.title===knowledge.title)!
 assert.equal(resource.kind,'knowledge');assert.equal(resource.version,'1.0.0');assert.ok(resource.source.kind==='local');const path=resource.source.path;assert.equal(decode(result.item.packageContent!.files.find(row=>row.path===path)!.bytes),markdown)
 assert.equal(result.item.manifest.relations.some(row=>row.to===resource.id),false)
 const archive=await exportIndustryArchive(result.item),restored=await readIndustryArchive(archive.bytes,archive.name);assert.equal(restored.length,1);assert.deepEqual(restored[0]!.item!.packageContent!.files,result.item.packageContent!.files)
 await assert.rejects(buildCompleteBusinessPackage({...input,knowledge:[{...knowledge,contentHash:'a'.repeat(64)}]}),/正文摘要/)
 await assert.rejects(buildCompleteBusinessPackage({...input,knowledge:[{...knowledge,markdown:'a'.repeat(2*1024*1024+1)}]}),/2 MiB/)
})
test('当前业务员工从其他业务上游包移植时保留连接工作计划依赖，移除无关员工和计划',async()=>{
 const input=await fixture(),scope='business_60000000-0000-4000-8000-000000000001',source=input.roles[0]!,old=input.packages[0]!.item,manifest=structuredClone(old.manifest) as any
 manifest.resources.push({id:'unrelated-role',kind:'role',title:'无关员工',version:'1.0.0',required:true,source:{kind:'local',path:'unrelated-role.json'}},{id:'unrelated-plan',kind:'plan',title:'无关计划',version:'1.0.0',required:true,source:{kind:'local',path:'unrelated-plan.json'}})
 manifest.relations.push({kind:'role-work',from:'unrelated-role',to:'unrelated-plan'})
 const files=old.packageContent!.files.map(row=>({path:row.path,bytes:row.path==='teloa.json'?json(manifest):row.bytes}));files.push({path:'unrelated-role.json',bytes:json({format:'teloa.role/v1',kind:'employee',name:'无关员工',duty:'其他业务职责',dataScope:'其他数据',executionScope:'只读'})},{path:'unrelated-plan.json',bytes:json({format:'teloa.plan/v1',version:'1.0.0',title:'无关计划',workTemplate:'alert-triage-review',dataScope:'其他数据',trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Shanghai'}})})
 const item=await readIndustryDirectory(files.map(row=>({path:row.path,size:row.bytes.length,read:async()=>row.bytes})),'teloa.json','上游业务'),current={...input,scope,packages:[{loadId:'load-one',loadScope:'SOC',item}],roles:[{...source,role:{...source.role,scopes:[scope]},documents:source.documents.map(row=>({...row,resource:{...row.resource,scopeIds:[scope]}}))}],declarations:{...input.declarations,objectTypes:[]}}
 const result=await buildCompleteBusinessPackage(current);assert.ok(isIndustryManifest(result.item.manifest));const output=result.item.manifest
 assert.equal(result.counts.role,1);assert.equal(result.counts.plan,1);assert.equal(output.resources.some(row=>row.id.startsWith('unrelated-')),false)
 const exported=result.item.packageContent!.files
 assert.equal(exported.some(row=>/unrelated-(role|plan)\.json$/.test(row.path)),false)
 assert.equal(exported.some(row=>decode(row.bytes).includes('无关员工')||decode(row.bytes).includes('无关计划')),false)
 const sidecar=JSON.parse(decode(exported.find(row=>row.path==='packages/package-1/source-manifest.json.txt')!.bytes));assert.equal(sidecar.resources.some((row:{id:string})=>row.id.startsWith('unrelated-')),false)
 assert.ok(exported.some(row=>row.path==='packages/package-1/assets/diagram.png'));assert.ok(exported.some(row=>row.path==='packages/package-1/skills/investigate/references/guide.md'))

 for(const [kind,to] of [['role-connection','docs'],['role-connection','visualize'],['role-work','daily']] as const)assert.ok(output.relations.some(row=>row.kind===kind&&row.from==='analyst'&&row.to===to))
 for(const id of ['alert-triage-review','endpoint-isolation-record','daily','soc-endpoint-isolation','investigate'])assert.ok(output.resources.some(row=>row.id===id))
 const rows=inspectIndustryContent(output,result.item.packageContent!);assert.ok(rows.every(row=>!['invalid','unresolved','missing'].includes(row.state)))
 for(const row of rows)if(row.definition?.kind==='work-template')assert.equal(row.definition.manifest.domain,scope)
 const archive=await exportIndustryArchive(result.item),restored=await readIndustryArchive(archive.bytes,archive.name);assert.equal(restored.length,1);assert.deepEqual(restored[0]!.item!.manifest,output)
 await assert.rejects(buildCompleteBusinessPackage({...current,roles:current.roles.map(({origin:_origin,...row})=>row)}),/可信来源关联/)
 await assert.rejects(buildCompleteBusinessPackage({...current,roles:current.roles.map(row=>({...row,origin:{loadId:'load-one',localId:'docs'}}))}),/可信来源关联/)
})
test('完整业务包拒绝多包ID碰撞、损坏固定字节、缺员工知识或技能，不输出半份ZIP',async()=>{
 const input=await fixture()
 await assert.rejects(buildCompleteBusinessPackage({...input,packages:[...input.packages,{...input.packages[0]!,loadId:'load-two'}]}),/资源标识冲突/)
 const corrupted=structuredClone(input);corrupted.packages[0]!.item.packageContent!.files.find(row=>row.path==='assets/diagram.png')!.bytes[0]=9;await assert.rejects(buildCompleteBusinessPackage(corrupted),/固定内容已变化/)
 await assert.rejects(buildCompleteBusinessPackage({...input,roles:[{...input.roles[0]!,documents:[]}]}),/知识正文不完整/)
 await assert.rejects(buildCompleteBusinessPackage({...input,roles:[{...input.roles[0]!,skills:[]}]}),/技能静态正文不完整/)
})
test('缺少随包任务模板或动作输入不对齐时准确拒绝，保留原动作和默认动作',async()=>{
 const input=await fixture(),action=inspectIndustryContent(input.packages[0]!.item.manifest as any,input.packages[0]!.item.packageContent!).find(row=>row.id==='assign-alert-review')!
 assert.ok(action.definition?.kind==='business-action');const body=action.definition.definition
 await assert.rejects(buildCompleteBusinessPackage({...input,declarations:{...input.declarations,actions:[{localId:body.id,version:body.version,body:{...body,target:{kind:'work-template',localId:'missing-template'}}}]}}),/未闭合声明/)
 await assert.rejects(buildCompleteBusinessPackage({...input,declarations:{...input.declarations,actions:[{localId:body.id,version:body.version,body:{...body,inputs:body.inputs.slice(0,1)}}]}}),/输入数量/)
})
test('公共依赖缺正文及当前技能文件超过导入限制时拒绝导出',async()=>{
 const input=await fixture(),source=input.packages[0]!.item,manifest=structuredClone(source.manifest) as any;manifest.resources.find((row:any)=>row.id==='investigate').source={kind:'public',id:'public-investigate',version:'1.0.0'}
 const originalFiles=source.packageContent!.files.map(row=>({path:row.path,bytes:row.path==='teloa.json'?json(manifest):row.bytes})),item=await readIndustryDirectory(originalFiles.map(row=>({path:row.path,size:row.bytes.length,read:async()=>row.bytes})),'teloa.json','公共依赖')
 await assert.rejects(buildCompleteBusinessPackage({...input,packages:[{loadId:'load-one',item}]}),/尚未取得完整正文/)
 const skill=input.roles[0]!.skills[0]!,large='a'.repeat(2*1024*1024+1)
 await assert.rejects(buildCompleteBusinessPackage({...input,roles:[{...input.roles[0]!,skills:[{...skill,text:large,files:[{path:'SKILL.md',text:large}]}]}]}),/2 MiB/)
})


test('完整包纯打包器也拒绝跨scope知识或未投影的员工scope',async()=>{
 const input=await fixture(),source=input.roles[0]!
 for(const scopeIds of [['other'],['SOC','other']])await assert.rejects(buildCompleteBusinessPackage({...input,roles:[{...source,documents:source.documents.map(document=>({...document,resource:{...document.resource,scopeIds}}))}]}),{code:'teloa/complete-business-cross-scope'})
 await assert.rejects(buildCompleteBusinessPackage({...input,roles:[{...source,role:{...source.role,scopes:['SOC','other']}}]}),{code:'teloa/complete-business-cross-scope'})
})

test('排除员工入口与完整技能目录重叠时拒绝，不复制私文或生成缺静态依赖的半份技能',async()=>{
 const input=await fixture(),old=input.packages[0]!.item,manifest=structuredClone(old.manifest) as any
 manifest.resources.find((row:{id:string})=>row.id==='investigate').source={kind:'local',path:'SKILL.md'}
 manifest.resources.push({id:'excluded-role',kind:'role',title:'上游无关员工',version:'1.0.0',required:true,source:{kind:'local',path:'excluded-role.json'}})
 const original=old.packageContent!.files,files=original.map(row=>({path:row.path,bytes:row.path==='teloa.json'?json(manifest):row.bytes}))
 files.push({path:'SKILL.md',bytes:original.find(row=>row.path==='skills/investigate/SKILL.md')!.bytes},{path:'excluded-role.json',bytes:json({format:'teloa.role/v1',kind:'employee',name:'不导出的员工',duty:'私有职责',dataScope:'上游',executionScope:'只读'})})
 const item=await readIndustryDirectory(files.map(row=>({path:row.path,size:row.bytes.length,read:async()=>row.bytes})),'teloa.json','目录重叠'),scope='business_70000000-0000-4000-8000-000000000001',source=input.roles[0]!
 await assert.rejects(buildCompleteBusinessPackage({...input,scope,packages:[{loadId:'load-one',loadScope:'SOC',item}],roles:[{...source,role:{...source.role,scopes:[scope]},documents:source.documents.map(document=>({...document,resource:{...document.resource,scopeIds:[scope]}}))}],declarations:{...input.declarations,objectTypes:[]}}),/完整目录包含被排除或替换/)
})


test('当前正式业务配置替换原包看板资源和静态JSON，导出后页面定义闭合且可ZIP往返',async()=>{
 const input=await fixture(),configuration={...dashboardResourceFixture(),id:'current-business-configuration',version:'1.0.0'},current=configuration.configuration
 current.title='CURRENT_FORMAL_CONFIGURATION';current.pages[0]!.id='current-records';current.homePageId='current-records'
 const result=await buildCompleteBusinessPackage({...input,configuration});assert.ok(isIndustryManifest(result.item.manifest))
 const manifest=result.item.manifest,content=result.item.packageContent!,configurations=manifest.resources.filter(row=>row.kind==='business-configuration')
 assert.deepEqual(configurations.map(row=>row.id),['current-business-configuration'])
 assert.equal(manifest.resources.some(row=>row.id==='soc-overview'),false);assert.equal(content.files.some(row=>row.path==='packages/package-1/dashboards/soc.json'),false)
 const sidecar=JSON.parse(decode(content.files.find(row=>row.path==='packages/package-1/source-manifest.json.txt')!.bytes));assert.equal(sidecar.resources.some((row:{kind:string})=>row.kind==='business-configuration'),false)
 const inspected=inspectIndustryContent(manifest,content).find(row=>row.id==='current-business-configuration')!;assert.ok(inspected.definition?.kind==='business-configuration');assert.deepEqual(inspected.definition.definition,configuration)
 assert.equal(inspected.definition.definition.configuration.homePageId,'current-records');assert.deepEqual(content.files.find(row=>row.path==='packages/package-1/assets/diagram.png')!.bytes,new Uint8Array([0,255,13,77]))
 const archive=await exportIndustryArchive(result.item),restored=await readIndustryArchive(archive.bytes,archive.name);assert.equal(restored.length,1);assert.deepEqual(restored[0]!.item!.manifest,manifest);assert.deepEqual(restored[0]!.item!.packageContent!.files,content.files)
})

test('尚未应用正式配置时保留原包待准备看板，跨scope正式配置明确拒绝',async()=>{
 const input=await fixture(),without=await buildCompleteBusinessPackage({...input,configuration:null});assert.equal(without.counts['business-configuration'],1);assert.ok(without.item.packageContent!.files.some(row=>row.path==='packages/package-1/dashboards/soc.json'))
 const configuration=dashboardResourceFixture();configuration.configuration.scope='other';for(const row of configuration.configuration.definitions)row.definition.domain='other'
 await assert.rejects(buildCompleteBusinessPackage({...input,configuration}),{code:'teloa/complete-business-cross-scope'})
})
