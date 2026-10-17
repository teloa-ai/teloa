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

test('能力配置保留六个同级原生分组，默认展开真实工作方式，记忆保留按需入口',()=>{
 const role=baseRole({storage:'persistent'})
 const html=render(role,{editing:true,memoryApi:{recoveryMessage:()=>undefined,pending:()=>false,list:async()=>[]},capabilitiesMarker:'ROLE-TOOL-GRANTS-CONTAINER'})
 const groups=[...html.matchAll(/<details id="role-profile-section-([^"]+)"([^>]*)>/g)]
 assert.deepEqual(groups.map(group=>group[1]),['how','tools','reading','limit','runtime','changes'])
 for(const group of groups)assert.equal(/\sopen(?:\s|=|$)/.test(group[2]!),group[1]==='how',`默认展开状态错误：${group[1]}`)
 for(const section of ROLE_PROFILE_SECTIONS.filter(section=>section!=='memory')){
  const {lead}=roleProfileSectionKeys(section)
  assert.ok(!html.includes(zh(lead)),`不再铺设泛说明副标题：${lead}`)
 }
 assert.ok(html.includes('1 项自主处理'),'摘要来自真实职责')
 assert.ok(html.includes('1 份已分配'),'只统计已分配资料，不宣称已读')
})

test('「编辑」态：既有元素逐项仍在渲染结果里（持久岗位）',()=>{
 const role=baseRole({storage:'persistent'})
 const html=render(role,{editing:true,memoryApi:{recoveryMessage:()=>undefined,pending:()=>false,list:async()=>[]},capabilitiesMarker:'ROLE-TOOL-GRANTS-CONTAINER'})
 // RoleKnowledge 的容器：aria-label 用的是 knowledge.rolePicker 词条。
 assert.ok(html.includes(zh('knowledge.rolePicker')),'RoleKnowledge 容器缺失')
 // RoleToolGrants 的真实实例由 WorkbenchFrame 组装并经 capabilities(id) 注入；这里验证 TeamPage 仍在持久岗位下调用它。
 assert.ok(html.includes('ROLE-TOOL-GRANTS-CONTAINER'),'capabilities(role.id) 未注入')
 assert.ok(html.includes('数据范围词条-仅限安全日志与告警平台的只读数据'),'role.dataScope 原文缺失')
 assert.ok(html.includes('执行范围词条-不直接改动线上系统只能提交建议工单'),'role.executionScope 原文缺失')
 for(const group of responsibilityGroups(responsibility))for(const item of group.items)assert.ok(html.includes(item),`职责条目缺失：${item}`)
 assert.ok(html.includes(zh('team.detail.knowledgeReadDesc')),'授权说明缺失：knowledgeReadDesc')
 assert.ok(html.includes(zh('team.detail.toolsConnectionsDesc')),'授权说明缺失：toolsConnectionsDesc')
 assert.ok(html.includes(zh('team.detail.formalApprovalDesc')),'授权说明缺失：formalApprovalDesc')
 assert.ok(html.includes('>变更记录</strong>'),'变更记录同级分组缺失')
 assert.ok(html.includes('变更记录词条-岗位创建'),'history 条目缺失')
})

