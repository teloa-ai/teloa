import test from 'node:test'
import assert from 'node:assert/strict'
import {generateKeyPairSync,sign} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {MARKET_INDEX_MAX_BYTES} from '@teloa/contract'
import {OfficialCatalogRemote} from '../src/market/official-catalog-remote.ts'
import {listUpstreamEntries,getUpstreamEntry,remoteIndexSkipped,adoptRemoteUpstreamEntries} from '../src/market/official-upstream.ts'
import {officialCatalogIndex} from '../src/market/official-catalog-snapshot.ts'

const root=new URL('../../../',import.meta.url)
const upstreamEntry=JSON.parse(await readFile(new URL('tests/fixtures/public-market/catalog/skills/anthropic.frontend-design.json',root),'utf8'))
const officialEntry=JSON.parse(await readFile(new URL('tests/fixtures/public-market/catalog/skills/anthropic.internal-comms.json',root),'utf8'))
const {privateKey,publicKey}=generateKeyPairSync('ed25519')
const publicKeyPem=publicKey.export({type:'spki',format:'pem'}) as string
const URL_INDEX='https://market.teloa.ai/index.json',URL_SIG='https://market.teloa.ai/index.json.sig'
const URL_V2='https://market.teloa.ai/v2/index.json',URL_V2_SIG='https://market.teloa.ai/v2/index.json.sig'
// 人工夹具目录版本（2026.9.x）早于随发行固定的快照，注入更早的本机基线；默认基线另有用例单独核对。
const FIXTURE_BASELINE='2026.9.1'

const enc=new TextEncoder()
const indexBytes=(entries:unknown[],catalogVersion='2026.9.25')=>enc.encode(JSON.stringify({format:'teloa.market-index/v1',catalogVersion,entries:[...entries].sort((a:any,b:any)=>a.id<b.id?-1:a.id>b.id?1:0)}))
const indexBytesV2=(entries:unknown[],catalogVersion='2026.9.25')=>enc.encode(JSON.stringify({format:'teloa.market-index/v2',catalogVersion,entries:[...entries].sort((a:any,b:any)=>a.id<b.id?-1:a.id>b.id?1:0)}))
const signatureOf=(bytes:Uint8Array)=>sign(null,bytes,privateKey).toString('base64')+'\n'
type Served={index:Uint8Array;signature:string;etag?:string;status?:number;headers?:Record<string,string>;v2?:{index:Uint8Array;signature:string;etag?:string;status?:number;sigStatus?:number}}
type Logged={level:'info'|'warn';message:string}
function stubFetch(current:Served|(()=>Served),calls:{url:string;init:RequestInit|undefined}[]=[]):typeof fetch{
 return (async(input:string|URL|Request,init?:RequestInit)=>{
  const served=typeof current==='function'?current():current
  const url=String(input);calls.push({url,init})
  if(url===URL_V2){
   if(!served.v2)return new Response('not found',{status:404})
   if(served.v2.etag&&new Headers(init?.headers).get('if-none-match')===served.v2.etag)return new Response(null,{status:304})
   return new Response(served.v2.index as BodyInit,{status:served.v2.status??200,headers:served.v2.etag?{etag:served.v2.etag}:{}})
  }
  if(url===URL_V2_SIG){if(!served.v2)return new Response('not found',{status:404});return new Response(served.v2.signature,{status:served.v2.sigStatus??200})}
  if(url===URL_INDEX){
   const requested=new Headers(init?.headers).get('if-none-match')
   if(served.etag&&requested===served.etag)return new Response(null,{status:304})
   return new Response(served.index as BodyInit,{status:served.status??200,headers:{...(served.etag?{etag:served.etag}:{}),...(served.headers??{})}})
  }
  if(url===URL_SIG)return new Response(served.signature,{status:200})
  return new Response('not found',{status:404})
 }) as typeof fetch
}
const remoteWith=(served:Served,calls:{url:string;init:RequestInit|undefined}[]=[],url?:string)=>{
 const log:string[]=[],levels:Logged['level'][]=[]
 const remote=new OfficialCatalogRemote({publicKey:publicKeyPem,teloaVersion:'0.2.0-alpha.8',baselineCatalogVersion:FIXTURE_BASELINE,fetch:stubFetch(served,calls),log:(level,message)=>{levels.push(level);log.push(message)},...(url?{url}:{})})
 return {remote,log,levels,calls}
}
const good=()=>{const index=indexBytes([officialEntry,upstreamEntry]);return {index,signature:signatureOf(index),etag:'"v1"'}}

