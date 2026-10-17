/**
 * 分页游标正确性与边界测试（无需数据库，使用 stub store）。
 * 覆盖：无效 cursor → invalid-input；首页/末页/恰好整除三种边界。
 */
import test,{before} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {marketCatalogTreeHash,WorkError,type MarketCatalogEntry} from '@teloa/contract'
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

// ---- 上游分支：期望来自市场仓已审目录（不读本仓上游索引反推）--------------
const reviewed=JSON.parse(readFileSync(new URL('../../../tests/fixtures/reviewed-catalog-20261014.json',import.meta.url),'utf8')) as {upstream:{byMarketplace:Record<'cursor'|'claude-code',string[]>;withInstalls:string[]}}
const cursorIds=reviewed.upstream.byMarketplace.cursor,claudeCodeIds=reviewed.upstream.byMarketplace['claude-code']
type ListRequest=NonNullable<Parameters<OfficialCatalogService['list']>[1]>
/** 跟随 nextCursor 遍历到底，返回每页条目。 */
async function traverse(svc:OfficialCatalogService,request:ListRequest){
 const pages:MarketCatalogEntry[][]=[];let cursor:string|undefined
 do{const page=await svc.list(actor(),{...request,...(cursor?{cursor}:{})});pages.push(page.items.map(item=>item.entry));cursor=page.nextCursor??undefined}while(cursor)
 return pages
}
const ids=(pages:MarketCatalogEntry[][])=>pages.map(page=>page.map(entry=>entry.id))

test('上游分支：无效 cursor 抛 invalid-input',async()=>{
 const snap=buildMultiSkillSnapshot(1)
 const svc=new OfficialCatalogService(stub() as unknown as MarketContentStore,snap)
 await assert.rejects(
  ()=>svc.list(actor(),{marketplace:'cursor',cursor:'upstream.no-such-entry'}),
  (err:unknown)=>{assert.ok(err instanceof WorkError);assert.equal(err.code,'teloa/invalid-input');return true}
 )
})

// ---- 上游分支：分页边界（真实上游索引，Cursor 来源 79 条）-----------------
test('上游分支：首页返回 limit 项，nextCursor 指向本页末条',async()=>{
 // 已审上游条目都没有安装量：默认 installs 排序即按 id 升序；有安装量条目时须改写本文件的期望顺序
 assert.deepEqual(reviewed.upstream.withInstalls,[])
 const snap=buildMultiSkillSnapshot(1)
 const svc=new OfficialCatalogService(stub() as unknown as MarketContentStore,snap)
 const page1=await svc.list(actor(),{marketplace:'cursor',limit:3})
 assert.deepEqual(page1.items.map(item=>item.entry.id),cursorIds.slice(0,3))
 assert.equal(page1.nextCursor,cursorIds[2])
 assert.deepEqual(page1.counts,{solution:0,dashboard:0,role:0,skill:cursorIds.length,connector:0,model:0})
})

test('上游分支：按默认上限完整遍历不重不漏，末页 nextCursor 为 null',async()=>{
 const snap=buildMultiSkillSnapshot(1)
 const svc=new OfficialCatalogService(stub() as unknown as MarketContentStore,snap)
 // limit 超过 50 按 50 截断；79 条共两页
 const pages=ids(await traverse(svc,{marketplace:'cursor',limit:80}))
 assert.deepEqual(pages.map(page=>page.length),[50,cursorIds.length-50])
 assert.deepEqual(pages.flat(),cursorIds)
})

test('上游分支：恰好整除时末页 nextCursor 为 null；name 排序遍历完整',async()=>{
 const snap=buildMultiSkillSnapshot(1)
 const svc=new OfficialCatalogService(stub() as unknown as MarketContentStore,snap)
 // Claude Code 来源 3 条：limit=3 一页取完，limit=1 三页、第三页即末页
 const whole=await svc.list(actor(),{marketplace:'claude-code',limit:3})
 assert.deepEqual(whole.items.map(item=>item.entry.id),claudeCodeIds)
 assert.equal(whole.nextCursor,null,'恰好整除最后一页 nextCursor 应为 null')
 assert.deepEqual(ids(await traverse(svc,{marketplace:'claude-code',limit:1})),claudeCodeIds.map(id=>[id]))
 // name 排序按技能名：两页跨页仍按名有序，且与已审集合相同、不重不漏
 const named=await traverse(svc,{marketplace:'cursor',sort:'name'})
 assert.deepEqual(named.map(page=>page.length),[50,cursorIds.length-50])
 assert.deepEqual(named.flat().map(entry=>entry.id).sort(),cursorIds)
 const names=named.flat().map(entry=>(entry as {skill:{name:string}}).skill.name)
 assert.deepEqual(names,[...names].sort())
})
