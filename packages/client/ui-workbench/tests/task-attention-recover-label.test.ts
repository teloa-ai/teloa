import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'

const root = new URL('../src/client/', import.meta.url)

test('恢复状态按钮使用独立的动作词条，状态描述仍用 unverified',async()=>{
  const source = await readFile(new URL('TaskPage.tsx', root), 'utf8')
  const stateRequestLine = source.split('\n').find(line=>line.includes('persistence?.stateRequest&&'))
  assert.ok(stateRequestLine, '找不到恢复状态横幅所在行')
  // 横幅前缀仍是状态描述，保留 unverified。
  assert.match(stateRequestLine!, /<span>\{t\('task\.attention\.unverified'\)\}/)
  // 按钮是动作，改用专属词条。
  assert.match(stateRequestLine!, /<button[^>]*onClick=\{[\s\S]*?\}>\{t\('task\.attention\.recover'\)\}<\/button>/)
  assert.doesNotMatch(stateRequestLine!, /<button[^>]*>\{t\('task\.attention\.unverified'\)\}<\/button>/)
  // 页顶不再重复裸露的未核对提示；具体操作与表格列仍保留状态描述。
  assert.doesNotMatch(source, /<p role="status">\{t\('task\.attention\.unverified'\)\}<\/p>/)
  // 目录选中/未选中时的状态描述由 task-list-render.test.ts 的真实组件渲染覆盖。
})
