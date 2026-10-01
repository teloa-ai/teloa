import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {
  TELOA_NOTICE_STORAGE_KEY,
  TELOA_NOTICE_VERSION,
  readNoticeAcknowledged,
  writeNoticeAcknowledged,
} from '../lib/types/client/teloa-notice.js'
import {MESSAGE_KEYS, catalogs, translateMessage} from '../lib/types/client/i18n/messages.js'

const clientRoot = new URL('../src/client/', import.meta.url)
const read = (name: string) => readFile(new URL(name, clientRoot), 'utf8')

// 公告版本号与关于页同源：都取自本包 package.json 的 version（见 tsdown.config.ts 的 __TELOA_VERSION__ 注入）。
const packageManifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {version: string}
const appVersion = packageManifest.version

const memoryStorage = (initial?: string) => {
  let value = initial
  return {
    getItem: (key: string) => (key === TELOA_NOTICE_STORAGE_KEY ? value ?? null : null),
    setItem: (key: string, next: string) => {
      if (key === TELOA_NOTICE_STORAGE_KEY) value = next
    },
    read: () => value,
  }
}

const throwingStorage = {
  getItem: () => {
    throw Error('localStorage 不可用')
  },
  setItem: () => {
    throw Error('localStorage 不可用')
  },
}

test('未确认时声明照常显示，确认后按版本记住', () => {
  const storage = memoryStorage()
  assert.equal(readNoticeAcknowledged(storage, TELOA_NOTICE_VERSION), false)
  assert.equal(writeNoticeAcknowledged(storage, TELOA_NOTICE_VERSION), true)
  assert.equal(storage.read(), TELOA_NOTICE_VERSION)
  assert.equal(readNoticeAcknowledged(storage, TELOA_NOTICE_VERSION), true)
})

test('文案版本变更后重新显示声明', () => {
  const storage = memoryStorage('2026-01-01.1')
  assert.equal(readNoticeAcknowledged(storage, TELOA_NOTICE_VERSION), false)
})

test('localStorage 抛错或缺失时按未确认处理且写入不抛出', () => {
  assert.equal(readNoticeAcknowledged(throwingStorage, TELOA_NOTICE_VERSION), false)
  assert.equal(writeNoticeAcknowledged(throwingStorage, TELOA_NOTICE_VERSION), false)
  assert.equal(readNoticeAcknowledged(undefined, TELOA_NOTICE_VERSION), false)
  assert.equal(writeNoticeAcknowledged(undefined, TELOA_NOTICE_VERSION), false)
})

test('确认状态使用本机浏览器级键与固定版本常量', () => {
  assert.equal(TELOA_NOTICE_STORAGE_KEY, 'teloa.notice/v1')
  assert.equal(TELOA_NOTICE_VERSION, '2026-09-14.1')
})

