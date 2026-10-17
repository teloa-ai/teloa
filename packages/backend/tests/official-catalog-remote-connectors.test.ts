import test from 'node:test'
import assert from 'node:assert/strict'
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {OfficialCatalogRemote} from '../src/market/official-catalog-remote.ts'
import {OfficialCatalogService} from '../src/market/official-catalog.ts'
import type {MarketActor} from '../src/market/content-store.ts'

// 在线签名索引里的连接器：采用后进入官方列表与 getConnectorEntry，供原受管连接添加；坏索引、stdio、与快照同 id / 同服务名的条目都不进入。
const root=new URL('../../../',import.meta.url)
const deepwiki=JSON.parse(await readFile(new URL('tests/fixtures/public-market/catalog/connectors/teloa.mcp-slack.json',root),'utf8'))
const {privateKey,publicKey}=generateKeyPairSync('ed25519')
const publicKeyPem=publicKey.export({type:'spki',format:'pem'}) as string
const enc=new TextEncoder()
const human=():MarketActor=>({ownerId:randomUUID(),kind:'human'})
const store={import:async()=>{throw new Error('不应导入内容')},findByIdentity:async()=>null,findByCatalogSources:async()=>new Map<string,string>()}

const connector=(id:string,serverName:string,patch:Record<string,unknown>={})=>({...structuredClone(deepwiki),id,...patch,connector:{...structuredClone(deepwiki.connector),serverName,auth:{kind:'none'},recipe:{transport:'streamable-http',url:`https://mcp.example.org/${serverName}`},...(patch.connector as object??{})}})
const online=connector('teloa.mcp-online-notes','online_notes')
const stdio=connector('teloa.mcp-online-stdio','online_stdio',{connector:{recipe:{transport:'stdio',package:'@example/mcp',version:'1.0.0',integrity:'sha512-'+'A'.repeat(86)+'==',bin:'lib/main.js',args:[]}}})

type Served={v2:Uint8Array;signature:string}
const signed=(entries:unknown[],catalogVersion='2026.10.14'):Served=>{const v2=enc.encode(JSON.stringify({format:'teloa.market-index/v2',catalogVersion,entries}));return {v2,signature:sign(null,v2,privateKey).toString('base64')}}
function remoteFor(get:()=>Served){
 const log:string[]=[]
 const fetchIndex=(async(input:string|URL|Request)=>{
  const url=String(input),served=get()
  if(url==='https://market.teloa.ai/v2/index.json.sig')return new Response(served.signature)
  if(url==='https://market.teloa.ai/v2/index.json')return new Response(served.v2 as BodyInit)
  return new Response('not found',{status:404})
 }) as typeof fetch
 return {remote:new OfficialCatalogRemote({publicKey:publicKeyPem,teloaVersion:'0.2.0-alpha.7',baselineCatalogVersion:'2026.10.1',fetch:fetchIndex,log:(_level,message)=>log.push(message)}),log}
}
const allListed=async(service:OfficialCatalogService)=>{
 const ids:string[]=[];let cursor:string|undefined
 for(;;){const page=await service.list(human(),{kind:'connector',...(cursor?{cursor}:{})});ids.push(...page.items.map(item=>item.entry.id));if(!page.nextCursor)return ids;cursor=page.nextCursor}
}

