/**
 * 分页游标正确性与边界测试（无需数据库，使用 stub store）。
 * 覆盖：无效 cursor → invalid-input；首页/末页/恰好整除三种边界。
 */
import test,{before} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {marketCatalogTreeHash,WorkError} from '@teloa/contract'
import {type MarketActor,type MarketContentStore} from '../src/market/content-store.ts'
import {OfficialCatalogService,type OfficialCatalogSnapshot} from '../src/market/official-catalog.ts'
import {loadOfficialUpstreamIndex} from '../src/market/official-upstream.ts'

const sha256=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex')
const enc=new TextEncoder()
const stub=()=>({import:async()=>({receipt:{},content:{}} as never),findByIdentity:async()=>null,findByCatalogSources:async()=>new Map<string,string>()})
const actor=():MarketActor=>({ownerId:randomUUID(),kind:'human'})

// ---- 构建 N 个 skill 条目的快照 ------------------------------------------
function buildMultiSkillSnapshot(count:number):OfficialCatalogSnapshot{
 const entries=[]
 const files:Record<string,string>={}
 for(let i=0;i<count;i++){
  const name=`skill-${String(i).padStart(3,'0')}`
  const id=`test.${name}`
  const content=enc.encode(`---\nname: ${name}\ndescription: test skill ${i}\n---\nbody ${i}\n`)
  const license=enc.encode('MIT')
  const artifactFiles=[
   {path:'SKILL.md',sha256:sha256(content),size:content.byteLength},
   {path:'LICENSE',sha256:sha256(license),size:license.byteLength},
  ]
  const entry={
   format:'teloa.market-catalog-entry/v1',id,kind:'skill',delivery:'install',version:'1.0.0',
   upstream:{ecosystem:'test',author:'test',repository:{host:'github.com',owner:'test',repo:name},commit:'a'.repeat(40),path:'src',license:'MIT',files:[{path:'SKILL.md',gitBlob:'b'.repeat(40),size:content.byteLength}]},
   modifications:[],license:{spdx:'MIT',files:['LICENSE']},
   compatibility:{status:'content-only',teloa:'>=0.2.0',dsh:'0.1.0',conditions:[]},
   requires:{tools:[],network:false,runtimes:[]},
   review:{status:'approved',reviewedAt:'2026-09-25',reviewer:'test'},
   taxonomy:{functions:['dev-tools'],industries:['general']},
   skill:{name,title:{'zh-CN':`技能${i}`,en:`Skill ${i}`},summary:{'zh-CN':'摘要',en:'Summary'}},
   artifact:{files:artifactFiles,treeHash:marketCatalogTreeHash(artifactFiles,sha256)},
  }
  entries.push(entry)
  files[`${id}/1.0.0/SKILL.md`]=Buffer.from(content).toString('base64')
  files[`${id}/1.0.0/LICENSE`]=Buffer.from(license).toString('base64')
 }
 const index={format:'teloa.market-catalog/v1',catalogVersion:'test-cursor',entries}
 const indexJson=JSON.stringify(index)
 return {indexSha256:sha256(indexJson),index,files}
}

// ---- 上游条目索引（真实文件，不连网）--------------------------------------
before(async()=>{await loadOfficialUpstreamIndex()})

// ---- Teloa 分支：无效 cursor -----------------------------------------------
test('Teloa 分支：无效 cursor 抛 invalid-input',async()=>{
 const snap=buildMultiSkillSnapshot(3)
 const svc=new OfficialCatalogService(stub() as unknown as MarketContentStore,snap)
 await assert.rejects(
  ()=>svc.list(actor(),{cursor:'teloa.no-such-entry'}),
  (err:unknown)=>{assert.ok(err instanceof WorkError);assert.equal(err.code,'teloa/invalid-input');return true}
 )
})

// ---- Teloa 分支：分页边界 --------------------------------------------------
test('Teloa 分支：首页返回 limit 项，nextCursor 指向下一条',async()=>{
 const snap=buildMultiSkillSnapshot(5)
 const svc=new OfficialCatalogService(stub() as unknown as MarketContentStore,snap)
 const page1=await svc.list(actor(),{limit:2})
 assert.equal(page1.items.length,2)
 assert.equal(page1.items[0]!.entry.id,'test.skill-000')
 assert.equal(page1.items[1]!.entry.id,'test.skill-001')
 assert.equal(page1.nextCursor,'test.skill-001')
})

