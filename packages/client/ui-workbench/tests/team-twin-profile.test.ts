import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {chineseUiLiterals} from './i18n-ast.ts'

// 与 team-profile-sections.test.ts 同一手法：.tsx 走 tsc 产物，CSS Modules 换成类名代理，断言只看结构不看样式。
registerHooks({
 resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
})

const {RoleDetail}=await import('../lib/types/client/TeamPage.js')
const {I18nProvider}=await import('../lib/types/client/i18n/provider.js')
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')
const {emptyTaskPreview}=await import('../lib/types/client/task-preview.js')
const {emptyCollaboration}=await import('../lib/types/client/collaboration-preview.js')
const {twinDisplayName}=await import('../lib/types/client/team-presentation.js')

const zh=(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params)
const runtime={t:zh,subscribe:()=>()=>{},getSnapshot:()=>({locale:'zh-CN' as const,dshLocale:'zh',revision:1})}
const noop=()=>{}
const noopNode=()=>null

// 分身示例岗位存的是第一人称的「我的分身」（role-preview.ts:31），界面上要按用户名显示。
const twinRole=(patch:Record<string,unknown>={})=>({
 id:'twin',name:'我的分身',kind:'twin',scopes:['general'],state:'active',version:1,
 duty:'按本人确认的偏好整理资料、代拟回复和判断建议。正式批准由本人完成。',
 dataScope:'本人可见且明确提供的资料。',executionScope:'仅代拟；不能代批、冒充本人或直接外发。',
 skills:['交班代拟'],knowledge:[],
 memories:[] as unknown[],
 history:[{text:'载入同事界面示例',actorId:'self',at:'2026-01-01T00:00:00.000Z'}],
 ...patch,
})

const render=(role:Record<string,unknown>,profileName='Max',conversations:()=>unknown=noopNode,talk?:(id:string)=>Promise<boolean>)=>renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime as never},createElement(RoleDetail as never,{
 profileName,
 work:{},resourceApi:{},memoryApi:undefined,runtimeConfigs:undefined,capabilityState:undefined,
 persistence:undefined,
 conversations,
 ...(talk?{talk}:{}),
 input:{draft:undefined,editing:false},
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
 capabilities:()=>null,
 plans:noopNode,
} as never)))

test('twinDisplayName 按用户名拼「{name} 的分身」，不用存储里的第一人称名',()=>{
 assert.equal(twinDisplayName('Max',zh),'Max 的分身')
 assert.equal(twinDisplayName('  李雷  ',zh),'李雷 的分身')
 assert.equal(twinDisplayName('Max'),'Max 的分身')
})

test('分身个人主页页头：人类头像 + 「Max 的分身」+ 代拟阶段徽标 + 副标题',()=>{
 const html=render(twinRole())
 assert.match(html,/<h1>Max 的分身<span class="stage">代拟阶段<\/span><\/h1>/)
 assert.ok(html.includes(zh('team.twin.subtitle',{name:'Max'})),'缺少副标题')
 // 「我的分身」是存储里的示例名，界面上任何地方都不该再出现。
 assert.ok(!html.includes('我的分身'),'页面上仍出现存储里的第一人称名「我的分身」')
 // 人类头像：圆形 avatar + human，与同事的六档色块头像刻意不同。
 assert.match(html,/class="avatar human[^"]*"/)
 assert.ok(html.includes(zh('team.detail.back')),'「全部员工」返回链接缺失')
})

test('分身个人主页三页签：代拟工作（默认当前）/ 判断力样本 / 授权边界',()=>{
 const html=render(twinRole())
 for(const key of ['team.twin.tab.draft','team.detail.tab.judgment','team.twin.tab.boundary'])assert.ok(html.includes(`>${zh(key)}</button>`),`页签缺失：${key}`)
 assert.match(html,/role="tab"[^>]*aria-selected="true"[^>]*>代拟工作<\/button>/,'默认当前页签应是「代拟工作」')
 assert.equal(html.split('aria-selected="true"').length-1,1,'同一时刻只能有一个当前页签')
 assert.match(html,/role="tablist"/,'页签组缺少 tablist 语义')
 assert.match(html,/role="tabpanel"[^>]*aria-labelledby=/,'内容区缺少与页签的关联')
 assert.ok(html.includes(zh('team.twin.tabsAria')),'页签组缺少 aria-label')
})

