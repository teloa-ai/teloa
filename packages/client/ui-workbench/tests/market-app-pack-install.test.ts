import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {marketCatalogUpstreamTreeHash} from '@teloa/contract'
import {installAppPack} from '../src/client/market-app-pack-install.ts'

// 应用包一次安装：逐个所选来源经原目录固定指纹添加 → 原生预览 → 原生安装；不跳内容页、不扩大授权，失败与待核对按真实记录返回。
const sha=(text:string)=>createHash('sha256').update(text).digest('hex')
const hex=(n:number)=>String(n).repeat(64).slice(0,64)
const entry=(name:string,version='1.0.0'):any=>({id:'cursor.pstack-'+name,kind:'skill',delivery:'upstream',version,skill:{name},upstream:{kind:'github',repository:{host:'github.com',owner:'cursor',repo:'plugins'},commit:'8'.repeat(40),path:'pstack/skills/'+name,files:[{path:'SKILL.md',gitBlob:'b'.repeat(40),sha256:'1'.repeat(64),size:1}]}})
const contentOf=(name:string)=>({architect:'11111111-1111-4111-8111-111111111111',arena:'22222222-2222-4222-8222-222222222222',bro:'33333333-3333-4333-8333-333333333333'} as Record<string,string>)[name]!
const nameOf=(contentId:string)=>['architect','arena','bro'].find(name=>contentOf(name)===contentId)!
const native=(name:string)=>({name,description:name,modelInvocable:true,userInvocable:true,bodyHash:hex(7)})
const source=(name:string,version='1.0.0')=>({kind:'atomic' as const,contentId:contentOf(name),contentHash:hex(5),resourceId:name,resourceVersion:version})
const record=(name:string,id:string,patch:Record<string,unknown>={})=>({id,ownerId:'local:owner',source:source(name),bundleHash:hex(3),native:native(name),trust:{} as never,trustHash:hex(4),state:'installed' as const,version:2,createdAt:'2026-10-14T00:00:00.000Z',updatedAt:'2026-10-14T00:00:00.000Z',...patch})

function ports(options:{installed?:any[];previewVersion?:Record<string,string>;failInstall?:Record<string,'rejected'|'network'>;pending?:any}={}){
 const calls:any[]=[];let pending=options.pending
 let ids=0
 const api={
  catalog:{add:async(entryId:string,expected?:{version:string;treeHash:string})=>{calls.push(['add',entryId,expected]);return {contentId:contentOf(entryId.replace('cursor.pstack-',''))}}},
  skills:{
   list:async()=>{calls.push(['list']);return {items:options.installed??[],usages:[]}},
   pending:()=>pending,
   recover:async()=>{calls.push(['recover',pending.requestId]);const name=nameOf(pending.source.contentId);pending=undefined;return record(name,'99999999-9999-4999-8999-999999999999')},
   preview:async(input:any)=>{const name=nameOf(input.contentId);calls.push(['preview',name]);return {source:source(name,options.previewVersion?.[name]??'1.0.0'),bundleHash:hex(3),native:native(name),files:[{path:'SKILL.md',hash:hex(6),size:1}],trust:{} as never,trustHash:hex(4),installationPlan:{skills:[],plugins:[],connections:[],permissions:[]}}},
   install:async(request:any)=>{const name=nameOf(request.source.contentId);calls.push(['install',name,request]);const fail=options.failInstall?.[name]
    if(fail==='rejected')throw Object.assign(Error('来源已变化'),{rejected:true,code:'teloa/source-unavailable'})
    if(fail==='network'){pending=request;throw Error('网络中断')}
    return record(name,'44444444-4444-4444-8444-44444444444'+String(++ids))},
  },
  requestId:()=>'55555555-5555-4555-8555-55555555555'+String(calls.length%10),
 }
 return {api,calls}
}
const members=(names:string[],added:Record<string,string>={})=>names.map(name=>({entryId:'cursor.pstack-'+name,entry:entry(name),contentId:added[name]??null}))

