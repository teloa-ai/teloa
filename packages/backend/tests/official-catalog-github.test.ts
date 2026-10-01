import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {marketCatalogUpstreamTreeHash,readMarketCatalogEntry,type MarketCatalogUpstreamSkillEntry} from '@teloa/contract'
import {OfficialCatalogService} from '../src/market/official-catalog.ts'
import {adoptRemoteUpstreamEntries} from '../src/market/official-upstream.ts'
import {initializeMarketContents,MarketContentStore,type MarketActor} from '../src/market/content-store.ts'
import type {GithubHttpPort} from '../src/market/github-source.ts'
import {useLocalContainerRuntime} from './testcontainers-env.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()}
const encode=(text:string)=>new TextEncoder().encode(text)
const sha=(text:string|Uint8Array)=>createHash('sha256').update(text).digest('hex')
const blob=(text:string)=>createHash('sha1').update('blob '+encode(text).byteLength+'\0').update(encode(text)).digest('hex')
const actor=():MarketActor=>({ownerId:randomUUID(),kind:'human'})
const texts:Record<string,string>={'SKILL.md':'---\nname: catalog-notes\ndescription: Summarize notes\n---\n# Notes\nKeep source links.\n','LICENSE':'MIT License\nCopyright (c) Example\n','references/guide.md':'Keep context.'}
const notice='Repository attribution\nCopyright (c) Fixture Authors\n'
const loc=(text:string)=>({'zh-CN':text,en:text})
function fixture(){
 const entry=readMarketCatalogEntry({format:'teloa.market-catalog-entry/v1',id:'codex.catalog-notes',kind:'skill',delivery:'upstream',version:'1.0.0',taxonomy:{functions:['office-docs'],industries:['general']},skill:{name:'catalog-notes',title:loc('整理笔记'),summary:loc('整理笔记并保留来源')},
  upstream:{kind:'github',repository:{host:'github.com',owner:'example',repo:'skills'},commit:'a'.repeat(40),path:'skills/notes',files:[...Object.entries(texts).map(([path,text])=>({path,gitBlob:blob(text),sha256:sha(text),size:encode(text).byteLength})),{path:'licenses/upstream/NOTICE',repositoryPath:'NOTICE',gitBlob:blob(notice),sha256:sha(notice),size:encode(notice).byteLength}]},
  origin:{marketplace:'codex',installs:null,installsLabel:'未公开',countedAt:'2026-09-27'},alternatives:[],unsupportedComponents:[{kind:'scripts',count:1}],modifications:[],license:{spdx:'MIT',files:['LICENSE','licenses/upstream/NOTICE']},compatibility:{status:'content-only',teloa:'>=0.2.0-alpha.7',dsh:'0.1.7-rc.1',conditions:[]},requires:{tools:[],network:false,runtimes:[]},review:{status:'approved',reviewedAt:'2026-09-27',reviewer:'Fixture reviewer'}}) as MarketCatalogUpstreamSkillEntry
 const calls:string[]=[],http:GithubHttpPort={request:async request=>{
  calls.push(request.url)
  const url=new URL(request.url)
  let text:string
  if(url.hostname==='api.github.com'){
   // 已审清单走非递归树：必须省略 recursive，只读固定根与声明文件的祖先树，不进入 scripts。
   assert.equal(url.search,'','非递归树必须完全省略 recursive 参数')
   const file=(name:string,text:string)=>({path:name,mode:'100644',type:'blob',sha:blob(text),size:encode(text).byteLength}),directory=(name:string,sha:string)=>({path:name,mode:'040000',type:'tree',sha})
   const trees:Record<string,unknown>={
    // GitHub 按 commit 请求根树时回包 sha 是 commit 本身。
    [(entry.upstream as {commit:string}).commit]:{sha:(entry.upstream as {commit:string}).commit,truncated:false,tree:[directory('skills','2'.repeat(40)),file('NOTICE',notice)]},
    ['2'.repeat(40)]:{sha:'2'.repeat(40),truncated:false,tree:[directory('notes','3'.repeat(40))]},
    ['3'.repeat(40)]:{sha:'3'.repeat(40),truncated:false,tree:[file('SKILL.md',texts['SKILL.md']!),file('LICENSE',texts.LICENSE!),directory('references','4'.repeat(40)),directory('scripts','5'.repeat(40))]},
    ['4'.repeat(40)]:{sha:'4'.repeat(40),truncated:false,tree:[file('guide.md',texts['references/guide.md']!)]},
   }
   const tree=trees[url.pathname.split('/git/trees/')[1]!]
   assert.ok(tree,'只读固定根与审核文件祖先树：'+request.url);text=JSON.stringify(tree)
  }
  else if(url.pathname.endsWith('/NOTICE'))text=notice
  else{const path=url.pathname.split('/skills/notes/')[1]!;assert.ok(Object.hasOwn(texts,path),'只能下载声明文件');text=texts[path]!}
  return {status:200,headers:{},body:(async function*(){yield encode(text)})()}
 }}
 const store=new MarketContentStore(pool,identity)
 const service=()=>new OfficialCatalogService(store,undefined,undefined,http)
 adoptRemoteUpstreamEntries([entry])
 return {entry,calls,http,store,service,tree:()=>marketCatalogUpstreamTreeHash(entry.upstream,sha)}
}
before(async()=>{
 useLocalContainerRuntime()
 container=await new PostgreSqlContainer('postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73').start()
 pool=new Pool({connectionString:container.getConnectionUri()});await initializeMarketContents(pool)
},{timeout:180_000})
after(async()=>{adoptRemoteUpstreamEntries([]);await pool?.end();await container?.stop()})

