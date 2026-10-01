import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createMarketContentHandler} from '../src/market-content.ts'
import {isPendingRequestEndpoint} from '@teloa/contract'
import {PendingRequestService} from '@teloa/backend'

const atomicPayload={
 kind:'atomic-skill',requestId:'11111111-1111-4111-8111-111111111111',
 source:{kind:'upload',name:'报告方法'},metadata:{id:'report-writing',title:'报告方法',version:'1.0.0',categories:['写作']},
 files:[{path:'report/SKILL.md',base64:'IyDmiqXlkYrmlrnms5UK'}],
}
const storedContent={id:'22222222-2222-4222-8222-222222222222',ownerId:'local:owner',kind:'atomic-skill',logicalId:'report-writing',version:'1.0.0',hash:'a'.repeat(64),baseHash:'a'.repeat(64),manifestPath:'report/SKILL.md',metadata:atomicPayload.metadata,provides:[{resourceId:'report-writing',kind:'skill',version:'1.0.0',path:'report/SKILL.md'}],references:[],createdAt:'2026-09-11T00:00:00.000Z',files:[{path:'report/SKILL.md',hash:'b'.repeat(64),bytes:Uint8Array.from(Buffer.from(atomicPayload.files[0]!.base64,'base64'))}]}
const storedResult={receipt:{requestId:atomicPayload.requestId,contentId:storedContent.id,source:atomicPayload.source,createdAt:'2026-09-11T00:00:00.000Z'},content:storedContent}

test('较大市场上传绕过通用pending正文，领域回执保留固定请求、本人和完整字节；通用上限不扩大',async()=>{
 const bytes=Buffer.alloc(160_000,0x61),payload={...atomicPayload,files:[{path:'report/SKILL.md',base64:bytes.toString('base64')}]}
 const pending=new PendingRequestService({connect:async()=>assert.fail('上传正文不得打开通用pending存储')} as never)
 let fixed:Record<string,unknown>|undefined
 const handle=createMarketContentHandler('local:owner',async()=>({
  import:async(actor,input)=>{assert.deepEqual(actor,{ownerId:'local:owner',kind:'human'});fixed=input as Record<string,unknown>;return {...storedResult,content:{...storedContent,files:[{...storedContent.files[0]!,bytes}]}}},
  importGithub:async()=>storedResult,importGithubSkill:async()=>storedResult,get:async()=>storedContent,list:async()=>({items:[],nextCursor:null}),
  getImport:async(actor,input)=>{assert.deepEqual(actor,{ownerId:'local:owner',kind:'human'});assert.deepEqual(input,{requestId:payload.requestId});return {...storedResult,content:{...storedContent,files:[{...storedContent.files[0]!,bytes}]}}},
 }))
 const endpoint:string='market-content/import'
 if(isPendingRequestEndpoint(endpoint))await pending.reserve('local:owner',endpoint,payload,'2026-10-01T00:00:00.000Z')
 const result=await handle('market-content/import',payload) as {content:{files:{base64:string}[]}}
 assert.equal(fixed?.requestId,payload.requestId);assert.deepEqual((fixed?.files as {bytes:Uint8Array}[])[0]!.bytes,Uint8Array.from(bytes))
 assert.equal(result.content.files[0]!.base64,payload.files[0]!.base64)
 const recovered=await handle('market-content/receipt',{requestId:payload.requestId}) as typeof result
 assert.equal(recovered.content.files[0]!.base64,payload.files[0]!.base64)
 await assert.rejects(pending.reserve('local:owner','roles/create',{requestId:payload.requestId,text:'x'.repeat(100_001)},'2026-10-01T00:00:00.000Z'),{code:'teloa/invalid-input'})
})