test('一次安装：每个来源带固定版本与树指纹添加，原生预览后按 bundleHash / trustHash 安装；已固定的内容不重复添加，已装的不重复安装',async()=>{
 const {api,calls}=ports({installed:[record('bro','66666666-6666-4666-8666-666666666666')]})
 const result=await installAppPack(members(['architect','arena','bro'],{arena:contentOf('arena'),bro:contentOf('bro')}),api,{isCurrent:()=>true})
 assert.deepEqual(result.outcomes.map(item=>[item.entryId,item.state]),[['cursor.pstack-architect','installed'],['cursor.pstack-arena','installed'],['cursor.pstack-bro','already-installed']])
 assert.equal(result.stopped,null)
 const add=calls.filter(call=>call[0]==='add')
 assert.deepEqual(add,[['add','cursor.pstack-architect',{version:'1.0.0',treeHash:marketCatalogUpstreamTreeHash(entry('architect').upstream,sha)}]],'只添加尚未固定的来源，并携带版本与树指纹')
 const installs=calls.filter(call=>call[0]==='install')
 assert.deepEqual(installs.map(call=>call[1]),['architect','arena'])
 for(const [,,request] of installs){assert.equal(request.expectedBundleHash,hex(3));assert.equal(request.expectedTrustHash,hex(4));assert.equal(request.source.kind,'atomic')}
 assert.equal(new Set(installs.map(call=>call[2].requestId)).size,2,'每个来源各自的安装请求身份')
})

test('被拒的来源记为未完成并继续；网络中断留下原请求时停在待核对，后续来源不动；再次安装先按原请求核对',async()=>{
 const first=ports({failInstall:{architect:'rejected',arena:'network'}})
 const result=await installAppPack(members(['architect','arena','bro']),first.api,{isCurrent:()=>true})
 assert.deepEqual(result.outcomes.map(item=>item.state),['failed','pending','not-started'])
 assert.equal(result.stopped,'pending')
 assert.equal(first.calls.some(call=>call[0]==='preview'&&call[1]==='bro'),false,'待核对后不再推进其他来源')
 const pending=first.api.skills.pending()
 const retry=await installAppPack(members(['architect','arena','bro'],{architect:contentOf('architect'),arena:contentOf('arena')}),first.api,{isCurrent:()=>true})
 assert.equal(first.calls.find(call=>call[0]==='recover')?.[1],pending.requestId,'先按原请求身份核对，不另起新请求')
 assert.deepEqual(retry.outcomes.map(item=>[item.entryId,item.state]),[['cursor.pstack-architect','failed'],['cursor.pstack-arena','installed'],['cursor.pstack-bro','installed']])
})

test('其他来源有待核对请求、宿主切换或返回版本不一致时都不安装；已有同名技能不覆盖、明确列出',async()=>{
 const other=ports({pending:{requestId:'77777777-7777-4777-8777-777777777777',source:{kind:'atomic',contentId:'88888888-8888-4888-8888-888888888888'},expectedBundleHash:hex(3)}})
 await assert.rejects(installAppPack(members(['architect']),other.api,{isCurrent:()=>true}),/待核对/)
 assert.equal(other.calls.some(call=>call[0]==='add'||call[0]==='install'),false)
 let current=true
 const stale=ports()
 const original=stale.api.skills.preview
 stale.api.skills.preview=async(input:any)=>{const value=await original(input);current=false;return value}
 const staleResult=await installAppPack(members(['architect','arena']),stale.api,{isCurrent:()=>current})
 assert.equal(staleResult.stopped,'stale');assert.equal(stale.calls.some(call=>call[0]==='install'),false,'宿主或本人代次变化后不再提交安装')
 const drift=ports({previewVersion:{architect:'2.0.0'}})
 const driftResult=await installAppPack(members(['architect']),drift.api,{isCurrent:()=>true})
 assert.equal(driftResult.outcomes[0]!.state,'failed');assert.equal(drift.calls.some(call=>call[0]==='install'),false)
 const sameName=ports({installed:[{...record('architect','12121212-1212-4121-8121-121212121212'),source:{...source('architect'),contentId:'abababab-abab-4bab-8bab-abababababab',contentHash:hex(9)}}]})
 const conflict=await installAppPack(members(['architect']),sameName.api,{isCurrent:()=>true})
 assert.deepEqual([conflict.outcomes[0]!.state,conflict.outcomes[0]!.nameInUse],['name-conflict','architect'])
 assert.equal(sameName.calls.some(call=>call[0]==='install'),false,'同名技能交给原选择流程，不静默替换')
})
