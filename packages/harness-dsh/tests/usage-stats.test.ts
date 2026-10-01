/**
 * 使用统计宿主模块测试
 * 运行方式：node --test tests/usage-stats.test.ts
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, rm, readFile, writeFile, mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http'

import {
  readOrCreateInstallId,
  removeLegacyParticipationFile,
  createSignalActivity,
  detectExclusion,
  utcDay,
  utcYesterday,
  _resetInProcessDay,
} from '../src/usage-stats.ts'

// ---------------------------------------------------------------------------
// Test HTTP stub server
// ---------------------------------------------------------------------------
type StubBehavior = {status: number; count: number}
const stubQueue: StubBehavior[] = []
let stubReceived: object[] = []

const stubServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  let body = ''
  req.on('data', (chunk: Buffer) => (body += chunk))
  req.on('end', () => {
    try {
      stubReceived.push(JSON.parse(body) as object)
    } catch {
      /* ignore */
    }
    const behavior = stubQueue.shift() ?? {status: 200, count: 1}
    res.writeHead(behavior.status, {'Content-Type': 'application/json'})
    res.end(JSON.stringify({accepted: behavior.status < 400}))
  })
})

let stubPort = 0
await new Promise<void>(resolve => {
  stubServer.listen(0, '127.0.0.1', () => {
    stubPort = (stubServer.address() as {port: number}).port
    resolve()
  })
})
process.env.TELOA_USAGE_STATS_ENDPOINT = `http://127.0.0.1:${stubPort}`

/** 正式发行入口（npm CLI、容器）显式设置的开启值；宿主缺省不发送。 */
const ON: NodeJS.ProcessEnv = {TELOA_USAGE_STATS: 'on'}

function resetStub() {
  stubQueue.length = 0
  stubReceived = []
  _resetInProcessDay()
}

function enqueue(status: number, count = 1) {
  for (let i = 0; i < count; i++) stubQueue.push({status, count: 1})
}

async function makeTmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'teloa-usage-stats-test-'))
}

// ---------------------------------------------------------------------------
// Verify source wiring: 默认参与、无设置页——宿主不再暴露 usage-stats/* 端点，只接活动信号
// ---------------------------------------------------------------------------
test('wiring: index.ts 只接活动信号，不暴露 usage-stats/* RPC 端点', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /usage-stats\//)
  assert.doesNotMatch(source, /usageStatsEndpoints|createUsageStatsHandler/)
  assert.match(source, /registerUsageActivity\(ctx,signalActivity\)/)
  assert.match(source, /runPorts\.onAccepted=\(\)=>signalActivity\(\)/)
})

test('wiring: 契约不再导出参与状态与 get/set 记录读取器', async () => {
  const contract = (await import('@teloa/contract')) as Record<string, unknown>
  for (const name of ['readUsageStatsRecord', 'readUsageStatsSetInput']) assert.equal(contract[name], undefined, name)
  assert.equal(typeof contract.buildInstallationEvent, 'function')
  assert.equal(typeof contract.buildActiveDayEvent, 'function')
})

// ---------------------------------------------------------------------------
// exclusion detection
// ---------------------------------------------------------------------------
test('detectExclusion: TELOA_USAGE_STATS=off', () => {
  assert.equal(detectExclusion({TELOA_USAGE_STATS: 'off'}), 'env-off')
})
test('detectExclusion: CI=true 即使 on 也排除', () => {
  assert.equal(detectExclusion({...ON, CI: 'true'}), 'ci')
})
test('detectExclusion: TELOA_BROWSER_ACCEPTANCE=1 即使 on 也排除', () => {
  assert.equal(detectExclusion({...ON, TELOA_BROWSER_ACCEPTANCE: '1'}), 'acceptance')
})
test('detectExclusion: NODE_ENV=development 即使 on 也排除', () => {
  assert.equal(detectExclusion({...ON, NODE_ENV: 'development'}), 'dev')
})
test('detectExclusion: 未设置 TELOA_USAGE_STATS 即不发送（源码启动与进程内测试宿主）', () => {
  assert.equal(detectExclusion({}), 'not-enabled')
  assert.equal(detectExclusion({TELOA_USAGE_STATS: 'yes'}), 'not-enabled')
})
test('detectExclusion: 只有 TELOA_USAGE_STATS=on 且无其他排除时发送', () => {
  assert.equal(detectExclusion(ON), undefined)
})