test('「代拟工作」页签：代拟未发送卡 + 既有 TwinDraftEditor + 找它说话入口',()=>{
 const html=render(twinRole({draft:{body:'代拟正文-今天需要你决定三件事。',version:1,editorId:'self',updatedAt:'2026-01-02T00:00:00.000Z'}}))
 assert.ok(html.includes(zh('team.twin.draft.badge')),'缺少「代拟 · 未发送」')
 assert.ok(html.includes(zh('team.twin.draft.title')),'缺少代拟卡标题')
 assert.ok(html.includes('代拟正文-今天需要你决定三件事。'),'代拟卡未呈现 role.draft 正文')
 assert.ok(html.includes(zh('team.twin.draft.edit')),'缺少「编辑代拟内容」')
 // 写入路径仍是既有 TwinDraftEditor（标题与保存按钮都来自它自己的词条）。
 assert.ok(html.includes(zh('twinDraft.title')),'代拟编辑器缺失')
 assert.ok(html.includes(zh('twinDraft.save')),'代拟编辑器的保存按钮缺失')
 assert.ok(html.includes(zh('team.twin.chat.note')),'缺少「本人确认后使用」说明')
 assert.ok(html.includes(zh('team.profile.action.chat')),'缺少「找它说话」入口')
 // 没有代拟稿时给一句话占位，不留空卡。
 assert.ok(render(twinRole()).includes(zh('team.twin.draft.empty')),'空代拟稿缺少占位说明')
})

