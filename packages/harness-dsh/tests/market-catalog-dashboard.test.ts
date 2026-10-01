import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {emptyMarketCatalogCounts,marketCatalogTreeHash} from '@teloa/contract'
import {createMarketCatalogHandler} from '../src/market-catalog.ts'
import {encodeReceipt} from '../src/market-content.ts'

test('目录 RPC 接受独立看板筛选与 v4 完整配置清单，方案读取不采用配置',async()=>{
 const base=JSON.parse(readFileSync(new URL('../../../tests/fixtures/public-market/catalog/solutions/teloa.soc.json',import.meta.url),'utf8'))
 const {solution,...common}=base,entry={...common,id:'teloa.dashboard.soc',kind:'dashboard',version:'1.0.0',compatibility:{...base.compatibility,teloa:'>=0.2.0-alpha.7 <0.3.0'},dashboard:{...solution,packageId:'soc-dashboard'}}
 const counts={...emptyMarketCatalogCounts(),dashboard:1},manifest={format:'teloa.business-package/v4',id:'soc-dashboard',version:'1.0.0',resources:[{id:'soc-overview',kind:'business-configuration'}]},calls:unknown[]=[]
 const files=[{path:'teloa.json',sha256:'a'.repeat(64),size:20},{path:'configuration.json',sha256:'b'.repeat(64),size:30},{path:'LICENSE',sha256:'c'.repeat(64),size:40}],artifact={files,treeHash:marketCatalogTreeHash(files,text=>createHash('sha256').update(text).digest('hex'))}
 const handle=createMarketCatalogHandler('local:owner',async()=>({
  list:async(actor,request)=>{calls.push([actor,request]);return {catalogVersion:'2026.10.1.1',items:[{entry,artifact,addedContentId:null,addedRoleId:null,secretGroup:null}],nextCursor:null,counts,skipped:{unknownKind:0,newerApp:0}}},
  add:async()=>{throw Error('unused')},addRole:async()=>{throw Error('unused')},solutionPackage:async(actor,input)=>{calls.push([actor,input]);return {entryId:input.entryId,version:'1.0.0',manifest,readOnlyResources:[]}},
 }),encodeReceipt)
 const listed=await handle('market-catalog/list',{kind:'dashboard'}) as {counts:unknown;items:{entry:{kind:string}}[]}
 assert.deepEqual(listed.counts,counts);assert.equal(listed.items[0]?.entry.kind,'dashboard')
 const result=await handle('market-catalog/solution',{entryId:entry.id}) as {manifest:unknown}
 assert.deepEqual(result.manifest,manifest)
 assert.deepEqual(calls[0],[{ownerId:'local:owner',kind:'human'},{kind:'dashboard'}])
 assert.deepEqual(calls[1],[{ownerId:'local:owner',kind:'human'},{entryId:entry.id}])
 // 列表仍核验固定工件摘要，不因为增加 dashboard 类型而放宽回包。
 artifact.treeHash='0'.repeat(64)
 await assert.rejects(handle('market-catalog/list',{kind:'dashboard'}),{code:'teloa/invalid-host-response'})
})
