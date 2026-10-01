import test from 'node:test'
import assert from 'node:assert/strict'
import {createMarketPluginInstallApi} from '../src/client/market-plugin-install-api.ts'

const source={registry:'npm' as const,packageName:'@example/visualize',version:'1.2.3'}
const preview={schema:'teloa.market-plugin-install-preview/v1' as const,source,trust:{status:'verified' as const,publisher:'Example',integrity:'sha512-'+Buffer.from('integrity').toString('base64')},bundleHash:'a'.repeat(64),permissionSummary:{permissions:[{id:'browser.sandbox',description:'在隔离框架中显示图表',required:true}]}}
const installation={id:'11111111-1111-4111-8111-111111111111',ownerId:'self',preview,state:'installed-active' as const,attempt:1,receipt:{schema:'teloa.market-plugin-install-receipt/v1' as const,outcome:'succeeded' as const},observation:{schema:'teloa.market-plugin-install-observation/v1' as const,status:'active' as const,source,bundleHash:preview.bundleHash,permissionSummary:preview.permissionSummary},createdAt:'2026-09-13T00:00:00.000Z',updatedAt:'2026-09-13T00:00:00.000Z'}
const request={schema:'teloa.market-plugin-install-spec/v1' as const,requestId:'22222222-2222-4222-8222-222222222222',preview}

test('市场插件安装的未知回包保留固定请求并以同一请求核对',async()=>{
 let raw:string|null=null,calls=0
 const api=createMarketPluginInstallApi(async(endpoint,payload)=>{
  assert.equal(endpoint,'market-plugins/install')
  assert.deepEqual(payload,request)
  if(!calls++)throw Error('连接中断')
  return installation
 },{read:()=>raw,write:value=>{raw=value},clear:()=>{raw=null}})
 await assert.rejects(api.install(request),/连接中断/)
 assert.deepEqual(api.pending(),request)
 assert.deepEqual(await api.recover(),installation)
 assert.equal(raw,null)
})

test('未知安装结果只允许核对，不能借相同来源重发另一个请求',async()=>{
 const unknown={...installation,state:'unknown' as const,receipt:{schema:'teloa.market-plugin-install-receipt/v1' as const,outcome:'unknown' as const,failure:{code:'install-unknown' as const,message:'未收到安装回执',retryable:true}},failure:{code:'install-unknown' as const,message:'未收到安装回执',retryable:true}}
 let installs=0,reconciles=0
 const api=createMarketPluginInstallApi(async(endpoint)=>{
  if(endpoint==='market-plugins/install'){installs++;return unknown}
  if(endpoint==='market-plugins/reconcile'){reconciles++;return installation}
  throw Error('unexpected endpoint')
 })
 assert.deepEqual(await api.install(request),unknown)
 await assert.rejects(api.install({...request,requestId:'33333333-3333-4333-8333-333333333333'}),/核对/)
 assert.equal(installs,1)
 assert.deepEqual(await api.reconcile(unknown.id),installation)
 assert.equal(reconciles,1)
})

test('仅接受完整 npm 精确来源预览，拒绝伪造或错配回包',async()=>{
 const api=createMarketPluginInstallApi(async()=>preview)
 assert.deepEqual(await api.preview(source),preview)
 await assert.rejects(createMarketPluginInstallApi(async()=>({...preview,source:{...source,version:'1.2.4'}})).preview(source),/一致/)
 await assert.rejects(createMarketPluginInstallApi(async()=>({...preview,trust:{...preview.trust,integrity:'sha512-'}})).preview(source),/格式/)
})

test('已激活安装必须与固定预览的来源、摘要和权限一致',async()=>{
 await assert.rejects(createMarketPluginInstallApi(async()=>({...installation,observation:{...installation.observation!,source:{...source,version:'1.2.4'}}})).get(installation.id),/格式/)
})

test('权限只按 id 与 required 核对：旧说明文字的记录可读，id 或 required 变化仍拒绝',async()=>{
 const permission=preview.permissionSummary.permissions[0]!
 const legacy={...installation,preview:{...preview,permissionSummary:{permissions:[{...permission,description:'旧版说明'}]}}}
 assert.equal((await createMarketPluginInstallApi(async()=>legacy).get(installation.id)).preview.permissionSummary.permissions[0]!.description,'旧版说明')
 for(const changed of [{...permission,required:false},{...permission,id:'browser.other'}])await assert.rejects(createMarketPluginInstallApi(async()=>({...installation,observation:{...installation.observation!,permissionSummary:{permissions:[changed]}}})).get(installation.id),/格式/)
})
