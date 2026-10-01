import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createServer as createSocketServer } from 'node:net'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findStartupUrl, authorizeSession, assertTeloaReady, guardTeloaReadiness } from '../scripts/核对宿主就绪.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const starter = fileURLToPath(new URL('../scripts/启动DSH.mjs', import.meta.url))
const freePort = () => new Promise(done => {
  const probe = createSocketServer()
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => done(port)) })
})

/**
 * 进程级用例的隔离宿主环境：DSH_HOME 与运行目录都落在临时目录，正式 `.runtime/` 一个字节都不写。
 * profile 按启动器自己的校验口径直接生成，省掉真实 DSH 的 `--from-default-profile` 一轮——
 * 那一步要拉起真实宿主并铺开 bundle，分钟级，且会把产物写进被测的 DSH_HOME。
 * 取舍：这份最小 profile 复刻了启动器要求的 web bundle 顺序，启动器改口径时这里要同步。
 * 临时根先取 realpath：macOS 的 /var 是软链，子进程的 process.cwd() 返回的是真实路径。
 */
async function isolatedHome(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'teloa-starter-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  const dshHome = join(base, 'dsh'), runtimeRoot = join(base, 'teloa')
  await mkdir(join(dshHome, 'profiles', 'teloa'), { recursive: true })
  await writeFile(join(dshHome, 'profiles', 'teloa', 'package.json'), JSON.stringify({
    name: 'teloa-profile', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'startup' } },
  }, null, 2) + '\n')
  return { base, dshHome, runtimeRoot, workspace: join(runtimeRoot, 'workspace') }
}

/** 启动器环境：桩宿主、临时端口与隔离运行目录；工作区不显式配置，按运行目录派生。 */
function starterEnv(home, mode, port, overrides = {}) {
  const env = {
    ...process.env,
    TELOA_DSH_STUB_HOST: 'tests/fixtures/桩宿主.mjs', TELOA_STUB_MODE: mode, TELOA_DSH_PORT: String(port),
    TELOA_DSH_HOME: home.dshHome, TELOA_RUNTIME_ROOT: home.runtimeRoot, TELOA_DSH_PROFILE: 'teloa',
    ...overrides,
  }
  if (!('TELOA_WORKSPACE_ROOT' in overrides)) delete env.TELOA_WORKSPACE_ROOT
  return env
}

/** 真跑启动器：把 spawn 目标换成桩宿主，端口临时分配，不碰正式 3100 宿主也不写正式运行目录。 */
async function runStarter(t, mode, overrides = {}) {
  const home = await isolatedHome(t), port = await freePort()
  const result = spawnSync(process.execPath, [starter], { cwd: root, env: starterEnv(home, mode, port, overrides), encoding: 'utf8', timeout: 30_000 })
  return { ...result, port, home }
}

/**
 * 起一个最小 DSH 仿真：根路径发 Cookie，/teloa 通道按 mounted 决定 200 还是 405。
 * mounted 传数字时表示"前 N 次探测仍未挂载"，用来复刻真实宿主的装配空窗。
 */
function startStub(mounted) {
  let probes = 0
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (request.method === 'GET' && url.pathname === '/') {
      if (url.searchParams.get('token') !== 'stub-token') { response.writeHead(401).end(); return }
      response.writeHead(302, { 'set-cookie': 'dsh-session=stub; Path=/; HttpOnly', location: '/' }).end()
      return
    }
    if (request.method === 'POST' && url.pathname === '/teloa/conversations/list') {
      if (request.headers.cookie !== 'dsh-session=stub') { response.writeHead(401).end(); return }
      // 插件挂载失败时真实宿主由静态前端接管，非 GET/HEAD 回的是 405 而不是 404。
      probes += 1
      if (mounted === false || (typeof mounted === 'number' && probes <= mounted)) { response.writeHead(405).end(); return }
      let body = ''
      request.setEncoding('utf8')
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        const envelope = JSON.parse(body)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: [] } }))
      })
      return
    }
    response.writeHead(404).end()
  })
  return new Promise(done => server.listen(0, '127.0.0.1', () => done({
    url: 'http://127.0.0.1:' + server.address().port + '/?token=stub-token',
    probes: () => probes,
    close: () => new Promise(closed => server.close(closed)),
  })))
}