test('验签与结构都通过时采用新目录：上游条目进入 listUpstreamEntries，官方条目不替换随发行快照',async()=>{
 const {remote,log,levels}=remoteWith(good())
 assert.equal(remote.current(),null)
 assert.equal(await remote.refresh(),'adopted')
 assert.equal(remote.current()?.entries.length,2)
 assert.deepEqual(listUpstreamEntries().map(entry=>entry.id),['anthropic.frontend-design'])
 assert.equal(getUpstreamEntry('anthropic.frontend-design')?.upstream.kind,'github')
 assert.equal(getUpstreamEntry('anthropic.internal-comms'),undefined)
 assert.equal(log.length,1);assert.match(log[0]!,/v2 索引未采用，回退 v1/)
 // v2 尚未发布（404）是常态，只记 info，不当告警
 assert.deepEqual(levels,['info'])
})

test('签名错误、结构不合法、重定向、超大、非白名单主机一律拒绝并保留旧目录',async()=>{
 const {remote}=remoteWith(good())
 assert.equal(await remote.refresh(),'adopted')
 const before=remote.current()
 const cases:{name:string;served:Served|null;url?:string;pattern:RegExp}[]=[
  {name:'签名错误',served:(()=>{const index=indexBytes([upstreamEntry],'2026.9.26');const other=signatureOf(indexBytes([upstreamEntry],'2026.9.27'));return {index,signature:other}})(),pattern:/签名/},
  {name:'签名不是 base64 的 64 字节',served:{index:indexBytes([upstreamEntry],'2026.9.26'),signature:'abc\n'},pattern:/签名/},
  {name:'结构不合法（签名有效）',served:(()=>{const index=enc.encode(JSON.stringify({format:'teloa.market-index/v1',catalogVersion:'2026.9.26',entries:[{...upstreamEntry,compatibility:{status:'maybe'}}]}));return {index,signature:signatureOf(index)}})(),pattern:/结构|格式|兼容/},
  {name:'非 JSON（签名有效）',served:(()=>{const index=enc.encode('not json');return {index,signature:signatureOf(index)}})(),pattern:/结构|JSON/},
  {name:'Content-Length 超过 5 MiB',served:(()=>{const index=indexBytes([upstreamEntry],'2026.9.26');return {index,signature:signatureOf(index),headers:{'content-length':String(MARKET_INDEX_MAX_BYTES+1)}}})(),pattern:/5 MiB|大小/},
  {name:'非 200 状态',served:{index:indexBytes([upstreamEntry],'2026.9.26'),signature:'x',status:500},pattern:/500|状态/},
  {name:'主机不在白名单',served:null,url:'https://www.teloa.ai/index.json',pattern:/主机|白名单/},
  {name:'非 https',served:null,url:'http://market.teloa.ai/index.json',pattern:/https/},
 ]
 for(const item of cases){
  const log:string[]=[],calls:{url:string;init:RequestInit|undefined}[]=[]
  let served:Served=good()
  const remote2=new OfficialCatalogRemote({publicKey:publicKeyPem,teloaVersion:'0.2.0-alpha.8',baselineCatalogVersion:FIXTURE_BASELINE,fetch:stubFetch(()=>served,calls),log:(_level,message)=>log.push(message),...(item.url?{url:item.url,urlV2:item.url.replace('/index.json','/v2/index.json')}:{})})
  // 先让 remote2 持有一份旧目录，再换成坏数据（无 ETag，服务端返回 200），核对旧目录保留
  if(!item.url){assert.equal(await remote2.refresh(),'adopted',item.name);served=item.served!;calls.length=0}
  assert.equal(await remote2.refresh(),'rejected',item.name)
  assert.match(log.at(-1)??'',item.pattern,item.name)
  if(item.url)assert.equal(calls.length,0,item.name+'：不应发出请求')
  else assert.equal(remote2.current()?.catalogVersion,'2026.9.25',item.name+'：应保留旧目录')
 }
 // 原 remote 未受影响
 assert.equal(remote.current(),before)
 // 重定向：fetch 以 redirect:'error' 发起，遇到重定向抛错
 const log:string[]=[]
 const redirecting=new OfficialCatalogRemote({publicKey:publicKeyPem,teloaVersion:'0.2.0-alpha.8',baselineCatalogVersion:FIXTURE_BASELINE,log:(_level,message)=>log.push(message),fetch:(async(_input:string|URL|Request,init?:RequestInit)=>{
  assert.equal(init?.redirect,'error')
  throw new TypeError('fetch failed: redirect')
 }) as typeof fetch})
 assert.equal(await redirecting.refresh(),'rejected')
 assert.match(log[0]!,/redirect|下载/)
 // 流式超大：没有 Content-Length，但字节流超过上限
 const huge=new OfficialCatalogRemote({publicKey:publicKeyPem,teloaVersion:'0.2.0-alpha.8',baselineCatalogVersion:FIXTURE_BASELINE,log:(_level,message)=>log.push(message),fetch:(async(input:string|URL|Request)=>{
  if(String(input)===URL_INDEX){
   let sent=0
   const chunk=new Uint8Array(1024*1024)
   return new Response(new ReadableStream({pull(controller){if(sent<=MARKET_INDEX_MAX_BYTES){controller.enqueue(chunk);sent+=chunk.byteLength}else controller.close()}}),{status:200})
  }
  return new Response(signatureOf(indexBytes([])),{status:200})
 }) as typeof fetch})
 assert.equal(await huge.refresh(),'rejected')
 assert.match(log.at(-1)!,/5 MiB|大小/)
})

