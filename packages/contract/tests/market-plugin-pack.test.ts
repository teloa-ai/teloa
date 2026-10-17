import test from 'node:test'
import assert from 'node:assert/strict'
import {readMarketCatalogEntry,marketEntryNeedsV2,assertUpstreamPluginsConsistent,marketCatalogUpstreamTreeHash,marketCatalogUpstreamTreeInput} from '../src/market-catalog.ts'
import {readMarketIndex,readMarketIndexV2,assembleMarketIndexV2} from '../src/market-index.ts'
import {createHash} from 'node:crypto'

// 上游插件分组（应用包）：同一公开 pluginId / 原仓 / 固定提交 / 插件根的技能声明同一份 plugin，只用于呈现与一次安装，不改安装身份。
const loc=(text:string)=>({'zh-CN':text,en:text})
const plugin=(patch:Record<string,unknown>={})=>({marketplace:'cursor',id:'9717366',title:loc('pstack'),summary:loc('工程方法技能包'),root:'pstack',manifest:{path:'pstack/.cursor-plugin/plugin.json',gitBlob:'e'.repeat(40),sha256:'4'.repeat(64)},license:{spdx:'MIT'},connectors:[],...patch})
const member=(name:string,patch:Record<string,unknown>={}):any=>({format:'teloa.market-catalog-entry/v1',id:'cursor.pstack-'+name,kind:'skill',delivery:'upstream',version:'0.15.23',taxonomy:{functions:['dev-tools'],industries:['general']},skill:{name,title:loc(name),summary:loc(name+' 方法')},
 upstream:{kind:'github',repository:{host:'github.com',owner:'cursor',repo:'plugins'},commit:'8'.repeat(40),path:'pstack/skills/'+name,files:[{path:'SKILL.md',gitBlob:'b'.repeat(40),sha256:'1'.repeat(64),size:1},{path:'licenses/upstream/LICENSE',repositoryPath:'LICENSE',gitBlob:'c'.repeat(40),sha256:'2'.repeat(64),size:2}]},
 origin:{marketplace:'cursor',installs:null,installsLabel:'未公开',countedAt:'2026-10-14'},alternatives:[],unsupportedComponents:[{kind:'commands',count:2}],modifications:[],license:{spdx:'MIT',files:['licenses/upstream/LICENSE']},
 compatibility:{status:'content-only',teloa:'>=0.2.0-alpha.8',dsh:'0.1.7-rc.1',conditions:[]},requires:{tools:[],network:false,runtimes:[]},review:{status:'approved',reviewedAt:'2026-10-14',reviewer:'Fixture'},plugin:plugin(),...patch})
const invalid=(error:any)=>error?.code==='teloa/invalid-input'

test('cursor 来源与 plugin 分组按原样读出；只允许 GitHub 固定提交、技能与清单都在插件根内、兼容下界不低于新版本',()=>{
 const row=member('architect')
 assert.deepEqual(readMarketCatalogEntry(row),row)
 const remotion=member('remotion-studio',{plugin:plugin({id:'49339676',root:'.',manifest:{path:'plugin.json',gitBlob:'e'.repeat(40),sha256:'4'.repeat(64)}})});remotion.upstream.path='skills/remotion-studio'
 assert.equal((readMarketCatalogEntry(remotion) as any).plugin.root,'.','仓库根插件写 "."')
 const {plugin:_,...plain}=member('architect')
 assert.equal((readMarketCatalogEntry(plain) as any).origin.marketplace,'cursor','没有分组也可单独收录 cursor 来源技能')
 const broken:[string,(row:any)=>void][]=[
  ['来源不一致',row=>{row.origin.marketplace='claude-code'}],
  ['未知插件来源',row=>{row.plugin.marketplace='grok';row.origin.marketplace='grok'}],
  ['pluginId 文法',row=>{row.plugin.id='../9717366'}],
  ['技能在插件根外',row=>{row.upstream.path='other/skills/architect'}],
  ['根前缀伪装',row=>{row.upstream.path='pstack-evil/skills/architect'}],
  ['清单在插件根外',row=>{row.plugin.manifest.path='plugin.json'}],
  ['清单摘要格式',row=>{row.plugin.manifest.sha256='x'}],
  ['未知字段',row=>{row.plugin.commands=['x']}],
  ['连接器标识文法',row=>{row.plugin.connectors=['Slack']}],
  ['连接器重复',row=>{row.plugin.connectors=['teloa.mcp-slack','teloa.mcp-slack']}],
  ['兼容下界与旧版同为 alpha.7（旧读取器无法逐项跳过）',row=>{row.compatibility.teloa='>=0.2.0-alpha.7'}],
 ]
 for(const [label,change] of broken){const value=member('architect');change(value);assert.throws(()=>readMarketCatalogEntry(value),invalid,label)}
 const clawhub=member('architect');clawhub.upstream={kind:'clawhub',owner:'x',slug:'architect',version:'1.0.0',files:[{path:'SKILL.md',sha256:'1'.repeat(64),size:1}]};clawhub.license.files=[]
 assert.throws(()=>readMarketCatalogEntry(clawhub),invalid,'ClawHub 来源不能声明插件分组')
 const install={...member('architect'),delivery:'install'}
 assert.throws(()=>readMarketCatalogEntry(install),invalid,'只有上游条目可带 plugin')
})

