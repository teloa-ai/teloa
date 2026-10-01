import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {roleWriteDefinition} from '@teloa/contract'
import {
 HIRE_ACTIONS, HIRE_DEFAULT_LIMITS, HIRE_LEVELS, HIRE_PRESETS,
 hireActionLabel, hireApplyLimits, hireAutoFields, hireDrifted, hireLevelLabel, hireMergeLimit, hireMergePreset,
 hirePresetExtraSkills, hirePresetFields, hirePresetLabel, hirePresetRecommendedSkills,
 type HireAction, type HireLevel,
} from '../src/client/role-hire-presets.ts'
import {runtimeConfigCanSave} from '../src/client/role-runtime-config.ts'

// .tsx 组件不能被 node 直接类型剥离，走 tsc 产物；CSS Modules 换成类名代理，断言只看结构不看样式
// （和 team-profile-sections.test.ts 同样的取巧）。
registerHooks({
 resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
})

const {RoleForm}=await import('../lib/types/client/TeamPage.js')
const {I18nProvider}=await import('../lib/types/client/i18n/provider.js')
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')

const zh=(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params)
const runtime={t:zh,subscribe:()=>()=>{},getSnapshot:()=>({locale:'zh-CN' as const,dshLocale:'zh',revision:1})}
const noop=()=>{}
// 纯函数逐句返回执行边界，界面层按语言拼；测试里统一用同一条词条当分隔符（L4）。
const JOIN=zh('team.hire.listJoin')
const joined=<T extends {executionScope:string[]}>(fields:T)=>({...fields,executionScope:fields.executionScope.join(JOIN)})

// ── 第一部分：三问预设 → 契约字段的纯函数映射 ─────────────────────────────

test('三个预设 × 默认边界，派生字段直接喂给契约 roleWriteDefinition 不抛；缺 name 时抛 teloa/invalid-input',()=>{
 for(const preset of HIRE_PRESETS){
  const derived=joined(hireApplyLimits({name:'新同事',kind:'employee',scopes:['general'],...hirePresetFields(preset,zh)},HIRE_DEFAULT_LIMITS,zh))
  assert.doesNotThrow(()=>roleWriteDefinition(derived),`预设 ${preset} 不应抛出`)
  const {name:_name,...withoutName}=derived
  assert.throws(()=>roleWriteDefinition(withoutName),(error:unknown)=>(error as {code?:unknown}).code==='teloa/invalid-input',`预设 ${preset} 缺 name 应抛 teloa/invalid-input`)
 }
})

test('五类动作 × 三档逐项：自己做进 autonomousActions、问你进 confirmationPoints、不能做进 executionScope 且都不串组',()=>{
 for(const action of HIRE_ACTIONS){
  for(const level of HIRE_LEVELS){
   const limits={...HIRE_DEFAULT_LIMITS,[action]:level} as Readonly<Record<HireAction,HireLevel>>
   const base=hirePresetFields(HIRE_PRESETS[0],zh)
   const applied=hireApplyLimits({name:'新同事',kind:'employee',scopes:['general'],...base},limits,zh)
   const sentence=zh(`team.hire.action.${action}.${level}`)
   const responsibility=applied.responsibility!
   if(level==='self'){
    assert.ok(responsibility.autonomousActions.includes(sentence),`${action}/${level} 应进 autonomousActions`)
    assert.ok(!responsibility.confirmationPoints.includes(sentence),`${action}/${level} 不应进 confirmationPoints`)
    assert.ok(!applied.executionScope.includes(sentence),`${action}/${level} 不应进 executionScope`)
   } else if(level==='ask'){
    assert.ok(responsibility.confirmationPoints.includes(sentence),`${action}/${level} 应进 confirmationPoints`)
    assert.ok(!responsibility.autonomousActions.includes(sentence),`${action}/${level} 不应进 autonomousActions`)
    assert.ok(!applied.executionScope.includes(sentence),`${action}/${level} 不应进 executionScope`)
   } else {
    assert.ok(applied.executionScope.includes(sentence),`${action}/${level} 应进 executionScope`)
    assert.ok(!responsibility.autonomousActions.includes(sentence),`${action}/${level} 不应进 autonomousActions`)
    assert.ok(!responsibility.confirmationPoints.includes(sentence),`${action}/${level} 不应进 confirmationPoints`)
   }
  }
 }
})

test('triggers / escalationRules / deliveryChecks 三组在任何预设下都非空',()=>{
 for(const preset of HIRE_PRESETS){
  const fields=hirePresetFields(preset,zh)
  const responsibility=fields.responsibility!
  assert.ok(responsibility.triggers.length>0,`${preset} triggers 不应为空`)
  assert.ok(responsibility.escalationRules.length>0,`${preset} escalationRules 不应为空`)
  assert.ok(responsibility.deliveryChecks.length>0,`${preset} deliveryChecks 不应为空`)
 }
})

test('不设 runtimeConfig 时 runtimeConfigCanSave 判据为 true，证明四问能走到底',()=>{
 assert.equal(runtimeConfigCanSave({initialAgentPresetId:undefined,agentPresetId:undefined,changed:false,directory:undefined}),true)
})

