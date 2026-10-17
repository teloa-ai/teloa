import test from 'node:test'
import assert from 'node:assert/strict'
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto'
import {OfficialCatalogRemote} from '../src/market/official-catalog-remote.ts'
import {OfficialCatalogService} from '../src/market/official-catalog.ts'

// 在线签名 v2 索引里的 Cursor 插件技能：带分组声明原样进入 cursor 来源列表；同一插件成员不一致时整份拒绝，已采用目录不变。
const {privateKey,publicKey}=generateKeyPairSync('ed25519')
const publicKeyPem=publicKey.export({type:'spki',format:'pem'}) as string
const loc=(text:string)=>({'zh-CN':text,en:text})
const plugin={marketplace:'cursor',id:'49339676',title:loc('Remotion'),summary:loc('视频制作技能包'),root:'.',manifest:{path:'plugin.json',gitBlob:'e'.repeat(40),sha256:'4'.repeat(64)},license:{spdx:'MIT'},connectors:[]}
const member=(name:string,commit='8'.repeat(40))=>({format:'teloa.market-catalog-entry/v1',id:'cursor.'+name,kind:'skill',delivery:'upstream',version:'4.0.533',taxonomy:{functions:['content-design'],industries:['general']},skill:{name,title:loc(name),summary:loc(name)},
 upstream:{kind:'github',repository:{host:'github.com',owner:'remotion-dev',repo:'cursor-plugin'},commit,path:'skills/'+name,files:[{path:'SKILL.md',gitBlob:'b'.repeat(40),sha256:'1'.repeat(64),size:1},{path:'licenses/upstream/LICENSE',repositoryPath:'LICENSE',gitBlob:'c'.repeat(40),sha256:'2'.repeat(64),size:2}]},
 origin:{marketplace:'cursor',installs:null,installsLabel:'未公开',countedAt:'2026-10-14'},alternatives:[],unsupportedComponents:[],modifications:[],license:{spdx:'MIT',files:['licenses/upstream/LICENSE']},
 compatibility:{status:'content-only',teloa:'>=0.2.0-alpha.8',dsh:'0.1.7-rc.1',conditions:[]},requires:{tools:[],network:false,runtimes:[]},review:{status:'approved',reviewedAt:'2026-10-14',reviewer:'Teloa'},plugin})
const signed=(entries:unknown[],catalogVersion:string)=>{const v2=new TextEncoder().encode(JSON.stringify({format:'teloa.market-index/v2',catalogVersion,entries}));return {v2,signature:sign(null,v2,privateKey).toString('base64')}}
const store={import:async()=>{throw new Error('不应导入内容')},findByIdentity:async()=>null,findByCatalogSources:async()=>new Map<string,string>()}

test('签名 v2 的 Cursor 插件技能按分组原样列出；同一插件成员提交不一致时整份拒绝、保留已采用目录',async()=>{
 let served=signed([member('remotion-render'),member('remotion-studio')],'2026.10.14')
 const log:string[]=[]
 const fetchIndex=(async(input:string|URL|Request)=>{const url=String(input);if(url.endsWith('/v2/index.json.sig'))return new Response(served.signature);if(url.endsWith('/v2/index.json'))return new Response(served.v2 as BodyInit);return new Response('not found',{status:404})}) as typeof fetch
 const remote=new OfficialCatalogRemote({publicKey:publicKeyPem,teloaVersion:'0.2.0-alpha.8',baselineCatalogVersion:'2026.10.1',fetch:fetchIndex,log:(_level,message)=>log.push(message)})
 assert.equal(await remote.refresh(),'adopted',log.join('|'))
 const service=new OfficialCatalogService(store),actor={ownerId:randomUUID(),kind:'human' as const}
 const listed=await service.list(actor,{marketplace:'cursor'})
 assert.deepEqual(listed.items.map(item=>[item.entry.id,(item.entry as {plugin?:{id:string}}).plugin?.id]),[['cursor.remotion-render','49339676'],['cursor.remotion-studio','49339676']])
 served=signed([member('remotion-render'),member('remotion-studio','9'.repeat(40))],'2026.10.15')
 assert.equal(await remote.refresh(),'rejected')
 assert.match(log.join('\n'),/分组声明不一致/)
 assert.equal(remote.current()?.catalogVersion,'2026.10.14')
 assert.equal((await service.list(actor,{marketplace:'cursor'})).items.length,2)
})
