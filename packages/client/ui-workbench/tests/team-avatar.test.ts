import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {staffAvatarSeed, STAFF_AVATAR_TONES, STAFF_AVATAR_SHAPES} from '../src/client/staff-avatar-seed.ts'

const clientRoot = new URL('../src/client/', import.meta.url)
const baseline = JSON.parse(await readFile(new URL('./fixtures/ui-freeze-baseline.json', import.meta.url), 'utf8'))

// 和 evidence-list.test.ts 同样的取巧：.tsx 走 tsc 产物，CSS Modules 换成类名代理。
registerHooks({
  resolve: (specifier, context, next) => specifier.endsWith('.module.css') ? {url: new URL(specifier, context.parentURL).href, shortCircuit: true} : next(specifier, context),
  load: (url, context, next) => url.endsWith('.module.css') ? {format: 'module', shortCircuit: true, source: 'export default new Proxy({},{get:(_,key)=>String(key)})'} : next(url, context),
})
const {StaffAvatar} = await import('../lib/types/client/StaffAvatar.js')

test('staffAvatarSeed 同一 seed 两次派生一致', () => {
  assert.deepEqual(staffAvatarSeed('role-1'), staffAvatarSeed('role-1'))
})

test('staffAvatarSeed 二十个种子覆盖到至少 4 档 tone 与 4 档 shape（防止哈希退化）', () => {
  // 真实种子是岗位 id（多字符），不是单个字母——单字母 ASCII 码差值太小，`>>3` 会把变化压没，不是哈希退化。
  const seeds = Array.from({length: 20}, (_, index) => 'role-' + index)
  const looks = seeds.map(seed => staffAvatarSeed(seed))
  assert.ok(new Set(looks.map(look => look.tone)).size >= 4)
  assert.ok(new Set(looks.map(look => look.shape)).size >= 4)
  assert.ok(looks.every(look => look.tone >= 0 && look.tone < STAFF_AVATAR_TONES))
  assert.ok(looks.every(look => look.shape >= 0 && look.shape < STAFF_AVATAR_SHAPES))
})

test('StaffAvatar 渲染输出 aria-hidden（形象是装饰，名字另有文字呈现）', () => {
  const markup = renderToStaticMarkup(createElement(StaffAvatar, {initial: 'A', seed: 'role-1'}))
  assert.match(markup, /aria-hidden="true"/)
})

// 身份色是内容色：六档固定设计值不能映射到界面状态令牌；原型同步在 test:prototype 单独核对。
test('StaffAvatar.module.css 六档身份色与公开设计黄金逐字一致', async () => {
  const source = await readFile(new URL('StaffAvatar.module.css', clientRoot), 'utf8')
  const tonesOf = (css: string) => {
    const found = new Map<string, string>()
    for (const match of css.matchAll(/\.(tone\d)\{([^}]*)\}/g)) found.set(match[1] ?? '', (match[2] ?? '').trim())
    return found
  }
  const expected = baseline.staffAvatarTones, actual = tonesOf(source)
  assert.equal(expected.length, STAFF_AVATAR_TONES, '设计黄金应有六档身份色')
  assert.equal(actual.size, STAFF_AVATAR_TONES, '正式头像应有六档身份色')
  for (let tone = 0; tone < STAFF_AVATAR_TONES; tone++) {
    const key = 'tone' + tone
    assert.equal(actual.get(key), expected[tone], `${key} 与设计黄金不一致`)
    // 三个变量名是对外契约：市场插画 artTone0-5 复用同一套名字。
    for (const variable of ['--staff-bg', '--staff-ink', '--staff-glyph']) assert.ok(actual.get(key)?.includes(variable + ':'), `${key} 缺少 ${variable}`)
  }
  // 身份色不再经由状态令牌，否则「一致」可能只是巧合。
  assert.doesNotMatch(source, /--staff-(bg|ink|glyph):var\(--teloa-/)
})

test('个人主页头像：数字员工用 StaffAvatar，分身仍用既有 Fingerprint 角标的 .avatar', async () => {
  const source = await readFile(new URL('TeamPage.tsx', clientRoot), 'utf8')
  const body = source.slice(source.indexOf('function RoleDetail'), source.indexOf('function Dialog'))
  assert.ok(body.includes('StaffAvatar'), 'AI 员工应使用 StaffAvatar')
  // 分身整页搬到 TwinProfile.tsx（原型 原型.jsx:459 的 Avatar human），头像写法一字不改地跟着搬过去。
  const twin = await readFile(new URL('TwinProfile.tsx', clientRoot), 'utf8')
  assert.ok(twin.includes('teamCss.human'), '分身应保留既有 .human 头像样式')
  assert.ok(twin.includes('Fingerprint'), '分身角标应保留 Fingerprint')
  assert.ok(!twin.includes('StaffAvatar'), '分身不应套用AI 员工的六档身份色头像')
})
