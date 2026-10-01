import { randomUUID } from 'node:crypto'

// 0.1.6 的 auditStartupEntries 只对硬编码 required 列表拒绝启动，Teloa 的三行都不在其中。
// 宿主宣告 ready 不等于 Teloa 业务可用，所以启动器必须自己打一次真实只读调用。
const startupUrlPattern = /\bhttps?:\/\/[^\s]*[?&]token=[^\s"']+/g
// 宿主已在监听却不回包时，自检不能无限期等待，否则半死状态照样对外服务。
const probeTimeout = 30_000
// 宿主吞掉 SIGTERM 时不能把半死进程留在端口上。
const killEscalation = 5_000
// 宿主打印启动地址时插件树还在装配：Teloa 通道要等全库结构初始化结束才注册，
// 这段空窗里静态前端对 POST 一律回 405。单发探针会把正在起的宿主判成未挂载并杀掉，
// 所以未挂载按"还没到"重试，只有窗口耗尽才算失败。
const mountWindow = 20_000
const mountRetryInterval = 500
const sleep = milliseconds => new Promise(done => setTimeout(done, milliseconds))

/**
 * 从宿主启动输出里取出带一次性令牌的根地址；返回值只能喂给自检，不得写进日志。
 * 传入 expectedHost 时只认该 host 的地址：宿主内任何插件都能往 stdout 打印一行带 token 的
 * 外部地址，不锁定 host 就能把自检指向任意 origin，由对方伪造一个合法回包冒充就绪。
 */
export function findStartupUrl(text, expectedHost) {
  for (const match of text.matchAll(startupUrlPattern)) {
    let host
    try { host = new URL(match[0]).host } catch { continue }
    if (expectedHost === undefined || host === expectedHost) return match[0]
  }
  return undefined
}

/** 用一次性启动令牌换取浏览器会话 Cookie；诊断消息一律固定文案，不回显地址或令牌。 */
export async function authorizeSession(startupUrl, { fetch: send = fetch } = {}) {
  const response = await send(startupUrl, { redirect: 'manual', signal: AbortSignal.timeout(probeTimeout) })
  const cookie = (response.headers.getSetCookie?.() ?? []).map(value => value.split(';')[0]).join('; ')
  if (!cookie) throw Error('宿主没有签发浏览器会话，无法执行就绪自检。')
  return cookie
}

/**
 * 对 /teloa 通道打一个已有的只读端点；非 200、回包身份不符或业务失败都算未就绪。
 * timeout 由调用方按剩余挂载窗口夹一次：单发探针不得比整个窗口还能等。
 */
export async function probeTeloaChannel(origin, cookie, { fetch: send = fetch, timeout = probeTimeout } = {}) {
  const rpcId = randomUUID()
  const response = await send(new URL('/teloa/conversations/list', origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method: 'conversations/list', payload: {} }),
    signal: AbortSignal.timeout(timeout),
  })
  // 只有静态前端接管时的 404/405 才可能是"装配还没走到"；其余非 2xx（401/500/502…）
  // 说明通道已经在应答但状态不对，再重试只会把一台故障宿主拖到窗口耗尽才报错。
  if (response.status === 404 || response.status === 405) throw Object.assign(Error('Teloa 工作通道未挂载，宿主已就绪但业务不可用（HTTP ' + response.status + '）。'), { mounting: true })
  if (!response.ok) throw Error('Teloa 工作通道返回异常 HTTP 状态，拒绝按就绪对外服务（HTTP ' + response.status + '）。')
  // 解析失败的原文会把响应体片段带进诊断消息，这里只留固定文案。
  let envelope
  try { envelope = await response.json() }
  catch { throw Error('Teloa 工作通道回包不是合法 JSON，拒绝按就绪对外服务。') }
  if (envelope?.type !== 'server-response' || envelope.rpcId !== rpcId) throw Error('Teloa 工作通道回包身份不符，拒绝按就绪对外服务。')
  if (envelope.result?.ok !== true) throw Error('Teloa 工作通道返回失败：' + (envelope.result?.error?.code ?? '未知原因') + '。')
}

/**
 * 完整自检：换一次 Cookie（启动令牌是一次性的，重试不能再换），再在挂载窗口内反复打只读端点。
 * 只有"未挂载"重试；回包身份不符、非法 JSON、业务失败都是已挂载后的真实故障，立即失败。
 */
export async function assertTeloaReady(startupUrl, options = {}) {
  const { mountTimeout = mountWindow, ...request } = options
  const cookie = await authorizeSession(startupUrl, request)
  const origin = new URL(startupUrl).origin, deadline = Date.now() + mountTimeout
  let mounting
  for (;;) {
    // 窗口已尽就把上一次"未挂载"原样抛出：再补一次必然超时的探针，只会把诊断换成无意义的 AbortError。
    if (mounting && Date.now() >= deadline) throw mounting
    // 单发探针最多等到窗口结束：否则 30 秒的默认超时会让一个 1 秒的窗口实际拖满 30 秒。
    const timeout = Math.max(1, Math.min(probeTimeout, deadline - Date.now()))
    try { return await probeTeloaChannel(origin, cookie, { ...request, timeout }) }
    catch (error) {
      // 夹窗探针被掐断（AbortSignal.timeout 抛 TimeoutError，手动 abort 抛 AbortError）：
      // 末轮剩余窗口小于宿主响应时延时必然走到这里。诊断要么是上一次"未挂载"，
      // 要么是固定中文超时文案，绝不能把 fetch 的英文 AbortError 当成结论抛给用户。
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw mounting ?? Error('Teloa 工作通道在就绪窗口内没有回包，拒绝按就绪对外服务。')
      if (error?.mounting !== true) throw error
      mounting = error
      if (Date.now() >= deadline) throw error
      // 等待同样不越过窗口，否则下一轮只剩一个零头超时可用。
      await sleep(Math.min(mountRetryInterval, deadline - Date.now()))
    }
  }
}

/** 自检失败即终止宿主子进程并返回 1；成功返回 0 且不产生任何输出。 */
export async function guardTeloaReadiness({ child, startupUrl, mountTimeout, assert: check = assertTeloaReady, report = message => console.error(message) }) {
  try {
    await check(await startupUrl, mountTimeout === undefined ? {} : { mountTimeout })
    return 0
  } catch (error) {
    report('Teloa 宿主就绪自检失败：' + (error instanceof Error ? error.message : String(error)))
    child.kill('SIGTERM')
    setTimeout(() => child.kill('SIGKILL'), killEscalation).unref?.()
    return 1
  }
}