test('hirePresetExtraSkills 与 hirePresetLabel / hireActionLabel / hireLevelLabel 均产出非空人话文案',()=>{
 for(const preset of HIRE_PRESETS){
  assert.ok(hirePresetLabel(preset,zh).trim().length>0)
  for(const skill of hirePresetExtraSkills(preset,zh))assert.ok(skill.trim().length>0)
 }
 for(const action of HIRE_ACTIONS)assert.ok(hireActionLabel(action,zh).trim().length>0)
 for(const level of HIRE_LEVELS)assert.ok(hireLevelLabel(level,zh).trim().length>0)
})

// ── 复审修复轮 1：HIGH-1 / HIGH-2 / MEDIUM ────────────────────────────────

test('HIGH-1：dataScope 由预设 + 所选业务范围拼出一句固定话；不传 scopeSummary 时只有岗位基线句',()=>{
 const base=hirePresetFields('investigate',zh)
 // scopeSummary 是调用方（组件里用 list()）已经按当前语言拼好的一句摘要，纯函数不负责拼接列表（复审 LOW）。
 const withScopes=hirePresetFields('investigate',zh,'安全运营、应用安全')
 assert.ok(withScopes.dataScope.startsWith(base.dataScope),'带范围的 dataScope 应该在岗位基线句之后追加')
 assert.ok(withScopes.dataScope.includes('安全运营'),'dataScope 应包含选中的业务范围标签')
 assert.ok(withScopes.dataScope.includes('应用安全'),'dataScope 应包含选中的业务范围标签')
 assert.equal(hirePresetFields('investigate',zh,'').dataScope,base.dataScope,'空串等价于不传，只有岗位基线句')
})

test('MEDIUM：knowledge 永远是空数组，不会拿人话描述冒充资源 id',()=>{
 for(const preset of HIRE_PRESETS)assert.deepEqual(hirePresetFields(preset,zh).knowledge,[])
})

test('岗位卡推荐能力只用于展示，不会被冒充为运行时 Skill 名称写入新岗位',()=>{
 for(const preset of HIRE_PRESETS){
  assert.deepEqual(hirePresetFields(preset,zh).skills,[])
  assert.ok(hirePresetRecommendedSkills(preset,zh).length>0)
 }
})

test('HIGH-2：切三段开关（hireMergeLimit）只改 responsibility/executionScope，duty/skills/knowledge/dataScope 原样保留',()=>{
 const base=hirePresetFields('investigate',zh,'安全运营')
 // 模拟 pickPreset → 手动在②屏增减技能 → toggleLimit 这条路径。
 let value=joined(hireMergePreset({name:'新同事',kind:'employee',scopes:['general'],duty:'',dataScope:'',executionScope:'',skills:[],knowledge:[]},base,HIRE_DEFAULT_LIMITS,zh))
 const manualSkills=[...value.skills,'手动加的技能']
 value={...value,skills:manualSkills}
 const afterLimit=hireMergeLimit(value,base,{...HIRE_DEFAULT_LIMITS,send:'self'},zh)
 assert.deepEqual(afterLimit.skills,manualSkills,'切开关不应清空手动增减过的技能')
 assert.deepEqual(afterLimit.knowledge,value.knowledge,'切开关不应改动 knowledge')
 assert.equal(afterLimit.duty,value.duty,'切开关不应改动 duty')
 assert.equal(afterLimit.dataScope,value.dataScope,'切开关不应改动 dataScope')
 assert.ok(afterLimit.responsibility!.autonomousActions.includes(zh('team.hire.action.send.self')),'责任组应按新开关重新推导')
})

test('MEDIUM：切预设（hireMergePreset）会整体重置 duty/skills/knowledge/dataScope，和切开关的职责边界不同',()=>{
 const investigateBase=hirePresetFields('investigate',zh,'通用行政')
 const codeBase=hirePresetFields('code',zh,'通用行政')
 const value=joined(hireMergePreset({name:'新同事',kind:'employee',scopes:['general'],duty:'',dataScope:'',executionScope:'',skills:['手动加的技能'],knowledge:[]},investigateBase,HIRE_DEFAULT_LIMITS,zh))
 const afterPresetSwitch=hireMergePreset(value,codeBase,HIRE_DEFAULT_LIMITS,zh)
 assert.equal(afterPresetSwitch.duty,codeBase.duty,'切预设应换成新预设的 duty')
 assert.deepEqual(afterPresetSwitch.skills,codeBase.skills,'切预设应换成新预设的推荐技能，不保留旧预设手改的技能')
})

test('hireDrifted：没手动改过时为 false；改过 responsibility/dataScope/executionScope 后为 true',()=>{
 const base=hirePresetFields('investigate',zh,'通用行政')
 const auto=hireAutoFields(base,HIRE_DEFAULT_LIMITS,zh)
 const untouched={responsibility:auto.responsibility,dataScope:auto.dataScope,executionScope:auto.executionScope.join(JOIN)}
 assert.equal(hireDrifted(untouched,base,HIRE_DEFAULT_LIMITS,zh,JOIN),false)
 assert.equal(hireDrifted({...untouched,executionScope:untouched.executionScope+'（手动追加的一句话）'},base,HIRE_DEFAULT_LIMITS,zh,JOIN),true)
})

