import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createIndustryPluginHandler,guardDshPluginInstall} from '../src/industry-plugins.ts'
import {WorkError} from '@teloa/contract'

const id='12345678-1234-4234-8234-123456789012',loadId='22345678-1234-4234-8234-123456789012',itemInstanceId='32345678-1234-4234-8234-123456789012'
const contentId='42345678-1234-4234-8234-123456789012',stamp='2026-09-14T00:00:00.000Z'
const record={id,ownerId:'owner',loadId,itemInstanceId,itemLocalId:'visualize-plugin',contentId,contentHash:'a'.repeat(64),itemVersion:'0.1.2',scope:'space-'+contentId,definition:{format:'teloa.plugin/v1' as const,registry:'npm' as const,packageName:'dsh-visualize',version:'0.1.2'},definitionHash:'b'.repeat(64),installationId:null as string|null,state:'needs_install' as const,revision:1,createdAt:stamp,updatedAt:stamp}
const active={...record,installationId:id,state:'active' as const,revision:2}
const pending={...record,installationId:id,state:'pending-enable' as const,revision:2}
// 市场路径同形的固定预览：权限逐条、发布者、信任结论与完整性摘要都在里面，客户端据此呈现知情同意。
const preview={schema:'teloa.market-plugin-install-preview/v1' as const,source:{registry:'npm' as const,packageName:'dsh-visualize',version:'0.1.2'},trust:{status:'verified' as const,publisher:'dsh-visualize',integrity:'sha512-AAAABBBBCCCCDDDD=='},bundleHash:'c'.repeat(64),permissionSummary:{permissions:[{id:'bundle.patch',description:'插入一行组合条目',required:true}]}}
const instantiateInput={requestId:id,loadId,itemInstanceId}
const installInput={requestId:id,instanceId:id,expectedRevision:1,preview}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

test('行业插件入口固定本人并把 AbortSignal 交给真实安装',async()=>{
 const calls:unknown[][]=[],opened:(AbortSignal|undefined)[]=[]
 const handler=createIndustryPluginHandler('owner',async signal=>{
  opened.push(signal)
  return {
   instantiate:async(...args)=>{calls.push(['instantiate',...args]);return record},
   preview:async(...args)=>{calls.push(['preview',...args]);return preview},
   install:async(...args)=>{calls.push(['install',...args]);return pending},
   enable:async(...args)=>{calls.push(['enable',...args]);return active},
   reconcile:async(...args)=>{calls.push(['reconcile',...args]);return active},
   get:async(...args)=>{calls.push(['get',...args]);return record},
   list:async(...args)=>{calls.push(['list',...args]);return {items:[record]}},
  }
 })
 const signal=new AbortController().signal
 assert.deepEqual(await handler('industry-plugins/instantiate',instantiateInput),record)
 // 安装前先把预览原样交给客户端：这一步只读，不推进任何状态。
 assert.deepEqual(await handler('industry-plugins/preview',{instanceId:id},signal),preview)
 // 安装落到"已安装 · 待启用"：包进了 profile，但没进 bundles，补丁层尚未参与组合。
 const installed=await handler('industry-plugins/install',installInput,signal) as typeof pending
 assert.deepEqual(installed,pending)
 assert.equal(installed.revision,2);assert.match(installed.installationId,uuid);assert.equal(installed.state,'pending-enable')
 assert.deepEqual(await handler('industry-plugins/enable',{instanceId:id,preview},signal),active)
 assert.deepEqual(await handler('industry-plugins/reconcile',{instanceId:id},signal),active)
 assert.deepEqual(await handler('industry-plugins/get',{instanceId:id}),record)
 assert.deepEqual(await handler('industry-plugins/list',{}),{items:[record]})
 assert.deepEqual(calls,[['instantiate','owner',instantiateInput],['preview','owner',{instanceId:id}],['install','owner',installInput],['enable','owner',{instanceId:id,preview}],['reconcile','owner',{instanceId:id}],['get','owner',{instanceId:id}],['list','owner',{}]])
 assert.deepEqual(opened,[undefined,signal,signal,signal,signal,undefined,undefined])
})

