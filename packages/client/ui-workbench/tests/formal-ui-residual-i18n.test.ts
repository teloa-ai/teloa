import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {FORMAL_UI_RESIDUAL_MESSAGE_ROWS} from '../src/client/i18n/locales/formal-ui-residual.ts'
import {CONTINUOUS_DETAIL_MESSAGE_ROWS} from '../src/client/i18n/locales/continuous-details.ts'
import {roleStates,rolePeople} from '../src/client/role-preview.ts'
import {taskStates,attentionKinds} from '../src/client/task-preview.ts'
import {chineseUiLiterals} from './i18n-ast.ts'

const root=new URL('../src/client/',import.meta.url)
const pages=['Capabilities.tsx','PlanExecutionDirectory.tsx','ObjectConversations.tsx','TaskArtifactPicker.tsx','SettingsConfigurationGuide.tsx'] as const

test('正式 UI 残留区段的固定中文全部由语义词典提供',async()=>{
  for(const page of pages){
    const source=await readFile(new URL(page,root),'utf8')
    assert.match(source,/useI18n\(|i18n:TeloaI18n/,page)
    assert.deepEqual(chineseUiLiterals(source),[],page)
    assert.doesNotMatch(source,/(?:error|cause|caught|e) instanceof Error\?(?:error|cause|caught|e)\.message/,page)
  }
})

test('工作台会话上下文与面板 ARIA 使用产品词典',async()=>{
  const source=await readFile(new URL('WorkbenchFrame.tsx',root),'utf8')
  for(const key of ['frame.context.taskDetails','frame.context.roleDetails','frame.context.viewProfile','frame.context.owner','frame.context.businessDetails','frame.context.sourceAria','frame.nativeConversationAria','frame.nativeToolDetailsAria'])assert.match(source,new RegExp(`t\\('${key}'`))
  assert.doesNotMatch(source,/aria-label="(?:工作会话目录|当前会话来源|DSH 原生会话|原生工具详情)"/)
  const context=source.slice(source.indexOf("conversationObject.object.kind==='role'&&contextRole"),source.indexOf('nativeConversation',source.indexOf("conversationObject.object.kind==='role'&&contextRole")))
  assert.match(context,/team\.form\.employee/)
  assert.match(context,/role\.state\.paused/)
  assert.match(context,/navigation\.newConversation/)
  assert.match(context,/frame\.context\.viewProfile/)
  assert.match(context,/frame\.context\.owner/)
  assert.doesNotMatch(context,/frame\.context\.self|frame\.context\.back|actions\.openRole/)
})

test('正式 UI 残留词典覆盖十套主语言且使用统一术语',()=>{
  for(const row of FORMAL_UI_RESIDUAL_MESSAGE_ROWS){
    assert.equal(row.length,11,row[0])
    for(const value of row.slice(1))assert.ok(value.trim(),row[0])
  }
  const text=FORMAL_UI_RESIDUAL_MESSAGE_ROWS.flat().join('\n')
  assert.doesNotMatch(text,/Agent 预设|业务工作区/)
})

test('岗位、任务和待处理状态通过稳定词典键供正式页面消费',async()=>{
  assert.deepEqual(roleStates,{active:'role.state.active',paused:'role.state.paused',retired:'role.state.retired'})
  assert.deepEqual(taskStates,{ready:'status.ready',running:'status.running',paused:'status.paused',waiting:'status.waiting',blocked:'status.blocked',completed:'status.completed',cancelled:'status.cancelled'})
  assert.deepEqual(attentionKinds,{approval:'attention.approval',materials:'attention.materials',connection:'attention.connection',error:'attention.error',review:'attention.review',handoff:'attention.handoff',dispatch:'attention.dispatch',execution:'plan.run.prepared'})
  assert.deepEqual(rolePeople([]).map(person=>person.kind),['human'])
  const rows=new Map(FORMAL_UI_RESIDUAL_MESSAGE_ROWS.map(row=>[row[0],row]))
  for(const key of Object.values(roleStates))assert.equal(rows.get(key)?.length,11,key)
  for(const file of ['BusinessPage.tsx','CollaborationPage.tsx','TaskPage.tsx','TeamPage.tsx']){
    const source=await readFile(new URL(file,root),'utf8')
    assert.doesNotMatch(source,/\{(?:roleStates|taskStates|attentionKinds)\[[^\]]+\]\}/,file)
  }
})

