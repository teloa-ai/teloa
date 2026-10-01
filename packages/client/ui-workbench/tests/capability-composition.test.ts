import assert from 'node:assert/strict'
import test from 'node:test'
import {registerHooks} from 'node:module'
import {existsSync} from 'node:fs'
import {readFile} from 'node:fs/promises'
import type {CapabilitySnapshot} from '@teloa/contract'
import {CAPABILITY_ROW_IDS,COMPOSITION_ROWS,compositionTargetScope,composeFromWorkspace} from '../src/client/industry-composition.ts'
import type {IndustryLoadRecord} from '../src/client/industry-load-api.ts'

// capability-composition.ts 真值导入 industry-composition.js；跟 page-create-skill-content.test.ts 同样的取巧：
// Node 原生 TS 剥离不重写模块说明符，这里把它指回同目录的 .ts 源文件。
registerHooks({resolve(specifier,context,next){
 if(specifier.endsWith('.js')&&specifier.startsWith('.')&&context.parentURL?.includes('/ui-workbench/src/client/')){
  const source=new URL(specifier.slice(0,-3)+'.ts',context.parentURL)
  if(existsSync(source))return next(source.href,context)
 }
 return next(specifier,context)
}})
const {capabilitySections}=await import('../src/client/capability-composition.ts')

type LoadItem=IndustryLoadRecord['items'][number]
const loadItem=(localId:string,instanceId:string,kind:LoadItem['kind'],status:LoadItem['status']='active'):LoadItem=>
 ({localId,instanceId,kind,title:localId+'-标题',version:'1.0.0',required:true,status})
const load=(id:string,scope:string,items:LoadItem[]):IndustryLoadRecord=>({
 id,ownerId:'self',contentId:id+'-content',contentHash:'c'.repeat(64),
 templateId:'bundle-shared',templateVersion:'1.0.0',templateTitle:'共享方案',domain:'general',scope,description:'说明',targetVersion:1,
 space:{id:scope+'-space',name:scope+' 空间',version:1,scope},
 items,relations:[],entrypoints:[],createdAt:'2026-09-20T00:00:00.000Z',mappingHash:'m'.repeat(64),status:'active',
})

// 同一模板包（templateId 相同）分别加载到 alpha、beta 两个业务，localId 逐字相同：
// 技能、接入源、扩展是共享落点，理应各自只合并出一条；任务模板落点带 scope，理应逐业务各一条。
const alpha=load('load-alpha','alpha',[
 loadItem('triage','alpha-skill','skill','active'),
 loadItem('edr','alpha-mcp','mcp','active'),
 loadItem('ext','alpha-ext','plugin','active'),
 loadItem('wt','alpha-wt','work-template','active'),
])
const beta=load('load-beta','beta',[
 loadItem('triage','beta-skill','skill','pending-adapter'),
 loadItem('edr','beta-mcp','mcp','detached'),
 loadItem('ext','beta-ext','plugin','active'),
 loadItem('wt','beta-wt','work-template','active'),
])

test('capabilitySections 只产出跨业务复用的四行，顺序与 COMPOSITION_ROWS 过滤一致，不含 staff/knowledge/board',()=>{
 const sections=capabilitySections({loads:[]})
 const expected=COMPOSITION_ROWS.filter(row=>(CAPABILITY_ROW_IDS as readonly string[]).includes(row.id)).map(row=>row.id)
 assert.deepEqual(sections.map(section=>section.id),expected)
 assert.deepEqual(sections.map(section=>section.id),['skill','source','method','extension'])
 for(const id of ['staff','knowledge','board'])assert.equal(sections.some(section=>(section.id as string)===id),false)
})

test('同一模板加载到两个业务时技能/接入源/扩展各只出现一条且 origin.scopes 两个，任务模板出现两条各带一个 scope',()=>{
 const sections=capabilitySections({loads:[alpha,beta]})
 const bySection=(id:string)=>sections.find(section=>section.id===id)!

 const skill=bySection('skill')
 assert.equal(skill.items.length,1)
 assert.deepEqual(skill.items[0]!.origin,{kind:'business',scopes:['alpha','beta']})

 const source=bySection('source')
 assert.equal(source.items.length,1)
 assert.deepEqual(source.items[0]!.origin,{kind:'business',scopes:['alpha','beta']})

 const extension=bySection('extension')
 assert.equal(extension.items.length,1)
 assert.deepEqual(extension.items[0]!.origin,{kind:'business',scopes:['alpha','beta']})

 const method=bySection('method')
 assert.equal(method.items.length,2)
 assert.deepEqual(method.items.map(item=>item.origin),[{kind:'business',scopes:['alpha']},{kind:'business',scopes:['beta']}])
})