test('真实内容仓：GitHub 目录添加保留来源、版本、许可；同请求及新请求不重复内容，重建服务后可回读',async()=>{
 const f=fixture(),self=actor(),service=f.service(),request={requestId:randomUUID(),entryId:f.entry.id,expectedTreeHash:f.tree()}
 assert.equal((await service.list(self,{marketplace:'codex'})).items[0]!.addedContentId,null)
 const first=await service.add(self,request),content=await f.store.get(self,{contentId:first.content.id})
 assert.equal(first.receipt.source.kind,'catalog');assert.equal(first.content.version,'1.0.0');assert.equal(first.content.logicalId,'catalog-notes')
 assert.equal((first.receipt.source as {treeHash:string}).treeHash,f.tree())
 assert.equal(content.trust.repository?.owner,'example');assert.deepEqual(content.trust.license,{status:'declared',value:'MIT'})
 assert.deepEqual(content.files.map(file=>file.path),['catalog-notes/LICENSE','catalog-notes/SKILL.md','catalog-notes/licenses/upstream/NOTICE','catalog-notes/references/guide.md'])
 assert.equal(new TextDecoder().decode(content.files[0]!.bytes),texts.LICENSE)
 assert.equal(new TextDecoder().decode(content.files[2]!.bytes),notice)
 assert.deepEqual((await service.add(self,request)).receipt,first.receipt)
 assert.equal((await service.add(self,{...request,requestId:randomUUID()})).content.id,first.content.id)
 assert.equal((await pool.query('select count(*)::int n from teloa_market_contents where owner_id=$1',[self.ownerId])).rows[0].n,1)
 assert.equal((await f.service().list(self,{marketplace:'codex'})).items[0]!.addedContentId,first.content.id)
 assert.equal((await f.service().list(actor(),{marketplace:'codex'})).items[0]!.addedContentId,null)
 assert.ok(f.calls.every(url=>!url.includes('run.py')&&!url.endsWith('5'.repeat(40))))
 assert.equal(new Set(f.calls.filter(url=>url.includes('/git/trees/'))).size,4,'只读固定根与三层祖先树，不进入无关子树')
})

test('目录上游仓库名含点（如 next.js）时照常添加，来源与信任记录保留原名',async()=>{
 const f=fixture(),self=actor()
 if(f.entry.upstream.kind!=='github')throw Error('fixture')
 f.entry.upstream.repository.repo='next.js';adoptRemoteUpstreamEntries([f.entry])
 const {content}=await f.service().add(self,{requestId:randomUUID(),entryId:f.entry.id})
 assert.equal((await f.store.get(self,{contentId:content.id})).trust.repository?.repo,'next.js')
 assert.ok(f.calls.every(url=>url.includes('/next.js/')))
})