test('计划执行深层组件不固定简体中文、服务错误或中文日期',async()=>{
  for(const file of ['PlanExecutionHistory.tsx','PlanScheduleSummary.tsx']){
    const source=await readFile(new URL(file,root),'utf8')
    assert.match(source,/useI18n\(/,file)
    assert.deepEqual(chineseUiLiterals(source,file),[],file)
    assert.doesNotMatch(source,/error\.message|cause\.message|toLocaleString\(['"]zh-CN/,file)
  }
})

test('协作群页不向用户透传原始异常',async()=>{
  const [entry,saved]=await Promise.all([
    readFile(new URL('CollaborationPage.tsx',root),'utf8'),
    readFile(new URL('SavedCollaborationPage.tsx',root),'utf8'),
  ])
  for(const source of [entry,saved])assert.doesNotMatch(source,/error instanceof Error\?error\.message/)
  assert.match(saved,/localizeWorkError\(locale,cause\)/)
  assert.doesNotMatch(entry,/<small>\{person\.kind\}<\/small>/)
})

test('一级产品术语统一为自动化与执行位置',async()=>{
  const automation={
    'zh-CN':'自动化','zh-Hant':'自動化',en:'Automation',ja:'自動化',ko:'자동화',vi:'Tự động hóa',es:'Automatización',fr:'Automatisation',de:'Automatisierung',pt:'Automação',
  } as const
  const executionLocation={
    'zh-CN':'执行位置','zh-Hant':'執行位置',en:'Execution locations',ja:'実行場所',ko:'실행 위치',vi:'Vị trí thực thi',es:'Ubicaciones de ejecución',fr:'Emplacements d’exécution',de:'Ausführungsorte',pt:'Locais de execução',
  } as const
  for(const locale of Object.keys(automation) as Array<keyof typeof automation>){
    const source=await readFile(new URL(`i18n/locales/${locale}.ts`,root),'utf8')
    const value=(key:string)=>source.match(new RegExp(`'${key.replaceAll('.','\\.')}': '([^']+)'`))?.[1]
    assert.equal(value('navigation.plans'),automation[locale],locale)
    assert.equal(value('settings.workspace'),executionLocation[locale],locale)
    assert.doesNotMatch(value('profile.description')??'',/单机|單機|工作空间|工作空間|workspace/i,locale)
  }
  const [simplified,traditional]=await Promise.all([
    readFile(new URL('i18n/locales/zh-CN.ts',root),'utf8'),
    readFile(new URL('i18n/locales/zh-Hant.ts',root),'utf8'),
  ])
  assert.match(simplified,/'continuous\.action\.create': '新建自动化'/)
  assert.match(traditional,/'continuous\.action\.create': '新增自動化'/)
  const integration=await readFile(new URL('settings-integration.ts',root),'utf8')
  assert.doesNotMatch(integration,/本机工作区/)
  assert.match(integration,/label:\(\)=>t\('settings\.workspace'\)/)
  for(const file of ['industry-template-presentation.ts','industry-workspace-projection.ts','role-configuration-relations.ts']){
    const source=await readFile(new URL(file,root),'utf8')
    assert.doesNotMatch(source,/持续工作/,file)
  }
})

test('自动化内部用具体触发方式说明配置',()=>{
  const rows=new Map(CONTINUOUS_DETAIL_MESSAGE_ROWS.map(row=>[row[0],row]))
  assert.equal(rows.get('continuous.form.schedule')?.[1],'定时执行')
  assert.equal(rows.get('continuous.form.event')?.[1],'事件触发')
  assert.equal(rows.get('continuous.form.schedule')?.length,11)
  assert.equal(rows.get('continuous.form.event')?.length,11)
})


test('AI-Native Team Studio 是唯一的工作室品牌名称',async()=>{
  for(const locale of ['zh-CN','zh-Hant','en','ja','ko','vi','es','fr','de','pt']){
    const source=await readFile(new URL(`i18n/locales/${locale}.ts`,root),'utf8')
    assert.match(source,/'app\.name': 'Teloa AI-Native Team Studio'/,locale)
    assert.doesNotMatch(source,/'app\.name': 'Teloa AI Studio'/,locale)
  }
  const english=await readFile(new URL('i18n/locales/en.ts',root),'utf8')
  assert.match(english,/'about\.studio': 'AI-Native Team Studio'/)
  for(const file of ['WorkHome.tsx','WorkbenchFrame.tsx','AboutSettings.tsx','conversation-brand.ts']){
    const source=await readFile(new URL(file,root),'utf8')
    assert.doesNotMatch(source,/>AI Studio<|return 'AI Studio'/,file)
  }
  const navigation=await readFile(new URL('../src/client/WorkNavigation.tsx',import.meta.url),'utf8')
  const home=await readFile(new URL('../src/client/WorkHome.tsx',import.meta.url),'utf8')
  const navigationStyles=await readFile(new URL('../src/client/WorkbenchFrame.module.css',import.meta.url),'utf8')
  assert.doesNotMatch(home,/className=\{css\.brand\}|darkLogo|lightLogo/)
  assert.match(navigation,/<div className=\{css\.brandHeading\}><img[^>]+alt="Teloa"\/><span className=\{css\.brandTier\}>\{application\.product\}<\/span><\/div><span className=\{css\.brandStudio\}>AI-Native Team Studio<\/span>/)
  assert.match(navigationStyles,/\.brandIdentity\{[^}]*flex-direction:column[^}]*align-items:flex-start/)
  assert.match(navigationStyles,/\.brandStudio\{[^}]*width:auto[^}]*text-align:left/)
})