test('行业插件入口拒绝伪造字段、伪造安装身份与重复映射',async()=>{
 let opened=0
 const unopened=createIndustryPluginHandler('owner',async()=>{opened++;throw Error('不应打开服务')})
 for(const payload of [{...instantiateInput,ownerId:'other'},{...instantiateInput,scope:'general'},{...instantiateInput,itemInstanceId:'bad'}])await assert.rejects(unopened('industry-plugins/instantiate',payload),{code:'teloa/invalid-input'})
 await assert.rejects(unopened('industry-plugins/install',{...installInput,packageName:'evil-pkg'},new AbortController().signal),{code:'teloa/invalid-input'})
 // 缺预览、预览形状不对、预览多带字段：都在通道口拒绝，服务一次也不打开。
 await assert.rejects(unopened('industry-plugins/install',{requestId:id,instanceId:id,expectedRevision:1},new AbortController().signal),{code:'teloa/invalid-input'})
 await assert.rejects(unopened('industry-plugins/install',{...installInput,preview:{...preview,bundleHash:'zz'}},new AbortController().signal),{code:'teloa/invalid-input'})
 await assert.rejects(unopened('industry-plugins/enable',{instanceId:id},new AbortController().signal),{code:'teloa/invalid-input'})
 await assert.rejects(unopened('industry-plugins/enable',{instanceId:id,preview:{...preview,extra:true}},new AbortController().signal),{code:'teloa/invalid-input'})
 await assert.rejects(unopened('industry-plugins/preview',{instanceId:'bad'},new AbortController().signal),{code:'teloa/invalid-input'})
 await assert.rejects(unopened('industry-plugins/reconcile',{instanceId:id,installationId:id},new AbortController().signal),{code:'teloa/invalid-input'})
 assert.equal(opened,0)
 const bad=createIndustryPluginHandler('owner',async()=>({
  instantiate:async()=>({...record,state:'active'}),
  preview:async()=>({...preview,trust:{...preview.trust,integrity:'not-a-digest'}}),
  install:async()=>({...active,installationId:null}),
  enable:async()=>({...active,id:contentId}),
  reconcile:async()=>({...active,id:contentId}),
  get:async()=>({...record,definition:{...record.definition,version:'latest'}}),
  list:async()=>({items:[record,{...record,id:contentId}]}),
 }))
 await assert.rejects(bad('industry-plugins/instantiate',instantiateInput),{code:'teloa/invalid-host-response'})
 await assert.rejects(bad('industry-plugins/preview',{instanceId:id},new AbortController().signal),{code:'teloa/invalid-host-response'})
 await assert.rejects(bad('industry-plugins/install',installInput,new AbortController().signal),{code:'teloa/invalid-host-response'})
 await assert.rejects(bad('industry-plugins/enable',{instanceId:id,preview},new AbortController().signal),{code:'teloa/invalid-host-response'})
 await assert.rejects(bad('industry-plugins/reconcile',{instanceId:id},new AbortController().signal),{code:'teloa/invalid-host-response'})
 await assert.rejects(bad('industry-plugins/get',{instanceId:id}),{code:'teloa/invalid-host-response'})
 await assert.rejects(bad('industry-plugins/list',{}),{code:'teloa/invalid-host-response'})
})