test('完整业务配置沿行业固定内容 wire 传输，保留引用与正文，不产生采用操作',async()=>{
 const manifest={format:'teloa.business-package/v4',resources:[{id:'overview',kind:'business-configuration'}]},bytes=new TextEncoder().encode(JSON.stringify(manifest))
 const references=[{resourceId:'overview',sourceContentId:storedContent.id,sourceItemId:'directory-'+storedContent.hash,sourceResourceId:'soc-overview',sourceHash:storedContent.hash}]
 const fixed={...storedContent,kind:'industry-template',metadata:manifest,manifestPath:'teloa.json',references,provides:[{resourceId:'overview',kind:'business-configuration',version:'1.0.0',path:'configuration.json'}],files:[{path:'teloa.json',hash:'c'.repeat(64),bytes}]}
 let forwarded:unknown
 const handle=createMarketContentHandler('local:owner',async()=>({import:async(_actor,input)=>{forwarded=input;return {...storedResult,content:fixed}},importGithub:async()=>storedResult,importGithubSkill:async()=>storedResult,get:async()=>fixed,getImport:async()=>storedResult,list:async()=>({items:[],nextCursor:null})}))
 const result=await handle('market-content/import',{kind:'industry-template',requestId:atomicPayload.requestId,source:atomicPayload.source,manifestPath:'teloa.json',references,files:[{path:'teloa.json',base64:Buffer.from(bytes).toString('base64')}]}) as {content:Record<string,unknown>}
 assert.deepEqual((forwarded as {references:unknown}).references,references)
 assert.deepEqual(result.content.references,references);assert.deepEqual(result.content.provides,fixed.provides)
 assert.equal(Object.hasOwn(result.content,'adopted'),false)
})

test('未知端点、伪造owner、非规范base64和超限字节在打开服务前拒绝',async()=>{
 let opened=0
 const handle=createMarketContentHandler('local:owner',async()=>{opened++;throw Error('不应打开服务')})
 await assert.rejects(handle('market-content/install',{}),{code:'teloa/not-found'})
 await assert.rejects(handle('market-content/import',{...atomicPayload,ownerId:'forged'}),{code:'teloa/invalid-input'})
 await assert.rejects(handle('market-content/import',{...atomicPayload,files:[{path:'SKILL.md',base64:'YQ'}]}),{code:'teloa/invalid-input'})
 await assert.rejects(handle('market-content/import',{...atomicPayload,files:[{path:'SKILL.md',base64:Buffer.alloc(2*1024*1024+1).toString('base64')}]}),{code:'teloa/invalid-input'})
 assert.equal(opened,0)
})

test('规范base64接受单文件2MiB及总量20MiB边界',async()=>{
 const base64=Buffer.alloc(2*1024*1024,0xa5).toString('base64')
 let total=0
 const handle=createMarketContentHandler('local:owner',async()=>({
  import:async(_actor:unknown,input:unknown)=>{total=(input as {files:{bytes:Uint8Array}[]}).files.reduce((sum,file)=>sum+file.bytes.byteLength,0);return storedResult},
  importGithub:async()=>storedResult,importGithubSkill:async()=>storedResult,
  get:async()=>storedContent,getImport:async()=>storedResult,list:async()=>({items:[],nextCursor:null}),
 }))
 await handle('market-content/import',{...atomicPayload,files:Array.from({length:10},(_,index)=>({path:index?'report/file-'+index:'report/SKILL.md',base64}))})
 assert.equal(total,20*1024*1024)
 await assert.rejects(handle('market-content/import',{...atomicPayload,files:Array.from({length:11},(_,index)=>({path:index?'report/extra-'+index:'report/SKILL.md',base64}))}),{code:'teloa/invalid-input'})
 assert.equal(total,20*1024*1024)
})

test('import固定宿主本人和人类身份，文件字节与响应base64完整往返',async()=>{
 const calls:unknown[][]=[],handle=createMarketContentHandler('local:owner',async()=>({
  import:async(actor:unknown,input:unknown)=>{calls.push([actor,input]);return storedResult},
  importGithub:async()=>storedResult,importGithubSkill:async()=>storedResult,
  get:async()=>storedContent,getImport:async()=>storedResult,list:async()=>({items:[],nextCursor:null}),
 }))
 const result=await handle('market-content/import',atomicPayload) as typeof storedResult&{content:{files:{path:string;hash:string;base64:string}[]}}
 assert.deepEqual(calls[0]?.[0],{ownerId:'local:owner',kind:'human'})
 const forwarded=calls[0]?.[1] as {files:{path:string;bytes:Uint8Array}[]}
 assert.equal(new TextDecoder().decode(forwarded.files[0]!.bytes),'# 报告方法\n')
 assert.equal(result.content.files[0]!.base64,atomicPayload.files[0]!.base64)
 assert.equal('bytes' in result.content.files[0]!,false)
 assert.equal(result.content.hash,'a'.repeat(64))
})

