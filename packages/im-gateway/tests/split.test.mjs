// 源自 dsh-im-gateway（https://github.com/zhuiyueya/dsh-im-gateway，commit c907dd5，MIT，Copyright (c) 2026 zhuiyueya）。
// Teloa 修改：import 改指源码 ../src/core/split.ts；前缀改为可选（默认关闭），带前缀用例显式传 { prefix: true }。许可全文见 packages/im-gateway/licenses/dsh-im-gateway.LICENSE，来源记录见 provenance/dsh-im-gateway.md。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitText } from '../src/core/split.ts'

test('短文本不分片', () => {
  assert.deepEqual(splitText('hello', 4096), ['hello'])
})

test('恰好等于上限不分片', () => {
  assert.deepEqual(splitText('a'.repeat(100), 100), ['a'.repeat(100)])
})

test('超过上限按字符切分', () => {
  const parts = splitText('x'.repeat(250), 100, { prefix: true })
  assert.ok(parts.length >= 3)
  for (const p of parts) assert.ok([...p].length <= 100, `part too long: ${p.length}`)
  assert.equal(parts.join('').replace(/（\d+\/\d+）/g, ''), 'x'.repeat(250))
})

test('中文文本在句号处断行', () => {
  const text = '第一句话。第二句话。第三句话。第四句话。'
  const parts = splitText(text, 10, { prefix: true })
  // 每段结尾应是句号（除最后一段）
  for (let i = 0; i < parts.length - 1; i += 1) {
    const body = parts[i].replace(/（\d+\/\d+）/, '')
    assert.ok(body.endsWith('。'), `段 ${i} 未在句号断行: ${body}`)
  }
  assert.equal(parts.join('').replace(/（\d+\/\d+）/g, ''), text)
})

test('前缀带分段序号且收敛', () => {
  const parts = splitText('y'.repeat(300), 120, { prefix: true })
  assert.ok(parts.length >= 3)
  const last = parts[parts.length - 1]
  const m = last.match(/（(\d+)\/(\d+)）/)
  assert.ok(m, '最后一段应有前缀')
  assert.equal(Number(m[1]), parts.length)
  assert.equal(Number(m[2]), parts.length)
})

test('换行优先断行', () => {
  const text = 'line1\nline2\nline3\nline4\nline5\n'
  const parts = splitText(text, 12, { prefix: true })
  for (let i = 0; i < parts.length - 1; i += 1) {
    const body = parts[i].replace(/（\d+\/\d+）/, '')
    assert.ok(body.endsWith('\n'), `段 ${i} 未在换行断行: ${JSON.stringify(body)}`)
  }
})

test('空文本返回空数组', () => {
  assert.deepEqual(splitText('', 100), [])
})

test('max=0 时原样返回', () => {
  assert.deepEqual(splitText('abc', 0), ['abc'])
})

// ── Teloa 新增 ──

test('prefix 默认关闭：首片不含「（1/」，拼回等于原文且每片 ≤max', () => {
  const text = '第一句话。第二句话。第三句话。第四句话。'
  const parts = splitText(text, 10)
  assert.ok(parts.length >= 2)
  assert.ok(!parts[0].includes('（1/'))
  assert.equal(parts.join(''), text)
  for (const p of parts) assert.ok([...p].length <= 10)
  for (let i = 0; i < parts.length - 1; i += 1) assert.ok(parts[i].endsWith('。'))
})

test('按码点计数：代理对字符不被劈开', () => {
  const text = '😀'.repeat(25)
  for (const parts of [splitText(text, 10), splitText(text, 10, { prefix: true })]) {
    assert.equal(parts.join('').replace(/（\d+\/\d+）/g, ''), text)
    for (const p of parts) {
      assert.ok([...p].length <= 10)
      assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(p), '不得出现孤立代理项')
    }
  }
})

test('M1：prefix 模式前缀位数变长（9→10 段）时按真实段数重切，不截断正文（含代理对）', () => {
  for (const text of ['z'.repeat(900), '😀'.repeat(900), '好'.repeat(450) + '😀'.repeat(450)]) {
    const parts = splitText(text, 100, { prefix: true })
    assert.ok(parts.length >= 10)
    assert.equal(parts.map((p) => p.replace(/^（\d+\/\d+）/, '')).join(''), text)
    parts.forEach((p, i) => {
      assert.ok([...p].length <= 100, `段 ${i} 超长`)
      assert.ok(p.startsWith(`（${i + 1}/${parts.length}）`), `段 ${i} 前缀错: ${p.slice(0, 8)}`)
    })
  }
})