test('同一 pluginId 的成员必须固定同一原仓、提交、插件声明与未采用组件；插件内技能名不得重复',()=>{
 const ok=[readMarketCatalogEntry(member('architect')),readMarketCatalogEntry(member('arena'))]
 assert.doesNotThrow(()=>assertUpstreamPluginsConsistent(ok))
 const variants:[string,any][]=[
  ['提交不同',(()=>{const row=member('arena');row.upstream.commit='9'.repeat(40);return row})()],
  ['原仓不同',(()=>{const row=member('arena');row.upstream.repository.repo='plugins-fork';return row})()],
  ['插件根不同',member('arena',{plugin:plugin({root:'pstack/skills',manifest:{path:'pstack/skills/plugin.json',gitBlob:'e'.repeat(40),sha256:'4'.repeat(64)}})})],
  ['标题不同',member('arena',{plugin:plugin({title:loc('pstack 2')})})],
  ['未采用组件不同',member('arena',{unsupportedComponents:[]})],
 ]
 for(const [label,row] of variants)assert.throws(()=>assertUpstreamPluginsConsistent([ok[0]!,readMarketCatalogEntry(row)]),invalid,label)
 const twin=member('architect');twin.id='cursor.pstack-architect-2';twin.upstream.path='pstack/skills/architect-2'
 assert.throws(()=>assertUpstreamPluginsConsistent([ok[0]!,readMarketCatalogEntry(twin)]),/技能名重复/)
 const other=member('arena',{plugin:plugin({id:'49339676'})})
 assert.doesNotThrow(()=>assertUpstreamPluginsConsistent([ok[0]!,readMarketCatalogEntry(other)]),'不同 pluginId 各自成组')
})

test('v1 冻结索引不收 cursor 来源与插件分组；v2 发布端核对分组一致，上报 0.2.0-alpha.7 的应用按兼容下界逐项跳过而不是整份拒收',()=>{
 const rows=[member('architect'),member('arena')].sort((a,b)=>a.id<b.id?-1:1)
 for(const row of rows)assert.equal(marketEntryNeedsV2(readMarketCatalogEntry(row)),true)
 const {plugin:_,...plain}=member('architect')
 assert.equal(marketEntryNeedsV2(readMarketCatalogEntry(plain)),true,'cursor 来源本身是旧客户端不认识的来源')
 assert.throws(()=>readMarketIndex({format:'teloa.market-index/v1',catalogVersion:'2026.10.14',entries:rows}),invalid)
 assert.equal(assembleMarketIndexV2({format:'teloa.market-index/v2',catalogVersion:'2026.10.14',entries:rows}).entries.length,2)
 const drifted=[member('architect'),(()=>{const row=member('arena');row.upstream.commit='9'.repeat(40);return row})()].sort((a,b)=>a.id<b.id?-1:1)
 assert.throws(()=>assembleMarketIndexV2({format:'teloa.market-index/v2',catalogVersion:'2026.10.14',entries:drifted}),invalid)
 assert.throws(()=>readMarketIndexV2({format:'teloa.market-index/v2',catalogVersion:'2026.10.14',entries:drifted},'0.2.0-alpha.8'),invalid)
 const old=readMarketIndexV2({format:'teloa.market-index/v2',catalogVersion:'2026.10.14',entries:rows},'0.2.0-alpha.7')
 assert.deepEqual([old.entries.length,old.skipped.newerApp],[0,2])
})

test('上游树摘要输入单独导出，浏览器可用异步摘要算出与宿主相同的指纹',()=>{
 const up=readMarketCatalogEntry(member('architect')) as any
 assert.equal(createHash('sha256').update(marketCatalogUpstreamTreeInput(up.upstream)).digest('hex'),marketCatalogUpstreamTreeHash(up.upstream,text=>createHash('sha256').update(text).digest('hex')))
})