test('启动输出里只认带令牌的根地址，自检消息不回显地址', () => {
  assert.equal(findStartupUrl('dsh web: http://127.0.0.1:3100/?token=abc123\n'), 'http://127.0.0.1:3100/?token=abc123')
  assert.equal(findStartupUrl('正在启动…\n'), undefined)
})

test('指定 host 时略过其他 origin 的地址，继续找本启动器自己的那一行', () => {
  const 输出 = '某插件: http://10.0.0.9:9999/?token=外部令牌\ndsh web: http://127.0.0.1:3100/?token=abc123\n'
  assert.equal(findStartupUrl(输出, '127.0.0.1:3100'), 'http://127.0.0.1:3100/?token=abc123')
  assert.equal(findStartupUrl(输出, '127.0.0.1:3200'), undefined, '端口不符不能拿来当自检目标')
  assert.equal(findStartupUrl('某插件: http://10.0.0.9:9999/?token=外部令牌\n', '127.0.0.1:3100'), undefined)
  // LAN 地址与本机地址同行时也只认本机那个。
  assert.equal(findStartupUrl('dsh web: http://127.0.0.1:3100/?token=a (LAN: http://192.168.1.5:3100/?token=a)\n', '127.0.0.1:3100'), 'http://127.0.0.1:3100/?token=a')
})

test('Teloa 通道已挂载时自检通过', async () => {
  const stub = await startStub(true)
  await assertTeloaReady(stub.url)
  await stub.close()
})

test('Teloa 通道未挂载时自检失败，且失败消息不含地址或令牌', async () => {
  const stub = await startStub(false)
  const error = await assertTeloaReady(stub.url, { mountTimeout: 300 }).then(() => undefined, failure => failure)
  assert.ok(error instanceof Error)
  assert.match(error.message, /Teloa 工作通道未挂载/)
  assert.ok(!error.message.includes('token'))
  assert.ok(!error.message.includes('127.0.0.1'))
  await stub.close()
})

test('装配空窗里的未挂载按"还没到"重试，挂载后自检通过', async () => {
  // 隔离宿主首启实测：地址打印时全库结构初始化还没跑完，Teloa 通道要几秒后才注册。
  // 单发探针会把这台正在起的宿主判成未挂载并杀掉，装配也随之半途中断。
  const stub = await startStub(2)
  await assertTeloaReady(stub.url, { mountTimeout: 10_000 })
  assert.equal(stub.probes(), 3, '应当在挂载窗口内重试到通道真正挂载')
  await stub.close()
})

test('通道已挂载后的业务失败立即失败，不占用挂载窗口重试', async () => {
  let calls = 0
  const send = async (_, init) => {
    calls += 1
    if (calls === 1) return new Response(null, { status: 303, headers: { 'set-cookie': 'dsh-session=stub; Path=/' } })
    return Response.json({ type: 'server-response', rpcId: JSON.parse(init.body).rpcId, result: { ok: false, error: { code: 'teloa/forbidden' } } })
  }
  const error = await assertTeloaReady('http://127.0.0.1:1/?token=unused', { fetch: send, mountTimeout: 10_000 }).then(() => undefined, failure => failure)
  assert.ok(error instanceof Error)
  assert.match(error.message, /Teloa 工作通道返回失败：teloa\/forbidden。/)
  assert.equal(calls, 2, '已挂载后的失败不能重试')
})

test('末轮探针被窗口夹到超时时，诊断仍是上一次的"未挂载"固定文案', async () => {
  let calls = 0
  const send = async (_, init) => {
    calls += 1
    if (calls === 1) return new Response(null, { status: 303, headers: { 'set-cookie': 'dsh-session=stub; Path=/' } })
    if (calls === 2) return new Response(null, { status: 405 })
    // 末轮：剩余窗口比宿主响应时延还短，探针必然被 AbortSignal.timeout 掐断。
    return new Promise((_done, fail) => init.signal.addEventListener('abort', () => fail(init.signal.reason)))
  }
  const error = await assertTeloaReady('http://127.0.0.1:1/?token=unused', { fetch: send, mountTimeout: 700 }).then(() => undefined, failure => failure)
  assert.ok(error instanceof Error)
  assert.match(error.message, /Teloa 工作通道未挂载.*HTTP 405/, '应沿用上一次的未挂载诊断')
  assert.doesNotMatch(error.message, /abort|Abort|timed out/, '不得把 fetch 的英文中断错误当成结论')
  assert.equal(calls, 3)
})