test('import 接受独立 Skill 的本地化元数据并原样交给后端 port',async()=>{
 const localized={title:{original:'报告方法',defaultLocale:'en',locales:{en:'Report writing','zh-Hant':'報告方法'}}}
 let forwarded:unknown,opened=0
 const handle=createMarketContentHandler('local:owner',async()=>{opened++;return {
  import:async(_actor:unknown,input:unknown)=>{forwarded=input;return storedResult},
  importGithub:async()=>storedResult,importGithubSkill:async()=>storedResult,
  get:async()=>storedContent,getImport:async()=>storedResult,list:async()=>({items:[],nextCursor:null}),
 }})
 await handle('market-content/import',{...atomicPayload,metadata:{...atomicPayload.metadata,localized}})
 assert.equal(opened,1)
 assert.deepEqual((forwarded as {metadata:{localized:unknown}}).metadata.localized,localized)
})

test('get只按内容身份读取并把所有文件编码为wire格式',async()=>{
 const calls:unknown[]=[],handle=createMarketContentHandler('local:owner',async()=>({
  import:async()=>storedResult,
  importGithub:async()=>storedResult,importGithubSkill:async()=>storedResult,
  get:async(actor:unknown,input:unknown)=>{calls.push([actor,input]);return storedContent},
  getImport:async()=>storedResult,list:async()=>({items:[],nextCursor:null}),
 }))
 const result=await handle('market-content/get',{contentId:storedContent.id}) as {files:{base64:string}[]}
 assert.deepEqual(calls,[[{ownerId:'local:owner',kind:'human'},{contentId:storedContent.id}]])
 assert.deepEqual(result.files.map(file=>file.base64),[atomicPayload.files[0]!.base64])
 await assert.rejects(handle('market-content/get',{contentId:storedContent.id,ownerId:'forged'}),{code:'teloa/invalid-input'})
})

test('receipt以原请求ID调用getImport恢复原回执和内容',async()=>{
 const calls:unknown[]=[],handle=createMarketContentHandler('local:owner',async()=>({
  import:async()=>storedResult,
  importGithub:async()=>storedResult,importGithubSkill:async()=>storedResult,get:async()=>storedContent,list:async()=>({items:[],nextCursor:null}),
  getImport:async(actor:unknown,input:unknown)=>{calls.push([actor,input]);return storedResult},
 }))
 const result=await handle('market-content/receipt',{requestId:atomicPayload.requestId}) as typeof storedResult&{content:{files:{base64:string}[]}}
 assert.deepEqual(calls,[[{ownerId:'local:owner',kind:'human'},{requestId:atomicPayload.requestId}]])
 assert.equal(result.receipt.contentId,storedContent.id)
 assert.equal(result.content.files[0]!.base64,atomicPayload.files[0]!.base64)
})

test('list透传稳定分页参数并返回不含文件的内容摘要',async()=>{
 const {files:_,...summary}=storedContent,calls:unknown[][]=[]
 const handle=createMarketContentHandler('local:owner',async()=>({
  import:async()=>storedResult,
  importGithub:async()=>storedResult,importGithubSkill:async()=>storedResult,get:async()=>storedContent,getImport:async()=>storedResult,
  list:async(actor:unknown,input:unknown)=>{calls.push([actor,input]);return {items:[summary],nextCursor:storedContent.id}},
 }))
 const result=await handle('market-content/list',{cursor:'33333333-3333-4333-8333-333333333333',limit:25}) as {items:Record<string,unknown>[];nextCursor:string|null}
 assert.deepEqual(calls,[[{ownerId:'local:owner',kind:'human'},{cursor:'33333333-3333-4333-8333-333333333333',limit:25}]])
 assert.equal(result.items[0]!.id,storedContent.id)
 assert.equal('files' in result.items[0]!,false)
 assert.equal(result.nextCursor,storedContent.id)
})

test('list的伪造owner、非法cursor、越界limit和未知字段在服务前拒绝',async()=>{
 let opened=0
 const handle=createMarketContentHandler('local:owner',async()=>{opened++;throw Error('不应打开服务')})
 for(const payload of [{ownerId:'other'},{cursor:'not-uuid'},{limit:0},{limit:101},{limit:1.5},{unexpected:true}])await assert.rejects(handle('market-content/list',payload),{code:'teloa/invalid-input'})
 assert.equal(opened,0)
})