test('插件漂移投影保留安装身份并保持版本耦合，逐行失败项与实例身份不得重合',async()=>{
 const drifted={...active,state:'needs_install' as const,drift:true as const},broken='52345678-1234-4234-8234-123456789012'
 const page={items:[drifted],errors:[{instanceId:broken,code:'teloa/source-unavailable'}]}
 const handler=createIndustryPluginHandler('owner',async()=>({instantiate:async()=>record,preview:async()=>preview,install:async()=>pending,enable:async()=>active,reconcile:async()=>active,get:async()=>drifted,list:async()=>page}))
 assert.deepEqual(await handler('industry-plugins/list',{}),page)
 assert.deepEqual(await handler('industry-plugins/get',{instanceId:id}),drifted)
 const bad=[
  {items:[{...drifted,drift:false}]},
  {items:[{...active,drift:true}]},
  {items:[{...drifted,revision:1}]},
  {items:[{...drifted,installationId:null}]},
  {items:[{...record,drift:true,installationId:id}]},
  {items:[drifted],errors:[{instanceId:broken,code:'teloa/storage-corrupt'},{instanceId:broken,code:'teloa/source-unavailable'}]},
  {items:[drifted],errors:[{instanceId:id,code:'teloa/storage-corrupt'}]},
 ]
 for(const value of bad){
  const rejecting=createIndustryPluginHandler('owner',async()=>({instantiate:async()=>record,preview:async()=>preview,install:async()=>pending,enable:async()=>active,reconcile:async()=>active,get:async()=>record,list:async()=>value}))
  await assert.rejects(rejecting('industry-plugins/list',{}),{code:'teloa/invalid-host-response'})
 }
 const never=createIndustryPluginHandler('owner',async()=>({instantiate:async()=>record,preview:async()=>preview,install:async()=>pending,enable:async()=>active,reconcile:async()=>active,get:async()=>record,list:async()=>({items:[{...record,drift:true}]})}))
 assert.deepEqual(await never('industry-plugins/list',{}),{items:[{...record,drift:true}]})
})

test('插件安装端口只向上抛 WorkError',async()=>{
 await assert.rejects(guardDshPluginInstall(async()=>{throw Error('dsh 崩溃')}),{code:'teloa/dependency-unavailable'})
 await assert.rejects(guardDshPluginInstall(async()=>{throw new WorkError('teloa/source-unavailable','npm 不可达')}),{code:'teloa/source-unavailable'})
 assert.equal(await guardDshPluginInstall(async()=>'ok'),'ok')
})

test('正式宿主在 RPC 前初始化并路由行业插件端点',async()=>{
 const source=await readFile(new URL('../src/index.ts',import.meta.url),'utf8')
 const sequence=await readFile(new URL('../../backend/src/work/initialize-database.ts',import.meta.url),'utf8')
 assert.match(sequence,/await initializeIndustryPlugins\(pool\)/)
 const initializeIndex=source.indexOf('initializeTeloaDatabase(database.pool')
 assert.notEqual(initializeIndex,-1)
 assert.ok(initializeIndex<source.indexOf("connection.rpc.handle('/teloa'"))
 assert.match(source,/\.\.\.industryPluginEndpoints/)
 assert.match(source,/industryPluginHandler\(endpoint,payload,signal\)/)
 assert.match(source,/IndustryPluginSource\(market,loads\)/)
 assert.match(source,/new DshPluginInstallAdapter\(\{dshHome,profile:dshProfile/)
})

test('待启用是行业插件的合法状态，目录与详情都能如实呈现',async()=>{
 // 安装只把包装进 profile，包名不进 `dsh.profile.bundles`：本人第二次显式启用之前它的补丁层不参与组合。
 const handler=createIndustryPluginHandler('owner',async()=>({instantiate:async()=>record,preview:async()=>preview,install:async()=>pending,enable:async()=>active,reconcile:async()=>pending,get:async()=>pending,list:async()=>({items:[pending]})}))
 assert.deepEqual(await handler('industry-plugins/get',{instanceId:id}),pending)
 assert.deepEqual(await handler('industry-plugins/list',{}),{items:[pending]})
 assert.deepEqual(await handler('industry-plugins/reconcile',{instanceId:id},new AbortController().signal),pending)
})
