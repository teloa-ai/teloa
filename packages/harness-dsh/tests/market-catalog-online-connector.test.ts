import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {OfficialCatalogService} from '@teloa/backend'
import {adoptRemoteUpstreamEntries} from '../../backend/src/market/official-upstream.ts'
import {createMarketCatalogHandler} from '../src/market-catalog.ts'
import {encodeReceipt} from '../src/market-content.ts'

// 在线索引采用的远端连接器没有工件字节：宿主列表复核须放行 artifact:null，stdio 连接器缺工件仍按宿主错误拒绝。
const deepwiki=JSON.parse(await readFile(new URL('../../../tests/fixtures/public-market/catalog/connectors/teloa.mcp-deepwiki.json',import.meta.url),'utf8'))
const online={...deepwiki,id:'teloa.mcp-online-notes',connector:{...deepwiki.connector,serverName:'online_notes',recipe:{transport:'streamable-http',url:'https://mcp.example.org/mcp'}}}
const store={import:async()=>{throw Error('unused')},findByIdentity:async()=>null,findByCatalogSources:async()=>new Map<string,string>()}
const noop=async()=>{throw Error('unused')}

test('在线连接器经真实官方列表与宿主复核后可见（artifact 为 null）；stdio 连接器缺工件仍拒绝',async()=>{
 adoptRemoteUpstreamEntries([],{unknownKind:0,newerApp:0},[online])
 const service=new OfficialCatalogService(store)
 const handle=createMarketCatalogHandler('local:owner',async()=>({list:(actor,request)=>service.list(actor,request as never),add:noop,addRole:noop}),encodeReceipt)
 const listed=await handle('market-catalog/list',{kind:'connector',query:'online_notes'}) as {items:{entry:{id:string;connector:{recipe:unknown}};artifact:unknown}[]}
 assert.deepEqual(listed.items.map(item=>[item.entry.id,item.artifact,item.entry.connector.recipe]),[[online.id,null,online.connector.recipe]])
 const stdio={...online,connector:{...online.connector,recipe:{transport:'stdio',package:'@example/mcp',version:'1.0.0',integrity:'sha512-'+'A'.repeat(86)+'==',bin:'lib/main.js',args:[]}}}
 const forged=createMarketCatalogHandler('local:owner',async()=>({list:async()=>({...await service.list({ownerId:'local:owner',kind:'human'},{kind:'connector',query:'online_notes'}),items:[{entry:stdio,artifact:null,addedContentId:null,addedRoleId:null,secretGroup:null}]}),add:noop,addRole:noop}),encodeReceipt)
 await assert.rejects(forged('market-catalog/list',{}),{code:'teloa/invalid-host-response'})
})
