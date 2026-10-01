import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {marketSolutionResourceKinds,mcpConnectionReadOnly,readMarketCatalogEntry,readMarketCatalogListContents} from '../src/market-catalog.ts'

// 目录列表回包的可选字段 contents（2026-09-28 设计约束 3）：官方方案包内各类资源数量，方案卡据此写「包含：…」；
// 市场目录格式不变，只是宿主回包条目「存在才加入键集」。
const read=(path:string)=>JSON.parse(readFileSync(new URL('../../../tests/fixtures/public-market/'+path,import.meta.url),'utf8'))
const solution=readMarketCatalogEntry(read('catalog/solutions/teloa.soc.json'))
const connector=readMarketCatalogEntry(read('catalog/connectors/teloa.mcp-lark.json'))

test('包含计数：只收方案条目、十三类资源键、1～500 的整数，至少一类；回值按固定顺序重建不透传',()=>{
 assert.equal(marketSolutionResourceKinds.length,13)
 const value=readMarketCatalogListContents({skill:7,role:2,knowledge:1,'work-template':4,plan:1},solution)
 assert.deepEqual(Object.keys(value),['role','knowledge','skill','work-template','plan'])
 for(const broken of [{},{skill:0},{skill:-1},{skill:1.5},{skill:501},{skill:'1'},{unknown:1},null,[],{skill:1,extra:2}])
  assert.throws(()=>readMarketCatalogListContents(broken,solution),{code:'teloa/invalid-input'},JSON.stringify(broken))
 assert.throws(()=>readMarketCatalogListContents({skill:1},connector),{code:'teloa/invalid-input'})
})

test('连接只读判定：声明的每个工具都在同名服务的官方连接器里标为只读才算只读',()=>{
 if(connector.kind!=='connector')throw Error('fixture')
 assert.equal(mcpConnectionReadOnly({serverName:'lark',tools:['im_v1_chat_list','docx_builtin_search']},[connector]),true)
 assert.equal(mcpConnectionReadOnly({serverName:'lark',tools:['im_v1_chat_list','im_v1_message_create']},[connector]),false,'带写工具')
 assert.equal(mcpConnectionReadOnly({serverName:'lark',tools:['im_v1_chat_list','no_such_tool']},[connector]),false,'查不到的工具')
 assert.equal(mcpConnectionReadOnly({serverName:'yuque',tools:['yuque_search']},[connector]),false,'查不到连接器')
 assert.equal(mcpConnectionReadOnly({serverName:'lark',tools:[]},[connector]),false,'没有声明工具')
})
