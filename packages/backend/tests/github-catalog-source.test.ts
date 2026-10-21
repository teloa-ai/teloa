import {readFile} from 'node:fs/promises'
import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {deflateRawSync} from 'node:zlib'
import type {MarketCatalogUpstreamGithub} from '@teloa/contract'
import {downloadGithubCatalogSkill,type GithubHttpPort,type GithubHttpRequest} from '../src/market/github-source.ts'

const bytes=(text:string)=>new TextEncoder().encode(text)
const blob=(text:string)=>createHash('sha1').update('blob '+bytes(text).byteLength+'\0').update(bytes(text)).digest('hex')
const sha256=(text:string)=>createHash('sha256').update(bytes(text)).digest('hex')
const treeSha=(path:string)=>createHash('sha1').update('fixture-tree:'+path).digest('hex')
type TreeItem={path:string;type:string;mode:string;sha:string;size?:number|null}
type TreeReply={sha:string;truncated:boolean;tree:TreeItem[]}
function fixture(){
 const texts:Record<string,string>={'SKILL.md':'---\nname: notes\ndescription: Notes\n---\n# Notes\n','LICENSE':'MIT License','references/guide.md':'# Guide'}
 const source:MarketCatalogUpstreamGithub={kind:'github',repository:{host:'github.com',owner:'example',repo:'skills'},commit:'a'.repeat(40),path:'skills/notes',files:Object.entries(texts).map(([path,text])=>({path,gitBlob:blob(text),sha256:sha256(text),size:bytes(text).byteLength}))}
 const tree:{truncated:boolean;tree:TreeItem[]}={truncated:false,tree:[...source.files.map(file=>({path:source.path+'/'+file.path,type:'blob',mode:'100644',sha:file.gitBlob,size:file.size})),{path:source.path+'/scripts/run.py',type:'blob',mode:'100755',sha:'b'.repeat(40),size:200},{path:source.path+'/link',type:'blob',mode:'120000',sha:'b'.repeat(40),size:3}]}
 const calls:GithubHttpRequest[]=[]
 const overrides=new Map<string,{status?:number;headers?:Record<string,string>;body?:string}>()
 const treeChanges=new Map<string,(reply:TreeReply)=>void>(),directories=new Map([[treeSha(''),'']])
 const reply=(directory:string,ref:string):TreeReply=>{
  const prefix=directory?directory+'/':'',items:TreeItem[]=[],nested=new Set<string>()
  for(const item of tree.tree){
   if(!item.path.startsWith(prefix))continue
   const relative=item.path.slice(prefix.length),slash=relative.indexOf('/')
   if(slash<0)items.push({...item,path:relative})
   else{
    const name=relative.slice(0,slash),path=prefix+name,sha=treeSha(path)
    if(!nested.has(name)){items.push({path:name,type:'tree',mode:'040000',sha});nested.add(name);directories.set(sha,path)}
   }
  }
  // GitHub 对 /git/trees/{x} 的回包 sha 是请求参数 x：根树按 commit 请求时回的是 commit，不是根树 sha；一律回显请求参数。
  const result={sha:ref,truncated:tree.truncated,tree:items};treeChanges.get(directory)?.(result);return result
 }
 const http:GithubHttpPort={request:async request=>{
  calls.push(request)
  const url=new URL(request.url),isTree=url.hostname==='api.github.com',ref=url.pathname.split('/').at(-1)!
  assert.equal(url.search,'','非递归树必须完全省略 recursive 参数')
  const key=isTree?'tree:'+ref:decodeURIComponent(url.pathname.split('/'+source.commit+'/')[1]??'')
  const change=overrides.get(key),directory=ref===source.commit?'':directories.get(ref)
  if(isTree)assert.notEqual(directory,undefined,'不得读取未声明路径之外的树：'+request.url)
  const text=change?.body??(isTree?JSON.stringify(reply(directory!,ref)):texts[key.slice(source.path.length+1)])
  assert.equal(typeof text,'string','未声明文件不应下载：'+request.url)
  return {status:change?.status??200,headers:change?.headers??{},body:(async function*(){yield bytes(text!)})()}
 }}
 return {source,texts,tree,http,calls,overrides,treeChanges}
}
const treeCalls=(f:ReturnType<typeof fixture>)=>f.calls.filter(call=>new URL(call.url).hostname==='api.github.com')
const rawCalls=(f:ReturnType<typeof fixture>)=>f.calls.filter(call=>new URL(call.url).hostname==='raw.githubusercontent.com')

