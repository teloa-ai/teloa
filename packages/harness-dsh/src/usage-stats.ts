/**
 * 全球使用统计宿主模块
 *
 * 2026-09-25 用户裁定：统计默认参与并上报，应用内不提供设置页与关闭开关；所有安装在本人有活动时上报。
 * 宿主只有 TELOA_USAGE_STATS=on 时才发送，缺省不发送：正式发行入口（npm CLI 的 runtimeEnvironment、容器入口）显式设置 on，
 * 源码仓库启动与进程内测试宿主不设置，保证生产统计库不写开发与测试事件。
 * 内部排除环境优先于 on（不是用户功能，用于开发 / CI / 验收 / 企业离线部署）：
 * TELOA_USAGE_STATS=off / CI=true / TELOA_BROWSER_ACCEPTANCE=1 / NODE_ENV=development。
 * 迁移：二期遗留的 participation.json（on/off）不再读取，首次活动时删除；安装标识与发送状态保留，不会重复计数。
 * 发送从不阻塞调用方：3 秒超时、最多 3 次指数退避；只保留当日与至多昨日一条未确认事件。
 */

import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import {buildActiveDayEvent, buildInstallationEvent, buildResourceInstallEvent, type MarketInstallEntry} from '@teloa/contract'

// ---------------------------------------------------------------------------
// Harness app version (read once at module load)
// ---------------------------------------------------------------------------
const {version: APP_VERSION} = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {version: string}

// ---------------------------------------------------------------------------
// Endpoint URL (overridable via TELOA_USAGE_STATS_ENDPOINT; the host passes its read-only launch snapshot)
// ---------------------------------------------------------------------------
export function getEndpointBase(env: Readonly<Record<string, string | undefined>>): string {
  return (env.TELOA_USAGE_STATS_ENDPOINT ?? 'https://metrics.teloa.ai').replace(/\/$/, '')
}

// ---------------------------------------------------------------------------
// File paths inside runtimeRoot/usage-stats/
// ---------------------------------------------------------------------------
const DIR = 'usage-stats'
const ID_FILE = 'installation-id.json'
const ID_LOCK = '.id-create.lock'
/** 二期遗留的参与开关文件；不再读取，见 removeLegacyParticipationFile。 */
const LEGACY_PARTICIPATION_FILE = 'participation.json'
const STATE_FILE = 'state.json'

function statsDir(runtimeRoot: string): string {
  return join(runtimeRoot, DIR)
}

// ---------------------------------------------------------------------------
// Exclusion detection
// ---------------------------------------------------------------------------
export type UsageExclusionReason = 'env-off' | 'ci' | 'acceptance' | 'dev' | 'not-enabled'

export function detectExclusion(env: NodeJS.ProcessEnv = process.env): UsageExclusionReason | undefined {
  if (env.TELOA_USAGE_STATS === 'off') return 'env-off'
  if (env.CI === 'true') return 'ci'
  if (env.TELOA_BROWSER_ACCEPTANCE === '1') return 'acceptance'
  if (env.NODE_ENV === 'development') return 'dev'
  if (env.TELOA_USAGE_STATS !== 'on') return 'not-enabled'
  return undefined
}

