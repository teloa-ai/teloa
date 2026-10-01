import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'

test('正式宿主先迁移持续计划与行业计划表，再启动调度和注册 RPC',async()=>{
 const source=await readFile(new URL('../src/index.ts',import.meta.url),'utf8')
 // 建表已收敛到后端唯一入口：宿主只保证它在调度与 RPC 之前跑，计划两张表由入口序列负责。
 const sequence=await readFile(new URL('../../backend/src/work/initialize-database.ts',import.meta.url),'utf8')
 assert.match(sequence,/await initializePlanOccurrences\(pool\)/)
 assert.match(sequence,/await initializeIndustryPlans\(pool\)/)
 const initialize=source.indexOf('await initializeTeloaDatabase(database.pool')
 const scheduler=source.indexOf('resources.beforeDatabaseClose(startPlanScheduler(')
 const rpc=source.indexOf("connection.rpc.handle('/teloa'")
 assert.notEqual(initialize,-1)
 assert.ok(initialize<scheduler)
 assert.ok(initialize<rpc)
})