test('一次探针都没成功回过话时给出固定中文超时文案，不回显英文中断错误', async () => {
  const send = async (_, init) => {
    if (!init.method) return new Response(null, { status: 303, headers: { 'set-cookie': 'dsh-session=stub; Path=/' } })
    return new Promise((_done, fail) => init.signal.addEventListener('abort', () => fail(init.signal.reason)))
  }
  const error = await assertTeloaReady('http://127.0.0.1:1/?token=unused', { fetch: send, mountTimeout: 200 }).then(() => undefined, failure => failure)
  assert.ok(error instanceof Error)
  assert.equal(error.message, 'Teloa 工作通道在就绪窗口内没有回包，拒绝按就绪对外服务。')
})

test('自检失败时终止子进程并给出非零退出码；成功时不打印也不终止', async () => {
  const failing = []
  let killed
  const code = await guardTeloaReadiness({
    child: { kill: signal => { killed = signal } },
    startupUrl: Promise.resolve('http://127.0.0.1:1/?token=unused'),
    assert: async () => { throw Error('Teloa 工作通道未挂载，宿主已就绪但业务不可用（HTTP 404）。') },
    report: message => failing.push(message),
  })
  assert.equal(code, 1)
  assert.equal(killed, 'SIGTERM')
  assert.equal(failing.length, 1)
  assert.match(failing[0], /^Teloa 宿主就绪自检失败：/)

  const quiet = []
  let untouched = true
  const ok = await guardTeloaReadiness({
    child: { kill: () => { untouched = false } },
    startupUrl: Promise.resolve('http://127.0.0.1:1/?token=unused'),
    assert: async () => {},
    report: message => quiet.push(message),
  })
  assert.equal(ok, 0)
  assert.equal(untouched, true)
  assert.deepEqual(quiet, [])
})

test('拿不到启动地址时按失败处理', async () => {
  let killed
  const code = await guardTeloaReadiness({
    child: { kill: signal => { killed = signal } },
    startupUrl: Promise.reject(Error('宿主在 120 秒内没有打印启动地址。')),
    report: () => {},
  })
  assert.equal(code, 1)
  assert.equal(killed, 'SIGTERM')
})

test('启动器真跑：桩宿主不打印地址就退出时，启动器非零退出', async t => {
  const result = await runStarter(t, '无地址')
  assert.notEqual(result.status, 0, '拿不到启动地址不能报成功')
  assert.match(result.stderr, /Teloa 宿主就绪自检失败：宿主在打印启动地址前已退出。/)
  assert.ok(!result.stderr.includes('token='), '诊断消息不得回显令牌')
})

test('启动器真跑：Teloa 通道未挂载时终止桩宿主并非零退出', async t => {
  const result = await runStarter(t, '未挂载')
  assert.notEqual(result.status, 0, '半死宿主不能被报成启动成功')
  assert.match(result.stderr, /Teloa 宿主就绪自检失败：Teloa 工作通道未挂载.*HTTP 405/)
  assert.match(result.stdout, /桩宿主收到 SIGTERM/, '未就绪的宿主必须被终止')
  assert.ok(!result.stderr.includes(String(result.port)), '诊断消息不得回显地址')
})

test('启动器真跑：带令牌的行被 chunk 截断时不误杀健康宿主', async t => {
  const result = await runStarter(t, '半行令牌')
  assert.equal(result.status, 0, '半截令牌不能把健康宿主判成未就绪')
  assert.match(result.stdout, new RegExp('dsh web: http://127\\.0\\.0\\.1:' + result.port + '/\\?token=\\w{32}\\n'), '子进程输出必须原样转发')
  assert.doesNotMatch(result.stderr, /就绪自检失败/)
  assert.doesNotMatch(result.stdout, /桩宿主收到 SIG/, '健康宿主不能被终止')
})