test('合并后状态取最差一档：技能 A 已装、B 只登记时说待安装；接入源 A 连着、B 断了时说断开',()=>{
 const sections=capabilitySections({loads:[alpha,beta]})
 assert.equal(sections.find(section=>section.id==='skill')!.items[0]!.state,'pending-install')
 assert.equal(sections.find(section=>section.id==='source')!.items[0]!.state,'disconnected')
 const skill=sections.find(section=>section.id==='skill')!.items[0]!
 assert.equal(skill.instanceId,'beta-skill','配置落点必须对应待安装的实例')
 assert.equal(skill.industry!.spaceName,beta.space.name)
 assert.equal(sections.find(section=>section.id==='source')!.items[0]!.instanceId,'beta-mcp')
 const reversed=capabilitySections({loads:[beta,alpha]}).find(section=>section.id==='skill')!.items[0]!
 assert.equal(reversed.instanceId,'beta-skill','已安装条目不得覆盖待处理实例')
})

const conversation:CapabilitySnapshot['conversation']={id:'conversation',sessionId:'session',requestedSessionId:'session',ownerId:'self',title:'当前会话',scopeIds:['general'],version:1,status:'ready',createdAt:'2026-09-20T00:00:00.000Z'}

test('原生 skill 与 observed 工具各落对应行且标记工作室来源，not-connected 不产条目',()=>{
 const observed:CapabilitySnapshot={
  schema:'teloa.capabilities/v1',conversation,observedAt:'2026-09-20T00:00:00.000Z',
  skills:[{name:'draft',description:'写初稿',source:'/skills/draft.md',provider:'local',modelInvocable:true,userInvocable:true}],
  knowledge:{status:'not-connected'},
  connections:{status:'observed',tools:[{name:'mcp__docs__search',description:'查资料'}]},
  writes:{status:'not-implemented'},
 }
 const sections=capabilitySections({snapshot:observed,loads:[]})
 const skillItem=sections.find(section=>section.id==='skill')!.items[0]!
 assert.equal(skillItem.origin.kind,'studio')
 assert.equal(skillItem.state,'installed')
 assert.equal(skillItem.go.kind,'capabilities')
 const sourceItem=sections.find(section=>section.id==='source')!.items[0]!
 assert.equal(sourceItem.origin.kind,'studio')
 assert.equal(sourceItem.state,'discovered','工具目录只证明发现，不能证明连接健康或认证成功')
 assert.equal(sourceItem.go.kind,'connectors')

 const notConnected:CapabilitySnapshot={...observed,connections:{status:'not-connected'}}
 assert.equal(capabilitySections({snapshot:notConnected,loads:[]}).find(section=>section.id==='source')!.items.length,0)
})

test('任务模板只按 work-template 类型取数，不混入同名自动化或业务动作；业务汇总仍保留它们',()=>{
 const mixed=load('mixed','general',[
  {...loadItem('template','template-instance','work-template','pending-adapter'),title:'每周简报'},
  {...loadItem('automation','plan-instance','plan'),title:'每周简报'},
  {...loadItem('action','action-instance','business-action'),title:'每周简报'},
 ])
 const methods=capabilitySections({loads:[mixed]}).find(section=>section.id==='method')!.items
 assert.deepEqual(methods.map(item=>item.instanceId),['template-instance'])
 assert.equal(methods[0]!.title,'每周简报')
 const business=composeFromWorkspace({scope:'general',loads:[mixed],roles:[]}).find(section=>section.id==='method')!
 assert.deepEqual(business.items.map(item=>item.id),['template-instance','plan-instance','action-instance'])
 const automationOnly=load('automation-only','general',[loadItem('automation','plan-instance','plan')])
 assert.deepEqual(capabilitySections({loads:[automationOnly]}).find(section=>section.id==='method')!.items,[])
})

test('compositionTargetScope 覆盖全部七种 CompositionTarget：带业务范围的返回 scope，共享落点返回 undefined',()=>{
 assert.equal(compositionTargetScope({kind:'team',scope:'general'}),'general')
 assert.equal(compositionTargetScope({kind:'business',scope:'general',section:'alpha'}),'general')
 assert.equal(compositionTargetScope({kind:'plans',scope:'general'}),'general')
 assert.equal(compositionTargetScope({kind:'capabilities'}),undefined)
 assert.equal(compositionTargetScope({kind:'knowledge'}),undefined)
 assert.equal(compositionTargetScope({kind:'connectors'}),undefined)
 assert.equal(compositionTargetScope({kind:'market',category:'plugin'}),undefined)
})

test('新模块源码不出现行业名或对象类型名',async()=>{
 const source=await readFile(new URL('../src/client/capability-composition.ts',import.meta.url),'utf8')
 assert.doesNotMatch(source,/SOC|AppSec|告警|资产|Splunk/)
})
