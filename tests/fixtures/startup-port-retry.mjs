/** 只重试测试宿主在发布启动地址之前被抢占的临时端口；业务/就绪失败不重放。 */
export async function retryStartupPort(start, firstPort, nextPort) {
  let port = firstPort
  for (let attempt = 0; ; attempt++) {
    const result = start(port)
    const collision = result.status !== 0 && !/dsh web: http:\/\/127\.0\.0\.1:/.test(result.stdout || '') &&
      ((result.stderr || '').includes('端口 ' + port + ' 不可用；未停止其他服务。') || /\bEADDRINUSE\b/.test(result.stderr || ''))
    if (!collision || attempt >= 2) return { ...result, port }
    port = await nextPort()
  }
}
