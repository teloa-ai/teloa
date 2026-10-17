import assert from 'node:assert/strict'
import test from 'node:test'
import {registerHooks} from 'node:module'
import {existsSync} from 'node:fs'
import {readFile} from 'node:fs/promises'
import type {CapabilitySnapshot} from '@teloa/contract'
import {CAPABILITY_ROW_IDS,COMPOSITION_ROWS,compositionTargetScope,composeFromWorkspace} from '../src/client/industry-composition.ts'
import type {IndustryLoadRecord} from '../src/client/industry-load-api.ts'
import type {CapabilitySkillFact} from '../src/client/capability-skill-runtime.ts'

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
const {capabilitySkillLoadsKey}=await import('../src/client/capability-skill-runtime.ts')

test('工作室技能目录独立于任务运行的限定技能，空的已核验目录不会回退任务权限',()=>{
 const skill=(name:string)=>({name,description:name,source:'/skills/'+name,provider:'local',modelInvocable:true,userInvocable:true})
 const snapshot={skills:[skill('writing-revision')],connections:{status:'not-connected'}} as CapabilitySnapshot
 const studioSkills=[skill('find-skills'),skill('research')]
 const rows=capabilitySections({snapshot,studioSkills,loads:[]}).find(row=>row.id==='skill')!.items
 assert.deepEqual(rows.map(row=>row.title),['find-skills','research'])
 assert.deepEqual(capabilitySections({snapshot,studioSkills:[],loads:[]}).find(row=>row.id==='skill')!.items,[])
 assert.deepEqual(snapshot.skills.map(row=>row.name),['writing-revision'])
})

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

test('业务已核验关联安装只合并同一原生名与来源，保留友好名、原配置动作和独立技能',()=>{
 const nativeName='writing-bot-writing-revision-b212817e'
 const skill=(name:string,source='managed-original',provider='teloa-market')=>({name,description:'method',source,provider,modelInvocable:true,userInvocable:true})
 const native={nativeName,nativeSource:'managed-original',nativeProvider:'teloa-market'}
 const verified={loadId:alpha.id,itemInstanceId:'alpha-skill',status:'installed' as const,linked:true,installationId:'original-installation',...native}
 const skills=[skill(nativeName),skill('find-skills'),skill(nativeName+'-independent'),skill(nativeName,'other-original'),skill(nativeName,'managed-original','other-provider')]
 const compose=(fact:CapabilitySkillFact,loads:readonly IndustryLoadRecord[]=[alpha],key=capabilitySkillLoadsKey(loads))=>capabilitySections({loads,studioSkills:skills,skillRuntime:{loadsKey:key,state:'ready',facts:[fact]}}).find(row=>row.id==='skill')!.items
 const rows=compose(verified)
 assert.equal(rows.length,5)
 assert.equal(rows[0]!.title,'triage-标题');assert.equal(rows[0]!.instanceId,'alpha-skill');assert.equal(rows[0]!.skillStatus,'installed');assert.deepEqual(rows[0]!.go,{kind:'capabilities'})
 assert.deepEqual(rows.slice(1).map(row=>row.title),['find-skills',nativeName+'-independent',nativeName,nativeName])
 for(const change of [{...verified,linked:false},{...verified,nativeName:nativeName.toUpperCase()},{...verified,itemInstanceId:'other-instance'},{...verified,loadId:'other-load'}])assert.equal(compose(change).length,6)
 for(const status of ['unverified','unlinked','installed-unverified','disabled','missing','shadowed','mismatch','not-installed'] as const)assert.equal(compose({...verified,status}).length,6)
 const drift={...alpha,contentHash:'f'.repeat(64)}
 assert.equal(compose(verified,[drift],capabilitySkillLoadsKey([alpha])).length,6)
})

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

test('合并后按真实安装事实取最差一档：技能 A 已装、B 未安装时说待安装；接入源 A 连着、B 断了时说断开',()=>{
 const skillRuntime=(loads:readonly IndustryLoadRecord[])=>({loadsKey:capabilitySkillLoadsKey(loads),state:'ready' as const,facts:[{loadId:alpha.id,itemInstanceId:'alpha-skill',status:'installed' as const},{loadId:beta.id,itemInstanceId:'beta-skill',status:'not-installed' as const}]})
 const sections=capabilitySections({loads:[alpha,beta],skillRuntime:skillRuntime([alpha,beta])})
 assert.equal(sections.find(section=>section.id==='skill')!.items[0]!.state,'pending-install')
 assert.equal(sections.find(section=>section.id==='source')!.items[0]!.state,'disconnected')
 const skill=sections.find(section=>section.id==='skill')!.items[0]!
 assert.equal(skill.instanceId,'beta-skill','配置落点必须对应待安装的实例')
 assert.equal(skill.industry!.spaceName,beta.space.name)
 assert.equal(sections.find(section=>section.id==='source')!.items[0]!.instanceId,'beta-mcp')
 const reversed=capabilitySections({loads:[beta,alpha],skillRuntime:skillRuntime([beta,alpha])}).find(section=>section.id==='skill')!.items[0]!
 assert.equal(reversed.instanceId,'beta-skill','已安装条目不得覆盖待处理实例')
})

test('声明 active 不能冒充安装事实，旧加载或版本的迟到事实不能应用到当前能力行',()=>{
 const row=capabilitySections({loads:[alpha]}).find(section=>section.id==='skill')!.items[0]!
 assert.equal(row.state,'unverified');assert.equal(row.skillStatus,'unverified')
 const previous={loadsKey:capabilitySkillLoadsKey([alpha]),state:'ready' as const,facts:[{loadId:alpha.id,itemInstanceId:'alpha-skill',status:'installed' as const}]}
 const updated={...alpha,contentHash:'d'.repeat(64),items:alpha.items.map(item=>item.kind==='skill'?{...item,version:'2.0.0'}:item)}
 const current=capabilitySections({loads:[updated],skillRuntime:previous}).find(section=>section.id==='skill')!.items[0]!
 assert.equal(current.state,'unverified');assert.equal(current.skillStatus,'unverified');assert.equal(current.industry!.resourceVersion,'2.0.0')
 assert.deepEqual(capabilitySections({loads:[{...alpha,status:'unloaded'}],skillRuntime:previous}).find(section=>section.id==='skill')!.items,[])
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
