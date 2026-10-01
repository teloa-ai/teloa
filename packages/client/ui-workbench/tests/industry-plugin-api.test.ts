import test from 'node:test'
import assert from 'node:assert/strict'
import {createIndustryPluginApi} from '../src/client/industry-plugin-api.ts'

const id='12345678-1234-4234-8234-123456789012',loadId='22345678-1234-4234-8234-123456789012',itemInstanceId='32345678-1234-4234-8234-123456789012',installationId='62345678-1234-4234-8234-123456789012',stamp='2026-09-14T00:00:00.000Z'
const definition={format:'teloa.plugin/v1' as const,registry:'npm' as const,packageName:'@teloa/threat-intel-plugin',version:'1.2.0'}
const record={id,ownerId:'local:teloa-owner',loadId,itemInstanceId,itemLocalId:'threat-intel-plugin',contentId:'42345678-1234-4234-8234-123456789012',contentHash:'a'.repeat(64),itemVersion:'1.0.0',scope:'space-'+loadId,definition,definitionHash:'b'.repeat(64),installationId:null,state:'needs_install' as const,revision:1,createdAt:stamp,updatedAt:stamp}
const installed={...record,state:'active' as const,revision:2,installationId}
// 安装与启用都是「客户端持固定预览提交」：这一份就是人在确认区逐条核过的那一份。
const preview={schema:'teloa.market-plugin-install-preview/v1' as const,source:{registry:'npm' as const,packageName:definition.packageName,version:definition.version},trust:{status:'unverified' as const,publisher:'Example Publisher',integrity:'sha512-'+Buffer.from('integrity').toString('base64')},bundleHash:'c'.repeat(64),permissionSummary:{permissions:[{id:'dsh.bundle.insert',description:'向组合插入一行',required:true}]}}
const install={requestId:id,instanceId:id,expectedRevision:1,preview}

test('行业插件 API 登记固定来源、按预期版本安装并显式核对安装状态',async()=>{
 const calls:unknown[][]=[]
 const api=createIndustryPluginApi(async(method,payload)=>{calls.push([method,payload]);return method.endsWith('/list')?{items:[record]}:method.endsWith('/preview')?preview:method.endsWith('/install')||method.endsWith('/reconcile')||method.endsWith('/enable')?installed:record})
 assert.deepEqual(await api.instantiate({requestId:id,loadId,itemInstanceId}),record)
 assert.deepEqual(await api.install(install),installed)
 assert.deepEqual(await api.reconcile(id),installed)
 assert.deepEqual(await api.get(id),record)
 assert.deepEqual(await api.list(),{items:[record]})
 assert.deepEqual(await api.preview(id),preview)
 assert.deepEqual(await api.enable(id,preview),installed)
 assert.deepEqual(calls,[['industry-plugins/instantiate',{requestId:id,loadId,itemInstanceId}],['industry-plugins/install',install],['industry-plugins/reconcile',{instanceId:id}],['industry-plugins/get',{instanceId:id}],['industry-plugins/list',{}],['industry-plugins/preview',{instanceId:id}],['industry-plugins/enable',{instanceId:id,preview}]])
})

