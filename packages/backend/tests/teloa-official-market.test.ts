import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {OfficialCatalogService} from '../src/market/official-catalog.ts'
import {loadOfficialUpstreamIndex} from '../src/market/official-upstream.ts'
await loadOfficialUpstreamIndex()
const addedId=randomUUID(),observed:string[]=[]
const store={import:async()=>{throw Error('只读目录不应导入')},findByIdentity:async()=>null,findByCatalogSources:async(_actor:unknown,rows:readonly {entryId:string}[])=>{observed.push(...rows.map(row=>row.entryId));return new Map([['cursor.remotion-remotion-render',addedId]])}}
const actor={ownerId:randomUUID(),kind:'human' as const}

test('一个 Teloa 官方入口包含首批员工、团队与看板的完整 115 条目录，跨页不重复且无旧行业兜底',async()=>{
 const service=new OfficialCatalogService(store),ids:string[]=[]
 let cursor:string|undefined
 do{
  const page=await service.list(actor,{marketplace:'teloa',...(cursor?{cursor}:{})})
  assert.deepEqual(page.counts,{skill:93,connector:6,model:1,role:9,solution:3,dashboard:3})
  ids.push(...page.items.map(row=>row.entry.id));cursor=page.nextCursor??undefined
 }while(cursor)
 assert.equal(ids.length,115);assert.equal(new Set(ids).size,115)
 for(const id of ['teloa.grok-product-team','teloa.grok-marketing-team','teloa.grok-sales-team','teloa.saas-delivery-dashboard','teloa.content-ops-dashboard','teloa.b2b-sales-followup-dashboard'])assert.ok(ids.includes(id),id)
 assert.equal(ids.filter(id=>id.startsWith('teloa.grok-')&&!id.endsWith('-team')).length,9)
 assert.ok(ids.includes('teloa.mcp-slack'));assert.ok(ids.includes('cursor.remotion-remotion-render'))
 assert.equal(ids.some(id=>/^(clawhub|hermes|openclaw)\./.test(id)),false)
 assert.equal(ids.includes('teloa.soc'),false)
})

test('统一官方入口保留原技能身份与已安装内容链接，搜索直接找到可安装原条目',async()=>{
 const service=new OfficialCatalogService(store)
 const page=await service.list(actor,{marketplace:'teloa',kind:'skill',query:'remotion-render'})
 assert.equal(page.items.length,1)
 const row=page.items[0]!
 assert.equal(row.entry.id,'cursor.remotion-remotion-render');assert.equal(row.entry.delivery,'upstream')
 assert.equal(row.addedContentId,addedId);assert.equal(row.artifact,null)
 assert.ok(observed.includes('cursor.remotion-remotion-render'))
 assert.deepEqual((await service.list(actor,{marketplace:'teloa',query:'安全运营'})).items,[])
})
