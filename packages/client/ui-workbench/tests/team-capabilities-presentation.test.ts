import assert from 'node:assert/strict'
import test from 'node:test'
import {registerHooks} from 'node:module'
import {existsSync} from 'node:fs'
import type {CapabilitySnapshot} from '@teloa/contract'
import type {IndustryLoadRecord} from '../src/client/industry-load-api.ts'
import {projectIndustryWorkspace} from '../src/client/industry-workspace-projection.ts'
import {readFile} from 'node:fs/promises'

// team-capabilities-presentation.ts 现在真值导入 industry-composition.js；跟 page-create-skill-content.test.ts 同样的取巧：
// Node 原生 TS 剥离不重写模块说明符，这里把它指回同目录的 .ts 源文件。
registerHooks({resolve(specifier,context,next){
 if(specifier.endsWith('.js')&&specifier.startsWith('.')&&context.parentURL?.includes('/ui-workbench/src/client/')){
  const source=new URL(specifier.slice(0,-3)+'.ts',context.parentURL)
  if(existsSync(source))return next(source.href,context)
 }
 return next(specifier,context)
}})
const {teamCapabilityCatalog}=await import('../src/client/team-capabilities-presentation.ts')

const pageSource=await readFile(new URL('../src/client/TeamCapabilitiesPage.tsx',import.meta.url),'utf8')
const frameSource=await readFile(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8')

const conversation:CapabilitySnapshot['conversation']={id:'conversation',sessionId:'session',requestedSessionId:'session',ownerId:'self',title:'当前会话',scopeIds:['general'],version:1,status:'ready',createdAt:'2026-09-12T00:00:00.000Z'}
const snapshot:CapabilitySnapshot={schema:'teloa.capabilities/v1',conversation,observedAt:'2026-09-12T00:00:00.000Z',skills:[{name:'review',description:'核对资料',source:'/skills/review.md',provider:'local',modelInvocable:true,userInvocable:true}],knowledge:{status:'ready',resources:[{id:'resource',ownerId:'self',title:'调查手册',sourceId:'docs',sourceVersion:'a'.repeat(64),scopeIds:['general'],version:1,status:'active',createdAt:'2026-09-12T00:00:00.000Z',updatedAt:'2026-09-12T00:00:00.000Z'}]},connections:{status:'observed',tools:[{name:'mcp__edr__query',description:'查询告警'}]},writes:{status:'not-implemented'}}
test('团队能力目录只呈现 Skill 与接入源，不重复工作资料、市场扩展和配置方案',()=>{
 const catalog=teamCapabilityCatalog({snapshot})
 assert.deepEqual(catalog.categories.map(category=>[category.id,category.count]),[['skill',1],['source',1],['method',0],['extension',0]])
 assert.deepEqual(catalog.rows.map(row=>row.category),['skill','source'])
})

test('工作资料仍保留在能力快照中但不复制进团队能力目录',()=>{
 const catalog=teamCapabilityCatalog({snapshot})
 assert.equal(snapshot.knowledge.status,'ready')
 if(snapshot.knowledge.status==='ready')assert.equal(snapshot.knowledge.resources.length,1)
 assert.equal(catalog.rows.some(row=>row.key.startsWith('knowledge:')),false)
})

test('未读取原生目录时四个能力分类仍稳定显示零计数',()=>{
 const catalog=teamCapabilityCatalog({})
 assert.deepEqual(catalog.categories.map(category=>category.count),[0,0,0,0])
 assert.deepEqual(catalog.rows,[])
})

test('尚未接入会话时不呈现永久禁用的刷新入口',()=>{
 assert.doesNotMatch(pageSource,/disabled=\{state\.catalogStatus==='loading'\|\|state\.status!=='ready'\}/)
 assert.match(pageSource,/state\.status==='ready'\|\|category==='extension'/)
})

test('正式能力使用关系不再用页面内 demo 冒充持久化绑定',()=>{
 assert.doesNotMatch(pageSource,/CapabilityBindings/)
 assert.match(pageSource,/teamCapability\.bindingUnavailable\.title/)
 assert.match(pageSource,/teamCapability\.bindingUnavailable\.boundary/)
 assert.doesNotMatch(frameSource,/createCapabilityBinding/)
 assert.doesNotMatch(frameSource,/changeCapabilityBinding/)
 assert.doesNotMatch(frameSource,/from ['"]\.\/CapabilityBindings\.js['"]/)
 assert.match(frameSource,/from ['"]\.\/CapabilityTargetPanel\.js['"]/)
 assert.match(frameSource,/const configureBinding=\(_intentId:string\)=>actions\.openBinding\(null\)/)
 assert.doesNotMatch(frameSource,/bindings=\{\{/)
})

const industryLoad:IndustryLoadRecord={
 id:'12345678-1234-4234-8234-123456789012',ownerId:'self',contentId:'22345678-1234-4234-8234-123456789012',contentHash:'a'.repeat(64),templateId:'security-operations',templateVersion:'2.1.0',templateTitle:'安全运营',domain:'security',scope:'SOC',description:'安全运营工作环境',targetVersion:3,
 space:{id:'32345678-1234-4234-8234-123456789012',name:'安全运营',version:3,scope:'space-32345678-1234-4234-8234-123456789012'},
 items:[
  {localId:'triage',instanceId:'42345678-1234-4234-8234-123456789012',kind:'skill',title:'告警分诊',version:'1.4.0',required:true,status:'pending-adapter'},
  {localId:'edr',instanceId:'52345678-1234-4234-8234-123456789012',kind:'mcp',title:'EDR 连接',version:'3.0.0',required:true,status:'pending-adapter'},
  {localId:'plugin',instanceId:'62345678-1234-4234-8234-123456789012',kind:'plugin',title:'工单插件',version:'1.0.0',required:false,status:'pending-adapter'},
  {localId:'knowledge',instanceId:'72345678-1234-4234-8234-123456789012',kind:'knowledge',title:'调查手册',version:'1.0.0',required:true,status:'pending-adapter'},
 ],relations:[],entrypoints:[],createdAt:'2026-09-12T00:00:00.000Z',mappingHash:'b'.repeat(64),status:'active',
}

test('行业模板加载后的 Skill、MCP 连接进入团队能力；插件仍由市场安装与维护',()=>{
 const catalog=teamCapabilityCatalog({industryResources:projectIndustryWorkspace([industryLoad])})
 assert.deepEqual(catalog.categories.map(category=>[category.id,category.count]),[['skill',1],['source',1],['method',0],['extension',0]])
 assert.deepEqual(catalog.rows.map(row=>({key:row.key,category:row.category,title:row.title,status:row.status})),[
  {key:'industry:42345678-1234-4234-8234-123456789012',category:'skill',title:'告警分诊',status:'pending-install'},
  {key:'industry:52345678-1234-4234-8234-123456789012',category:'source',title:'EDR 连接',status:'disconnected'},
 ])
 assert.equal(catalog.rows.some(row=>row.title==='调查手册'),false)
 assert.equal(catalog.rows.some(row=>row.title==='工单插件'),false)
 assert.deepEqual(catalog.rows[0]?.industry,{spaceName:'安全运营',required:true,templateTitle:'安全运营',templateVersion:'2.1.0',resourceVersion:'1.4.0',templateId:'security-operations',contentHash:'a'.repeat(64)})
 assert.equal(catalog.rows[0]?.instanceId,'42345678-1234-4234-8234-123456789012')
})