test('复审修复轮 2 · HIGH-1 补完：仅勾业务范围（不碰预设/开关）时 dataScope 立刻带上新范围，且不会被误判成手动漂移',()=>{
 // 模拟 applyScope 的合并方式：只更新 scopes 与 dataScope，responsibility/executionScope 走当前 presetBase 重新推导对比。
 const limits=HIRE_DEFAULT_LIMITS
 const initialSummary='通用行政'
 const initialBase=hirePresetFields('investigate',zh,initialSummary)
 let value=joined(hireMergePreset({name:'新同事',kind:'employee',scopes:['general'],duty:'',dataScope:'',executionScope:'',skills:[],knowledge:[]},initialBase,limits,zh))
 // 用户在②屏勾选了「安全运营」，没碰任何职责/边界的手改内容。
 const nextSummary='通用行政、安全运营'
 const nextDataScope=hirePresetFields('investigate',zh,nextSummary).dataScope
 value={...value,scopes:['general','SOC'],dataScope:nextDataScope}
 const nextBase=hirePresetFields('investigate',zh,nextSummary)
 assert.ok(value.dataScope.includes('安全运营'),'勾选范围后 dataScope 应立刻包含新范围标签')
 assert.equal(hireDrifted(value,nextBase,limits,zh,JOIN),false,'只勾了范围、没手改职责/边界，不应被判成漂移')
})

// ── 第二部分：RoleForm 外壳按 mode 渲染不同步骤条 ─────────────────────────

const renderForm=(role:Record<string,unknown>|undefined)=>renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime as never},createElement(RoleForm as never,{
 work:{},resourceApi:{},runtimeConfigs:undefined,initial:undefined,persistent:false,role,close:noop,save:noop,
} as never)))

const navHtml=(html:string)=>html.match(/<nav[^]*?<\/nav>/)?.[0]??''
const stepButtonCount=(html:string)=>(navHtml(html).match(/<button/g)??[]).length
// 标题走 <strong>…</strong> 精确定位，避免像「边界」这种短词被别的步骤说明文案（如「业务与授权边界」）碰巧命中子串。
const hasStepTitle=(html:string,key:string)=>navHtml(html).includes(`<strong>${zh(key)}</strong>`)

test('role===undefined（招一位新同事）：步骤条是四项，标题走 team.hire.step.*',()=>{
 const html=renderForm(undefined)
 assert.equal(stepButtonCount(html),4,'新建时应是四步')
 for(const key of ['team.hire.step.identity','team.hire.step.job','team.hire.step.limit','team.hire.step.badge']){
  assert.ok(hasStepTitle(html,key),`步骤条应包含 ${key}`)
 }
 for(const key of ['team.form.step.identity','team.form.step.scope','team.form.step.capabilities','team.form.step.runtime','team.form.step.review']){
  assert.ok(!hasStepTitle(html,key),`新建步骤条不应出现编辑态标题 ${key}`)
 }
})

test('role 非空（编辑既有岗位）：步骤条仍是五项，标题走 team.form.step.*',()=>{
 const role={
  name:'安全分析师',kind:'employee',scopes:['general'],state:'active',version:2,
  duty:'负责安全告警的初筛与结论输出。',
  dataScope:'数据范围词条-仅限安全日志与告警平台的只读数据',
  executionScope:'执行范围词条-不直接改动线上系统只能提交建议工单',
  skills:['日志检索'],knowledge:['kb-1'],
  responsibility:{triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]},
 }
 const html=renderForm(role)
 assert.equal(stepButtonCount(html),5,'编辑时应保持五步')
 for(const key of ['team.form.step.identity','team.form.step.scope','team.form.step.capabilities','team.form.step.runtime','team.form.step.review']){
  assert.ok(hasStepTitle(html,key),`步骤条应包含 ${key}`)
 }
 for(const key of ['team.hire.step.identity','team.hire.step.job','team.hire.step.limit','team.hire.step.badge']){
  assert.ok(!hasStepTitle(html,key),`编辑步骤条不应出现入职态标题 ${key}`)
 }
})

test('L4：执行边界逐句返回数组，拼接分隔符由调用方按语言给出，纯函数里不留中文分号',async()=>{
 const base=hirePresetFields('investigate',zh,'安全运营')
 const applied=hireApplyLimits({name:'新同事',kind:'employee',scopes:['general'],...base},{...HIRE_DEFAULT_LIMITS,change:'never',send:'never'},zh)
 assert.ok(Array.isArray(applied.executionScope),'executionScope 必须是逐句数组')
 assert.deepEqual(applied.executionScope,[base.executionScope,zh('team.hire.action.change.never'),zh('team.hire.action.send.never')].filter(Boolean))
 assert.equal(joined(applied).executionScope,applied.executionScope.join(JOIN))
 const source=await readFile(new URL('../src/client/role-hire-presets.ts',import.meta.url),'utf8')
 assert.doesNotMatch(source,/join\('；'\)/)
})