// ---------------------------------------------------------------------------
// 正式发行入口显式开启；源码启动脚本不再设置任何值（缺省即不发送）
// ---------------------------------------------------------------------------
test('入口: 容器入口显式开启且外部值优先', async () => {
  const source = await readFile(new URL('../../../scripts/启动容器.mjs', import.meta.url), 'utf8')
  assert.match(source, /env:\{TELOA_USAGE_STATS:'on',TELOA_MARKET_REMOTE:'on',\.\.\.stripped\.env\}/)
})
test('入口: 源码启动脚本不设置 TELOA_USAGE_STATS', async () => {
  const source = await readFile(new URL('../../../scripts/启动DSH.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /TELOA_USAGE_STATS:/)
})

// ---------------------------------------------------------------------------
// Installation ID: concurrent same-dir calls return same ID
// ---------------------------------------------------------------------------
test('readOrCreateInstallId: concurrent calls return same id', async () => {
  const dir = await makeTmp()
  try {
    const [id1, id2, id3] = await Promise.all([
      readOrCreateInstallId(dir),
      readOrCreateInstallId(dir),
      readOrCreateInstallId(dir),
    ])
    assert.ok(id1, 'id1 should be defined')
    assert.equal(id1, id2, 'concurrent calls must return same id')
    assert.equal(id1, id3, 'concurrent calls must return same id')
    // UUID v4 lowercase format
    assert.match(id1!, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
})

// ---------------------------------------------------------------------------
// Installation ID: identity file corruption suspends stats
// ---------------------------------------------------------------------------
test('readOrCreateInstallId: corrupt file returns undefined', async () => {
  const dir = await makeTmp()
  try {
    await mkdir(join(dir, 'usage-stats'), {recursive: true})
    await writeFile(join(dir, 'usage-stats', 'installation-id.json'), 'not-valid-json', 'utf8')
    const id = await readOrCreateInstallId(dir)
    assert.equal(id, undefined, 'corrupt file must suspend (return undefined)')
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
})

test('readOrCreateInstallId: invalid uuid in file returns undefined', async () => {
  const dir = await makeTmp()
  try {
    await mkdir(join(dir, 'usage-stats'), {recursive: true})
    await writeFile(join(dir, 'usage-stats', 'installation-id.json'), JSON.stringify({installationId: 'not-a-uuid'}), 'utf8')
    const id = await readOrCreateInstallId(dir)
    assert.equal(id, undefined, 'invalid uuid must suspend')
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
})

// ---------------------------------------------------------------------------
// 默认参与：没有任何参与文件也发送；排除环境一律不发
// ---------------------------------------------------------------------------
test('signalActivity: 未设置 TELOA_USAGE_STATS 时零请求、不建安装标识', async () => {
  resetStub()
  const dir = await makeTmp()
  try {
    enqueue(200, 4)
    const signal = createSignalActivity(dir, () => ({}))
    signal()
    await new Promise(r => setTimeout(r, 300))
    assert.equal(stubReceived.length, 0, 'unset env must not send')
    await assert.rejects(readFile(join(dir, 'usage-stats', 'installation-id.json'), 'utf8'))
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
})

test('signalActivity: 正式入口开启后无任何设置文件即发送 installation + active-day', async () => {
  resetStub()
  const dir = await makeTmp()
  try {
    enqueue(200, 4)
    const signal = createSignalActivity(dir, () => ON)
    signal()
    await new Promise(r => setTimeout(r, 300))
    const kinds = stubReceived.map((e: object) => (e as {event: string}).event)
    assert.ok(kinds.includes('installation'), 'default must send installation')
    assert.ok(kinds.includes('active-day'), 'default must send active-day')
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
})

test('signalActivity: 迁移——二期 participation.json 为 off/unset 的本机按参与处理并删除该文件，安装标识与发送状态保留', async () => {
  const existingId = '11111111-2222-4333-8444-555555555555'
  for (const legacy of ['off', 'on', 'garbage']) {
    resetStub()
    const dir = await makeTmp()
    try {
      await mkdir(join(dir, 'usage-stats'), {recursive: true})
      const legacyPath = join(dir, 'usage-stats', 'participation.json')
      const idPath = join(dir, 'usage-stats', 'installation-id.json')
      await writeFile(legacyPath, legacy === 'garbage' ? 'not json' : JSON.stringify({participation: legacy}), 'utf8')
      await writeFile(idPath, JSON.stringify({installationId: existingId}), 'utf8')
      await writeFile(join(dir, 'usage-stats', 'state.json'), JSON.stringify({installationSent: true}), 'utf8')
      enqueue(200, 4)
      const signal = createSignalActivity(dir, () => ON)
      signal()
      await new Promise(r => setTimeout(r, 300))
      const events = stubReceived as Array<{event: string; installationId: string}>
      assert.equal(events.filter(e => e.event === 'installation').length, 0, `legacy=${legacy} must not resend installation`)
      assert.equal(events.filter(e => e.event === 'active-day').length, 1, `legacy=${legacy} must still report active-day`)
      assert.ok(events.every(e => e.installationId === existingId), `legacy=${legacy} must keep installation id`)
      assert.equal(JSON.parse(await readFile(idPath, 'utf8')).installationId, existingId)
      await assert.rejects(readFile(legacyPath, 'utf8'), (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT', `legacy=${legacy} file removed`)
    } finally {
      await rm(dir, {recursive: true, force: true})
    }
  }
})

test('removeLegacyParticipationFile: 文件不存在时静默', async () => {
  const dir = await makeTmp()
  try {
    await removeLegacyParticipationFile(dir)
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
})

test('signalActivity: 排除环境（env-off / ci / acceptance / dev）一律不发', async () => {
  const envs: NodeJS.ProcessEnv[] = [
    {TELOA_USAGE_STATS: 'off'},
    {...ON, CI: 'true'},
    {...ON, TELOA_BROWSER_ACCEPTANCE: '1'},
    {...ON, NODE_ENV: 'development'},
  ]
  for (const env of envs) {
    resetStub()
    const dir = await makeTmp()
    try {
      enqueue(200)
      const signal = createSignalActivity(dir, () => env)
      signal()
      await new Promise(r => setTimeout(r, 100))
      assert.equal(stubReceived.length, 0, `excluded env must not send: ${JSON.stringify(env)}`)
    } finally {
      await rm(dir, {recursive: true, force: true})
    }
  }
})

// ---------------------------------------------------------------------------
// After enabling: installation event sent once, then not again
// ---------------------------------------------------------------------------
test('signalActivity: sends installation + active-day on first signal', async () => {
  resetStub()
  const dir = await makeTmp()
  try {
    enqueue(200, 4) // enough capacity
    const signal = createSignalActivity(dir, () => ON)
    signal()
    await new Promise(r => setTimeout(r, 300))

    const installEvents = stubReceived.filter((e: object) => (e as {event: string}).event === 'installation')
    const activeDayEvents = stubReceived.filter((e: object) => (e as {event: string}).event === 'active-day')
    assert.equal(installEvents.length, 1, 'installation event must be sent exactly once')
    assert.ok(activeDayEvents.length >= 1, 'active-day event must be sent')
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
})

test('signalActivity: installation event not sent again after first', async () => {
  resetStub()
  const dir = await makeTmp()
  try {
    enqueue(200, 10)
    const signal = createSignalActivity(dir, () => ON)
    signal()
    await new Promise(r => setTimeout(r, 300))
    const firstCount = stubReceived.length

    // Reset in-process day to allow a second signal (simulates new process/day)
    _resetInProcessDay()
    // Write a different day to lastSentDay to simulate new day
    const stateFile = join(dir, 'usage-stats', 'state.json')
    const state = JSON.parse(await readFile(stateFile, 'utf8')) as {installationSent: boolean; lastSentDay?: string}
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
    await writeFile(stateFile, JSON.stringify({...state, lastSentDay: tomorrow}), 'utf8')

    signal()
    await new Promise(r => setTimeout(r, 300))
    const afterSecond = stubReceived.slice(firstCount)
    const installAfter = afterSecond.filter((e: object) => (e as {event: string}).event === 'installation')
    assert.equal(installAfter.length, 0, 'installation must not be sent a second time')
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
})

// ---------------------------------------------------------------------------
// Same day multiple signals: only one active-day send
// ---------------------------------------------------------------------------
test('signalActivity: same-day multiple signals send only one active-day', async () => {
  resetStub()
  const dir = await makeTmp()
  try {
    enqueue(200, 10)
    const signal = createSignalActivity(dir, () => ON)
    signal()
    signal()
    signal()
    await new Promise(r => setTimeout(r, 300))
    const activeDayEvents = stubReceived.filter((e: object) => (e as {event: string}).event === 'active-day')
    // May have 1 (deduped) or at most 2 (if installation+active-day) - but only 1 active-day per day
    const uniqueDays = new Set(activeDayEvents.map((e: object) => (e as {day: string}).day))
    assert.equal(uniqueDays.size, 1, 'only one active-day per UTC day')
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
})

// ---------------------------------------------------------------------------
// Yesterday backfill: pending day from yesterday gets sent with today
// ---------------------------------------------------------------------------
test('signalActivity: yesterday backfill within window', async () => {
  resetStub()
  const dir = await makeTmp()
  try {
    const yesterday = utcYesterday()
    // Simulate: installation sent, yesterday was pending but not confirmed
    await mkdir(join(dir, 'usage-stats'), {recursive: true})
    await writeFile(
      join(dir, 'usage-stats', 'state.json'),
      JSON.stringify({installationSent: true, pendingDay: yesterday}),
      'utf8',
    )
    enqueue(200, 4)
    const signal = createSignalActivity(dir, () => ON)
    signal()
    await new Promise(r => setTimeout(r, 300))
    const days = stubReceived.map((e: object) => (e as {day?: string}).day).filter(Boolean)
    assert.ok(days.includes(yesterday), 'yesterday must be backfilled')
    assert.ok(days.includes(utcDay()), 'today must also be sent')
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
})

// ---------------------------------------------------------------------------
// Window exceeded: pending day older than yesterday is discarded (not sent)
// ---------------------------------------------------------------------------
test('signalActivity: day older than yesterday is discarded', async () => {
  resetStub()
  const dir = await makeTmp()
  try {
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10)
    await mkdir(join(dir, 'usage-stats'), {recursive: true})
    await writeFile(
      join(dir, 'usage-stats', 'state.json'),
      JSON.stringify({installationSent: true, pendingDay: twoDaysAgo}),
      'utf8',
    )
    enqueue(200, 4)
    const signal = createSignalActivity(dir, () => ON)
    signal()
    await new Promise(r => setTimeout(r, 300))
    const days = stubReceived.map((e: object) => (e as {day?: string}).day).filter(Boolean)
    assert.ok(!days.includes(twoDaysAgo), 'expired day must not be sent')
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
})

// ---------------------------------------------------------------------------
// 4xx response: terminal discard (no retry)
// ---------------------------------------------------------------------------
test('signalActivity: 4xx response is terminal - no retry', async () => {
  resetStub()
  const dir = await makeTmp()
  try {
    enqueue(400, 1) // first request gets 400
    enqueue(400, 1) // second request (active-day) gets 400
    const signal = createSignalActivity(dir, () => ON)
    signal()
    await new Promise(r => setTimeout(r, 1000))
    // At most 2 requests sent (installation + active-day), no retries
    assert.ok(stubReceived.length <= 2, '4xx must not trigger retry (got ' + stubReceived.length + ' requests)')
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
})

// ---------------------------------------------------------------------------
// 只核对公开出站事件白名单；运营服务端协议测试不属于 Free 源码。
// ---------------------------------------------------------------------------
test('protocol: events contain only the public client fields', async () => {
  resetStub()
  const dir = await makeTmp()
  try {
    enqueue(200, 4)
    const signal = createSignalActivity(dir, () => ON)
    signal()
    await new Promise(r => setTimeout(r, 300))

    assert.ok(stubReceived.length > 0, 'at least one event must have been sent')
    for (const event of stubReceived) {
      const fields = event as Record<string, unknown>
      assert.ok(fields.event === 'installation' || fields.event === 'active-day')
      const keys = ['schemaVersion', 'installationId', 'event', 'appVersion', 'edition', ...(fields.event === 'active-day' ? ['day'] : [])]
      assert.deepEqual(Object.keys(fields).sort(), keys.sort(), 'outbound events must not include private content or unknown fields')
      assert.equal(fields.schemaVersion, 1)
      assert.equal(fields.edition, 'free')
      assert.match(String(fields.installationId), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      assert.match(String(fields.appVersion), /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
      if (fields.event === 'active-day') {
        assert.match(String(fields.day), /^\d{4}-\d{2}-\d{2}$/)
        assert.equal(new Date(String(fields.day) + 'T00:00:00Z').toISOString().slice(0, 10), fields.day)
      }
    }
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
})

// Cleanup
test.after(async () => {
  await new Promise<void>(resolve => stubServer.close(() => resolve()))
})

test('对话钩子只在本人消息被接受的步骤发信号；子代理、被拒绝、无本人消息的步骤不发',async()=>{
 const {registerUsageActivity}=await import('../src/usage-stats.ts')
 let handler:((input:unknown,next:()=>Promise<unknown>)=>Promise<unknown>)|undefined
 const ctx={on:(event:string,fn:typeof handler)=>{assert.equal(event,'agent/pre-step');handler=fn;return ()=>{}}}
 let signals=0
 registerUsageActivity(ctx as never,()=>{signals++})
 const step=async(origin:string,decision:unknown)=>handler!({agent:{session:{header:{origin}}}},async()=>decision)
 const user={kind:'accept',messages:[{source:{kind:'user'}}]}
 assert.deepEqual(await step('user',user),user)
 assert.equal(signals,1)
 await step('subagent',user)
 await step('user',{kind:'reject',messages:[{source:{kind:'user'}}]})
 await step('user',{kind:'accept',messages:[{source:{kind:'skill-invocation'}}]})
 assert.equal(signals,1)
})