test('「判断力样本」页签是既有分身记忆列表（twinPath 路径说明 + 演示确认/撤回）',()=>{
 const html=render(twinRole({memories:[{id:'mem-1',title:'候选判断',text:'内容词条-代拟草稿的判断依据',source:'自评',scope:'private',status:'candidate',version:1,createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'}]}))
 assert.ok(html.includes(zh('team.detail.tab.judgment')),'缺少「判断力样本」标题')
 assert.ok(html.includes(zh('team.memory.twinPath')),'缺少分身记忆的路径说明')
 assert.ok(html.includes(zh('team.memory.private')),'分身记忆应标注本人私有')
 assert.ok(html.includes('内容词条-代拟草稿的判断依据'),'记忆正文缺失')
 assert.ok(html.includes(zh('team.memory.confirmDemo')),'缺少确认按钮')
 assert.ok(html.includes(zh('team.memory.withdrawDemo')),'缺少撤回按钮')
})

test('「授权边界」页签：五条 dl + 上锁 callout，群内身份写成「Max 的分身」',()=>{
 const html=render(twinRole())
 assert.ok(html.includes(zh('team.twin.boundary.title')),'缺少「当前授权：代拟」')
 const terms=['canTerm','approvalTerm','identityTerm','memoryTerm','delegationTerm']
 for(const term of terms)assert.ok(html.includes(`<dt>${zh('team.twin.boundary.'+term)}</dt>`),`授权边界少一条词条：${term}`)
 assert.ok(html.includes(zh('team.twin.boundary.canDesc')),'缺少「可以」的内容')
 assert.ok(html.includes(zh('team.twin.boundary.approvalDesc',{name:'Max'})),'「正式批准」应写明由本人完成')
 assert.ok(html.includes(zh('team.twin.boundary.identityDesc',{name:'Max 的分身'})),'「群内身份」应显示「Max 的分身」')
 assert.ok(html.includes(zh('team.twin.boundary.memoryDesc')),'缺少「私人记忆」的内容')
 assert.ok(html.includes(zh('team.twin.boundary.delegationDesc')),'缺少「代批阶段」的内容')
 assert.ok(html.includes(zh('team.twin.boundary.callout')),'缺少「知道你的偏好，不等于拥有你的权限。」')
})

test('分身主页不再走同事的六组折叠与身份栏（整页换成分身形态）',()=>{
 const html=render(twinRole())
 assert.ok(!html.includes('identityRail'),'分身不应再渲染员工身份栏')
 assert.ok(!html.includes(zh('team.profile.timeline.title')),'分身不应再渲染员工的时间线标题')
 assert.ok(!html.includes(zh('team.profile.action.assign')),'分身不能交办任务，不该出现「交给它一件事」')
 assert.ok(!html.includes(zh('team.action.edit')),'默认分身不是可编辑岗位；代拟工作只能编辑草案正文')
 for(const key of ['team.profile.action.pause','team.profile.action.resume','team.profile.action.retire'])assert.ok(!html.includes(zh(key)),`默认分身不应出现岗位生命周期动作：${key}`)
})

test('已退役数字员工保留只读历史会话入口，不再提供对话与交办入口',()=>{
 const role=twinRole({id:'retired-analyst',name:'已退役分析师',kind:'employee',storage:'persistent',state:'retired',retirementReason:'岗位已结束'})
 const html=render(role,'Max',()=>createElement('div',{'data-history':'kept'},'历史会话'),async()=>true)
 assert.match(html,/data-history="kept"/,'退役后仍应能查看已关联的历史会话')
 assert.ok(html.includes(zh('team.profile.action.history')),'退役身份应直接提供“查看历史会话”')
 assert.ok(!html.includes(zh('team.profile.action.chat')),'退役身份不能再发起新会话')
 assert.ok(!html.includes(zh('team.profile.action.assign')),'退役身份不能再接收新任务')
})

test('分身页签在窄屏保持 44px 命中区',async()=>{
 const styles=await readFile(new URL('../src/client/TwinProfile.module.css',import.meta.url),'utf8')
 assert.match(styles,/@media\(max-width:760px\)\{[^}]*\.tabs\{[^}]*\}\.tabs button\{min-height:44px!important\}/)
})

test('退役对象的关联面板只读：可打开历史，但不能创建、关联、准备或解除',async()=>{
 const source=await readFile(new URL('../src/client/ObjectConversations.tsx',import.meta.url),'utf8')
 assert.match(source,/<button type="button" disabled=\{!object\.canStart\|\|blocked\} onClick=\{create\}/)
 assert.ok(source.includes('<select value={chosen} onChange={event=>setChosen(event.target.value)} disabled={!object.canStart||blocked}>'))
 assert.match(source,/disabled=\{!object\.canStart\|\|blocked\|\|!chosen\}/)
 assert.match(source,/disabled=\{blocked\|\|!object\.canStart\|\|!conversation\|\|archived\}/)
 assert.match(source,/disabled=\{blocked\|\|!object\.canStart\} onClick=\{\(\)=>void act\(\(\)=>unlink/)
 assert.match(source,/disabled=\{busy\|\|archived\|\|\(!conversation&&!taskRun\)\} onClick=\{\(\)=>void act\(\(\)=>open/,'打开历史不应受 canStart 限制')
})

const {StaffRoster}=await import('../lib/types/client/StaffRoster.js')
const rosterMarkup=(profileName?:string)=>renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime as never},createElement(StaffRoster as never,{
 roles:[twinRole(),twinRole({id:'analyst',name:'安全分析师',kind:'employee'})],
 labels:[{scope:'general',title:'通用工作',kind:'builtin',loads:0,activeLoads:0,tasks:0,groups:0}],
 tasks:[],fold:{toggled:[]},onFoldChange:noop,searching:false,onSelect:noop,onHire:noop,
 ...(profileName?{profileName}:{}),
} as never)))

test('同事名单行：分身按「Max 的分身」显示，数字员工仍照 role.name',()=>{
 const html=rosterMarkup('Max')
 assert.ok(html.includes('<strong>Max 的分身</strong>'),'名单行没按用户名显示分身')
 assert.ok(!html.includes('我的分身'),'名单里仍出现存储里的第一人称名')
 assert.ok(html.includes('<strong>安全分析师</strong>'),'AI 员工的名字不该被改写')
 // 不传 profileName 时退回默认用户名（personalProfile 的 defaultPersonalDisplayName），不会退回第一人称名。
 assert.ok(!rosterMarkup().includes('我的分身'))
})

test('TwinProfile.tsx 的固定 UI 中文全部经词典呈现',async()=>{
 const source=await readFile(new URL('../src/client/TwinProfile.tsx',import.meta.url),'utf8')
 assert.deepEqual(chineseUiLiterals(source,'TwinProfile.tsx'),[])
})

// 用户两次否决页面上的强调色竖条（design specification）：同事信息页上的分隔线一律中性。
// --teloa-focus 与 --teloa-accent 在 theme-tokens.module.css 里是同一枚品牌红，所以两个名字都要守。
test('TeamPage.module.css 的 border-left/border-top 不得引用强调色或身份色',async()=>{
 const css=await readFile(new URL('../src/client/TeamPage.module.css',import.meta.url),'utf8')
 const offenders=[...css.matchAll(/border-(?:left|top)[^;}]*/g)].map(match=>match[0]).filter(rule=>/--teloa-accent|--teloa-focus|--staff-/.test(rule))
 assert.deepEqual(offenders,[],'着色线必须改成中性 var(--teloa-border)')
})
