import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {readMarketCatalogEntry,type MarketCatalogUpstreamSkillEntry} from '@teloa/contract'
import {OfficialCatalogService} from '../src/market/official-catalog.ts'
import {adoptRemoteUpstreamEntries} from '../src/market/official-upstream.ts'

const xaiSecret={envVarName:'XAI_API_KEY',label:{'zh-CN':'xAI API 密钥',en:'xAI API key'},required:true,target:'bearer',endpoints:[{origin:'https://api.x.ai',pathPrefixes:['/v1/']}],methods:['POST']}
const otherSecret={...xaiSecret,envVarName:'OTHER_KEY',endpoints:[{origin:'https://other.example.com',pathPrefixes:['/']}]}
test('getSkillSecretsByEntry：按条目 id 取声明；同名多条目各回自己的声明、不取首个；skillEntryIdsByName 列出全部同名条目',()=>{
 // 市场仓 2026.9.28.6 起 x-search 自带密钥声明；用例按需自行加声明，这里先去掉密钥相关字段
 const {secrets:_secrets,httpGuide:_guide,secretGroup:_group,...raw}=JSON.parse(readFileSync(new URL('../../../tests/fixtures/public-market/catalog/skills/clawhub.jaaneek.x-search.json',import.meta.url),'utf8'))
 // 带 secrets 的条目须过契约版本闸（needs-configuration、>=0.2.0-alpha.7、requires.tools 含 teloa_skill_http）
 const gated=(entry:Record<string,unknown>,secrets:unknown[])=>readMarketCatalogEntry({...entry,compatibility:{...raw.compatibility,status:'needs-configuration',teloa:'>=0.2.0-alpha.7'},requires:{...raw.requires,tools:['teloa_skill_http']},secrets}) as MarketCatalogUpstreamSkillEntry
 const a=gated(raw,[xaiSecret])
 const b=gated({...raw,id:'clawhub.other.x-search',upstream:{...raw.upstream,owner:'other'}},[otherSecret])
 const plain=readMarketCatalogEntry({...raw,id:'clawhub.third.x-search',upstream:{...raw.upstream,owner:'third'}}) as MarketCatalogUpstreamSkillEntry
 assert.equal(a.skill.name,b.skill.name);assert.equal(a.skill.name,plain.skill.name)
 adoptRemoteUpstreamEntries([a,b,plain])
 const service=new OfficialCatalogService({} as never)
 assert.deepEqual(service.getSkillSecretsByEntry(a.id).map(s=>s.envVarName),['XAI_API_KEY'])
 assert.deepEqual(service.getSkillSecretsByEntry(b.id).map(s=>s.envVarName),['OTHER_KEY'])
 assert.deepEqual(service.getSkillSecretsByEntry(plain.id),[])
 assert.deepEqual(service.getSkillSecretsByEntry('clawhub.none.x-search'),[])
 assert.deepEqual(service.skillEntryIdsByName(a.skill.name).sort(),[a.id,b.id,plain.id].sort())
 assert.deepEqual(service.skillEntryIdsByName('no-such-skill'),[])
 assert.equal('getSkillSecrets' in service,false,'不再提供按技能名取首个同名条目的入口')
})

test('getSkillSecretMetaByEntry / skillSecretGroupMembers：快照与上游缓存两处都取到调用指引与共享密钥组；组成员按技能名排序、不按安装过滤',async()=>{
 const {createHash}=await import('node:crypto')
 const {officialCatalogFiles,officialCatalogIndex}=await import('../src/market/official-catalog-snapshot.ts')
 const shared={envVarName:'SHARED_API_KEY',label:{'zh-CN':'共享密钥',en:'Shared key'},required:true,target:'bearer',methods:['GET']}
 const guide={'zh-CN':'先 GET /v1/list 再按 id 取详情。',en:'GET /v1/list first, then fetch details by id.'}
 const gate={status:'needs-configuration',teloa:'>=0.2.0-alpha.7'}
 // 快照条目：改一条托管技能并重算索引摘要
 const index=structuredClone(officialCatalogIndex) as {entries:Record<string,any>[]}
 const managed=index.entries.find(entry=>entry.id==='anthropic.internal-comms')!
 managed.compatibility={...managed.compatibility,...gate};managed.requires={...managed.requires,tools:['teloa_skill_http']}
 managed.secrets=[{...shared,endpoints:[{origin:'https://api.shared.example.com',pathPrefixes:['/v1/']}]}];managed.secretGroup='shared-demo';managed.httpGuide=guide
 const snapshot={indexSha256:createHash('sha256').update(JSON.stringify(index)).digest('hex'),index,files:{...officialCatalogFiles}}
 // 上游条目：同组、不同前缀与方法；另一条无指引
 // 市场仓 2026.9.28.6 起 x-search 自带密钥声明；用例按需自行加声明，这里先去掉密钥相关字段
 const {secrets:_secrets,httpGuide:_guide,secretGroup:_group,...raw}=JSON.parse(readFileSync(new URL('../../../tests/fixtures/public-market/catalog/skills/clawhub.jaaneek.x-search.json',import.meta.url),'utf8'))
 const upstream=(id:string,owner:string,extra:Record<string,unknown>)=>readMarketCatalogEntry({...raw,id,upstream:{...raw.upstream,owner},compatibility:{...raw.compatibility,...gate},requires:{...raw.requires,tools:['teloa_skill_http']},...extra}) as MarketCatalogUpstreamSkillEntry
 const a=upstream('clawhub.grp.x-search','grp',{secrets:[{...shared,endpoints:[{origin:'https://api.shared.example.com',pathPrefixes:['/v2/']}],methods:['POST']}],secretGroup:'shared-demo'})
 const plain=upstream('clawhub.plain.x-search','plain',{secrets:[xaiSecret],httpGuide:guide})
 adoptRemoteUpstreamEntries([a,plain])
 const service=new OfficialCatalogService({} as never,snapshot)
 assert.deepEqual(service.getSkillSecretMetaByEntry('anthropic.internal-comms'),{httpGuide:guide,secretGroup:'shared-demo'})
 assert.deepEqual(service.getSkillSecretMetaByEntry(a.id),{secretGroup:'shared-demo'})
 assert.deepEqual(service.getSkillSecretMetaByEntry(plain.id),{httpGuide:guide})
 assert.deepEqual(service.getSkillSecretMetaByEntry('no.such-entry'),{})
 const members=service.skillSecretGroupMembers('shared-demo')
 assert.deepEqual(members.map(m=>[m.skill,m.entryId]),[['internal-comms','anthropic.internal-comms'],['x-search',a.id]])
 assert.deepEqual(members[0]!.httpGuide,guide);assert.equal('httpGuide' in members[1]!,false)
 assert.deepEqual(members[1]!.secrets[0]!.endpoints[0]!.pathPrefixes,['/v2/'])
 assert.deepEqual(service.skillSecretGroupMembers('no-group'),[])
 // 回的是副本：改动不影响目录
 members[0]!.secrets[0]!.methods.push('DELETE')
 assert.deepEqual(service.skillSecretGroupMembers('shared-demo')[0]!.secrets[0]!.methods,['GET'])
 adoptRemoteUpstreamEntries([])
})