test('先拉签名再拉索引；带 ETag 的 304 不重复解析；上游目录保持已采用的版本',async()=>{
 const calls:{url:string;init:RequestInit|undefined}[]=[]
 const {remote}=remoteWith(good(),calls)
 assert.equal(await remote.refresh(),'adopted')
 assert.deepEqual(calls.map(call=>call.url),[URL_V2_SIG,URL_SIG,URL_INDEX])
 assert.equal(await remote.refresh(),'unchanged')
 assert.deepEqual(calls.map(call=>call.url),[URL_V2_SIG,URL_SIG,URL_INDEX,URL_V2_SIG,URL_SIG,URL_INDEX])
 assert.equal(new Headers(calls[5]!.init?.headers).get('if-none-match'),'"v1"')
 assert.equal(remote.current()?.catalogVersion,'2026.9.25')
 assert.deepEqual(listUpstreamEntries().map(entry=>entry.id),['anthropic.frontend-design'])
})

test('start 立即拉取并按周期重试，stop 后不再拉取',async()=>{
 const calls:{url:string;init:RequestInit|undefined}[]=[]
 const {remote}=remoteWith(good(),calls)
 remote.start(20)
 await new Promise(resolve=>setTimeout(resolve,60))
 remote.stop()
 const seen=calls.length
 assert.ok(seen>=6,'至少一次首拉与一次周期拉取（每次 3 个请求），实际 '+seen)
 await new Promise(resolve=>setTimeout(resolve,50))
 assert.equal(calls.length,seen)
})