test('Teloa 分支：末页 nextCursor 为 null',async()=>{
 const snap=buildMultiSkillSnapshot(5)
 const svc=new OfficialCatalogService(stub() as unknown as MarketContentStore,snap)
 const page1=await svc.list(actor(),{limit:2})
 const page2=await svc.list(actor(),{limit:2,cursor:page1.nextCursor!})
 assert.equal(page2.items.length,2)
 assert.equal(page2.items[0]!.entry.id,'test.skill-002')
 const page3=await svc.list(actor(),{limit:2,cursor:page2.nextCursor!})
 assert.equal(page3.items.length,1)
 assert.equal(page3.nextCursor,null)
})

test('Teloa 分支：恰好整除时 nextCursor 为 null',async()=>{
 const snap=buildMultiSkillSnapshot(4)
 const svc=new OfficialCatalogService(stub() as unknown as MarketContentStore,snap)
 const page1=await svc.list(actor(),{limit:2})
 assert.equal(page1.items.length,2)
 assert.notEqual(page1.nextCursor,null)
 const page2=await svc.list(actor(),{limit:2,cursor:page1.nextCursor!})
 assert.equal(page2.items.length,2)
 assert.equal(page2.nextCursor,null,'恰好整除最后一页 nextCursor 应为 null')
})

// ---- 上游分支：无效 cursor --------------------------------------------------
test('上游分支：无效 cursor 抛 invalid-input',async()=>{
 const snap=buildMultiSkillSnapshot(1)
 const svc=new OfficialCatalogService(stub() as unknown as MarketContentStore,snap)
 await assert.rejects(
  ()=>svc.list(actor(),{marketplace:'clawhub',cursor:'upstream.no-such-entry'}),
  (err:unknown)=>{assert.ok(err instanceof WorkError);assert.equal(err.code,'teloa/invalid-input');return true}
 )
})

// ---- 上游分支：分页边界（使用真实 55 条上游条目）--------------------------
test('上游分支：首页返回 limit 项，nextCursor 非 null',async()=>{
 const snap=buildMultiSkillSnapshot(1)
 const svc=new OfficialCatalogService(stub() as unknown as MarketContentStore,snap)
 const page1=await svc.list(actor(),{marketplace:'clawhub',limit:3})
 assert.equal(page1.items.length,3)
 assert.notEqual(page1.nextCursor,null)
})

test('上游分支：末页 nextCursor 为 null',async()=>{
 const snap=buildMultiSkillSnapshot(1)
 const svc=new OfficialCatalogService(stub() as unknown as MarketContentStore,snap)
 // 用 limit=50（默认）拉两页，第二页应为最后一页
 const page1=await svc.list(actor(),{marketplace:'clawhub',limit:50})
 assert.equal(page1.items.length,50,'第一页 50 条')
 assert.notEqual(page1.nextCursor,null)
 const page2=await svc.list(actor(),{marketplace:'clawhub',limit:50,cursor:page1.nextCursor!})
 assert.ok(page2.items.length>0)
 assert.equal(page2.nextCursor,null,'55 条共 2 页，第二页 nextCursor 应为 null')
})

test('上游分支：恰好整除时（limit=55 或 name 排序）末页 nextCursor 为 null',async()=>{
 const snap=buildMultiSkillSnapshot(1)
 const svc=new OfficialCatalogService(stub() as unknown as MarketContentStore,snap)
 // 上游 55 条，默认 max limit 50；按 name 排序仍然 55 条
 const page1=await svc.list(actor(),{marketplace:'clawhub',limit:50,sort:'name'})
 assert.equal(page1.items.length,50)
 const page2=await svc.list(actor(),{marketplace:'clawhub',limit:50,sort:'name',cursor:page1.nextCursor!})
 assert.equal(page2.items.length,5,'55 - 50 = 5')
 assert.equal(page2.nextCursor,null)
})