// ---------------------------------------------------------------------------
// Atomic file write: write to .tmp then rename (POSIX atomic)
// ---------------------------------------------------------------------------
async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp.${randomUUID()}`
  await writeFile(tmp, content, {encoding: 'utf8', mode: 0o600})
  await rename(tmp, path)
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, {recursive: true})
}

// UUID v4 lowercase pattern (matches metrics-worker/src/protocol.mjs)
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/**
 * 读取或创建安装 ID。
 * 使用目录创建作为跨进程原子锁（POSIX 保证 mkdir 原子性）。
 * 若文件损坏/权限错误，返回 undefined（暂停统计，不重新生成）。
 */
export async function readOrCreateInstallId(runtimeRoot: string): Promise<string | undefined> {
  const dir = statsDir(runtimeRoot)
  const idPath = join(dir, ID_FILE)
  const lockPath = join(dir, ID_LOCK)

  // Fast path: try reading existing ID
  try {
    const raw = await readFile(idPath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'installationId' in parsed &&
      typeof (parsed as Record<string, unknown>).installationId === 'string' &&
      UUID_V4.test(String((parsed as Record<string, unknown>).installationId))
    ) {
      return String((parsed as Record<string, unknown>).installationId)
    }
    // File exists but is corrupt - suspend stats
    return undefined
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Permission or parse error - suspend stats
      return undefined
    }
  }

  // File doesn't exist; try to acquire lock via atomic mkdir
  await ensureDir(dir)
  try {
    await mkdir(lockPath)
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      // Another process holds the lock - wait 100ms then retry
      await new Promise<void>(resolve => setTimeout(resolve, 100))
      return readOrCreateInstallId(runtimeRoot)
    }
    // Unexpected error acquiring lock - suspend stats
    return undefined
  }

  try {
    // Double-check: file may have been created while we waited
    try {
      const raw = await readFile(idPath, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'installationId' in parsed &&
        typeof (parsed as Record<string, unknown>).installationId === 'string' &&
        UUID_V4.test(String((parsed as Record<string, unknown>).installationId))
      ) {
        return String((parsed as Record<string, unknown>).installationId)
      }
      return undefined // corrupt - suspend
    } catch (e2: unknown) {
      if ((e2 as NodeJS.ErrnoException).code !== 'ENOENT') return undefined
    }

    const id = randomUUID()
    await atomicWrite(idPath, JSON.stringify({installationId: id}) + '\n')
    return id
  } finally {
    await rm(lockPath, {recursive: true, force: true}).catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// Legacy participation file (二期 on/off 开关) - no longer consulted
// ---------------------------------------------------------------------------
/** 删除二期遗留的 participation.json；不存在或删不掉都忽略，不影响上报。 */
export async function removeLegacyParticipationFile(runtimeRoot: string): Promise<void> {
  await rm(join(statsDir(runtimeRoot), LEGACY_PARTICIPATION_FILE), {force: true}).catch(() => undefined)
}

// ---------------------------------------------------------------------------
// Send state (installation sent flag, last confirmed day, pending day)
// ---------------------------------------------------------------------------
type SendState = {
  installationSent: boolean
  lastSentDay?: string // YYYY-MM-DD of last confirmed active-day send
  pendingDay?: string  // YYYY-MM-DD of in-flight / not-yet-confirmed active-day
}

async function readSendState(runtimeRoot: string): Promise<SendState> {
  const path = join(statsDir(runtimeRoot), STATE_FILE)
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      installationSent: parsed.installationSent === true,
      ...(typeof parsed.lastSentDay === 'string' ? {lastSentDay: parsed.lastSentDay} : {}),
      ...(typeof parsed.pendingDay === 'string' ? {pendingDay: parsed.pendingDay} : {}),
    }
  } catch {
    return {installationSent: false}
  }
}

function omitPendingDay(state: SendState): SendState {
  const {pendingDay: _p, ...rest} = state
  return rest
}

async function writeSendState(runtimeRoot: string, state: SendState): Promise<void> {
  await ensureDir(statsDir(runtimeRoot))
  await atomicWrite(join(statsDir(runtimeRoot), STATE_FILE), JSON.stringify(state) + '\n')
}

// ---------------------------------------------------------------------------
// UTC day helpers
// ---------------------------------------------------------------------------
export function utcDay(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10)
}

export function utcYesterday(now: number = Date.now()): string {
  return new Date(now - 86_400_000).toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// HTTP send with timeout and exponential backoff (3 retries max)
// 4xx (except 429) → terminal (discard); 429 / 5xx / network error → retry
// ---------------------------------------------------------------------------
async function sendEventOnce(event: object, base: string, timeoutMs = 3000): Promise<'ok' | 'terminal' | 'retry'> {
  const url = `${base}/v1/events`
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (resp.ok) return 'ok'
    if (resp.status === 429) return 'retry'
    if (resp.status >= 400 && resp.status < 500) return 'terminal'
    return 'retry'
  } catch {
    return 'retry'
  }
}

async function sendWithRetry(event: object, base: string): Promise<boolean> {
  const delays: number[] = [0, 1000, 4000]
  for (const delay of delays) {
    if (delay > 0) await new Promise<void>(resolve => setTimeout(resolve, delay))
    const result = await sendEventOnce(event, base)
    if (result === 'ok') return true
    if (result === 'terminal') return true // discard on 4xx - treat as done
  }
  return false
}

// ---------------------------------------------------------------------------
// In-process day dedup (avoids reading disk on every RPC call in a hot session)
// ---------------------------------------------------------------------------
let _lastActivityDay: string | undefined

// Exposed for tests
export function _resetInProcessDay(): void {
  _lastActivityDay = undefined
}

// ---------------------------------------------------------------------------
// Activity signal entry point
// Fires non-blocking: returns immediately; all I/O runs in detached promise.
// ---------------------------------------------------------------------------
/**
 * `getEnv` 给排除判定，`getEndpointEnv` 给上报地址。宿主传入只读启动快照（launch-env.ts）：工作区 `.env` 被 DSH 合入
 * `process.env` 后，不能借它打开统计或把上报改发到别处。缺省读 process.env 只给测试用。
 */
export function createSignalActivity(runtimeRoot: string, getEnv: () => NodeJS.ProcessEnv = () => process.env, getEndpointEnv: () => Readonly<Record<string, string | undefined>> = () => process.env) {
  return (): void => {
    void (async () => {
      try {
        // 先做内存去重：信号会在每个对话步骤触发，当天已确认发送后不再读文件
        const today = utcDay()
        if (_lastActivityDay === today) return
        if (detectExclusion(getEnv())) return
        await removeLegacyParticipationFile(runtimeRoot)

        const yesterday = utcYesterday()

        const installId = await readOrCreateInstallId(runtimeRoot)
        if (!installId) return // identity error - suspend

        const state = await readSendState(runtimeRoot)

        // Collect events to send
        const events: object[] = []

        if (!state.installationSent) {
          events.push(buildInstallationEvent(installId, APP_VERSION))
        }

        // Backfill: pending day from yesterday is still in window
        if (
          state.pendingDay !== undefined &&
          state.pendingDay === yesterday &&
          state.lastSentDay !== yesterday
        ) {
          events.push(buildActiveDayEvent(installId, APP_VERSION, yesterday))
        }

        // Today's active-day (if not already confirmed)
        if (state.lastSentDay !== today) {
          events.push(buildActiveDayEvent(installId, APP_VERSION, today))
          // Record as pending before sending (so crash/abort doesn't lose the day)
          await writeSendState(runtimeRoot, {...state, pendingDay: today})
        }

        // Discard expired pending day (older than yesterday)
        if (
          state.pendingDay !== undefined &&
          state.pendingDay !== today &&
          state.pendingDay !== yesterday
        ) {
          const current = await readSendState(runtimeRoot)
          await writeSendState(runtimeRoot, omitPendingDay(current))
        }

        if (events.length === 0) {
          _lastActivityDay = today
          return
        }

        // Send all events; update state on full success
        let allSent = true
        for (const event of events) {
          const ok = await sendWithRetry(event, getEndpointBase(getEndpointEnv()))
          if (!ok) allSent = false
        }

        if (allSent) {
          _lastActivityDay = today
          await writeSendState(runtimeRoot, {installationSent: true, lastSentDay: today})
        }
      } catch {
        // Non-blocking - swallow all errors silently
      }
    })()
  }
}

/**
 * 本人输入被宿主接受即记一次活动：只看这一步是否真的带入了本人消息，子代理会话与被拒绝的步骤不计。
 * 同日去重由 signal 自身完成，这里每步调用的代价只是一次内存比较。
 */
export function registerUsageActivity(ctx: Context, signal: () => void) {
  return ctx.on('agent/pre-step', async ({agent}, next) => {
    const decision = await next()
    if (decision.kind !== 'reject' && agent.session.header.origin !== 'subagent' && decision.messages.some(message => message.source.kind === 'user')) signal()
    return decision
  })
}

// ---------------------------------------------------------------------------
// Market resource installs (市场二期，规格 2026-09-26 §8)
// ---------------------------------------------------------------------------
const RESOURCE_FILE = 'resource-installs.json'
const RESOURCE_KEEP = 500

/** 已确认上报的「原始日期|条目 ID」；缺失或损坏时按未发送处理（最坏多发一次，服务端按原始日去重）。 */
async function readResourceSent(runtimeRoot: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(join(statsDir(runtimeRoot), RESOURCE_FILE), 'utf8')) as Record<string, unknown>
    if (Array.isArray(parsed.entries) && parsed.entries.every(item => typeof item === 'string')) return parsed.entries as string[]
  } catch {
    /* 缺失或损坏 */
  }
  return []
}

/**
 * 市场资源安装上报：与使用统计同一开关与排除规则（TELOA_USAGE_STATS=on 且无内部排除），没有单独开关。
 * 只由官方目录添加成功的回执触发（market-install-report.ts）；事件携带原始日期，同一（原始日期, 条目）至多确认发送一次。
 * 服务端只收今天、昨天、前天的原始日期，超窗的重放直接不发。调用立即返回；发送串行执行，任何错误都不影响添加结果。
 */
export function createResourceInstallReporter(runtimeRoot: string, getEnv: () => NodeJS.ProcessEnv = () => process.env, getEndpointEnv: () => Readonly<Record<string, string | undefined>> = () => process.env) {
  let queue: Promise<void> = Promise.resolve()
  return (entry: MarketInstallEntry): void => {
    queue = queue.then(async () => {
      try {
        if (detectExclusion(getEnv())) return
        const now = Date.now()
        const today = utcDay(now)
        const oldest = utcDay(now - 2 * 86_400_000)
        if (entry.day < oldest || entry.day > today) return
        const key = `${entry.day}|${entry.id}`
        const sent = (await readResourceSent(runtimeRoot)).filter(item => item.slice(0, 10) >= oldest)
        if (sent.includes(key)) return
        const installId = await readOrCreateInstallId(runtimeRoot)
        if (!installId) return
        if (!(await sendWithRetry(buildResourceInstallEvent(installId, APP_VERSION, entry), getEndpointBase(getEndpointEnv())))) return
        await ensureDir(statsDir(runtimeRoot))
        await atomicWrite(join(statsDir(runtimeRoot), RESOURCE_FILE), JSON.stringify({entries: [...sent, key].slice(-RESOURCE_KEEP)}) + '\n')
      } catch {
        // Non-blocking - swallow all errors silently
      }
    })
  }
}