test('预览后固定来源变化、unsupported 与 Agent 主体都在联网写库前拒绝',async()=>{
 const f=fixture(),self=actor(),request={requestId:randomUUID(),entryId:f.entry.id,expectedTreeHash:f.tree()}
 assert.equal(f.entry.upstream.kind,'github');if(f.entry.upstream.kind!=='github')throw Error('fixture')
 f.entry.upstream.commit='b'.repeat(40);adoptRemoteUpstreamEntries([f.entry])
 await assert.rejects(f.service().add(self,request),{code:'teloa/version-conflict'})
 await assert.rejects(f.service().add({...self,kind:'agent'},request),{code:'teloa/forbidden'})
 f.entry.compatibility.status='unsupported';adoptRemoteUpstreamEntries([f.entry])
 await assert.rejects(f.service().add(self,{...request,expectedTreeHash:f.tree()}),{code:'teloa/invalid-input'})
 assert.equal(f.calls.length,0)
 assert.equal((await pool.query('select count(*)::int n from teloa_market_contents where owner_id=$1',[self.ownerId])).rows[0].n,0)
})

test('相同字节换固定提交后不冒充已添加；旧 requestId 不能静默绑定新来源',async()=>{
 const f=fixture(),self=actor(),request={requestId:randomUUID(),entryId:f.entry.id}
 await f.service().add(self,request)
 if(f.entry.upstream.kind!=='github')throw Error('fixture')
 f.entry.upstream.commit='b'.repeat(40);adoptRemoteUpstreamEntries([f.entry])
 assert.equal((await f.service().list(self,{marketplace:'codex'})).items[0]!.addedContentId,null)
 await assert.rejects(f.service().add(self,request),{code:'teloa/conflict'})
})

test('下载字节被改动时内容库不产生半份资源，恢复后同 requestId 可重试',async()=>{
 const f=fixture(),self=actor(),request={requestId:randomUUID(),entryId:f.entry.id},http:GithubHttpPort={request:async req=>req.url.includes('raw.githubusercontent.com')?{status:200,headers:{},body:(async function*(){yield encode('tampered')})()}:f.http.request(req)}
 await assert.rejects(new OfficialCatalogService(f.store,undefined,undefined,http).add(self,request),{code:'teloa/source-unavailable'})
 assert.equal((await pool.query('select count(*)::int n from teloa_market_contents where owner_id=$1',[self.ownerId])).rows[0].n,0)
 const result=await f.service().add(self,request)
 assert.equal((await f.store.getImport(self,{requestId:request.requestId})).content.id,result.content.id)
})

test('仅仓库根 NOTICE 被篡改也拒绝整次添加，重试保留固定原字节',async()=>{
 const f=fixture(),self=actor(),request={requestId:randomUUID(),entryId:f.entry.id},http:GithubHttpPort={request:async req=>req.url.endsWith('/NOTICE')?{status:200,headers:{},body:(async function*(){yield encode('changed notice')})()}:f.http.request(req)}
 await assert.rejects(new OfficialCatalogService(f.store,undefined,undefined,http).add(self,request),{code:'teloa/source-unavailable'})
 assert.equal((await pool.query('select count(*)::int n from teloa_market_contents where owner_id=$1',[self.ownerId])).rows[0].n,0)
 const {content}=await f.service().add(self,request),saved=await f.store.get(self,{contentId:content.id})
 assert.equal(new TextDecoder().decode(saved.files.find(file=>file.path.endsWith('/licenses/upstream/NOTICE'))!.bytes),notice)
})

test('目录钉的 sha256 与下载字节不符（blob 与大小仍相符）时拒绝添加，内容库不产生半份资源',async()=>{
 const f=fixture(),self=actor()
 if(f.entry.upstream.kind!=='github')throw Error('fixture')
 f.entry.upstream.files[1]!.sha256='0'.repeat(64);adoptRemoteUpstreamEntries([f.entry])
 await assert.rejects(f.service().add(self,{requestId:randomUUID(),entryId:f.entry.id}),(error:any)=>error?.code==='teloa/source-unavailable'&&/sha256/.test(error.message))
 assert.equal((await pool.query('select count(*)::int n from teloa_market_contents where owner_id=$1',[self.ownerId])).rows[0].n,0)
})