test('启动器真跑：地址出现前按 Ctrl-C 算用户取消，不报自检失败', async t => {
  const home = await isolatedHome(t), port = await freePort()
  const child = spawn(process.execPath, [starter], {
    cwd: root,
    env: starterEnv(home, '静默长驻', port),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })
  const exited = new Promise(done => child.once('exit', () => done()))
  await new Promise(done => setTimeout(done, 500))
  child.kill('SIGINT')
  await exited
  assert.doesNotMatch(stderr, /就绪自检失败/, '用户取消不是自检失败')
})

test('启动器真跑：宿主在配置的运行目录下的专用工作区里运行，不落在仓库根', async t => {
  const result = await runStarter(t, '半行令牌')
  assert.equal(result.status, 0)
  assert.ok(result.stdout.includes('桩宿主工作目录: ' + result.home.workspace + '\n'), '宿主 cwd 必须是所配置运行目录下的专用工作区；sandbox-policy 的兜底写范围取 process.cwd()')
  assert.ok(!result.stdout.includes('桩宿主工作目录: ' + root.replace(/\/$/, '') + '\n'), '宿主 cwd 不能是仓库根')
  const stats = await stat(result.home.workspace)
  assert.ok(stats.isDirectory(), '启动器必须先把工作区目录建出来')
  assert.equal(stats.mode & 0o777, 0o700, '工作区权限与运行目录里其余状态一致')
})

test('启动器真跑：仓库根、其上级与仓库内运行目录之外的工作区都拒绝启动，诊断不含路径', async t => {
  const repository = root.replace(/\/$/, '')
  for (const workspace of [
    repository,                                                   // 仓库根本身
    fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, ''), // 仓库的上级
    resolve(repository, 'packages'),                              // 仓库内的源码目录
    resolve(repository, '.runtime'),                              // 运行目录本身：其下有口令与会话日志
  ]) {
    const result = await runStarter(t, '半行令牌', { TELOA_WORKSPACE_ROOT: workspace })
    assert.notEqual(result.status, 0, '不可用的工作区不能起服务：' + workspace)
    assert.match(result.stderr, /^工作区不能落在本程序所在目录及其上级，也不能落在该目录内运行目录之外的位置；请改用专用工作区后重新启动。$/m)
    assert.ok(!result.stderr.includes(workspace), '诊断消息不得回显路径')
    assert.doesNotMatch(result.stdout, /桩宿主/, '拒绝发生在起宿主之前')
  }
})

test('启动器真跑：仓库内运行目录之下与仓库之外的工作区都允许', async t => {
  // 运行目录之下：正式 .runtime/teloa/workspace 与验收 .runtime/teloa-e2e-… 都走这条路径。
  const inside = await runStarter(t, '半行令牌', { TELOA_WORKSPACE_ROOT: resolve(root, '.runtime/teloa-e2e-启动器用例/workspace') })
  assert.equal(inside.status, 0, '运行目录之下的工作区必须放行')
  assert.ok(inside.stdout.includes('桩宿主工作目录: ' + resolve(root, '.runtime/teloa-e2e-启动器用例/workspace') + '\n'))
  await rm(resolve(root, '.runtime/teloa-e2e-启动器用例'), { recursive: true, force: true })
  // 仓库之外：那是用户自己的目录，启动器不替他决定。
  const outsideHome = await isolatedHome(t)
  const outside = await runStarter(t, '半行令牌', { TELOA_WORKSPACE_ROOT: join(outsideHome.base, '用户自己的目录') })
  assert.equal(outside.status, 0, '仓库之外的工作区必须放行')
  assert.ok(outside.stdout.includes('桩宿主工作目录: ' + join(outsideHome.base, '用户自己的目录') + '\n'))
})