type ArchiveEntry={path:string;text?:string;mode?:number;os?:number;creatorVersion?:number;externalAttrs?:number;badCrc?:boolean}
function catalogZip(source:MarketCatalogUpstreamGithub,entries:ArchiveEntry[],options:{root?:string;commit?:string}={}):Uint8Array{
 const root=options.root??`${source.repository.repo}-${source.commit}`,locals:Buffer[]=[],centrals:Buffer[]=[];let offset=0
 const crc32=(value:Uint8Array)=>{let crc=0xffffffff;for(const byte of value){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}return (crc^0xffffffff)>>>0}
 for(const entry of entries){
  const name=Buffer.from(root+'/'+entry.path),plain=Buffer.from(entry.text??''),compressed=deflateRawSync(plain),crc=(crc32(plain)+(entry.badCrc?1:0))>>>0
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(8,8);local.writeUInt32LE(crc,14);local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(plain.length,22);local.writeUInt16LE(name.length,26)
  locals.push(local,name,compressed)
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(entry.creatorVersion??(((entry.os??3)<<8)|20),4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt16LE(8,10);central.writeUInt32LE(crc,16);central.writeUInt32LE(compressed.length,20);central.writeUInt32LE(plain.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(entry.externalAttrs??((((entry.mode??(entry.path.endsWith('/')?0x41ed:0x81a4))&0xffff)<<16)>>>0),38);central.writeUInt32LE(offset,42)
  centrals.push(central,name);offset+=local.length+name.length+compressed.length
 }
 const comment=Buffer.from(options.commit??source.commit),size=centrals.reduce((sum,part)=>sum+part.length,0),end=Buffer.alloc(22)
 end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(size,12);end.writeUInt32LE(offset,16);end.writeUInt16LE(comment.length,20)
 return Buffer.concat([...locals,...centrals,end,comment])
}
function rateFallbackFixture(){
 const f=fixture(),entries:ArchiveEntry[]=[{path:'',mode:0x41ed},{path:'skills/'},{path:'skills/notes/'},{path:'skills/notes/references/'},...Object.entries(f.texts).map(([path,text])=>({path:f.source.path+'/'+path,text}))]
 const seen:GithubHttpRequest[]=[],options:{root?:string;commit?:string}={},api={status:403,headers:{'x-ratelimit-remaining':'0','x-ratelimit-reset':String(Math.floor(Date.now()/1000)+60)} as Record<string,string>},archive={status:200,headers:{} as Record<string,string>}
 const http:GithubHttpPort={request:async request=>{
  seen.push(request)
  if(new URL(request.url).hostname==='api.github.com')return {...api,body:(async function*(){yield bytes('rate limit exceeded')})()}
  assert.equal(request.url,`https://codeload.github.com/${f.source.repository.owner}/${f.source.repository.repo}/zip/${f.source.commit}`)
  const zip=catalogZip(f.source,entries,options)
  return {status:archive.status,headers:{'content-length':String(zip.length),...archive.headers},body:(async function*(){yield zip})()}
 }}
 return {...f,entries,seen,options,api,archive,fallbackHttp:http}
}

test('固定目录遇真实API限额时仅一次同提交ZIP恢复，原文件与许可摘要不变',async()=>{
 const f=rateFallbackFixture(),files=await downloadGithubCatalogSkill(f.source,f.fallbackHttp)
 assert.deepEqual(files.map(file=>file.path),['LICENSE','SKILL.md','references/guide.md'])
 for(const file of files)assert.deepEqual(file.bytes,bytes(f.texts[file.path]!))
 assert.equal(f.seen.length,2)
 assert.equal(new URL(f.seen[0]!.url).hostname,'api.github.com')
 assert.equal(new URL(f.seen[1]!.url).hostname,'codeload.github.com')
 assert.ok(f.seen.every(call=>call.redirect==='manual'&&!('authorization' in call.headers)))
})

test('限额归档仍拒绝错误提交/根、无可信模式、危险路径与祖先歧义，不返回部分文件',async()=>{
 const cases:{name:string;change:(f:ReturnType<typeof rateFallbackFixture>)=>void}[]=[
  {name:'错误提交注释',change:f=>{f.options.commit='b'.repeat(40)}},
  {name:'错误固定根',change:f=>{f.options.root='skills-'+ 'b'.repeat(40)}},
  {name:'缺少根目录',change:f=>{f.entries.shift()}},
  {name:'缺少祖先目录',change:f=>{f.entries.splice(1,1)}},
  {name:'祖先是文件',change:f=>{f.entries[1]={path:'skills',text:''}}},
  {name:'大小写祖先歧义',change:f=>{f.entries.push({path:'Skills/'})}},
  {name:'目录重复',change:f=>{f.entries.push({path:'skills/'})}},
  {name:'文件/目录同名',change:f=>{f.entries.push({path:'skills/notes/SKILL.md/'})}},
  {name:'未知creator OS',change:f=>{f.entries.at(-1)!.os=0}},
  {name:'无Unix模式',change:f=>{f.entries.at(-1)!.mode=0}},
  {name:'可执行文件',change:f=>{f.entries.at(-1)!.mode=0x81ed}},
  {name:'特殊权限',change:f=>{f.entries.at(-1)!.mode=0x89a4}},
  {name:'符号链接',change:f=>{f.entries.at(-1)!.mode=0xa1ff}},
  {name:'目录伪装',change:f=>{f.entries.at(-1)!.mode=0x41ed}},
  {name:'路径越界',change:f=>{f.entries.push({path:'../escape',text:'x'})}},
  {name:'文件缺失',change:f=>{f.entries.pop()}},
  {name:'CRC错误',change:f=>{f.entries.at(-1)!.badCrc=true}},
  {name:'文件篡改',change:f=>{f.entries.at(-1)!.text='changed'}},
  {name:'固定blob不符',change:f=>{f.source.files[0]!.gitBlob='b'.repeat(40)}},
  {name:'固定sha256不符',change:f=>{f.source.files[0]!.sha256='b'.repeat(64)}},
  {name:'固定大小不符',change:f=>{f.source.files[0]!.size=1}},
 ]
 for(const item of cases){const f=rateFallbackFixture();item.change(f);await assert.rejects(downloadGithubCatalogSkill(f.source,f.fallbackHttp),(error:unknown)=>error instanceof Error&&'code' in error&&error.code==='teloa/source-unavailable'&&/GitHub API 限流/.test(error.message)&&/固定提交归档验证也未完成/.test(error.message),item.name);assert.equal(f.seen.length,2,item.name)}
})

test('非限额403/404/网络或树内容损坏不读取归档；429限额可恢复，归档失败保留两阶段原因',async()=>{
 for(const status of [403,404,500]){const f=rateFallbackFixture();f.api.status=status;f.api.headers={};await assert.rejects(downloadGithubCatalogSkill(f.source,f.fallbackHttp));assert.equal(f.seen.length,1)}
 const network=rateFallbackFixture();await assert.rejects(downloadGithubCatalogSkill(network.source,{request:async request=>{network.seen.push(request);throw Error('network')}}));assert.equal(network.seen.length,1)
 const badTree=fixture();badTree.overrides.set('tree:'+badTree.source.commit,{body:'{}'});await assert.rejects(downloadGithubCatalogSkill(badTree.source,badTree.http));assert.equal(badTree.calls.length,1)
 const retry=rateFallbackFixture();retry.api.status=429;retry.api.headers={'retry-after':'120'};assert.equal((await downloadGithubCatalogSkill(retry.source,retry.fallbackHttp)).length,3)
 for(const status of [301,403,404]){const f=rateFallbackFixture();f.archive.status=status;f.archive.headers={location:'https://evil.example/archive'};await assert.rejects(downloadGithubCatalogSkill(f.source,f.fallbackHttp),(error:unknown)=>error instanceof Error&&/API 限流/.test(error.message)&&new RegExp('HTTP '+status).test(error.message));assert.equal(f.seen.length,2)}
 const tooLarge=rateFallbackFixture();tooLarge.archive.headers={'content-length':String(20*1024*1024+1)};await assert.rejects(downloadGithubCatalogSkill(tooLarge.source,tooLarge.fallbackHttp),/超过/);assert.equal(tooLarge.seen.length,2)
})

test('限额归档保留NFD原路径、目录外许可映射和size未知时的实际摘要验证',async()=>{
 const f=rateFallbackFixture(),text='Repository license'
 f.source.files.push({path:'licenses/upstream/LICENSE',repositoryPath:'LICENSE',gitBlob:blob(text),sha256:sha256(text),size:bytes(text).byteLength});f.entries.push({path:'LICENSE',text})
 f.source.files[0]!.size=null
 const files=await downloadGithubCatalogSkill(f.source,f.fallbackHttp)
 assert.deepEqual(files.map(file=>file.path),['LICENSE','SKILL.md','licenses/upstream/LICENSE','references/guide.md'])
 assert.deepEqual(files.find(file=>file.path==='licenses/upstream/LICENSE')!.bytes,bytes(text))
 const unicode=rateFallbackFixture(),guide=unicode.source.files.find(file=>file.path==='references/guide.md')!
 guide.path='references/café.md';unicode.entries.at(-1)!.path=unicode.source.path+'/references/cafe\u0301.md'
 assert.ok((await downloadGithubCatalogSkill(unicode.source,unicode.fallbackHttp)).some(file=>file.path==='references/café.md'))
 unicode.entries.push({path:unicode.source.path+'/references/café.md',text:unicode.texts['references/guide.md']!})
 await assert.rejects(downloadGithubCatalogSkill(unicode.source,unicode.fallbackHttp),/重复|冲突/)
})

test('仅支持Git官方默认ZIP模式和同响应规范更名，固定commit/root/header不一致或歧义均拒绝',async()=>{
 // Git 2.50.1 的真实 100644/100755/120000 树归档复核：普通文件 0/0，执行与链接 0x0317/Unix attrs。
 // 规则来源：git/git archive-zip.c write_zip_entry；这不是把任意缺失模式当普通文件。
 const gitDefault=()=>{const f=rateFallbackFixture();for(const entry of f.entries){entry.creatorVersion=0;entry.externalAttrs=entry.path===''||entry.path.endsWith('/')?16:0}return f}
 const renamed=gitDefault();renamed.options.root='renamed-skills-'+renamed.source.commit;renamed.archive.headers={'content-disposition':`attachment; filename=${renamed.options.root}.zip`}
 assert.equal((await downloadGithubCatalogSkill(renamed.source,renamed.fallbackHttp)).length,3);assert.equal(renamed.seen.length,2)
 const direct=gitDefault();assert.equal((await downloadGithubCatalogSkill(direct.source,direct.fallbackHttp)).length,3)
 for(const disposition of [
  `attachment; filename=renamed-skills-${'b'.repeat(40)}.zip`,
  `attachment; filename=renamed-skills-${'b'.repeat(7)}.zip`,
  `attachment; filename=renamed-skills-${direct.source.commit}.zip; filename=other.zip`,
  `attachment; filename*=UTF-8''renamed-skills-${direct.source.commit}.zip`,
  `attachment; filename=../renamed-skills-${direct.source.commit}.zip`,
  `attachment; filename=renamed%2fskills-${direct.source.commit}.zip`,
  `attachment; filename=renamed-skills-${direct.source.commit}.zip.extra`,
  `inline; filename=renamed-skills-${direct.source.commit}.zip`,
  `attachment; filename=renamed-skills-${direct.source.commit}.zip`,
 ]){const f=gitDefault();f.archive.headers={'content-disposition':disposition};await assert.rejects(downloadGithubCatalogSkill(f.source,f.fallbackHttp),/归档/);assert.equal(f.seen.length,2)}
 for(const attrs of [1,16,32,0x81a40000]){const f=gitDefault();f.entries.at(-1)!.externalAttrs=attrs;await assert.rejects(downloadGithubCatalogSkill(f.source,f.fallbackHttp),/模式|100644/)}
 const unknownCreator=gitDefault();unknownCreator.entries.at(-1)!.creatorVersion=20;await assert.rejects(downloadGithubCatalogSkill(unknownCreator.source,unknownCreator.fallbackHttp),/模式/)
 for(const mode of [0x81ed,0xa1ff]){const f=gitDefault();f.entries.at(-1)!.creatorVersion=0x0317;f.entries.at(-1)!.externalAttrs=(mode<<16)>>>0;await assert.rejects(downloadGithubCatalogSkill(f.source,f.fallbackHttp),/100644|符号链接/)}
})

test('限额备用归档与原目录遍历共用120秒预算，过期不开始备用请求也不返回已读文件',async t=>{
 let clock=0;t.mock.method(Date,'now',()=>clock)
 for(const expiredBefore of [true,false]){
  clock=0;const f=rateFallbackFixture()
  const http:GithubHttpPort={request:async request=>{const reply=await f.fallbackHttp.request(request);clock=new URL(request.url).hostname==='api.github.com'?(expiredBefore?120001:119000):120001;return reply}}
  await assert.rejects(downloadGithubCatalogSkill(f.source,http),/120 秒/)
  assert.equal(f.seen.length,expiredBefore?1:2)
 }
})

test('目录只下载已审查文件，固定提交、逐文件 blob/大小与许可原字节，剥离文件不请求',async()=>{
 const f=fixture(),files=await downloadGithubCatalogSkill(f.source,f.http)
 assert.deepEqual(files.map(file=>file.path),['LICENSE','SKILL.md','references/guide.md'])
 for(const file of files)assert.deepEqual(file.bytes,bytes(f.texts[file.path]!))
 assert.equal(f.calls.length,7)
 assert.ok(f.calls.every(call=>call.redirect==='manual'))
 assert.ok(rawCalls(f).every(call=>call.url.includes(f.source.commit)))
 assert.ok(f.calls.every(call=>!call.url.includes('scripts/run.py')&&!call.url.endsWith('/link')))
 assert.equal(f.calls[0]!.url,'https://api.github.com/repos/example/skills/git/trees/'+f.source.commit)
 assert.deepEqual(treeCalls(f).map(call=>call.url.split('/').at(-1)),[f.source.commit,treeSha('skills'),treeSha('skills/notes'),treeSha('skills/notes/references')])
})

test('GitHub 行为锚点：按 commit 请求根树时回包 sha 等于 commit，已审路径只验格式即可通过',async()=>{
 const f=fixture(),seen:string[]=[]
 const http:GithubHttpPort={request:async request=>{const reply=await f.http.request(request);if(!request.url.endsWith('/git/trees/'+f.source.commit))return reply;let text='';for await(const chunk of reply.body)text+=new TextDecoder().decode(chunk);seen.push(JSON.parse(text).sha);return {...reply,body:(async function*(){yield bytes(text)})()}}}
 assert.equal((await downloadGithubCatalogSkill(f.source,http)).length,3)
 assert.deepEqual(seen,[f.source.commit])
})

test('逐文件核对目录钉的 sha256：blob 与大小都对但 sha256 不符也拒绝（source-unavailable），sha256 格式非法按声明无效拒绝',async()=>{
 const f=fixture();f.source.files[1]!.sha256='0'.repeat(64)
 await assert.rejects(downloadGithubCatalogSkill(f.source,f.http),(error:any)=>error?.code==='teloa/source-unavailable'&&/sha256/.test(error.message)&&error.message.includes(f.source.files[1]!.path))
 for(const value of [undefined,'A'.repeat(64),'0'.repeat(63),null]){
  const g=fixture();(g.source.files[0] as any).sha256=value
  await assert.rejects(downloadGithubCatalogSkill(g.source,g.http),(error:any)=>error?.code==='teloa/invalid-input')
  assert.equal(g.calls.length,0,'声明无效时不发请求')
 }
})

test('声明 size 为 null 时仍根据固定 Git 树核对实际大小；文件顺序不影响结果',async()=>{
 const f=fixture();f.source.files.reverse();f.source.files[0]!.size=null
 assert.equal((await downloadGithubCatalogSkill(f.source,f.http)).length,3)
})

test('目录外 LICENSE/NOTICE 按同一提交核对原始路径和字节，保留目录内许可证且不下载无关文件',async()=>{
 const f=fixture(),legal={'LICENSE':'Repository license','skills/NOTICE.txt':'Repository notice'}
 for(const [repositoryPath,text] of Object.entries(legal)){
  f.source.files.push({path:'licenses/upstream/'+repositoryPath,repositoryPath,gitBlob:blob(text),sha256:sha256(text),size:bytes(text).byteLength})
  f.tree.tree.push({path:repositoryPath,type:'blob',mode:'100644',sha:blob(text),size:bytes(text).byteLength})
  f.overrides.set(repositoryPath,{body:text})
 }
 const files=await downloadGithubCatalogSkill(f.source,f.http)
 assert.equal(files.length,5)
 assert.equal(new TextDecoder().decode(files.find(file=>file.path==='LICENSE')!.bytes),'MIT License')
 for(const [path,text] of Object.entries(legal))assert.equal(new TextDecoder().decode(files.find(file=>file.path==='licenses/upstream/'+path)!.bytes),text)
 assert.ok(f.calls.some(call=>call.url.endsWith('/'+f.source.commit+'/LICENSE')))
 assert.equal(f.calls.length,9)
 f.tree.tree.at(-1)!.mode='120000';f.calls.length=0
 await assert.rejects(downloadGithubCatalogSkill(f.source,f.http),{code:'teloa/source-unavailable'})
 assert.equal(rawCalls(f).length,0)
})

test('许可映射不能借根文件改写入口或跨目录导入，联网前即拒绝',async()=>{
 for(const file of [
  {path:'SKILL.md',repositoryPath:'LICENSE'},
  {path:'licenses/upstream/other/LICENSE',repositoryPath:'other/LICENSE'},
  {path:'licenses/upstream/README.md',repositoryPath:'README.md'},
  {path:'licenses/upstream/THIRD_PARTY_NOTICES.md.js',repositoryPath:'THIRD_PARTY_NOTICES.md.js'},
  {path:'licenses/upstream/other/THIRD_PARTY_NOTICES.md',repositoryPath:'other/THIRD_PARTY_NOTICES.md'},
  {path:'licenses/upstream/../LICENSE',repositoryPath:'../LICENSE'},
 ]){const f=fixture();f.source.files.push({...file,gitBlob:'c'.repeat(40),sha256:'c'.repeat(64),size:1});await assert.rejects(downloadGithubCatalogSkill(f.source,f.http));assert.equal(f.calls.length,0)}
})

test('根 THIRD_PARTY_NOTICES.md 按固定 blob 下载，缺失、篡改和执行位均拒绝',async()=>{
 for(const mode of ['ok','missing','tampered','executable']){
  const f=fixture(),repositoryPath='THIRD_PARTY_NOTICES.md',text='Third-party notices\nMIT License\n'
  f.source.files.push({path:'licenses/upstream/'+repositoryPath,repositoryPath,gitBlob:blob(text),sha256:sha256(text),size:bytes(text).byteLength})
  if(mode!=='missing')f.tree.tree.push({path:repositoryPath,type:'blob',mode:mode==='executable'?'100755':'100644',sha:blob(text),size:bytes(text).byteLength})
  f.overrides.set(repositoryPath,{body:mode==='tampered'?text+'changed':text})
  if(mode==='ok'){
   const files=await downloadGithubCatalogSkill(f.source,f.http)
   assert.deepEqual(files.find(file=>file.path==='licenses/upstream/'+repositoryPath)?.bytes,bytes(text))
   assert.ok(f.calls.some(call=>call.url==='https://raw.githubusercontent.com/example/skills/'+f.source.commit+'/'+repositoryPath))
  }else{
   await assert.rejects(downloadGithubCatalogSkill(f.source,f.http),{code:'teloa/source-unavailable'})
   if(mode!=='tampered')assert.equal(rawCalls(f).length,0)
  }
 }
})

test('未审查的 Lobster 文件不下载，声明安装时在联网前拒绝',async()=>{
 const f=fixture(),workflow={path:'examples/inbox-triage.lobster',gitBlob:'d'.repeat(40),sha256:'d'.repeat(64),size:100}
 f.tree.tree.push({path:f.source.path+'/'+workflow.path,type:'blob',mode:'100644',sha:workflow.gitBlob,size:workflow.size})
 assert.equal((await downloadGithubCatalogSkill(f.source,f.http)).length,3)
 assert.ok(f.calls.every(call=>!call.url.endsWith('.lobster')))
 for(const path of [workflow.path,'examples/PR.LOBSTER']){
  f.source.files=[...fixture().source.files,{...workflow,path}];f.calls.length=0
  await assert.rejects(downloadGithubCatalogSkill(f.source,f.http),{code:'teloa/invalid-input'})
  assert.equal(f.calls.length,0)
 }
})

// 每例同时断言原因文案：标签与实际命中的拒绝路径必须一致，文案要指明出问题的文件或阶段。
for(const [label,change,reason] of [
 ['缺失文件',(f:ReturnType<typeof fixture>)=>{f.tree.tree.pop();f.tree.tree.shift()},/缺少目录声明的文件：skills\/notes\/SKILL\.md（skills\/notes\/SKILL\.md 不存在）/],
 ['摘要与清单不同',(f:ReturnType<typeof fixture>)=>{f.tree.tree[0]!.sha='c'.repeat(40)},/文件 skills\/notes\/SKILL\.md 与已审查目录清单不一致（模式 100644、blob cccccccccccc/],
 ['大小与清单不同',(f:ReturnType<typeof fixture>)=>{f.tree.tree[0]!.size=1},/文件 skills\/notes\/SKILL\.md 与已审查目录清单不一致（.*大小 1）/],
 ['执行位',(f:ReturnType<typeof fixture>)=>{f.tree.tree[0]!.mode='100755'},/文件 skills\/notes\/SKILL\.md 与已审查目录清单不一致（模式 100755/],
 ['符号链接',(f:ReturnType<typeof fixture>)=>{f.tree.tree[0]!.mode='120000'},/符号链接（skills\/notes\/SKILL\.md）/],
 ['重复文件',(f:ReturnType<typeof fixture>)=>{f.tree.tree.push({...f.tree.tree[0]!})},/skills\/notes 下有多个与 SKILL\.md 同名或大小写\/NFC 等价的条目/],
 ['截断 Git 树',(f:ReturnType<typeof fixture>)=>{f.tree.truncated=true},/根树（commit aaaaaaaaaaaa） 非递归单层列表被截断/],
] as const)test('目录 Git 树'+label+'时在下载文件前拒绝，并说明原因',async()=>{
 const f=fixture();change(f)
 await assert.rejects(downloadGithubCatalogSkill(f.source,f.http),{code:'teloa/source-unavailable',message:reason})
 assert.equal(rawCalls(f).length,0)
})

test('非 200 回包按阶段、HTTP 状态与路径定位；403/429 且剩余配额为 0 视为限流并给出重置时间',async()=>{
 const missing=fixture();missing.overrides.set('tree:'+treeSha('skills'),{status:404,body:'{}'})
 await assert.rejects(downloadGithubCatalogSkill(missing.source,missing.http),{code:'teloa/source-unavailable',message:/GitHub 目录树 skills 请求失败（HTTP 404）：\/repos\/example\/skills\/git\/trees\//})
 const reset=Math.floor(Date.now()/1000)+1800,limited=fixture()
 limited.overrides.set('tree:'+limited.source.commit,{status:403,headers:{'X-RateLimit-Remaining':'0','X-RateLimit-Reset':String(reset)},body:'rate limit exceeded'})
 await assert.rejects(downloadGithubCatalogSkill(limited.source,limited.http),{code:'teloa/source-unavailable',message:new RegExp('GitHub API 限流（HTTP 403，剩余配额 0），约 (29|30) 分钟后（'+new Date(reset*1000).toISOString().replace(/[.]/g,'\\.')+'）重置；根树')})
 const retry=fixture();retry.overrides.set('tree:'+retry.source.commit,{status:429,headers:{'retry-after':'120'},body:''})
 await assert.rejects(downloadGithubCatalogSkill(retry.source,retry.http),{message:/限流（HTTP 429，剩余配额 未知），约 2 分钟后/})
 const forbidden=fixture();forbidden.overrides.set('tree:'+forbidden.source.commit,{status:403,headers:{'x-ratelimit-remaining':'42'},body:''})
 await assert.rejects(downloadGithubCatalogSkill(forbidden.source,forbidden.http),{message:/^GitHub 根树（commit aaaaaaaaaaaa） 请求失败（HTTP 403）：/})
 const raw=fixture();raw.overrides.set(raw.source.path+'/SKILL.md',{status:500,body:''})
 await assert.rejects(downloadGithubCatalogSkill(raw.source,raw.http),{message:/GitHub 文件 skills\/notes\/SKILL\.md 请求失败（HTTP 500）：\/example\/skills\/a{40}\/skills\/notes\/SKILL\.md/})
 for(const f of [missing,limited,retry,forbidden])assert.equal(rawCalls(f).length,0)
})

// 上游可控的名字进入文案前必须把 DEL、C1、行/段分隔符与双向控制符转成可见 \uXXXX（JSON.stringify 本身不转义它们）。
const invisible=/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/
test('上游名字含 DEL、C1、U+2028/2029 或双向控制符：目录声明在联网前按不安全路径拒绝，文案不回显不可见字符',async()=>{
 // 目录路径契约（L1）先拒 C1、分隔符与双向控制符，不再走到树/raw 阶段；DEL 与超长仍由 finalPath 以可见 \uXXXX 文案拒绝
 for(const char of ['\u0085','\u009b','\u2028','\u2029','\u202e']){
  const f=fixture(),name='a'+char+'b.md'
  f.source.files.push({path:name,gitBlob:blob('x'),sha256:sha256('x'),size:1});f.tree.tree.push({path:f.source.path+'/'+name,type:'blob',mode:'120000',sha:blob('x'),size:1})
  const error=await downloadGithubCatalogSkill(f.source,f.http).then(()=>undefined,(reason:Error)=>reason)
  assert.ok(error instanceof Error&&(error as any).code==='teloa/invalid-input',JSON.stringify(char));assert.ok(!invisible.test(error.message),JSON.stringify(char))
  assert.equal(f.calls.length,0)
 }
 const del=fixture();del.source.files[1]!.path='a\u007fb.md'
 await assert.rejects(downloadGithubCatalogSkill(del.source,del.http),(error:Error)=>error.message.includes('不安全路径："a\\u007fb.md"')&&!invisible.test(error.message))
 const long=fixture();long.source.files[1]!.path='a\u2028'+'x'.repeat(600)+'.md'
 await assert.rejects(downloadGithubCatalogSkill(long.source,long.http),(error:Error)=>error.message.includes('超过 500 字符："a\\u2028x')&&error.message.endsWith('"…')&&!invisible.test(error.message))
 const plain=fixture();plain.source.files[1]!.path='a'+'x'.repeat(260)+'\u0000.md'
 await assert.rejects(downloadGithubCatalogSkill(plain.source,plain.http),(error:Error)=>/不安全路径："ax{199}"…$/.test(error.message))
 for(const f of [del,long,plain])assert.equal(f.calls.length,0)
})

test('raw 下载失败与字节不符的文案里，上游文件路径照常定位',async()=>{
 for(const [change,reason] of [[{status:500,body:''},'GitHub 文件 skills/notes/a b.md 请求失败（HTTP 500）'],[{body:'tampered'},'上游文件 skills/notes/a b.md 与固定提交不一致']] as const){
  const f=fixture(),name='a b.md'
  f.source.files.push({path:name,gitBlob:blob('x'),sha256:sha256('x'),size:1});f.tree.tree.push({path:f.source.path+'/'+name,type:'blob',mode:'100644',sha:blob('x'),size:1});f.overrides.set(f.source.path+'/'+name,change)
  await assert.rejects(downloadGithubCatalogSkill(f.source,f.http),(error:Error)=>error.message.includes(reason)&&!invisible.test(error.message))
 }
})

test('响应字节篡改、重定向及超限响应失败，不返回部分文件',async()=>{
 for(const change of [{body:'tampered'}, {status:302}, {headers:{'content-length':String(2*1024*1024+1)}}]){
  const f=fixture();f.overrides.set(f.source.path+'/SKILL.md',change)
  await assert.rejects(downloadGithubCatalogSkill(f.source,f.http),{code:'teloa/source-unavailable'})
 }
})

test('危险路径、脚本、隐藏文件、无入口、重复路径和非固定提交在联网前拒绝',async()=>{
 for(const change of [
  (s:MarketCatalogUpstreamGithub)=>{s.commit='main'},
  (s:MarketCatalogUpstreamGithub)=>{s.repository.owner='evil/owner'},
  (s:MarketCatalogUpstreamGithub)=>{s.repository.host='evil.example' as 'github.com'},
  (s:MarketCatalogUpstreamGithub)=>{s.path='../other'},
  (s:MarketCatalogUpstreamGithub)=>{s.files[1]!.path='../LICENSE'},
  (s:MarketCatalogUpstreamGithub)=>{s.files[1]!.path='scripts/guide.md'},
  (s:MarketCatalogUpstreamGithub)=>{s.files[1]!.path='.hidden'},
  (s:MarketCatalogUpstreamGithub)=>{s.files[1]!.path='tool.py'},
  (s:MarketCatalogUpstreamGithub)=>{s.files.shift()},
  (s:MarketCatalogUpstreamGithub)=>{s.files.push({...s.files[0]!})},
  (s:MarketCatalogUpstreamGithub)=>{s.files[1]!.size=3*1024*1024},
 ]){
  const f=fixture();change(f.source)
  await assert.rejects(downloadGithubCatalogSkill(f.source,f.http))
  assert.equal(f.calls.length,0)
 }
})

test('递归整树超过 8 MiB 的五文件清单只读必要的四棵树，不进入无关子树',async()=>{
 const f=fixture()
 for(const name of ['LICENSE','THIRD_PARTY_NOTICES.md']){
  const text='Repository '+name
  f.source.files.push({path:'licenses/upstream/'+name,repositoryPath:name,gitBlob:blob(text),sha256:sha256(text),size:bytes(text).byteLength})
  f.tree.tree.push({path:name,type:'blob',mode:'100644',sha:blob(text),size:bytes(text).byteLength})
  f.overrides.set(name,{body:text})
 }
 for(let index=f.tree.tree.length;index<52327;index++)f.tree.tree.push({path:'unrelated/deep/'+index+'.md',type:'blob',mode:'100644',sha:'b'.repeat(40),size:1,...{url:'https://api.github.com/repos/example/skills/git/blobs/'+'b'.repeat(40)}})
 assert.ok(bytes(JSON.stringify(f.tree)).byteLength>8*1024*1024)
 const files=await downloadGithubCatalogSkill(f.source,f.http)
 assert.equal(files.length,5);assert.equal(treeCalls(f).length,4);assert.equal(rawCalls(f).length,5)
 assert.ok(f.calls.every(call=>!call.url.includes(treeSha('unrelated'))&&!call.url.includes('recursive')))
})

// 原因文案与标签对应：回包里被改名的 skills（多级路径、越界、反斜线、编码、空名）从不被查找或进入 URL，命中的是「祖先缺失」路径。
const notFound=/缺少目录声明的文件：skills\/notes\/SKILL\.md（skills 不存在）。$/
for(const [label,change,reason] of [
 ['祖先链接',(r:TreeReply)=>{r.tree[0]!.type='blob';r.tree[0]!.mode='120000'},/路径 skills 不是普通目录树（符号链接）/],
 ['祖先子模块',(r:TreeReply)=>{r.tree[0]!.type='commit';r.tree[0]!.mode='160000'},/路径 skills 不是普通目录树（子模块）/],
 ['祖先普通文件',(r:TreeReply)=>{r.tree[0]!.type='blob';r.tree[0]!.mode='100644'},/路径 skills 不是普通目录树（文件）/],
 ['祖先类型模式矛盾',(r:TreeReply)=>{r.tree[0]!.mode='100644'},/^GitHub 子目录 skills 声明为树但模式或 sha 非法。$/],
 ['祖先 SHA 非法',(r:TreeReply)=>{r.tree[0]!.sha='main'},/^GitHub 子目录 skills 声明为树但模式或 sha 非法。$/],
 ['祖先未知类型',(r:TreeReply)=>{r.tree[0]!.type='odd\u0085type'},/路径 skills 不是普通目录树（未知类型 "odd\\u0085type"）/],
 ['祖先环路',(r:TreeReply)=>{r.tree[0]!.sha=r.sha},/目录 skills 的树 sha 与其祖先重复（环路）/],
 ['祖先缺失',(r:TreeReply)=>{r.tree=[]},notFound],
 ['祖先大小写不符',(r:TreeReply)=>{r.tree[0]!.path='Skills'},/缺少目录声明的文件：skills\/notes\/SKILL\.md（skills 不存在；仓库中有大小写或 Unicode 规范化不同的 Skills，路径区分大小写/],
 ['大小写冲突',(r:TreeReply)=>{r.tree.push({...r.tree[0]!,path:'SKILLS'})},/根 下有多个与 skills 同名或大小写\/NFC 等价的条目/],
 ['同名重复',(r:TreeReply)=>{r.tree.push({...r.tree[0]!})},/根 下有多个与 skills 同名或大小写\/NFC 等价的条目/],
 ['回包内含多级路径',(r:TreeReply)=>{r.tree[0]!.path='skills/notes'},notFound],
 ['回包越界路径',(r:TreeReply)=>{r.tree[0]!.path='..'},notFound],
 ['回包反斜线',(r:TreeReply)=>{r.tree[0]!.path='bad\\path'},notFound],
 ['回包编码路径',(r:TreeReply)=>{r.tree[0]!.path='%2e%2e'},notFound],
 ['回包空名',(r:TreeReply)=>{r.tree[0]!.path=''},notFound],
 ['根树 SHA 非法',(r:TreeReply)=>{r.sha='not-a-tree'},/根树（commit aaaaaaaaaaaa） 回包格式无效/],
] as const)test('逐级树拒绝'+label+'，不下载 raw，并说明原因',async()=>{
 const f=fixture();f.treeChanges.set('',change)
 await assert.rejects(downloadGithubCatalogSkill(f.source,f.http),{code:'teloa/source-unavailable',message:reason})
 assert.equal(f.calls.length,1);assert.equal(rawCalls(f).length,0)
})

test('子树回包必须匹配父树 SHA 且完整，不能用错误树或截断回包继续',async()=>{
 for(const [change,reason] of [[(r:TreeReply)=>{r.sha='e'.repeat(40)},/目录树 skills 回包 sha e{40} 与预期 [0-9a-f]{40} 不一致/],[(r:TreeReply)=>{r.truncated=true},/目录树 skills 非递归单层列表被截断/],[(r:TreeReply)=>{delete (r as Partial<TreeReply>).truncated},/目录树 skills 回包格式无效/]] as const){
  const f=fixture();f.treeChanges.set('skills',change)
  await assert.rejects(downloadGithubCatalogSkill(f.source,f.http),{code:'teloa/source-unavailable',message:reason})
  assert.equal(f.calls.length,2);assert.equal(rawCalls(f).length,0)
 }
 for(const body of ['{','{}','{"sha":"'+treeSha('')+'","truncated":false,"tree":[null]}']){
  const f=fixture();f.overrides.set('tree:'+f.source.commit,{body})
  await assert.rejects(downloadGithubCatalogSkill(f.source,f.http),{code:'teloa/source-unavailable'})
  assert.equal(f.calls.length,1)
 }
})

test('末端必须为普通 100644 blob，合法目录、子模块及非法 blob 元数据都拒绝',async()=>{
 for(const change of [{mode:'040000',type:'tree'},{mode:'160000',type:'commit'},{type:'tree'},{sha:'bad'},{size:-1},{size:1.5},{size:null}]){
  const f=fixture();Object.assign(f.tree.tree[0]!,change)
  await assert.rejects(downloadGithubCatalogSkill(f.source,f.http),{code:'teloa/source-unavailable'})
  assert.equal(rawCalls(f).length,0)
 }
})

test('NFD 目录与文件按 NFC 选择，raw 仍使用逐级树中的原始路径',async()=>{
 const f=fixture(),rawDirectory='skills/cafe\u0301',rawName='re\u0301f.md',text='# Unicode'
 f.tree.tree=f.tree.tree.map(item=>({...item,path:item.path.replace(f.source.path,rawDirectory)}))
 f.source.path=rawDirectory.normalize('NFC')
 f.source.files.push({path:rawName.normalize('NFC'),gitBlob:blob(text),sha256:sha256(text),size:bytes(text).byteLength})
 f.tree.tree.push({path:rawDirectory+'/'+rawName,type:'blob',mode:'100644',sha:blob(text),size:bytes(text).byteLength})
 for(const file of f.source.files)f.overrides.set(rawDirectory+'/'+(file.path===rawName.normalize('NFC')?rawName:file.path),{body:file.path===rawName.normalize('NFC')?text:f.texts[file.path]!})
 const files=await downloadGithubCatalogSkill(f.source,f.http)
 assert.equal(files.length,4)
 assert.ok(f.calls.some(call=>call.url.endsWith('/skills/'+encodeURIComponent('cafe\u0301')+'/'+encodeURIComponent(rawName))))
})

test('多个声明目录引用同一树 SHA 时去重读取，raw 仍保持各自的声明路径',async()=>{
 const f=fixture(),text=f.texts['references/guide.md']!
 f.source.files.push({path:'copies/guide.md',gitBlob:blob(text),sha256:sha256(text),size:bytes(text).byteLength})
 f.tree.tree.push({path:f.source.path+'/copies/guide.md',type:'blob',mode:'100644',sha:blob(text),size:bytes(text).byteLength})
 f.overrides.set(f.source.path+'/copies/guide.md',{body:text})
 f.treeChanges.set(f.source.path,r=>{r.tree.find(item=>item.path==='copies')!.sha=treeSha(f.source.path+'/references')})
 const files=await downloadGithubCatalogSkill(f.source,f.http)
 assert.equal(files.length,4);assert.equal(treeCalls(f).length,4)
 assert.equal(new Set(treeCalls(f).map(call=>call.url)).size,4)
 assert.equal(rawCalls(f).length,4)
})

test('单个树响应至多 8 MiB，响应头和实际流均受限',async()=>{
 for(const headers of [false,true]){
  const f=fixture(),padding='x'.repeat(8*1024*1024)
  f.treeChanges.set('skills',r=>{Object.assign(r,{padding})})
  const http:GithubHttpPort={request:async request=>{
   const reply=await f.http.request(request)
   return headers&&request.url.endsWith(treeSha('skills'))?{...reply,headers:{'content-length':String(padding.length+1)}}:reply
  }}
  await assert.rejects(downloadGithubCatalogSkill(f.source,http),{code:'teloa/source-unavailable'})
  assert.equal(treeCalls(f).length,2);assert.equal(rawCalls(f).length,0)
 }
})

test('树遍历累计 32 MiB：每棵都未超单次上限时仍按剩余预算截停',async()=>{
 const f=fixture(),padding='x'.repeat(7*1024*1024),text='# Extra'
 f.source.files.push({path:'extra/more.md',gitBlob:blob(text),sha256:sha256(text),size:bytes(text).byteLength})
 f.tree.tree.push({path:f.source.path+'/extra/more.md',type:'blob',mode:'100644',sha:blob(text),size:bytes(text).byteLength})
 for(const path of ['','skills','skills/notes','skills/notes/references','skills/notes/extra'])f.treeChanges.set(path,r=>{Object.assign(r,{padding})})
 await assert.rejects(downloadGithubCatalogSkill(f.source,f.http),{code:'teloa/source-unavailable',message:/目录树 skills\/notes\/extra（累计 32 MiB 预算仅剩 \d+ 字节） 响应读取失败或超过 \d+ 字节上限/})
 assert.equal(treeCalls(f).length,5);assert.equal(rawCalls(f).length,0)
})

test('沿途兄弟项的非法名、同名与大小写冲突不读取也不影响安装；只有经过的路径受约束',async()=>{
 const f=fixture()
 f.treeChanges.set('',r=>{r.tree.push({path:'bad#name',type:'blob',mode:'100644',sha:'b'.repeat(40),size:1},{path:'README.md',type:'blob',mode:'100644',sha:'b'.repeat(40),size:1},{path:'readme.md',type:'blob',mode:'100644',sha:'b'.repeat(40),size:1},{path:'x:y',type:'tree',mode:'040000',sha:'e'.repeat(40)},{path:'caf\u00e9',type:'blob',mode:'100644',sha:'b'.repeat(40),size:1},{path:'cafe\u0301',type:'blob',mode:'120000',sha:'b'.repeat(40),size:1})})
 assert.equal((await downloadGithubCatalogSkill(f.source,f.http)).length,3)
 assert.equal(treeCalls(f).length,4)
})

test('经过的目录与 NFC 等价目录并存时拒绝，避免歧义',async()=>{
 const f=fixture(),rawDirectory='skills/cafe\u0301'
 f.tree.tree=f.tree.tree.map(item=>({...item,path:item.path.replace(f.source.path,rawDirectory)}))
 f.source.path=rawDirectory.normalize('NFC')
 f.treeChanges.set('skills',r=>{r.tree.push({...r.tree[0]!,path:'caf\u00e9'})})
 await assert.rejects(downloadGithubCatalogSkill(f.source,f.http),{code:'teloa/source-unavailable'})
 assert.equal(rawCalls(f).length,0)
})

test('最多读取 1000 棵不同树，路径深且分散的 500 文件清单不能无限请求',async()=>{
 const f=fixture(),text='# Shared'
 f.source.files=f.source.files.slice(0,1);f.tree.tree=f.tree.tree.slice(0,1)
 for(let index=0;index<499;index++){
  const path='group'+index+'/nested/guide.md'
  f.source.files.push({path,gitBlob:blob(text),sha256:sha256(text),size:bytes(text).byteLength})
  f.tree.tree.push({path:f.source.path+'/'+path,type:'blob',mode:'100644',sha:blob(text),size:bytes(text).byteLength})
 }
 await assert.rejects(downloadGithubCatalogSkill(f.source,f.http),/读取已达 1000 棵上限（目录树 skills\/notes\/group\d+\/nested）/)
 assert.equal(treeCalls(f).length,1000);assert.equal(rawCalls(f).length,0)
})

test('声明 size 未知时仍执行单文件 2 MiB、总文件 20 MiB 和 500 文件限制',async()=>{
 for(const count of [1,11]){
  const f=fixture();f.source.files=[];f.tree.tree=[]
  for(let index=0;index<count;index++){
   const path=index===0?'SKILL.md':'f'+index+'.md',size=2*1024*1024+(count===1?1:0)
   f.source.files.push({path,gitBlob:blob('x'),sha256:sha256('x'),size:null})
   f.tree.tree.push({path:f.source.path+'/'+path,type:'blob',mode:'100644',sha:blob('x'),size})
  }
  await assert.rejects(downloadGithubCatalogSkill(f.source,f.http),{code:'teloa/source-unavailable'})
  assert.equal(rawCalls(f).length,0)
 }
 const f=fixture();f.source.files=Array.from({length:501},()=>({...f.source.files[0]!}))
 await assert.rejects(downloadGithubCatalogSkill(f.source,f.http),{code:'teloa/invalid-input'})
 assert.equal(f.calls.length,0)
})

test('120 秒预算覆盖全部树遍历，且不得在 raw 阶段重新计时',async t=>{
 let clock=0;t.mock.method(Date,'now',()=>clock)
 for(const phase of ['tree','raw']){
  clock=0;const f=fixture()
  const http:GithubHttpPort={request:async request=>{
   const reply=await f.http.request(request)
   clock+=new URL(request.url).hostname==='api.github.com'?(phase==='tree'?31000:29750):1001
   return reply
  }}
  await assert.rejects(downloadGithubCatalogSkill(f.source,http),/120 秒/)
  assert.equal(treeCalls(f).length,4)
  assert.equal(rawCalls(f).length,phase==='tree'?0:3)
 }
})

test('单次树请求的十秒截止通过 HTTP signal 中止请求',async t=>{
 t.mock.timers.enable({apis:['setTimeout']})
 const f=fixture();let started!:()=>void
 const entered=new Promise<void>(resolve=>{started=resolve})
 const work=downloadGithubCatalogSkill(f.source,{request:request=>new Promise((_resolve,reject)=>{
  request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true});started()
 })})
 const rejected=assert.rejects(work,{code:'teloa/source-unavailable'})
 await entered;t.mock.timers.tick(10000);await rejected
})


async function reviewedPlugin(f:ReturnType<typeof fixture>){
 const index=JSON.parse(await readFile(new URL('../src/market/official-upstream-index.json',import.meta.url),'utf8'))
 const original=index.entries.find((entry:{id:string})=>entry.id==='cursor.remotion-remotion-maps')
 return {...original,id:'cursor.notes',skill:{...original.skill,name:'notes'},upstream:f.source,license:{spdx:'MIT',files:['LICENSE']}}
}
function supportingFile(f:ReturnType<typeof fixture>,path:string,mode='100644'){
 const text='export const value = 1;\n'
 f.texts[path]=text
 const row={path,gitBlob:blob(text),sha256:sha256(text),size:bytes(text).byteLength}
 f.source.files.push(row)
 f.tree.tree.push({path:f.source.path+'/'+path,type:'blob',mode,sha:row.gitBlob,size:row.size})
 return row
}

test('Teloa 已审原插件的辅助代码按固定清单下载，不运行，不带入未声明脚本或链接',async()=>{
 const f=fixture();supportingFile(f,'scripts/prepare.mjs')
 const entry=await reviewedPlugin(f),files=await downloadGithubCatalogSkill(entry,f.http)
 assert.equal(files.length,4);assert.deepEqual(files.find(row=>row.path==='scripts/prepare.mjs')!.bytes,bytes(f.texts['scripts/prepare.mjs']!))
 assert.equal(f.calls.some(call=>call.url.endsWith('scripts/run.py')||call.url.endsWith('/link')),false)
})

test('允许原插件辅助代码不扩展普通来源；未审条目、隐藏配置和二进制仍在联网前拒绝',async()=>{
 for(const mode of ['plain','unreviewed','hidden','binary']){
  const f=fixture();supportingFile(f,mode==='hidden'?'.env':mode==='binary'?'scripts/run.exe':'scripts/prepare.mjs')
  const entry=await reviewedPlugin(f);if(mode==='unreviewed')entry.review.reviewer='Other'
  await assert.rejects(downloadGithubCatalogSkill(mode==='plain'?f.source:entry,f.http),{code:'teloa/invalid-input'})
  assert.equal(f.calls.length,0,mode)
 }
})

test('原插件辅助文件也必须核对摘要和普通文件模式，不能借插件身份绕过原校验',async()=>{
 const f=fixture();supportingFile(f,'assets/data.ts');const entry=await reviewedPlugin(f)
 f.source.files.at(-1)!.sha256='e'.repeat(64)
 await assert.rejects(downloadGithubCatalogSkill(entry,f.http),error=>error instanceof Error&&/sha256/.test(error.message))
 const executable=fixture();supportingFile(executable,'assets/code.ts','100755')
 await assert.rejects(downloadGithubCatalogSkill(await reviewedPlugin(executable),executable.http),{code:'teloa/source-unavailable'})
})