test('只含新增连接器的签名 v2 索引：采用后官方列表可读、getConnectorEntry 给出原受管连接配置，且仍不能作为内容添加',async()=>{
 let served=signed([online])
 const {remote}=remoteFor(()=>served),service=new OfficialCatalogService(store)
 const before=await service.list(human(),{kind:'connector'})
 assert.equal(service.getConnectorEntry(online.id),undefined)
 assert.equal(await remote.refresh(),'adopted')
 const ids=await allListed(service)
 assert.ok(ids.includes(online.id),'在线新增连接器应进入官方列表')
 const page=await service.list(human(),{kind:'connector',query:'online_notes'})
 assert.deepEqual(page.items.map(item=>[item.entry.id,item.artifact,item.addedContentId]),[[online.id,null,null]])
 assert.equal(page.counts.connector,before.counts.connector+1)
 const entry=service.getConnectorEntry(online.id)!
 assert.equal(entry.connector.serverName,'online_notes')
 assert.deepEqual(entry.connector.recipe,{transport:'streamable-http',url:'https://mcp.example.org/online_notes'})
 assert.deepEqual(entry.connector.tools.map(tool=>tool.name),deepwiki.connector.tools.map((tool:{name:string})=>tool.name))
 assert.equal(service.isRemoteConnector(online.id),true)
 assert.equal(service.isRemoteConnector('teloa.mcp-slack'),false)
 assert.equal(service.hasEntry(online.id),true)
 assert.equal(service.getConnectorPackageLock(online.id),undefined)
 await assert.rejects(service.add(human(),{requestId:randomUUID(),entryId:online.id}),/连接不能添加为内容/)
 // 远端更新：同 id 新版本只影响之后的添加；移除后不再可查
 served=signed([connector(online.id,'online_notes',{version:'1.1.0',connector:{recipe:{transport:'streamable-http',url:'https://mcp.example.org/v2'}}})],'2026.10.15')
 assert.equal(await remote.refresh(),'adopted')
 assert.equal(service.getConnectorEntry(online.id)?.version,'1.1.0')
 served=signed([],'2026.10.16')
 assert.equal(await remote.refresh(),'adopted')
 assert.equal(service.getConnectorEntry(online.id),undefined)
 assert.equal((await allListed(service)).includes(online.id),false)
})

test('签名失败、服务名重复的索引整份拒绝，已采用的连接器保持不变；从未采用时不出现',async()=>{
 let served:Served={...signed([online]),signature:signed([online],'2026.10.99').signature}
 const {remote,log}=remoteFor(()=>served),service=new OfficialCatalogService(store)
 assert.equal(await remote.refresh(),'rejected')
 assert.equal(service.getConnectorEntry(online.id),undefined)
 assert.equal((await allListed(service)).includes(online.id),false)
 served=signed([online])
 assert.equal(await remote.refresh(),'adopted')
 served=signed([online,connector('teloa.mcp-online-twin','online_notes')].sort((a,b)=>a.id<b.id?-1:1),'2026.10.15')
 assert.equal(await remote.refresh(),'rejected')
 assert.match(log.join('\n'),/v2 索引结构不合法：连接器服务名重复/)
 assert.equal(remote.current()?.catalogVersion,'2026.10.14')
 assert.equal(service.getConnectorEntry('teloa.mcp-online-twin'),undefined)
 assert.equal(service.getConnectorEntry(online.id)?.connector.serverName,'online_notes')
})

test('不受支持的在线条目不进入：stdio 无随发行安装锁、与快照同 id 或同服务名的条目以快照为准',async()=>{
 const sameId=connector('teloa.mcp-slack','slack_online',{version:'9.0.0',connector:{recipe:{transport:'streamable-http',url:'https://evil.example.org/mcp'}}})
 const sameName=connector('teloa.mcp-zz-deepwiki-copy','slack')
 const served=signed([online,sameId,stdio,sameName].sort((a,b)=>a.id<b.id?-1:1))
 const {remote,log}=remoteFor(()=>served),service=new OfficialCatalogService(store)
 assert.equal(await remote.refresh(),'adopted')
 assert.match(log.join('\n'),/stdio/)
 assert.equal(service.getConnectorEntry(stdio.id),undefined)
 assert.equal(service.getConnectorEntry(sameName.id),undefined)
 const fixed=service.getConnectorEntry('teloa.mcp-slack')!
 assert.equal(fixed.version,deepwiki.version)
 assert.deepEqual(fixed.connector.recipe,deepwiki.connector.recipe)
 assert.equal(service.isRemoteConnector('teloa.mcp-slack'),false)
 const ids=await allListed(service)
 assert.equal(ids.filter(id=>id==='teloa.mcp-slack').length,1)
 assert.ok(ids.includes(online.id)&&!ids.includes(stdio.id)&&!ids.includes(sameName.id))
})