// 分身已换成整页的 TwinProfile（详见 team-twin-profile.test.ts），不再走这六组折叠；
// 这条只守住「换了外壳之后，代拟编辑器与记忆的确认/撤回仍然可达」。
test('分身：代拟卡里仍是既有 TwinDraftEditor，判断力样本里演示记忆仍有确认/撤回按钮',()=>{
 const role=baseRole({kind:'twin',memories:[{id:'mem-1',title:'候选判断',text:'内容词条-代拟草稿的判断依据',source:'自评',scope:'private',status:'candidate',version:1,createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'}]})
 const html=render(role,{editing:true})
 assert.ok(html.includes(zh('twinDraft.title')),'TwinDraftEditor 缺失')
 assert.ok(html.includes(zh('team.memory.confirmDemo')),'记忆演示分支缺少确认按钮')
 assert.ok(html.includes(zh('team.memory.withdrawDemo')),'记忆演示分支缺少撤回按钮')
})

test('默认工作页签仅工作内容；记忆与日志按需打开，能力配置保留在隐藏的能力与设备页签',()=>{
 const html=render(baseRole({storage:'persistent'}),{editing:false,memoryApi:{recoveryMessage:()=>undefined,pending:()=>false,list:async()=>[]},capabilitiesMarker:'ROLE-TOOL-GRANTS-CONTAINER'})
 assert.match(html,/id="employee-detail-panel-work"[^>]*role="tabpanel"[^>]*aria-labelledby="employee-detail-tab-work"/)
 assert.match(html,/id="employee-detail-panel-capabilities"[^>]*hidden=""/)
 assert.ok(html.includes('ROLE-TOOL-GRANTS-CONTAINER'),'配置入口必须保留在能力页签')
 assert.equal((html.match(/role="tablist"/g)??[]).length,1,'只保留三页签的一组导航')
 assert.ok(html.includes('>它记得的事</button>'),'记忆入口无需开启编辑态')
 assert.ok(html.includes('>工作日志</button>'),'日志入口无需开启编辑态')
 assert.ok(!html.includes('id="role-memory-tab-note"'),'不再常驻第二组页签')
 assert.ok(!html.includes('id="role-memory-tab-log"'),'不再常驻第二组页签')
 assert.ok(!html.includes(zh('team.profile.timeline.title')),'不重复堆叠旧动态时间线')
})

test('个人主页职责只在姓名下呈现一次，「今天在做」之后不再重复',()=>{
 const duty='负责安全告警的初筛与结论输出'
 const rail=railOf(render(baseRole({duty:duty+'。'}),{editing:false}))
 assert.equal(rail.split(duty).length-1,1,'身份栏重复显示了同一段职责')
})

test('responsibilityGroups 的 labelKey 不含中文字面量（供六组呈现调用）',()=>{
 for(const group of responsibilityGroups(responsibility)){
  assert.ok('labelKey' in group,'缺少 labelKey 字段')
  assert.doesNotMatch(group.labelKey,/[一-龥]/,`labelKey 不应是中文字面量：${group.labelKey}`)
 }
})

// 隔离宿主实测缺陷（2026-09-16 验收）：展开第二个分组时整张工作台变白，控制台 `slot entry crashed in 'root':
// TypeError: Cannot read properties of null (reading 'open')`。真因是 `toggleSection` 在 `setOpenSections`
// 的更新函数里读 `event.currentTarget`——React 合成事件派发结束就把 `currentTarget` 置空，更新函数是之后才执行的。
// 没有 DOM 的裸 node 测试跑不出真实 toggle 事件，因此按仓内既有做法做源码守卫：`currentTarget` 只能在更新函数之外读。
test('toggleSection 不在状态更新函数内部读 event.currentTarget（React 合成事件会置空它）',async()=>{
 const {readFile}=await import('node:fs/promises')
 const source=await readFile(new URL('../src/client/TeamPage.tsx',import.meta.url),'utf8')
 const line=source.split('\n').find(row=>row.includes('const toggleSection ='))
 assert.ok(line,'找不到 toggleSection 定义')
 const updater=line.slice(line.indexOf('setOpenSections('))
 assert.ok(!updater.includes('currentTarget'),'setOpenSections 的更新函数里仍在读 event.currentTarget：'+updater)
 assert.match(line,/const open\s*=\s*event\.currentTarget\.open/,'toggleSection 应先在处理器里当场读出 open 再交给更新函数')
})

// 隔离宿主实测缺陷（2026-09-16 验收）：390 下个人主页仍是两栏（实测 `220px 103.984px`）。真因是窄屏单栏的
// `@media(max-width:900px){.homepage{…}}` 写在 `.homepage` 基线规则**之前**，同等特指度下后写的基线规则胜出，
// 这条断点规则从来没生效过。守卫：单栏断点必须出现在基线规则之后。
test('个人主页窄屏单栏断点写在 .homepage 基线规则之后（否则被同等特指度的基线覆盖）',async()=>{
 const {readFile}=await import('node:fs/promises')
 const css=await readFile(new URL('../src/client/TeamPage.module.css',import.meta.url),'utf8')
 const 基线=css.indexOf('.homepage{display:grid')
 const 断点=css.indexOf('@media(max-width:900px){.homepage{')
 assert.ok(基线>=0,'找不到 .homepage 基线规则')
 assert.ok(断点>=0,'找不到 .homepage 的窄屏单栏断点')
 assert.ok(断点>基线,'窄屏单栏断点写在基线规则之前，会被同等特指度的基线覆盖')
})

// 隔离宿主实测缺陷：`.identityRail{position:sticky}` 在 `.homepage` 是 grid 且未设 align-items 时会被拉满整行高度，
// sticky 永远没有多余空间可粘，等于失效。守卫：基线补 align-items:start，窄屏单栏断点里 identityRail 退回 static
// （原型 数字员工形象.module.css:107-110 同样的两条）。
test('个人主页 .homepage 基线含 align-items:start，窄屏单栏断点里 .identityRail 退回 position:static',async()=>{
 const {readFile}=await import('node:fs/promises')
 const css=await readFile(new URL('../src/client/TeamPage.module.css',import.meta.url),'utf8')
 assert.match(css,/\.homepage\{[^}]*align-items:start[^}]*\}/,'.homepage 基线缺少 align-items:start，sticky 身份栏会被拉满行高')
 assert.match(css,/@media\(max-width:900px\)\{\.homepage\{[^}]*\}\.identityRail\{position:static\}\}/,'窄屏单栏断点里 .identityRail 应退回 position:static')
})

// ── 终审修复 B：身份栏照原型只留人话，系统态全部进折叠 ──────────────────────────────
const railOf=(html:string)=>html.slice(html.indexOf('<aside class="identityRail"'),html.indexOf('</aside>'))

test('T2 身份栏不再常驻「生命周期」与「真实状态/阻断/下一步」，这四条挪进默认折叠的第六组「运行状态」',()=>{
 const role=baseRole()
 const rail=railOf(render(role,{editing:false}))
 for(const key of ['team.detail.lifecycle','team.detail.actualState','team.detail.blocker','team.detail.next']){
  assert.ok(!rail.includes(zh(key)),`身份栏不应再出现系统态：${key}`)
 }
 // 一条不删：展开态里四条原样都在，且落在第六组的 details 里。
 const editing=render(role,{editing:true})
 const body=editing.slice(editing.indexOf('id="role-profile-runtime"'),editing.indexOf('</dl>',editing.indexOf('id="role-profile-runtime"')))
 for(const key of ['team.detail.lifecycle','team.detail.actualState','team.detail.blocker','team.detail.next']){
  assert.ok(body.includes(zh(key)),`第六组缺少：${key}`)
 }
 assert.ok(body.includes(zh('team.detail.blocker.none')),'当前阻断的取值缺失')
})

test('T5 版本号不在页顶常驻，只在「它的变更记录」的折叠小字里',()=>{
 const role=baseRole()
 const version=zh('team.detail.version',{version:2})
 assert.ok(!railOf(render(role,{editing:false})).includes(version),'身份栏不应出现版本号')
 const editing=render(role,{editing:true})
 const changes=editing.slice(editing.indexOf('id="role-profile-changes"'))
 assert.ok(changes.includes(version),'版本号应落在「它的变更记录」的折叠小字里')
})

test('定稿联系区顺序为对话、语音、邀请；生命周期和完整配置保留在员工管理',()=>{
 const rail=railOf(render(baseRole(),{editing:false}))
 const labels=['对话','语音','邀请'],positions=labels.map(label=>rail.indexOf('aria-label="'+label+'"'))
 assert.ok(positions.every(index=>index>=0));assert.deepEqual(positions,[...positions].sort((a,b)=>a-b))
 for(const label of labels){const action=rail.match(new RegExp('<button[^>]*aria-label="'+label+'"[^>]*>([\\s\\S]*?)</button>'));assert.ok(action);assert.equal(action[1]!.replace(/<[^>]*>/g,''),'','联系动作用有提示的图标，不显示文字按钮')}
 assert.ok(rail.includes('>员工管理</button>'),'身份更多菜单保留员工管理入口')
 for(const key of ['team.profile.action.pause','team.profile.action.retire','team.action.edit'])assert.ok(!rail.includes(zh(key)),'管理动作按需在抽屉呈现')
})

test('暂停员工可继续原对话，工作页签的交办按钮禁用',()=>{
 const html=render(baseRole({state:'paused'}),{editing:false,talk:async()=>true})
 const buttons=html.match(/<button[^>]*>[\s\S]*?<\/button>/g)??[]
 const chat=buttons.find(button=>button.includes('aria-label="对话"'))
 const assign=buttons.find(button=>button.includes(zh('team.profile.action.assign')))
 assert.ok(chat);assert.doesNotMatch(chat,/disabled/)
 assert.ok(assign);assert.match(assign,/disabled/)
})

test('T3 身份栏照原型 数字员工形象.module.css:102 固定在视口顶',async()=>{
 const {readFile}=await import('node:fs/promises')
 const css=await readFile(new URL('../src/client/TeamPage.module.css',import.meta.url),'utf8')
 assert.match(css,/\.identityRail\{[^}]*position:sticky[^}]*top:0/)
})

test('身份栏「今天在做」按 border-box 计宽，整页详情允许作为窄屏 flex 子项收缩',async()=>{
 const {readFile}=await import('node:fs/promises')
 const css=await readFile(new URL('../src/client/TeamPage.module.css',import.meta.url),'utf8')
 assert.match(css,/\.identityToday\{[^}]*box-sizing:border-box[^}]*width:100%/,'content-box 会让卡片连同横向 padding 超出身份栏')
 assert.match(css,/\.detailPage\{[^}]*min-width:0[^}]*min-height:0/,'个人主页容器缺少 min-width:0 时会被内部内容撑宽并在窄屏裁切')
})