test('先拉 v2：验签与结构通过即采用 v2，skipped 进入 remoteIndexSkipped 并记一条日志，不再请求 v1',async()=>{
 const calls:{url:string;init:RequestInit|undefined}[]=[]
 const newer={...upstreamEntry,id:'anthropic.zzz.newer',compatibility:{...upstreamEntry.compatibility,teloa:'>=9.0.0'}}
 const v2=indexBytesV2([officialEntry,upstreamEntry,newer,{...officialEntry,id:'zz.future',kind:'plugin'}])
 const {remote,log,levels}=remoteWith({...good(),v2:{index:v2,signature:signatureOf(v2)}},calls)
 assert.equal(await remote.refresh(),'adopted')
 assert.equal(remote.current()?.format,'teloa.market-index/v2')
 assert.deepEqual(remoteIndexSkipped(),{unknownKind:1,newerApp:1})
 assert.deepEqual(calls.map(call=>call.url),[URL_V2_SIG,URL_V2])
 assert.deepEqual(log,['v2 索引已采用：跳过未知类型 1 项、需更新应用 1 项。']);assert.deepEqual(levels,['info'])
})

test('v2 验签失败回退 v1 且只记一条日志；两者都失败保留旧目录并返回 rejected',async()=>{
 const calls:{url:string;init:RequestInit|undefined}[]=[]
 const v2=indexBytesV2([upstreamEntry]);const wrong=signatureOf(indexBytesV2([upstreamEntry],'2026.9.27'))
 const {remote,log,levels}=remoteWith({...good(),v2:{index:v2,signature:wrong}},calls)
 assert.equal(await remote.refresh(),'adopted')
 assert.equal(remote.current()?.format,'teloa.market-index/v1')
 assert.equal(log.length,1);assert.match(log[0]!,/v2.*回退 v1/);assert.deepEqual(levels,['warn'])
 assert.deepEqual(remoteIndexSkipped(),{unknownKind:0,newerApp:0})
 const broken=remoteWith({index:indexBytes([upstreamEntry],'2026.9.26'),signature:'abc\n',v2:{index:v2,signature:wrong}})
 assert.equal(await broken.remote.refresh(),'rejected')
 assert.equal(broken.remote.current(),null)
 assert.deepEqual(broken.levels,['warn','warn'])
})

test('跨版本 ETag：v2 采用后签名暂时 500 回退 v1，v2 恢复时不得带旧 ETag 停在 v1，须重新采用 v2',async()=>{
 const v2=indexBytesV2([officialEntry,upstreamEntry])
 let served:Served={...good(),v2:{index:v2,signature:signatureOf(v2),etag:'"v2"'}}
 const log:Logged[]=[]
 const remote=new OfficialCatalogRemote({publicKey:publicKeyPem,teloaVersion:'0.2.0-alpha.8',baselineCatalogVersion:FIXTURE_BASELINE,fetch:stubFetch(()=>served),log:(level,message)=>log.push({level,message})})
 assert.equal(await remote.refresh(),'adopted');assert.equal(remote.current()?.format,'teloa.market-index/v2')
 assert.equal(await remote.refresh(),'unchanged')
 served={...served,v2:{...served.v2!,sigStatus:500}}
 assert.equal(await remote.refresh(),'adopted');assert.equal(remote.current()?.format,'teloa.market-index/v1')
 assert.deepEqual(log.map(item=>item.level),['warn']);assert.match(log[0]!.message,/500/)
 served={...served,v2:{...served.v2!,sigStatus:200}}
 assert.equal(await remote.refresh(),'adopted');assert.equal(remote.current()?.format,'teloa.market-index/v2')
 assert.equal(await remote.refresh(),'unchanged');assert.equal(remote.current()?.format,'teloa.market-index/v2')
 assert.equal(log.length,1)
})

