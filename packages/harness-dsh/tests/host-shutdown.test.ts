import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {Context} from '@deepseek-ai/cordis'
import {createHostShutdown} from '../src/host-shutdown.ts'

test('真实 Cordis 卸载先停止所有后台循环，等待回填结束后才关闭数据库',async()=>{
 const ctx=new Context(),events:string[]=[]
 let finishScheduler!:()=>void,finishMonitor!:()=>void
 const scheduler=new Promise<void>(resolve=>{finishScheduler=resolve}),monitor=new Promise<void>(resolve=>{finishMonitor=resolve})
 const lifecycle=createHostShutdown(async()=>{events.push('pool.end')})
 ctx.effect(()=>lifecycle.stop)
 lifecycle.beforeClose(async()=>{events.push('scheduler.stop');await scheduler;events.push('scheduler.drained')})
 lifecycle.beforeClose(async()=>{events.push('monitor.stop');await monitor;events.push('monitor.drained')})
 const stopping=ctx.fiber.dispose()
 await new Promise<void>(resolve=>setImmediate(resolve))
 assert.deepEqual(events,['scheduler.stop','monitor.stop'])
 finishScheduler();await new Promise<void>(resolve=>setImmediate(resolve))
 assert.ok(!events.includes('pool.end'))
 finishMonitor();await stopping
 assert.deepEqual(events,['scheduler.stop','monitor.stop','scheduler.drained','monitor.drained','pool.end'])
 await lifecycle.stop();assert.equal(events.filter(event=>event==='pool.end').length,1)
})

test('一个后台循环卸载报错仍等待其余回填，并关闭数据库后报告错误',async()=>{
 const events:string[]=[],failure=Error('观察失败'),lifecycle=createHostShutdown(async()=>{events.push('pool.end')})
 let finish!:()=>void
 const gate=new Promise<void>(resolve=>{finish=resolve})
 lifecycle.beforeClose(()=>{throw failure})
 lifecycle.beforeClose(async()=>{await gate;events.push('monitor.drained')})
 const stopping=lifecycle.stop(),rejected=assert.rejects(stopping,(error:unknown)=>error instanceof AggregateError&&error.errors[0]===failure)
 await new Promise<void>(resolve=>setImmediate(resolve));assert.deepEqual(events,[])
 finish();await rejected;assert.deepEqual(events,['monitor.drained','pool.end'])
})

test('安全执行恢复循环与插件启动核对都在关库之前排空',async()=>{
 // 上面两条用例已经证明：凡是经 beforeClose 注册的驱动，关停时都先停、排空，最后才 pool.end。
 // 这条要钉的是这两条新驱动确实走了同一个注册口——漏注册的后果是关库瞬间它们还在往外打请求，
 // 打在一个正在关闭的连接池上。装配整装跑不起来（要真 DSH 上下文与真库），所以按本仓既有做法读装配源码。
 const source=await readFile(new URL('../src/index.ts',import.meta.url),'utf8')
 assert.match(source,/resources\.beforeDatabaseClose\(monitorTaskRuns\(\{\s*list:\(\)=>securityExecutions\.outstanding\(securityPrincipal\),\s*reconcile:[^\n]*securityDriver\.recover\(/,
  '安全执行恢复循环必须注册进 beforeDatabaseClose')
 assert.match(source,/const pluginStartupReconcile=[^\n]*async\(\)=>\{[\s\S]*?await reconcileInterruptedPluginInstallations\(/)
 assert.match(source,/resources\.beforeDatabaseClose\(\(\)=>pluginStartupReconcile\)/,'插件启动核对必须把那份在途 Promise 交给 beforeDatabaseClose 等')
 // 注册必须在装配期就发生，不能藏在某个请求路径里等第一次调用才挂上。
 const registered=source.indexOf('resources.beforeDatabaseClose(()=>pluginStartupReconcile)')
 assert.ok(registered>0&&registered<source.indexOf("connection.rpc.handle('/teloa'"))
})