test('启动器真跑：待启用插件被补回 bundles 时先自愈压制，随后正常起宿主', async t => {
  const home = await isolatedHome(t), port = await freePort()
  const profileDir = join(home.dshHome, 'profiles', 'teloa')
  const manifest = bundles => writeFile(join(profileDir, 'package.json'), JSON.stringify({
    name: 'teloa-profile', private: true, dependencies: { '@vendor/plugin': '1.0.0' },
    dsh: { profile: { bundles, patchReload: 'startup' } },
  }, null, 2) + '\n')
  await writeFile(join(profileDir, 'teloa-待启用插件.json'), JSON.stringify({ '@vendor/plugin@1.0.0': 'a'.repeat(64) }))

  // 上游 reconcilePlugins 在任何一次 dsh plugin add 之后都会把待启用的包补回 bundles；
  // 起宿主前启动器现在会先朝安全方向自愈一次（把它从 bundles 摘掉），压制成功就照常启动。
  await manifest(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@vendor/plugin'])
  const healed = spawnSync(process.execPath, [starter], { cwd: root, env: starterEnv(home, '半行令牌', port), encoding: 'utf8', timeout: 30_000 })
  assert.equal(healed.status, 0, (healed.stderr || '').trim())
  const healedManifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
  assert.deepEqual(healedManifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], '自愈后包应已从 bundles 摘掉')

  // 包被正常压制着（有待启用记录、但不在 bundles 里）时照常启动：自愈是幂等的空操作。
  await manifest(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  const allowed = spawnSync(process.execPath, [starter], { cwd: root, env: starterEnv(home, '半行令牌', await freePort()), encoding: 'utf8', timeout: 30_000 })
  assert.equal(allowed.status, 0, (allowed.stderr || '').trim())
})

test('启动器真跑：待启用插件清单读不出时，自愈压制失败仍拒绝起宿主', async t => {
  const home = await isolatedHome(t), port = await freePort()
  const profileDir = join(home.dshHome, 'profiles', 'teloa')
  // 正文不是合法 JSON：readPendingPlugins 按"读不出来"处理，不当成"没有待启用插件"。
  await writeFile(join(profileDir, 'teloa-待启用插件.json'), '{ 不是合法 JSON')
  const refused = spawnSync(process.execPath, [starter], { cwd: root, env: starterEnv(home, '半行令牌', port), encoding: 'utf8', timeout: 30_000 })
  assert.notEqual(refused.status, 0, '待启用清单读不出来就不能起宿主')
  assert.doesNotMatch(refused.stdout, /桩宿主/, '拒绝发生在起宿主之前')
  assert.ok(!refused.stderr.includes(profileDir), '诊断不得回显路径')
})

test('启动器真跑：profile 里 @teloa/im-gateway 的模块链接指向别处时原子改回本程序目录，随后照常起宿主', async t => {
  const home = await isolatedHome(t), port = await freePort()
  const modules = join(home.dshHome, 'profiles', 'teloa', 'node_modules', '@teloa')
  await mkdir(modules, { recursive: true })
  await mkdir(join(home.base, '别处的包'))
  await symlink(join(home.base, '别处的包'), join(modules, 'im-gateway'))
  const started = spawnSync(process.execPath, [starter], { cwd: root, env: starterEnv(home, '半行令牌', port), encoding: 'utf8', timeout: 30_000 })
  assert.equal(started.status, 0, (started.stderr || '').trim())
  assert.equal(await realpath(join(modules, 'im-gateway')), await realpath(join(root, 'packages', 'im-gateway')))
  // 启动器按全部随附扩展补链：本地中文检索的链接同样指向本程序目录，且不留临时链接
  assert.equal(await realpath(join(modules, 'local-embedding')), await realpath(join(root, 'packages', 'local-embedding')))
  assert.deepEqual(await readdir(modules), ['im-gateway', 'local-embedding'], '不留临时链接')
})

test('启动器真跑：profile 里 @teloa/im-gateway 的模块位置是无法修正的实体目录时拒绝起宿主', async t => {
  const home = await isolatedHome(t), port = await freePort()
  const modules = join(home.dshHome, 'profiles', 'teloa', 'node_modules', '@teloa')
  await mkdir(join(modules, 'im-gateway'), { recursive: true })
  const refused = spawnSync(process.execPath, [starter], { cwd: root, env: starterEnv(home, '半行令牌', port), encoding: 'utf8', timeout: 30_000 })
  assert.notEqual(refused.status, 0, '实体目录不能替换就不能起宿主')
  assert.doesNotMatch(refused.stdout, /桩宿主/, '拒绝发生在起宿主之前')
  assert.match(refused.stderr, /官方扩展来源/)
  assert.ok(!refused.stderr.includes(home.base), '诊断不得回显路径')
})

test('启动器真跑：源码 profile 登记的 IM 来源不是本程序目录时以官方值补登记，不进组合', async t => {
  const home = await isolatedHome(t), port = await freePort()
  const profileDir = join(home.dshHome, 'profiles', 'teloa')
  await mkdir(join(home.base, '旧程序目录'))
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({
    name: 'teloa-profile', private: true,
    dependencies: { '@teloa/bundle': 'link:' + join(root, 'packages', 'bundle'), '@teloa/im-gateway': 'link:' + join(home.base, '旧程序目录') },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'startup' } },
  }, null, 2) + '\n')
  const started = spawnSync(process.execPath, [starter], { cwd: root, env: starterEnv(home, '半行令牌', port), encoding: 'utf8', timeout: 120_000 })
  assert.equal(started.status, 0, (started.stderr || '').trim())
  assert.doesNotMatch(started.stderr, /补登记未完成/)
  const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies['@teloa/im-gateway'], 'link:' + join(root, 'packages', 'im-gateway'))
  assert.ok(!manifest.dsh.profile.bundles.includes('@teloa/im-gateway'), '补登记不进组合')
  assert.equal(await realpath(join(profileDir, 'node_modules', '@teloa', 'im-gateway')), await realpath(join(root, 'packages', 'im-gateway')))
})