test('引导步骤目录排除 DSH 内测声明并让 Teloa 声明排在最前', async () => {
  const source = await read('settings-integration.ts')
  assert.match(source, /const REPLACED_ONBOARDING_STEPS=new Set\(\['welcome-notice'\]\)/)
  assert.match(source, /REPLACED_ONBOARDING_STEPS\.has/)
  assert.match(source, /id:'teloa-notice',order:-200/)
  assert.match(source, /TeloaNotice/)
  // DSH 的 API Key 引导步骤（deepseek-official，order 0）必须保留，且排在 Teloa 声明之后。
  assert.doesNotMatch(source, /REPLACED_ONBOARDING_STEPS=new Set\(\[[^\]]*deepseek-official/)
})

test('Teloa 声明弹框复用语义 token 且可达性与 DSH 弹框一致', async () => {
  const [source, styles] = await Promise.all([read('TeloaNotice.tsx'), read('TeloaNotice.module.css')])
  assert.match(source, /role="dialog"/)
  assert.match(source, /aria-modal="true"/)
  assert.match(source, /aria-labelledby=\{titleId\}/)
  assert.match(source, /tabIndex=\{-1\}/)
  assert.match(source, /focus\(\{preventScroll:true\}\)/)
  assert.match(source, /t\('notice\.title'\)/)
  assert.match(source, /t\('notice\.body',\{version:__TELOA_VERSION__\}\)\.split\('\\n\\n'\)/)
  assert.match(source, /t\('notice\.continue'\)/)
  assert.match(source, /readNoticeAcknowledged/)
  assert.match(source, /writeNoticeAcknowledged/)
  assert.doesNotMatch(styles, /#[0-9a-fA-F]{3,8}\b|rgba?\(/)
  assert.match(styles, /var\(--teloa-/)
})

test('声明词条十语言齐全，简中与英文使用确认文案', () => {
  const keys = ['notice.title', 'notice.body', 'notice.continue'] as const
  for (const key of keys) assert.ok(MESSAGE_KEYS.includes(key), key)
  for (const [locale, catalog] of Object.entries(catalogs)) {
    for (const key of keys) assert.ok(catalog[key]?.trim(), `${locale} 缺少 ${key}`)
    const body = catalog['notice.body'] ?? ''
    assert.equal(body.split('\n\n').length, 2, `${locale} 正文必须分两段`)
    // 产品名在所有语言都保持原文。
    assert.match(body, /Teloa AI-Native Team Studio/, locale)
    assert.match(body, /DeepSeek Harness/, locale)
  }
  assert.equal(catalogs['zh-CN']['notice.title'], '个人版预览声明')
  assert.equal(catalogs['zh-CN']['notice.continue'], '我知道了')
  assert.equal(catalogs.en['notice.title'], 'Personal Edition Preview Notice')
  assert.equal(catalogs.en['notice.continue'], 'Got it')
  assert.equal(
    catalogs['zh-CN']['notice.body'],
    "Teloa AI-Native Team Studio 当前为个人单机版预览（{version}），功能与界面仍在快速迭代，可能出现变更、缺陷或数据结构调整。你的会话、任务、知识与配置只保存在本机数据库与运行目录，不会自动上传到 Teloa。你主动提交反馈时，所填分类、内容和可选邮箱会发送至 Teloa 私有反馈库，不读取或附带会话与日志。模型调用由你在 DeepSeek Harness 中配置的提供方处理，密钥由其原生服务管理。\n\n员工只能在你授予的数据范围、身份与执行权限内工作，高风险动作始终需要你审批。使用中遇到问题，欢迎通过\"关于\"页的联系方式反馈。",
  )
  assert.equal(
    catalogs.en['notice.body'],
    "Teloa AI-Native Team Studio is currently a personal single-machine preview ({version}). Features and UI are iterating quickly and may change, contain defects, or adjust data structures. Your conversations, tasks, knowledge, and settings stay in the local database and data directory and are not automatically uploaded to Teloa. When you explicitly submit feedback, the category, text and optional email you enter go to Teloa’s private feedback store; conversations and logs are not read or attached. Model calls go to the provider you configured in DeepSeek Harness, whose native service manages the keys.\n\nEmployees work only within the data scope, identity, and execution permissions you grant, and high-risk actions always require your approval. If you run into problems, reach us through the contact details on the About page.",
  )
})

test('公告版本号插值后与关于页同源（均取自 package.json version），不再写死旧版本号', () => {
  for (const [locale, catalog] of Object.entries(catalogs)) {
    assert.doesNotMatch(catalog['notice.body'] ?? '', /0\.0\.1-alpha/, locale)
    assert.match(catalog['notice.body'] ?? '', /\{version\}/, locale)
    assert.match(translateMessage(locale, 'notice.body', {version: appVersion}), new RegExp(appVersion.replace(/\./g, '\\.')), locale)
  }
  assert.equal(translateMessage('zh-CN', 'notice.body', {version: appVersion}).includes(`（${appVersion}）`), true)
  assert.equal(translateMessage('en', 'notice.body', {version: appVersion}).includes(`(${appVersion})`), true)
})
