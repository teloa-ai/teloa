import './employee-asset-test-loader.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'

// .tsx 组件不能被 node 直接类型剥离，走 tsc 产物；CSS Modules 换成类名代理，断言只看结构不看样式
// （和 team-avatar.test.ts / evidence-list.test.ts 同样的取巧）。
registerHooks({
 resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
})

const {RoleDetail}=await import('../lib/types/client/TeamPage.js')
const {responsibilityGroups}=await import('../lib/types/client/role-runtime-config.js')
const {ROLE_PROFILE_SECTIONS,roleProfileSectionKeys}=await import('../lib/types/client/role-profile-sections.js')
const {I18nProvider}=await import('../lib/types/client/i18n/provider.js')
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')
const {emptyTaskPreview}=await import('../lib/types/client/task-preview.js')
const {emptyCollaboration}=await import('../lib/types/client/collaboration-preview.js')

const zh=(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params)
const runtime={t:zh,subscribe:()=>()=>{},getSnapshot:()=>({locale:'zh-CN' as const,dshLocale:'zh',revision:1})}
const noop=()=>{}
const noopNode=()=>null

const responsibility={
 triggers:['触发词条-新告警进入队列'],
 autonomousActions:['自主词条-关联证据链'],
 confirmationPoints:['核对词条-提交处置前需核对'],
 escalationRules:['升级词条-证据冲突时升级'],
 deliveryChecks:['交付词条-结论必须附来源'],
}

const baseRole=(patch:Record<string,unknown>={})=>({
 id:'role-1',name:'安全分析师',kind:'employee',scopes:['general'],state:'active',version:2,
 duty:'负责安全告警的初筛与结论输出。',
 dataScope:'数据范围词条-仅限安全日志与告警平台的只读数据',
 executionScope:'执行范围词条-不直接改动线上系统只能提交建议工单',
 skills:['日志检索'],knowledge:['kb-1'],
 responsibility,
 memories:[] as unknown[],
 history:[{text:'变更记录词条-岗位创建',actorId:'self',at:'2026-01-01T00:00:00.000Z'}],
 ...patch,
})

const baseInput={draft:undefined}

const render=(role:Record<string,unknown>,options:{editing:boolean;capabilitiesMarker?:string;memoryApi?:unknown;talk?:(roleId:string)=>Promise<boolean>}={editing:true})=>renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime as never},createElement(RoleDetail as never,{
 work:{},resourceApi:{},memoryApi:options.memoryApi,runtimeConfigs:undefined,capabilityState:undefined,
 persistence:undefined,
 conversations:noopNode,
 ...(options.talk?{talk:options.talk}:{}),
 input:{...baseInput,editing:options.editing},
 update:noop,
 role,
 state:{...emptyTaskPreview(),roles:[role]},
 collaboration:emptyCollaboration(),
 change:noop,
 back:noop,
 openTask:noop,
 openGroup:noop,
 resources:noop,
 nativeSettings:noop,
 capabilities:(id:string)=>createElement('div',{'data-capabilities-node':id},options.capabilitiesMarker??'capabilities-marker'),
 plans:noopNode,
} as never)))

test('能力页平铺六个章节，复杂授权独立保留，职责原文不丢失',()=>{
 const html=render(baseRole({storage:'persistent'}),{editing:true,capabilitiesMarker:'ROLE-TOOL-GRANTS-CONTAINER'})
 const sections=[...html.matchAll(/<section id="role-profile-section-([^"]+)"/g)].map(match=>match[1])
 assert.deepEqual(sections,['how','tools','reading','limit','runtime','changes'])
 assert.doesNotMatch(html,/<details id="role-profile-section-/)
 for(const group of responsibilityGroups(responsibility))for(const item of group.items)assert.ok(html.includes(item),item)
 for(const value of ['ROLE-TOOL-GRANTS-CONTAINER','数据范围词条-仅限安全日志与告警平台的只读数据','执行范围词条-不直接改动线上系统只能提交建议工单','变更记录词条-岗位创建'])assert.ok(html.includes(value),value)
 for(const key of ['team.detail.knowledgeReadDesc','team.detail.toolsConnectionsDesc','team.detail.formalApprovalDesc'])assert.ok(html.includes(zh(key)),key)
})

test('默认工作页签不混入能力编辑器，记忆日志和权限仍有入口',()=>{
 const html=render(baseRole({storage:'persistent'}),{editing:false})
 assert.match(html,/id="employee-detail-panel-work"[^>]*role="tabpanel"/)
 assert.match(html,/id="employee-detail-panel-capabilities"[^>]*hidden=""/)
 for(const label of ['它记得的事','工作日志','委托与工具授权','员工管理'])assert.ok(html.includes(label),label)
 assert.equal((html.match(/role="tablist"/g)??[]).length,1)
})

test('员工身份区只展示一次职责，系统运行详情与版本保留在能力页',()=>{
 const role=baseRole(),html=render(role,{editing:false}),rail=html.slice(html.indexOf('<aside class="identityRail"'),html.indexOf('</aside>'))
 assert.equal(rail.split('负责安全告警的初筛与结论输出').length-1,1)
 for(const key of ['team.detail.lifecycle','team.detail.actualState','team.detail.blocker','team.detail.next']){assert.ok(!rail.includes(zh(key)),key);assert.ok(html.includes(zh(key)),key)}
 assert.ok(html.includes(zh('team.detail.version',{version:2})))
})

test('暂停员工仍可打开原对话，但不能交办新工作',()=>{
 const html=render(baseRole({state:'paused'}),{editing:false,talk:async()=>true}),buttons=html.match(/<button[^>]*>[\s\S]*?<\/button>/g)??[]
 const chat=buttons.find(button=>button.replace(/<[^>]*>/g,'')==='发消息'),assign=buttons.find(button=>button.includes(zh('team.profile.action.assign')))
 assert.ok(chat);assert.doesNotMatch(chat,/disabled/);assert.ok(assign);assert.match(assign,/disabled/)
})

test('分身代拟与候选记忆的确认和撤回能力保留',()=>{
 const role=baseRole({kind:'twin',memories:[{id:'mem-1',title:'候选判断',text:'内容词条-代拟草稿的判断依据',source:'自评',scope:'private',status:'candidate',version:1,createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'}]})
 const html=render(role,{editing:true})
 for(const key of ['twinDraft.title','team.memory.confirmDemo','team.memory.withdrawDemo'])assert.ok(html.includes(zh(key)),key)
})
