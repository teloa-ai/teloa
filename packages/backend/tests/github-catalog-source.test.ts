import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
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