const githubReceipt={receipt:{requestId:'44444444-4444-4444-8444-444444444444',contentId:storedContent.id,source:{kind:'github',owner:'teloa-ai',repo:'starter',requestedRef:'main',resolvedCommit:'0'.repeat(40),archiveHash:'c'.repeat(64)},createdAt:'2026-09-14T00:00:00.000Z'},content:storedContent}

test('import-github只转发请求身份与清单路径，信任、未知字段和非法身份在服务前拒绝',async()=>{
 const payload={requestId:'44444444-4444-4444-8444-444444444444',githubRequestId:'55555555-5555-4555-8555-555555555555',manifestPath:'teloa.json'}
 const calls:unknown[][]=[],handle=createMarketContentHandler('local:owner',async()=>({
  import:async()=>storedResult,get:async()=>storedContent,getImport:async()=>storedResult,list:async()=>({items:[],nextCursor:null}),
  importGithubSkill:async()=>storedResult,importGithub:async(actor:unknown,input:unknown)=>{calls.push([actor,input]);return githubReceipt},
 }))
 const result=await handle('market-content/import-github',payload) as typeof githubReceipt&{content:{files:{base64:string}[]}}
 assert.deepEqual(calls,[[{ownerId:'local:owner',kind:'human'},payload]])
 assert.deepEqual(result.receipt.source,githubReceipt.receipt.source)
 assert.equal(result.content.files[0]!.base64,atomicPayload.files[0]!.base64)
 let opened=0
 const closed=createMarketContentHandler('local:owner',async()=>{opened++;throw Error('不应打开服务')})
 for(const rejected of [{...payload,trust:{publisher:'forged'}},{...payload,requestId:'not-uuid'},{...payload,githubRequestId:'not-uuid'},{...payload,manifestPath:'../teloa.json'},{githubRequestId:payload.githubRequestId,manifestPath:'teloa.json'}])
  await assert.rejects(closed('market-content/import-github',rejected),{code:'teloa/invalid-input'})
 assert.equal(opened,0)
})

test('正式宿主在注册市场内容 RPC 前初始化固定内容目录',async()=>{
 const source=await readFile(new URL('../src/index.ts',import.meta.url),'utf8')
 const sequence=await readFile(new URL('../../backend/src/work/initialize-database.ts',import.meta.url),'utf8')
 assert.match(sequence,/await initializeMarketContents\(pool\)/)
 const initializeIndex=source.indexOf('initializeTeloaDatabase(database.pool')
 const rpcRegistrationIndex=source.indexOf("connection.rpc.handle('/teloa'")
 assert.notEqual(initializeIndex,-1)
 assert.notEqual(rpcRegistrationIndex,-1)
 assert.ok(initializeIndex<rpcRegistrationIndex)
 assert.match(source,/\.\.\.marketContentEndpoints/)
 assert.match(source,/importGithub:\(actor,input\)=>githubImport\.importIndustry\(actor,input\)/)
 assert.match(source,/marketContentHandler\(endpoint,payload\)/)
})

test('GitHub 子目录导入 Skill：只收请求身份与 SKILL.md 路径',async()=>{
 const calls:unknown[]=[]
 const handle=createMarketContentHandler('local:owner',async()=>({import:async()=>storedResult,importGithub:async()=>storedResult,importGithubSkill:async(_actor:unknown,input:unknown)=>{calls.push(input);return storedResult},get:async()=>storedContent,getImport:async()=>storedResult,list:async()=>({items:[],nextCursor:null})}))
 const payload={requestId:'11111111-1111-4111-8111-111111111111',githubRequestId:'33333333-3333-4333-8333-333333333333',skillPath:'skills/pdf/SKILL.md'}
 const result=await handle('market-content/import-github-skill',payload) as {content:{files:{base64:string}[]}}
 assert.deepEqual(calls,[payload]);assert.ok(result.content.files.every(file=>typeof file.base64==='string'))
 for(const bad of [{...payload,trust:{}},{...payload,skillPath:'skills/pdf/README.md'},{...payload,skillPath:'../SKILL.md'},{...payload,githubRequestId:'x'}])
  await assert.rejects(handle('market-content/import-github-skill',bad),{code:'teloa/invalid-input'})
})
