// 只供 tests/宿主就绪自检.test.js 的进程级回归使用的假 DSH 宿主。
// 由 scripts/启动DSH.mjs 的 TELOA_DSH_STUB_HOST 钩子拉起，复刻真实宿主的三处线形：
// 根路径按一次性令牌发 Cookie（303）、/teloa 通道的 RPC 回包、未挂载路径回 405。
import { createServer } from 'node:http'

const mode = process.env.TELOA_STUB_MODE
const port = Number(process.env.TELOA_DSH_PORT)
const token = 'zc3Qk7tVb9nA2mHs6Lx1Rd4Ff8Pw0Yj5'

// 供工作区收敛的进程级回归核对：沙箱策略的兜底写范围取宿主自己的 cwd。
process.stdout.write('桩宿主工作目录: ' + process.cwd() + '\n')

// (a) 不打印启动地址就正常退出：启动器必须按失败处理。
if (mode === '无地址') process.exit(0)

let decoyHits = 0

/** 诱饵：另一个 origin 上"合规"的应答方。启动器一旦不锁定 host，就会在这里拿到假就绪。 */
const decoy = createServer((request, response) => {
  decoyHits += 1
  const url = new URL(request.url, 'http://127.0.0.1')
  if (request.method === 'GET' && url.pathname === '/') {
    response.writeHead(303, { 'set-cookie': 'dsh-session=decoy; Path=/', location: '/' }).end()
    return
  }
  let body = ''
  request.setEncoding('utf8')
  request.on('data', chunk => { body += chunk })
  request.on('end', () => {
    const envelope = JSON.parse(body)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: [] } }))
  })
})

const host = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  if (request.method === 'GET' && url.pathname === '/') {
    if (url.searchParams.get('token') !== token) { response.writeHead(401).end(); return }
    response.writeHead(303, { 'set-cookie': 'dsh-session=stub; Path=/; HttpOnly', location: '/' }).end()
    return
  }
  if (request.method === 'POST' && url.pathname === '/teloa/conversations/list') {
    if (request.headers.cookie !== 'dsh-session=stub') { response.writeHead(401).end(); return }
    // (b)(d) 插件挂载失败：真实宿主此时由静态前端接管，非 GET/HEAD 一律 405。
    if (mode === '未挂载' || mode === '诱饵') { response.writeHead(405).end(); return }
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const envelope = JSON.parse(body)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: [] } }))
      // 自检已经通过，桩宿主收工退出，免得进程级用例悬在这里。
      setTimeout(() => { host.close(); decoy.close(); process.exit(0) }, 50)
    })
    return
  }
  response.writeHead(405).end()
})

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  process.stdout.write('桩宿主收到 ' + signal + '，诱饵被访问 ' + decoyHits + ' 次\n')
  host.close(); decoy.close(); process.exit(0)
})

decoy.listen(0, '127.0.0.1', () => {
  host.listen(port, '127.0.0.1', () => {
    const line = 'dsh web: http://127.0.0.1:' + port + '/?token=' + token
    // 一直不打印启动地址，用来模拟用户在地址出现前按下 Ctrl-C。
    if (mode === '静默长驻') return
    // (d) 先打印另一个 origin 的地址，启动器必须略过它继续等自己的 host。
    if (mode === '诱饵') process.stdout.write('某插件: http://127.0.0.1:' + decoy.address().port + '/?token=' + token + '\n')
    // (c) 把带令牌的那一行从中间劈开：启动器只能扫收完的整行，否则会拿到半截令牌。
    if (mode === '半行令牌') { process.stdout.write(line.slice(0, line.length - 12)); setTimeout(() => process.stdout.write(line.slice(-12) + '\n'), 150) }
    else process.stdout.write(line + '\n')
  })
})