// 目录降级保护：服务端滞后的旧索引即使验签与结构都通过，也不得整份替换更新的本机目录或已采用的在线目录。
const servedAt=(catalogVersion:string,entries:unknown[],etag?:string)=>{const index=indexBytes(entries,catalogVersion);return {index,signature:signatureOf(index),...(etag?{etag}:{})}}
const servedV2At=(catalogVersion:string,entries:unknown[],etag?:string)=>{const index=indexBytesV2(entries,catalogVersion);return {index,signature:signatureOf(index),...(etag?{etag}:{})}}
const upstreamIds=()=>listUpstreamEntries().map(entry=>entry.id)

test('默认基线取随发行目录快照：已验签且结构合法的旧 v2 与旧 v1 均拒绝、不替换本机目录；更新的版本照常采用',async()=>{
 const snapshotVersion=(officialCatalogIndex as {catalogVersion:string}).catalogVersion
 adoptRemoteUpstreamEntries([])
 let served:Served={...servedAt('2026.10.7.1',[upstreamEntry]),v2:servedV2At('2026.10.7.1',[upstreamEntry])}
 const log:Logged[]=[]
 const remote=new OfficialCatalogRemote({publicKey:publicKeyPem,teloaVersion:'0.2.0-alpha.8',fetch:stubFetch(()=>served),log:(level,message)=>log.push({level,message})})
 assert.equal(await remote.refresh(),'rejected')
 assert.equal(remote.current(),null)
 assert.deepEqual(upstreamIds(),[])
 assert.deepEqual(log.map(item=>item.level),['warn','warn'])
 assert.match(log[0]!.message,/^v2 索引未采用，回退 v1：v2 索引目录版本 2026\.10\.7\.1 早于本机目录 /)
 assert.match(log[1]!.message,/^索引目录版本 2026\.10\.7\.1 早于本机目录 /)
 assert.ok(log[1]!.message.includes(snapshotVersion),'默认基线应为快照目录版本 '+snapshotVersion)
 served={...served,v2:servedV2At('2099.1.1',[upstreamEntry])}
 assert.equal(await remote.refresh(),'adopted')
 assert.equal(remote.current()?.catalogVersion,'2099.1.1')
 assert.deepEqual(upstreamIds(),['anthropic.frontend-design'])
})

test('目录版本按 YYYY.M.D[.N] 数值比较（跨月份、跨序号）；采用后不降级，服务端已移除的条目不因旧索引复活',async()=>{
 adoptRemoteUpstreamEntries([])
 let served:Served=servedAt('2026.9.30.1',[upstreamEntry])
 const log:string[]=[]
 const remote=new OfficialCatalogRemote({publicKey:publicKeyPem,teloaVersion:'0.2.0-alpha.8',baselineCatalogVersion:'2026.9.30.2',fetch:stubFetch(()=>served),log:(_level,message)=>log.push(message)})
 // 同日序号更低；字符串比较会把 2026.9.4 排在 2026.9.30.2 之后；不合规范的版本无法比较
 for(const [version,pattern] of [['2026.9.30.1',/早于本机目录 2026\.9\.30\.2/],['2026.9.4',/早于本机目录 2026\.9\.30\.2/],['next',/不符合 YYYY\.M\.D/]] as const){
  served=servedAt(version,[upstreamEntry])
  assert.equal(await remote.refresh(),'rejected',version)
  assert.match(log.at(-1)!,pattern,version)
  assert.equal(remote.current(),null,version)
  assert.deepEqual(upstreamIds(),[],version)
 }
 // 字符串比较会把 2026.10.1.9 排在 2026.9.30.2 之前、2026.10.1.10 排在 2026.10.1.9 之前
 served=servedAt('2026.10.1.9',[upstreamEntry])
 assert.equal(await remote.refresh(),'adopted')
 assert.deepEqual(upstreamIds(),['anthropic.frontend-design'])
 served=servedAt('2026.10.1.10',[])
 assert.equal(await remote.refresh(),'adopted')
 assert.deepEqual(upstreamIds(),[],'更新的索引整份替换，服务端移除的条目随之移除')
 const adopted=remote.current()
 served=servedAt('2026.10.1.9',[upstreamEntry])
 assert.equal(await remote.refresh(),'rejected')
 assert.match(log.at(-1)!,/目录版本 2026\.10\.1\.9 早于本机目录 2026\.10\.1\.10/)
 assert.equal(remote.current(),adopted)
 assert.deepEqual(upstreamIds(),[],'旧索引不得复活已移除的条目')
 // 同版本重新发布（如 ETag 变化）照常采用
 served=servedAt('2026.10.1.10',[])
 assert.equal(await remote.refresh(),'adopted')
})

