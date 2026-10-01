import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {readMarketCatalogEntry,type MarketCatalogUpstreamSkillEntry} from '@teloa/contract'
import {OfficialCatalogService} from '../src/market/official-catalog.ts'
import {adoptRemoteUpstreamEntries} from '../src/market/official-upstream.ts'
import {officialCatalogFiles,officialCatalogIndex} from '../src/market/official-catalog-snapshot.ts'

// 列表回包的共享密钥组（规格 2026-09-28 D18）。本文件第一个用例依赖「上游缓存从未加载」的进程初始状态，用例顺序不能调换。
const actor={ownerId:'owner-1',kind:'human'} as const
const store={findByIdentity:async()=>null,findByCatalogSources:async()=>new Map<string,string>()} as never
const shared={envVarName:'SHARED_API_KEY',label:{'zh-CN':'共享密钥',en:'Shared key'},required:true,target:'bearer',methods:['GET']}
const gate={status:'needs-configuration',teloa:'>=0.2.0-alpha.7'}
function groupedSnapshot(){
 const index=structuredClone(officialCatalogIndex) as {entries:Record<string,any>[]}
 const managed=index.entries.find(entry=>entry.id==='anthropic.internal-comms')!
 managed.compatibility={...managed.compatibility,...gate};managed.requires={...managed.requires,tools:['teloa_skill_http']}
 managed.secrets=[{...shared,endpoints:[{origin:'https://api.shared.example.com',pathPrefixes:['/v1/']}]}];managed.secretGroup='shared-demo'
 return {indexSha256:createHash('sha256').update(JSON.stringify(index)).digest('hex'),index,files:{...officialCatalogFiles}}
}
const internalComms=(items:{entry:{id:string},secretGroup:unknown}[])=>items.find(item=>item.entry.id==='anthropic.internal-comms')!

test('上游缓存不可读时只用快照部分算组成员，列表照常返回',async()=>{
 const service=new OfficialCatalogService(store,groupedSnapshot())
 const item=internalComms((await service.list(actor,{query:'internal-comms'})).items)
 assert.deepEqual(item.secretGroup,{id:'shared-demo',members:[{entryId:'anthropic.internal-comms',title:(item.entry as any).skill.title}]})
})

test('同组两条（一条快照、一条上游缓存）：两边回包成员都是两项、含自身、按 entryId 升序；未分组技能、连接器、方案为 null',async()=>{
 // 市场仓 2026.9.28.6 起 x-search 自带密钥声明；用例按需自行加声明，这里先去掉密钥相关字段
 const {secrets:_secrets,httpGuide:_guide,secretGroup:_group,...raw}=JSON.parse(readFileSync(new URL('../../../tests/fixtures/public-market/catalog/skills/clawhub.jaaneek.x-search.json',import.meta.url),'utf8'))
 const upstream=(id:string,owner:string,extra:Record<string,unknown>)=>readMarketCatalogEntry({...raw,id,upstream:{...raw.upstream,owner},compatibility:{...raw.compatibility,...gate},requires:{...raw.requires,tools:['teloa_skill_http']},...extra}) as MarketCatalogUpstreamSkillEntry
 const grouped=upstream('clawhub.grp.x-search','grp',{secrets:[{...shared,endpoints:[{origin:'https://api.shared.example.com',pathPrefixes:['/v2/']}]}],secretGroup:'shared-demo'})
 const plain=readMarketCatalogEntry({...raw,id:'clawhub.plain.x-search',upstream:{...raw.upstream,owner:'plain'}}) as MarketCatalogUpstreamSkillEntry
 adoptRemoteUpstreamEntries([grouped,plain])
 try{
  const service=new OfficialCatalogService(store,groupedSnapshot())
  const managed=internalComms((await service.list(actor,{query:'internal-comms'})).items)
  const expected={id:'shared-demo',members:[
   {entryId:'anthropic.internal-comms',title:(managed.entry as any).skill.title},
   {entryId:'clawhub.grp.x-search',title:grouped.skill.title},
  ]}
  assert.deepEqual(managed.secretGroup,expected)
  const clawhub=(await service.list(actor,{marketplace:'clawhub'})).items
  assert.deepEqual(clawhub.find(item=>item.entry.id===grouped.id)!.secretGroup,expected)
  assert.equal(clawhub.find(item=>item.entry.id===plain.id)!.secretGroup,null)
  const teloa=(await service.list(actor)).items
  for(const item of teloa)if(item.entry.id!=='anthropic.internal-comms')assert.equal(item.secretGroup,null,item.entry.id)
  for(const kind of ['connector','solution'] as const){
   const items=(await service.list(actor,{kind})).items
   assert.ok(items.length>0,kind)
   assert.ok(items.every(item=>item.secretGroup===null),kind)
  }
 }finally{adoptRemoteUpstreamEntries([])}
})

test('条目有组但目录技能条目里没有它（在线索引并发替换）：成员兜底补上自身，列表不被宿主读取器拒收',async()=>{
 const {readMarketCatalogListSecretGroup}=await import('@teloa/contract')
 // Teloa 分支：目录技能条目取不到自身
 const service=new OfficialCatalogService(store,groupedSnapshot())
 ;(service as unknown as {skillEntries:()=>unknown[]}).skillEntries=()=>[]
 const item=internalComms((await service.list(actor,{query:'internal-comms'})).items)
 assert.deepEqual(item.secretGroup,{id:'shared-demo',members:[{entryId:'anthropic.internal-comms',title:(item.entry as any).skill.title}]})
 assert.doesNotThrow(()=>readMarketCatalogListSecretGroup(item.secretGroup,item.entry as never))
 // 上游分支：查询内容仓期间在线索引被整份替换
 // 市场仓 2026.9.28.6 起 x-search 自带密钥声明；用例按需自行加声明，这里先去掉密钥相关字段
 const {secrets:_secrets,httpGuide:_guide,secretGroup:_group,...raw}=JSON.parse(readFileSync(new URL('../../../tests/fixtures/public-market/catalog/skills/clawhub.jaaneek.x-search.json',import.meta.url),'utf8'))
 const grouped=readMarketCatalogEntry({...raw,id:'clawhub.grp.x-search',upstream:{...raw.upstream,owner:'grp'},compatibility:{...raw.compatibility,...gate},requires:{...raw.requires,tools:['teloa_skill_http']},secrets:[{...shared,endpoints:[{origin:'https://api.shared.example.com',pathPrefixes:['/v2/']}]}],secretGroup:'shared-demo'}) as MarketCatalogUpstreamSkillEntry
 adoptRemoteUpstreamEntries([grouped])
 try{
  const racing={findByIdentity:async()=>null,findByCatalogSources:async()=>{adoptRemoteUpstreamEntries([]);return new Map<string,string>()}} as never
  const listed=(await new OfficialCatalogService(racing,groupedSnapshot()).list(actor,{marketplace:'clawhub'})).items
  const row=listed.find(entry=>entry.entry.id===grouped.id)!
  assert.deepEqual((row.secretGroup as {members:{entryId:string}[]}).members.map(member=>member.entryId),['anthropic.internal-comms',grouped.id])
  assert.doesNotThrow(()=>readMarketCatalogListSecretGroup(row.secretGroup,row.entry))
 }finally{adoptRemoteUpstreamEntries([])}
})