test('启动器真跑：源码/容器补登记不经包管理器——第三方依赖装不上（离线、store 属主不符）时照常以官方值补登记，有渠道的老用户随即迁移启用', async t => {
  const home = await isolatedHome(t), port = await freePort()
  const profileDir = join(home.dshHome, 'profiles', 'teloa')
  // 第三方依赖指向不存在的本地目录：任何一次包管理器安装都会整体失败；补登记若仍经包管理器就会失败并推迟迁移。
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({
    name: 'teloa-profile', private: true,
    dependencies: { '@teloa/bundle': 'link:' + join(root, 'packages', 'bundle'), '@vendor/missing': 'file:' + join(home.base, '不存在') },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@teloa/bundle', '@vendor/missing'], patchReload: 'startup' } },
  }, null, 2) + '\n')
  await mkdir(join(home.runtimeRoot, 'im-gateway'), { recursive: true })
  await writeFile(join(home.runtimeRoot, 'im-gateway', 'channels.json'), JSON.stringify({ channels: [{ kind: 'telegram', id: 'stub' }] }))
  const started = spawnSync(process.execPath, [starter], { cwd: root, env: starterEnv(home, '半行令牌', port), encoding: 'utf8', timeout: 30_000 })
  assert.equal(started.status, 0, (started.stderr || '').trim())
  assert.doesNotMatch(started.stderr, /补登记未完成|迁移未完成/)
  const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies['@teloa/im-gateway'], 'link:' + join(root, 'packages', 'im-gateway'))
  assert.equal(manifest.dependencies['@vendor/missing'], 'file:' + join(home.base, '不存在'), '第三方登记原样保留')
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@teloa/bundle', '@teloa/im-gateway', '@vendor/missing'], 'IM 排在第三方之前')
  assert.deepEqual(JSON.parse(await readFile(join(profileDir, 'teloa-官方扩展.json'), 'utf8')), { 'im-gateway-optional-v1': 'enabled' })
  assert.equal(await realpath(join(profileDir, 'node_modules', '@teloa', 'im-gateway')), await realpath(join(root, 'packages', 'im-gateway')))
})

test('启动器真跑：--version 等检查分支不做补登记与迁移，也不告警', async t => {
  const home = await isolatedHome(t), port = await freePort()
  const profileDir = join(home.dshHome, 'profiles', 'teloa')
  const text = JSON.stringify({
    name: 'teloa-profile', private: true,
    dependencies: { '@teloa/bundle': 'link:' + join(root, 'packages', 'bundle') },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@teloa/bundle'], patchReload: 'startup' } },
  }, null, 2) + '\n'
  await writeFile(join(profileDir, 'package.json'), text)
  await mkdir(join(home.runtimeRoot, 'im-gateway'), { recursive: true })
  await writeFile(join(home.runtimeRoot, 'im-gateway', 'channels.json'), JSON.stringify({ channels: [{ kind: 'telegram', id: 'stub' }] }))
  const checked = spawnSync(process.execPath, [starter, '--version'], { cwd: root, env: starterEnv(home, '无地址', port), encoding: 'utf8', timeout: 30_000 })
  assert.equal(checked.status, 0, (checked.stderr || '').trim())
  assert.equal(checked.stderr, '', '检查分支的 stderr 被安装准备逐字核对，不能有告警')
  assert.equal(await readFile(join(profileDir, 'package.json'), 'utf8'), text, '不补登记、不启用')
  await assert.rejects(stat(join(profileDir, 'teloa-官方扩展.json')), { code: 'ENOENT' }, '不写迁移记录')
})