test('行业插件 API 拒绝映射漂移、伪造安装身份与重复实例',async()=>{
 const api=(value:unknown)=>createIndustryPluginApi(async()=>value)
 await assert.rejects(api({...record,loadId:id}).instantiate({requestId:id,loadId,itemInstanceId}),/映射/)
 await assert.rejects(api({...record,installationId}).instantiate({requestId:id,loadId,itemInstanceId}),/格式/)
 await assert.rejects(api({...record,state:'active'}).instantiate({requestId:id,loadId,itemInstanceId}),/格式/)
 await assert.rejects(api({...record,definition:{...definition,version:'1.2'}}).instantiate({requestId:id,loadId,itemInstanceId}),/格式/)
 await assert.rejects(api({...record,definition:{...definition,registry:'github'}}).instantiate({requestId:id,loadId,itemInstanceId}),/格式/)
 await assert.rejects(api({...record,definitionHash:'b'.repeat(63)}).instantiate({requestId:id,loadId,itemInstanceId}),/格式/)
 await assert.rejects(api({...installed,installationId:null}).install(install),/格式/)
 await assert.rejects(api({...installed,revision:3}).install(install),/版本/)
 await assert.rejects(api(installed).install({...install,packageName:'forged'} as never),/请求格式/)
 // 不带预览的旧形态提交：服务端会判 teloa/invalid-input，客户端先在通道口就拒。
 await assert.rejects(api(installed).install({requestId:id,instanceId:id,expectedRevision:1} as never),/预览格式/)
 await assert.rejects(api(installed).install({...install,preview:{...preview,trust:{...preview.trust,integrity:'not-an-integrity'}}} as never),/预览格式/)
 await assert.rejects(api(installed).enable(id,{...preview,bundleHash:'zz'} as never),/预览格式/)
 await assert.rejects(api(installed).reconcile('not-a-uuid'),/身份/)
 await assert.rejects(api({...installed,id:'52345678-1234-4234-8234-123456789012'}).reconcile(id),/身份/)
 await assert.rejects(api({items:[record,{...record,id:'52345678-1234-4234-8234-123456789012'}]}).list(),/重复/)
 // 逐行失败项不得自身重复，也不得与已返回的实例身份重合。
 await assert.rejects(api({items:[record],errors:[{instanceId:record.id,code:'teloa/storage-corrupt'}]}).list(),/格式/)
 await assert.rejects(api({items:[record],errors:[{instanceId:'52345678-1234-4234-8234-123456789012',code:'teloa/storage-corrupt'},{instanceId:'52345678-1234-4234-8234-123456789012',code:'teloa/source-unavailable'}]}).list(),/格式/)
})

test('行业插件安装失败保留原请求并以完全相同参数恢复',async()=>{
 let raw:string|null=null
 const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}},input=install,calls:unknown[][]=[]
 const api=createIndustryPluginApi(async(method,payload)=>{calls.push([method,payload]);if(calls.length===1)throw Error('连接断开');return installed},journal)
 await assert.rejects(api.install(input),/连接断开/)
 assert.deepEqual(api.pending(),input)
 assert.match(raw||'',/teloa\.industry-plugin-install\/v1/)
 assert.deepEqual(createIndustryPluginApi(async()=>installed,journal).pending(),input)
 assert.deepEqual(await api.recover(),installed)
 assert.deepEqual(calls,[['industry-plugins/install',input],['industry-plugins/install',input]])
 assert.equal(api.pending(),undefined)
 assert.equal(raw,null)
})

test('行业插件登记与核对不写恢复日志，日志损坏时停止安装',async()=>{
 let raw:string|null=null
 const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
 const api=createIndustryPluginApi(async(method)=>method.endsWith('/reconcile')?installed:record,journal)
 assert.deepEqual(await api.instantiate({requestId:id,loadId,itemInstanceId}),record)
 assert.deepEqual(await api.reconcile(id),installed)
 assert.equal(raw,null)
 assert.equal(api.pending(),undefined)
 const damaged=createIndustryPluginApi(async()=>installed,{read:()=>'{broken',write:()=>{},clear:()=>{}})
 assert.equal(damaged.recoveryMessage()?.code,'teloa/storage-corrupt')
 await assert.rejects(damaged.install(install),(error:unknown)=>(error as {code?:unknown})?.code==='teloa/storage-corrupt')
 await assert.rejects(damaged.recover(),(error:unknown)=>(error as {code?:unknown})?.code==='teloa/storage-corrupt')
})

test('行业插件安装被明确拒绝时清除恢复记录',async()=>{
 let raw:string|null=null
 const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
 const api=createIndustryPluginApi(async()=>{throw Object.assign(Error('版本冲突'),{rejected:true,code:'teloa/version-conflict'})},journal)
 await assert.rejects(api.install(install),/版本冲突/)
 assert.equal(journal.read(),null)
 assert.equal(api.pending(),undefined)
})