test('降级保护不影响 304 与 v2→v1 回退：较新的 v2 采用、v1 较新时回退采用；之后旧 v2 与旧 v1 均拒绝并保留原目录',async()=>{
 let served:Served={...servedAt('2026.10.14.1',[upstreamEntry],'"v1-a"'),v2:servedV2At('2026.10.14.1',[officialEntry,upstreamEntry],'"v2-a"')}
 const log:Logged[]=[]
 const remote=new OfficialCatalogRemote({publicKey:publicKeyPem,teloaVersion:'0.2.0-alpha.8',baselineCatalogVersion:'2026.10.14.1',fetch:stubFetch(()=>served),log:(level,message)=>log.push({level,message})})
 assert.equal(await remote.refresh(),'adopted');assert.equal(remote.current()?.format,'teloa.market-index/v2')
 assert.equal(await remote.refresh(),'unchanged')
 // v2 签名暂时 500：回退 v1，v1 更新则照常采用
 served={...servedAt('2026.10.15',[upstreamEntry],'"v1-b"'),v2:{...served.v2!,sigStatus:500}}
 assert.equal(await remote.refresh(),'adopted')
 assert.equal(remote.current()?.format,'teloa.market-index/v1');assert.equal(remote.current()?.catalogVersion,'2026.10.15')
 const kept=remote.current()
 // v2 恢复但仍是旧目录、v1 又被换回旧目录：两者都拒绝，保留已采用的 v1 目录
 served={...servedAt('2026.10.14.1',[],'"v1-c"'),v2:servedV2At('2026.10.14.1',[officialEntry],'"v2-a"')}
 log.length=0
 assert.equal(await remote.refresh(),'rejected')
 assert.equal(remote.current(),kept)
 assert.deepEqual(upstreamIds(),['anthropic.frontend-design'])
 assert.deepEqual(log.map(item=>item.level),['warn','warn'])
 assert.match(log[0]!.message,/v2 索引目录版本 2026\.10\.14\.1 早于本机目录 2026\.10\.15/)
 assert.match(log[1]!.message,/^索引目录版本 2026\.10\.14\.1 早于本机目录 2026\.10\.15/)
 // 较新的 v2 发布后照常采用
 served={...served,v2:servedV2At('2026.10.16',[upstreamEntry],'"v2-b"')}
 assert.equal(await remote.refresh(),'adopted')
 assert.equal(remote.current()?.format,'teloa.market-index/v2');assert.equal(remote.current()?.catalogVersion,'2026.10.16')
})


test('Teloa 官方目录不能采用已退出生态或未审来源，签名与新版本不能代替收录审核',async()=>{
 const oldSource=JSON.parse(await readFile(new URL('tests/fixtures/public-market/catalog/skills/clawhub.ivangdavila.git.json',root),'utf8'))
 for(const entry of [oldSource,{...upstreamEntry,review:{...upstreamEntry.review,reviewer:'Unreviewed source'}}]){
  const index=indexBytes([entry],'2099.2.1'),{remote,log}=remoteWith({index,signature:signatureOf(index)})
  assert.equal(await remote.refresh(),'rejected')
  assert.equal(remote.current(),null)
  assert.match(log.at(-1)!,/Teloa 官方收录/)
 }
})
