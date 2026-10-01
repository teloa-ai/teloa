import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile, readdir} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {createWebAccessHandler, webAccessEndpoints} from '../src/web-access.ts'
import {createTaskRunHandler} from '../src/task-runs.ts'
import type {TaskRunService, WebAccessPolicyService} from '@teloa/backend'
import type {WebAccessEntry, WebAccessPolicy} from '@teloa/contract'

const owner='local-owner'
const policy=(over:Partial<WebAccessPolicy>={}):WebAccessPolicy=>({version:1,enabled:true,blocked:[],...over})
const change={requestId:randomUUID(),expectedVersion:1,enabled:false,blocked:['blocked.example']}

function stand(results:{get?:unknown;change?:unknown}={}){
 const calls:{name:string;owner:string;input:unknown}[]=[]
 const service={
  get:async(actor:string,input:unknown)=>{calls.push({name:'get',owner:actor,input});return 'get' in results?results.get:policy()},
  change:async(actor:string,input:unknown)=>{calls.push({name:'change',owner:actor,input});return 'change' in results?results.change:policy({version:2,enabled:false,blocked:['blocked.example']})},
 }
 // 桩故意能回坏形状（unknown），所以在这里按端点的服务类型断言
 return {calls,handle:createWebAccessHandler(owner,async()=>service as unknown as Pick<WebAccessPolicyService,'get'|'change'>)}
}

test('endpointSet 守卫：两条上网设置端点必须同时进 endpointSet 与分发链，且全 src 只有这一处清单',async()=>{
 assert.deepEqual([...webAccessEndpoints],['web-access/get','web-access/change'])
 const root=new URL('../src/',import.meta.url)
 const source=await readFile(new URL('index.ts',root),'utf8')
 const line=source.split('\n').find(row=>row.startsWith('const endpointSet=new Set('))
 assert.ok(line,'index.ts 里找不到 endpointSet 的声明行')
 assert.match(line,/\.\.\.webAccessEndpoints/)
 assert.match(source,/\(webAccessEndpoints as readonly string\[\]\)\.includes\(endpoint\)\?await webAccessHandler\(endpoint,payload\)/)
 // 端点字面量只许出现在 web-access.ts 的那一份清单里，避免有人另起一份绕过 endpointSet 或多出第三条。
 for(const entry of await readdir(root,{withFileTypes:true})){
  if(!entry.isFile()||!entry.name.endsWith('.ts')||entry.name==='web-access.ts')continue
  const text=await readFile(new URL(entry.name,root),'utf8')
  for(const endpoint of webAccessEndpoints)assert.doesNotMatch(text,new RegExp(`["'\`]${endpoint}["'\`]`),`${entry.name} 里不得出现 ${endpoint} 的字面量`)
 }
})

test('两端点固定宿主本人、按契约白名单解析入参，回包原样透传服务结果',async()=>{
 const {calls,handle}=stand()
 assert.deepEqual(await handle('web-access/get',{}),policy())
 assert.deepEqual(await handle('web-access/change',change),policy({version:2,enabled:false,blocked:['blocked.example']}))
 assert.deepEqual(calls.map(call=>[call.name,call.owner]),[['get','local-owner'],['change','local-owner']])
 assert.deepEqual(calls[1]?.input,change)
})

test('不在两条里的端点即 not-found；白名单外的字段一律 invalid-input；对象上没有 details',async()=>{
 const {handle}=stand()
 await assert.rejects(handle('web-access/list',{}),(error:unknown)=>{
  assert.ok(error instanceof Error)
  assert.equal((error as {code?:string}).code,'teloa/not-found')
  assert.equal((error as {details?:unknown}).details,undefined)
  assert.doesNotMatch(String((error as Error).message),/WEB_/)
  return true
 })
 // get 不接受任何字段（taskInput(payload,[])）。
 await assert.rejects(handle('web-access/get',{enabled:true}),{code:'teloa/invalid-input'})
 await assert.rejects(handle('web-access/get',{requestId:randomUUID()}),{code:'teloa/invalid-input'})
 // change 白名单恰好四键：多出第五个键即拒。
 await assert.rejects(handle('web-access/change',{...change,extra:1}),{code:'teloa/invalid-input'})
 await assert.rejects(handle('web-access/change',{...change,details:{}}),{code:'teloa/invalid-input'})
})

test('回包过契约投影核对：不是精确三键的策略对象一律 invalid-host-response',async()=>{
 await assert.rejects(stand({get:{...policy(),extra:1}}).handle('web-access/get',{}),{code:'teloa/invalid-host-response'})
 await assert.rejects(stand({get:{enabled:true,blocked:[]}}).handle('web-access/get',{}),{code:'teloa/invalid-host-response'})
 await assert.rejects(stand({change:{...policy(),blocked:['BLOCKED.EXAMPLE']}}).handle('web-access/change',change),{code:'teloa/invalid-host-response'})
 await assert.rejects(stand({change:null}).handle('web-access/change',change),{code:'teloa/invalid-host-response'})
})

test('运行回包投影：带记录的运行贴出 webAccess 且按 at 升序，空列表运行不带该键，subagents 与 contextTokenEstimate 行为逐字不变',async()=>{
 const first={id:'11111111-1111-4111-8111-111111111111',sessionId:'run-one'},second={id:'22222222-2222-4222-8222-222222222222',sessionId:'run-two'}
 const service={list:async()=>[first,second]} as unknown as TaskRunService
 const registered={runId:first.id,reservationId:'call:one',state:'ended' as const,createdAt:'2026-09-17T00:00:00.000Z',endedAt:'2026-09-17T00:01:00.000Z',startedAt:'2026-09-17T00:00:00.000Z',childSessionId:'child_one',depth:1,stopReason:'completed'}
 const entryOne:WebAccessEntry={kind:'search',value:'第一次查询',at:'2026-09-20T00:00:00.000Z'}
 const entryTwo:WebAccessEntry={kind:'fetch',value:'https://example.com/',at:'2026-09-20T00:01:00.000Z'}
 const webAccessCalls:string[][]=[]
 const handler=createTaskRunHandler(
  'local-owner',async()=>service,{check:async()=>{},send:async()=>{},stop:async()=>{},events:async()=>[]},
  undefined,undefined,
  {listMany:async(actor,ids)=>{assert.equal(actor,'local-owner');return new Map([[first.id,[registered]]])}},
  {estimate:async sessionId=>sessionId==='run-one'?111:222},
  {listMany:async(actor,ids)=>{assert.equal(actor,'local-owner');webAccessCalls.push([...ids]);return new Map([[first.id,[entryOne,entryTwo]]])}},
 )
 const result=await handler('task-runs/list',{taskId:'task'},new AbortController().signal)
 assert.deepEqual(result,[
  {...first,subagents:[registered],webAccess:[entryOne,entryTwo],contextTokenEstimate:111},
  {...second,contextTokenEstimate:222},
 ])
 assert.deepEqual(webAccessCalls,[[first.id,second.id]])
 // 空列表的 run（second 没有登记项）不带 webAccess 键。
 assert.ok(!('webAccess' in (result as Array<Record<string,unknown>>)[1]!))
 // 升序核对：entryOne.at < entryTwo.at,且贴回顺序与读口返回顺序一致（读口已按 seq 升序，宿主不重排也不倒排）。
 const attached=(result as Array<{webAccess?:WebAccessEntry[]}>)[0]!.webAccess!
 assert.ok(new Date(attached[0]!.at).getTime()<new Date(attached[1]!.at).getTime())
})
