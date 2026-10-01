import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'

/**
 * 补签是启动期的一次性修补，不是装配的前置条件：它整体失败必须只记告警，`/teloa` 通道照常注册。
 * 装配整装跑不起来（要真 DSH 上下文与真库），所以按本仓既有做法（`host-shutdown.test.ts`）读装配源码。
 */
test('既有群补签失败不阻断装配：包在 try/catch 里，失败只记告警，RPC 通道照常注册',async()=>{
 const source=await readFile(new URL('../src/index.ts',import.meta.url),'utf8')
 const guarded=source.match(/try\{\s*const backfilled=await new CollaborationService\([\s\S]*?\.backfillDefaultGrants\(owner,[\s\S]*?\)\s*ctx\.logger\.info\('Teloa 既有群补签默认授权：%d 条',backfilled\)\s*\}catch\(error\)\{ctx\.logger\.warn\('Teloa 既有群补签默认授权未完成，本次跳过：%o',error\)\}/)
 assert.ok(guarded,'补签必须整段包在 try/catch 里：成功记 info，失败记 warn')
 // 单个群补不上时同样只记告警：报告口在装配处接的是 logger.warn，不是抛出。
 assert.match(source,/backfillDefaultGrants\(owner,\(groupId,code\)=>ctx\.logger\.warn\('Teloa 既有群补签默认授权跳过一个群：%s（%s）',groupId,code\)\)/)
 // 装配继续往下走：补签之后才是 RPC 注册，且两者都在装配期发生。
 const backfill=source.indexOf('.backfillDefaultGrants(owner,'),rpc=source.indexOf("connection.rpc.handle('/teloa'")
 assert.ok(backfill>0&&rpc>0)
 assert.ok(backfill<rpc)
})