test('启动器真跑：模块链接指向本程序目录时照常起宿主；迁移记录读不出只告警不阻断', async t => {
  const home = await isolatedHome(t), port = await freePort()
  const profileDir = join(home.dshHome, 'profiles', 'teloa')
  await mkdir(join(profileDir, 'node_modules', '@teloa'), { recursive: true })
  await symlink(join(root, 'packages', 'im-gateway'), join(profileDir, 'node_modules', '@teloa', 'im-gateway'))
  await writeFile(join(profileDir, 'teloa-官方扩展.json'), '{ 不是合法 JSON')
  const started = spawnSync(process.execPath, [starter], { cwd: root, env: starterEnv(home, '半行令牌', port), encoding: 'utf8', timeout: 30_000 })
  assert.equal(started.status, 0, (started.stderr || '').trim())
  assert.match(started.stderr, /官方扩展迁移未完成/)
})

test('启动器真跑：--dump-config 等检查分支不建工作区目录', async t => {
  const home = await isolatedHome(t), port = await freePort()
  // 检查分支借真实 DSH 做配置转储，用正式 DSH_HOME 里已经准备好的 profile，不换桩宿主；
  // 只把运行目录挪到临时位置，用来观察这条分支到底建不建工作区。
  const env = starterEnv(home, '半行令牌', port)
  delete env.TELOA_DSH_HOME
  delete env.TELOA_DSH_STUB_HOST
  const result = spawnSync(process.execPath, [starter, '--dump-config'], { cwd: root, env, encoding: 'utf8', timeout: 120_000 })
  assert.equal(result.status, 0, (result.stderr || '').trim())
  await assert.rejects(stat(home.workspace), { code: 'ENOENT' }, '检查分支不该把工作区目录建出来')
})

test('启动器真跑：桩宿主白名单拒绝指向仓库外的软链与不存在的路径', async t => {
  // 字符串前缀判断只看软链自身的路径，看不出软链背后指向了仓库外；这里在 tests/fixtures/
  // 下临时放一个指向仓库外的软链，验证白名单改成 realpath 比较后能截住这条绕过路径。
  const outsideHome = await isolatedHome(t)
  const target = join(outsideHome.base, '外部宿主.mjs')
  await writeFile(target, 'process.exit(1)\n')
  const link = resolve(root, 'tests/fixtures/临时软链宿主.mjs')
  await symlink(target, link)
  t.after(() => rm(link, { force: true }))

  const linked = await runStarter(t, '半行令牌', { TELOA_DSH_STUB_HOST: 'tests/fixtures/临时软链宿主.mjs' })
  assert.notEqual(linked.status, 0, '指向仓库外的软链必须被拒绝')
  assert.match(linked.stderr, /^桩宿主只能是本仓库 tests 目录下的 \.mjs 脚本。$/m)
  assert.doesNotMatch(linked.stdout, /桩宿主/, '拒绝发生在起宿主之前')

  const missing = await runStarter(t, '半行令牌', { TELOA_DSH_STUB_HOST: 'tests/fixtures/不存在的宿主.mjs' })
  assert.notEqual(missing.status, 0, '不存在的桩宿主路径必须被拒绝')
  assert.match(missing.stderr, /^桩宿主只能是本仓库 tests 目录下的 \.mjs 脚本。$/m)
})

test('启动器真跑：宿主先打印别的 origin 时，探针只打自己的 host', async t => {
  const result = await runStarter(t, '诱饵')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Teloa 工作通道未挂载.*HTTP 405/, '必须对本启动器的 host 判定，而不是被诱饵冒充就绪')
  assert.match(result.stdout, /诱饵被访问 0 次/, '探针一次都不能打到宿主输出里的外部地址')
})
