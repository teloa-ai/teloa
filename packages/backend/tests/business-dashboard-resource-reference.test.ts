import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import * as contentApi from '../src/market/content-store.ts'
import type {MarketContent} from '../src/market/content-store.ts'

const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex')
const file=(path:string,value:unknown)=>({path,bytes:new TextEncoder().encode(JSON.stringify(value))})
import {dashboardBody,dashboardManifest} from './fixtures/business-dashboard.ts'
const sourceContent=(scope='SOC'):MarketContent=>{
 const metadata=dashboardManifest(scope),files=[file('teloa.json',metadata),file('configuration.json',dashboardBody(scope))]
 const identity=contentApi.industryContentIdentity({manifestPath:'teloa.json',files,sourceLabel:'来源'})
 return {id:'12345678-1234-4234-8234-123456789012',ownerId:'owner',kind:'industry-template',logicalId:metadata.id,version:metadata.version,hash:identity.contentHash,baseHash:identity.contentHash,manifestPath:'teloa.json',metadata,trust:contentApi.normalizeMarketSourceTrust(undefined,'来源'),trustHash:identity.trustHash,files:files.map(row=>({...row,hash:sha(row.bytes)})),provides:[{resourceId:'soc-overview',kind:'business-configuration',version:'1.0.0',path:'configuration.json'}],references:[],createdAt:'2026-10-01T00:00:00.000Z'}
}
test('v4 完整配置固定身份稳定，资源读取保留同一份正文，不采用配置',()=>{
 const source=sourceContent(),again=sourceContent()
 assert.equal(source.hash,again.hash)
 assert.deepEqual(contentApi.readMarketBusinessConfigurationResource(source,'soc-overview'),dashboardBody())
 const cloned=contentApi.readMarketBusinessConfigurationResource(source,'soc-overview')
 cloned.configuration.title='修改副本'
 assert.equal(contentApi.readMarketBusinessConfigurationResource(source,'soc-overview').configuration.title,'安全运营')
})
test('旧方案格式不接受完整配置，正文身份、版本、范围、文件摘要与资源种类均严格匹配',()=>{
 for(const format of ['teloa.business-package/v2','teloa.business-package/v3'])assert.throws(()=>contentApi.validateManifest({...dashboardManifest(),format}),{code:'teloa/invalid-input'})
 const source=sourceContent()
 for(const content of [
  {...source,provides:[]},
  {...source,provides:[{...source.provides[0]!,kind:'skill'}]},
  {...source,files:source.files.map(row=>row.path==='configuration.json'?{...row,bytes:file(row.path,{...dashboardBody(),id:'other'}).bytes}:row)},
  {...source,metadata:{...source.metadata,scope:'OTHER'}},
 ])assert.throws(()=>contentApi.readMarketBusinessConfigurationResource(content as MarketContent,'soc-overview'),{code:'teloa/source-unavailable'})
 for(const body of [{...dashboardBody(),id:'other'},{...dashboardBody(),version:'2.0.0'}])assert.throws(()=>contentApi.industryContentIdentity({manifestPath:'teloa.json',files:[file('teloa.json',dashboardManifest()),file('configuration.json',body)],sourceLabel:'来源'}),{code:'teloa/invalid-input'})
})
test('公共配置引用核对同主体、固定内容身份、类型、版本和摘要，拒绝嵌套引用及环',()=>{
 const source=sourceContent(),resource={...dashboardManifest().resources[0]!,source:{kind:'public' as const,id:'soc-overview',version:'1.0.0'}},reference={resourceId:'soc-overview',sourceContentId:source.id,sourceItemId:'directory-'+source.hash,sourceResourceId:'soc-overview',sourceHash:source.hash}
 assert.doesNotThrow(()=>contentApi.assertMarketContentReference('owner','SOC',resource as never,reference,source))
 for(const [owner,ref,fixed] of [
  ['other',reference,source],
  ['owner',{...reference,resourceId:'other'},source],
  ['owner',{...reference,sourceContentId:'22345678-1234-4234-8234-123456789012'},source],
  ['owner',{...reference,sourceItemId:'directory-wrong'},source],
  ['owner',{...reference,sourceHash:'0'.repeat(64)},source],
  ['owner',{...reference,sourceResourceId:'missing'},source],
  ['owner',reference,{...source,kind:'atomic-skill'}],
  ['owner',reference,{...source,provides:[{...source.provides[0]!,version:'2.0.0'}]}],
  ['owner',reference,{...source,references:[reference]}],
 ] as const)assert.throws(()=>contentApi.assertMarketContentReference(owner,'SOC',resource as never,ref,fixed as MarketContent),{code:'teloa/source-unavailable'})
 assert.throws(()=>contentApi.assertMarketContentReference('owner','OTHER',resource as never,reference,source),{code:'teloa/source-unavailable'})
 const portable=sourceContent('template'),portableReference={...reference,sourceHash:portable.hash,sourceItemId:'directory-'+portable.hash}
 assert.doesNotThrow(()=>contentApi.assertMarketContentReference('owner','SOC',resource as never,portableReference,portable))
})
