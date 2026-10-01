import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {chineseUiLiterals} from './i18n-ast.ts'

const root = new URL('../src/client/', import.meta.url)

test('第二批核心页面通过同一 i18n provider 呈现主文案', async () => {
  for (const name of ['ContinuousPage.tsx', 'AboutSettings.tsx', 'PersonalProfileSettings.tsx', 'SettingsShell.tsx']) {
    const source = await readFile(new URL(name, root), 'utf8')
    assert.match(source, /useI18n\(/, name)
  }
})

test('核心页面不再固定简中 Intl 格式', async () => {
  for (const name of ['WorkHome.tsx', 'TeamPage.tsx', 'TaskPage.tsx', 'ContinuousPage.tsx']) {
    const source = await readFile(new URL(name, root), 'utf8')
    assert.doesNotMatch(source, /toLocaleString\(['"]zh-CN['"]/, name)
    assert.doesNotMatch(source, /Intl\.DateTimeFormat\(['"]zh-CN['"]/, name)
  }
})

test('第二批页面主标题和主操作不保留硬编码简中文案', async () => {
  const checks = {
    'ContinuousPage.tsx': ['持续工作沙盒', '新建沙盒计划', '暂无匹配的执行'],
    'AboutSettings.tsx': ['一个人，驾驭一支数字团队。', 'AI AI 员工工作室', '单机部署'],
    'PersonalProfileSettings.tsx': ['个人资料', '显示名称', '已保存。'],
    'SettingsShell.tsx': ['正在连接…', '连接已断开', '打开配置文件'],
  } as const
  for (const [name, phrases] of Object.entries(checks)) {
    const source = await readFile(new URL(name, root), 'utf8')
    for (const phrase of phrases) assert.doesNotMatch(source, new RegExp(phrase), `${name}: ${phrase}`)
  }
})

test('核心页面不直接向用户展示服务端异常 message', async () => {
  for (const name of ['TeamPage.tsx', 'TaskPage.tsx', 'ContinuousPage.tsx', 'SettingsShell.tsx', 'PersonalProfileSettings.tsx']) {
    const source = await readFile(new URL(name, root), 'utf8')
    assert.doesNotMatch(source, /instanceof Error\s*\?\s*\w+\.message/, name)
  }
})

test('三个核心目录的固定中文必须从词典取得', async () => {
  const sectionEnds = {
    'TeamPage.tsx': '\nfunction RoleDetail',
    'TaskPage.tsx': '\nexport function TaskForm',
    'ContinuousPage.tsx': '\nfunction PlanDetail',
  } as const
  const checks = {
    'TeamPage.tsx': ['岗位配置', '核对未完成交办', '继续核对岗位创建', '正在读取岗位…', '刷新已保存岗位', '岗位状态', '项未完成', '查看岗位示例', '员工有职责，也有边界'],
    'TaskPage.tsx': ['本机任务', '界面演示', '读取中…', '刷新任务', '待办目录', '任务目录', '任务业务范围', '需要你筛选', '工作 / 业务对象', '负责人', '进度', '尚未核对', '重置筛选', '查看任务与审批示例', '把决定留在工作上下文中'],
    'ContinuousPage.tsx': ['退出沙盒，返回已保存计划', '正在读取计划…', '刷新已保存计划', '进入界面沙盒', '核对未完成计划请求', '重试读取计划', '查看全部持续工作', '每次执行详情', '持续计划详情', '持续工作说明'],
  } as const
  for (const [name, phrases] of Object.entries(checks)) {
    const source = (await readFile(new URL(name, root), 'utf8')).split(sectionEnds[name as keyof typeof sectionEnds])[0]!
    for (const phrase of phrases) assert.doesNotMatch(source, new RegExp(phrase), `${name}: ${phrase}`)
  }
})

test('三个核心页目录区段没有绕过词典的中文 UI 文本', async () => {
  const sections = {
    'TeamPage.tsx': ['export function TeamPage', '\nfunction RoleDetail'],
    'TaskPage.tsx': ['export function TaskPage', '\nexport function TaskForm'],
    'ContinuousPage.tsx': ['export function ContinuousPage', '\nfunction PlanDetail'],
  } as const
  for (const [name, [start, end]] of Object.entries(sections)) {
    const source = await readFile(new URL(name, root), 'utf8')
    assert.deepEqual(chineseUiLiterals(source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start))),'page.tsx'), [], name)
  }
})

test('WorkbenchFrame 在页面边界前不保留服务端 error.message', async () => {
  const source = await readFile(new URL('WorkbenchFrame.tsx', root), 'utf8')
  assert.doesNotMatch(source, /instanceof Error\s*\?\s*\w+\.message/, 'WorkbenchFrame.tsx')
})

test('设置入口的可访问名称跟随当前语言', async () => {
  const brand = await readFile(new URL('SettingsBrand.tsx', root), 'utf8')
  const frame = await readFile(new URL('WorkbenchFrame.tsx', root), 'utf8')
  assert.match(brand, /t\(['"]shell\.settings['"]\)/)
  assert.doesNotMatch(brand, />设置</)
  assert.match(frame, /aria-label=\{t\(['"]shell\.settings['"]\)\}/)
  assert.doesNotMatch(frame, /aria-label=['"]设置['"]/)
})
