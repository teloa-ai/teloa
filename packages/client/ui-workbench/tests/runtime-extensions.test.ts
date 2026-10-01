import test from 'node:test'
import type {BundleInfo} from '@deepseek-ai/dsh-api-remotes/client'
import assert from 'node:assert/strict'
import {runtimeExtensions,createRuntimeExtensionReader} from '../src/client/runtime-extensions.ts'

const bundle=(name:string,extra:Partial<BundleInfo>={}):BundleInfo=>({name,installed:true,enabled:true,optional:false,removable:true,rows:[],overrides:[],...extra})
test('运行扩展只排除明确系统包，保留未知、可选和被锁定的受管扩展',()=>{
 const rows=runtimeExtensions([
  bundle('@teloa/bundle'),bundle('@deepseek-ai/dsh-base'),bundle('@acme/tools'),
  bundle('@acme/pending',{readOnlyReason:'management-required'}),bundle('@deepseek-ai/browser',{installed:false,enabled:false,optional:true}),
 ],[])
 assert.deepEqual(rows.map(row=>row.name),['@acme/pending','@acme/tools','@deepseek-ai/browser'])
 assert.equal(rows[2]!.installed,false)
 assert.equal(rows[2]!.enabled,false)
})
test('启用选择不冒充运行成功，混合失败保留组件事实',()=>{
 const rows=runtimeExtensions([bundle('mixed',{rows:[{rowId:'ok',moduleName:'one',entryId:'one' as never},{rowId:'bad',moduleName:'two',entryId:'two' as never}]}),bundle('unobserved')],[
  {entryId:'one',moduleName:'one',enabled:true,fiberPhase:'active'},
  {entryId:'two',moduleName:'two',enabled:true,fiberPhase:'failed'},
 ] as never)
 assert.equal(rows[0]!.runtime,'failed')
 assert.equal(rows[1]!.runtime,'unverified')
 assert.equal(rows[0]!.rows[0]!.fiberPhase,'active')
})
test('读取失败保留旧清单并标错，晚到请求不能覆盖较新的读取',async()=>{
 let complete!:(value:{bundles:never[];plugins:never[]})=>void
 let calls=0
 const api=createRuntimeExtensionReader(()=>++calls>2?Promise.reject(Error('offline')):calls===1?new Promise(resolve=>{complete=resolve}):Promise.resolve({bundles:[bundle('latest')] as never[],plugins:[]}))
 const old=api.refresh();await api.refresh();complete({bundles:[],plugins:[]});await old
 assert.equal(api.getSnapshot().items[0]!.name,'latest')
 await api.refresh();assert.equal(api.getSnapshot().status,'failed');assert.equal(api.getSnapshot().items[0]!.name,'latest')
 api.dispose();await api.refresh();assert.equal(calls,3)
})
