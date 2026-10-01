import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {deflateRawSync} from 'node:zlib'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {GithubSourceService,initializeGithubSources,type GithubHttpPort,type GithubHttpRequest,type GithubHttpResponse} from '../src/market/github-source.ts'
import {useLocalContainerRuntime} from './testcontainers-env.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const commit='0123456789abcdef0123456789abcdef01234567',ownerId=()=>randomUUID(),now=()=>new Date('2026-09-12T08:00:00.000Z').toISOString()
const bytes=(value:string)=>new TextEncoder().encode(value),stream=async function*(value:Uint8Array){for(let at=0;at<value.length;at+=7)yield value.slice(at,at+7)}
const response=(status:number,body:Uint8Array,headers:Record<string,string|undefined>={}):GithubHttpResponse=>({status,headers,body:stream(body)})
const json=(value:unknown,status=200)=>response(status,bytes(JSON.stringify(value)),{'content-type':'application/json'})
// commit 解析用 application/vnd.github.sha 只回 40 字节；子目录模式再读 commit 对象取根树 sha 与根树回包交叉核对。
const resolved=(sha:string=commit)=>response(200,bytes(sha),{'content-type':'application/vnd.github.sha'})
const commitObject=(tree:string=treeSha('root'))=>json({sha:commit,tree:{sha:tree}})

class Http implements GithubHttpPort{
 readonly calls:GithubHttpRequest[]=[]
 readonly replies:Array<GithubHttpResponse|Error|((request:GithubHttpRequest)=>Promise<GithubHttpResponse>)>
 constructor(replies:Array<GithubHttpResponse|Error|((request:GithubHttpRequest)=>Promise<GithubHttpResponse>)>){this.replies=replies}
 async request(request:GithubHttpRequest):Promise<GithubHttpResponse>{this.calls.push(request);const reply=this.replies.shift();if(!reply)throw Error('unexpected request');if(reply instanceof Error)throw reply;return typeof reply==='function'?reply(request):reply}
}

function crc32(value:Uint8Array):number{let crc=0xffffffff;for(const byte of value){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}return (crc^0xffffffff)>>>0}
type Entry={path:string;text:string;mode?:number;declaredSize?:number;badCrc?:boolean}
function zip(entries:Entry[]):Uint8Array{
 const locals:Buffer[]=[],centrals:Buffer[]=[];let offset=0
 for(const entry of entries){const name=Buffer.from(entry.path),plain=Buffer.from(entry.text),compressed=deflateRawSync(plain),declared=entry.declaredSize??plain.length,crc=(crc32(plain)+(entry.badCrc?1:0))>>>0
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(8,8);local.writeUInt32LE(crc,14);local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(declared,22);local.writeUInt16LE(name.length,26)
  locals.push(local,name,compressed)
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE((3<<8)|20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt16LE(8,10);central.writeUInt32LE(crc,16);central.writeUInt32LE(compressed.length,20);central.writeUInt32LE(declared,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE((((entry.mode??0x81a4)&0xffff)<<16)>>>0,38);central.writeUInt32LE(offset,42)
  centrals.push(central,name);offset+=local.length+name.length+compressed.length
 }
 const centralSize=centrals.reduce((sum,item)=>sum+item.length,0),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(centralSize,12);end.writeUInt32LE(offset,16)
 return Buffer.concat([...locals,...centrals,end])
}
const archive=(entries:Entry[])=>{const value=zip(entries);return response(200,value,{'content-type':'application/zip','content-length':String(value.length)})}

before(async()=>{useLocalContainerRuntime();container=await new PostgreSqlContainer('postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeGithubSources(pool)},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop()})

test('先固定 commit，再只从 codeload 按 commit 获取并持久化文件与 provenance',async()=>{
 const http=new Http([resolved(),archive([{path:'demo-'+commit+'/teloa.json',text:'{}'},{path:'demo-'+commit+'/skills/check/SKILL.md',text:'# check'}])]),requestId=randomUUID()
 const result=await new GithubSourceService(pool,{now},http).resolve(ownerId(),{requestId,owner:'Teloa-AI',repo:'demo_repo',ref:'feature/x'})
 assert.equal(http.calls.length,2);assert.equal(http.calls[0]?.url,'https://api.github.com/repos/Teloa-AI/demo_repo/commits/feature%2Fx');assert.equal(http.calls[1]?.url,'https://codeload.github.com/Teloa-AI/demo_repo/zip/'+commit)
 assert.ok(http.calls.every(call=>call.redirect==='manual'&&call.method==='GET'&&!Object.keys(call.headers).some(key=>key.toLowerCase()==='authorization')))
 assert.equal(http.calls[0]?.headers.accept,'application/vnd.github.sha','commit 解析只取 sha，不下载含 patch 的 commit JSON')
 assert.equal(result.stage,'ready');assert.deepEqual(result.provenance,{kind:'github',owner:'Teloa-AI',repo:'demo_repo',requestedRef:'feature/x',resolvedCommit:commit,archiveHash:result.provenance.archiveHash})
 assert.equal(result.trust.publisher,'Teloa-AI');assert.deepEqual(result.trust.repository,{host:'github.com',owner:'Teloa-AI',repo:'demo_repo'});assert.equal(result.trust.license.status,'missing');assert.equal(result.trust.signature.status,'unverified');assert.equal(result.trust.review.conclusion,'needs-review')
 assert.match(result.provenance.archiveHash,/^[0-9a-f]{64}$/);assert.deepEqual(result.files.map(file=>file.path),['skills/check/SKILL.md','teloa.json']);assert.equal(new TextDecoder().decode(result.files[0]?.bytes),'# check')
 const stored=await pool.query('select request_spec,stage,resolved_commit,archive_hash,record_hash from teloa_github_source_requests where owner_id=$1 and request_id=$2',[result.ownerId,requestId]);assert.deepEqual(stored.rows[0].request_spec,{owner:'Teloa-AI',repo:'demo_repo',ref:'feature/x'});assert.equal(stored.rows[0].stage,'ready');assert.equal(stored.rows[0].resolved_commit,commit);assert.match(stored.rows[0].record_hash,/^[0-9a-f]{64}$/)
})

test('失败后从已持久化 commit 恢复，不重新解析已移动的分支',async()=>{
 const self=ownerId(),requestId=randomUUID(),first=new Http([resolved(),new Error('connection lost')]),service=new GithubSourceService(pool,{now},first)
 await assert.rejects(service.resolve(self,{requestId,owner:'teloa-ai',repo:'bundle',ref:'main'}),{code:'teloa/source-unavailable'})
 assert.equal((await pool.query('select stage,resolved_commit from teloa_github_source_requests where owner_id=$1 and request_id=$2',[self,requestId])).rows[0].stage,'downloading')
 const second=new Http([archive([{path:'bundle-'+commit+'/teloa.json',text:'{}'}])]),recovered=await new GithubSourceService(pool,{now},second).resolve(self,{requestId,owner:'teloa-ai',repo:'bundle',ref:'main'})
 assert.equal(recovered.provenance.resolvedCommit,commit);assert.deepEqual(second.calls.map(call=>call.url),['https://codeload.github.com/teloa-ai/bundle/zip/'+commit])
 const offline=new Http([]),again=await new GithubSourceService(pool,{now},offline).resolve(self,{requestId,owner:'teloa-ai',repo:'bundle',ref:'main'});assert.equal(again.provenance.archiveHash,recovered.provenance.archiveHash);assert.equal(offline.calls.length,0)
 await assert.rejects(new GithubSourceService(pool,{now},offline).resolve(self,{requestId,owner:'teloa-ai',repo:'bundle',ref:'other'}),{code:'teloa/conflict'})
})

test('严格拒绝 owner、repo、ref 和未知字段，不把任意 URL 交给 HTTP port',async()=>{
 for(const input of [
  {requestId:randomUUID(),owner:'bad/name',repo:'repo',ref:'main'},
  {requestId:randomUUID(),owner:'-bad',repo:'repo',ref:'main'},
  {requestId:randomUUID(),owner:'good',repo:'../repo',ref:'main'},
  {requestId:randomUUID(),owner:'good',repo:'repo.git',ref:'main'},
  {requestId:randomUUID(),owner:'good',repo:'repo',ref:'main..next'},
  {requestId:randomUUID(),owner:'good',repo:'repo',ref:'main',url:'https://evil.example/archive.zip'},
 ]){const http=new Http([]);await assert.rejects(new GithubSourceService(pool,{now},http).resolve(ownerId(),input),{code:'teloa/invalid-input'});assert.equal(http.calls.length,0)}
})

test('拒绝重定向、超限响应和非 40 位 commit，错误含阶段、HTTP 状态与路径',async()=>{
 const cases:[GithubHttpResponse,RegExp][]=[
  [response(302,new Uint8Array(),{location:'https://evil.example'}),/commit 解析 main 返回了不允许跟随的重定向（HTTP 302）：\/repos\/good\/repo\/commits\/main/],
  [response(200,bytes('{}'),{'content-type':'application/json','content-length':String(2*1024)}),/commit 解析 main 响应 2048 字节，超过 1024 字节上限/],
  [json({sha:'abc'}),/没有为 main 返回固定的 40 位 commit/],
  [response(404,bytes('{}')),/commit 解析 main 请求失败（HTTP 404）：\/repos\/good\/repo\/commits\/main/],
 ]
 for(const [reply,message] of cases){const http=new Http([reply]);await assert.rejects(new GithubSourceService(pool,{now},http).resolve(ownerId(),{requestId:randomUUID(),owner:'good',repo:'repo',ref:'main'}),{code:'teloa/source-unavailable',message})}
 const tooLarge=new Http([resolved(),response(200,new Uint8Array(),{'content-type':'application/zip','content-length':String(20*1024*1024+1)})]);await assert.rejects(new GithubSourceService(pool,{now},tooLarge).resolve(ownerId(),{requestId:randomUUID(),owner:'good',repo:'repo',ref:'main'}),{code:'teloa/source-unavailable',message:/整仓归档 0123456789ab 响应 20971521 字节，超过 20971520 字节上限/})
})

test('40 位 ref 必须原样解析；tip commit 改动量大不再影响解析（只取 sha）',async()=>{
 const other='f'.repeat(40)
 await assert.rejects(new GithubSourceService(pool,{now},new Http([resolved(other)])).resolve(ownerId(),{requestId:randomUUID(),owner:'good',repo:'repo',ref:commit}),{code:'teloa/source-unavailable',message:new RegExp('返回的 commit '+other+' 与请求的 40 位 ref '+commit+' 不一致')})
 const http=new Http([resolved(),archive([{path:'repo-'+commit+'/a.txt',text:'A'}])])
 const result=await new GithubSourceService(pool,{now},http).resolve(ownerId(),{requestId:randomUUID(),owner:'good',repo:'repo',ref:commit})
 assert.equal(result.provenance.resolvedCommit,commit);assert.equal(http.calls[0]?.url,'https://api.github.com/repos/good/repo/commits/'+commit)
})

test('ZIP 安全边界拒绝越界路径、符号链接、膨胀文件和 CRC 损坏',async()=>{
 const unsafe:Entry[][]=[
  [{path:'repo-'+commit+'/../secret',text:'x'}],
  [{path:'repo-'+commit+'/link',text:'target',mode:0xa1ff}],
  [{path:'repo-'+commit+'/huge',text:'x',declaredSize:2*1024*1024+1}],
  [{path:'repo-'+commit+'/bad',text:'x',badCrc:true}],
 ]
 for(const entries of unsafe){const http=new Http([resolved(),archive(entries)]),self=ownerId(),requestId=randomUUID();await assert.rejects(new GithubSourceService(pool,{now},http).resolve(self,{requestId,owner:'good',repo:'repo',ref:'main'}),{code:'teloa/source-unavailable'});assert.equal((await pool.query('select count(*)::int count from teloa_github_source_files where owner_id=$1 and request_id=$2',[self,requestId])).rows[0].count,0)}
})

test('跨实例并发同一请求只执行一条 GitHub 链路，保存记录被篡改后停止读取',async()=>{
 const self=ownerId(),requestId=randomUUID(),http=new Http([resolved(),async()=>{await new Promise(resolve=>setTimeout(resolve,20));return archive([{path:'repo-'+commit+'/a.txt',text:'A'}])}]),input={requestId,owner:'good',repo:'repo',ref:'main'}
 const [left,right]=await Promise.all([new GithubSourceService(pool,{now},http).resolve(self,input),new GithubSourceService(pool,{now},http).resolve(self,input)]);assert.equal(http.calls.length,2);assert.equal(left.provenance.archiveHash,right.provenance.archiveHash)
 await pool.query("update teloa_github_source_files set bytes='B'::bytea where owner_id=$1 and request_id=$2",[self,requestId])
 await assert.rejects(new GithubSourceService(pool,{now},new Http([])).resolve(self,input),{code:'teloa/storage-corrupt'})
 assert.equal(createHash('sha256').update(left.files[0]!.bytes).digest('hex'),left.files[0]!.hash)
})

const gitBlob=(text:string)=>{const value=bytes(text);return createHash('sha1').update('blob '+value.byteLength+'\0').update(value).digest('hex')}
const treeEntry=(path:string,text:string,extra:Record<string,unknown>={})=>({path,mode:'100644',type:'blob',sha:gitBlob(text),size:bytes(text).byteLength,...extra})
const raw=(text:string)=>response(200,bytes(text),{'content-type':'application/octet-stream'})
const subtreeFiles={'skills/pdf/SKILL.md':'---\nname: pdf\ndescription: d\n---\nbody\n','skills/pdf/references/a.md':'# a\n'}
const treeSha=(name:string)=>createHash('sha1').update('fixture-tree:'+name).digest('hex')
const dir=(path:string,name:string,extra:Record<string,unknown>={})=>({path,mode:'040000',type:'tree',sha:treeSha(name),...extra})
const pdfTree=(extra:unknown[]=[])=>[treeEntry('SKILL.md',subtreeFiles['skills/pdf/SKILL.md']),dir('references','skills/pdf/references'),treeEntry('references/a.md',subtreeFiles['skills/pdf/references/a.md']),...extra]
// 子目录导入：先读 commit 对象取根树 sha，再按根树 sha（不是 commit）请求根树、沿途祖先非递归读取，只对目标子树一次递归列表（路径相对该子树）。
// GitHub 对 /git/trees/{x} 的回包 sha 总是请求参数 x 本身；夹具照此写。
const descent=(pdf:unknown[]|GithubHttpResponse=pdfTree(),skills:unknown[]=[dir('pdf','skills/pdf')])=>[
 json({sha:treeSha('root'),truncated:false,tree:[treeEntry('README.md','x'),dir('skills','skills'),dir('unrelated','unrelated')]}),
 json({sha:treeSha('skills'),truncated:false,tree:skills}),
 Array.isArray(pdf)?json({sha:treeSha('skills/pdf'),truncated:false,tree:pdf}):pdf,
]
const treeUrl=(name:string,recursive=false)=>'https://api.github.com/repos/openai/skills/git/trees/'+(name===commit?commit:treeSha(name))+(recursive?'?recursive=1':'')

test('子目录模式：根与祖先非递归下降，只递归列出目标子树，逐个核对 blob 摘要',async()=>{
 const http=new Http([resolved(),commitObject(),...descent(),raw(subtreeFiles['skills/pdf/SKILL.md']),raw(subtreeFiles['skills/pdf/references/a.md'])]),requestId=randomUUID(),self=ownerId()
 const result=await new GithubSourceService(pool,{now},http).resolve(self,{requestId,owner:'openai',repo:'skills',ref:'main',path:'skills/pdf'})
 assert.deepEqual(http.calls.map(call=>call.url),['https://api.github.com/repos/openai/skills/commits/main','https://api.github.com/repos/openai/skills/git/commits/'+commit,treeUrl('root'),treeUrl('skills'),treeUrl('skills/pdf',true),'https://raw.githubusercontent.com/openai/skills/'+commit+'/skills/pdf/SKILL.md','https://raw.githubusercontent.com/openai/skills/'+commit+'/skills/pdf/references/a.md'])
 assert.ok(http.calls.every(call=>call.redirect==='manual'&&!Object.keys(call.headers).some(key=>key.toLowerCase()==='authorization')))
 assert.deepEqual(result.files.map(file=>file.path),['skills/pdf/SKILL.md','skills/pdf/references/a.md'])
 assert.equal(result.provenance.path,'skills/pdf');assert.match(result.provenance.archiveHash,/^[0-9a-f]{64}$/)
 const offline=new Http([]),again=await new GithubSourceService(pool,{now},offline).read(self,{requestId})
 assert.equal(again.provenance.path,'skills/pdf');assert.equal(offline.calls.length,0)
 await assert.rejects(new GithubSourceService(pool,{now},offline).resolve(self,{requestId,owner:'openai',repo:'skills',ref:'main',path:'skills/other'}),{code:'teloa/conflict'})
})

test('子目录模式：目标子树递归列表被 GitHub 截断时改为非递归逐级展开',async()=>{
 const http=new Http([resolved(),commitObject(),...descent(json({sha:treeSha('skills/pdf'),truncated:true,tree:[]})),
  json({sha:treeSha('skills/pdf'),truncated:false,tree:[treeEntry('SKILL.md',subtreeFiles['skills/pdf/SKILL.md']),dir('references','skills/pdf/references')]}),
  json({sha:treeSha('skills/pdf/references'),truncated:false,tree:[treeEntry('a.md',subtreeFiles['skills/pdf/references/a.md'])]}),
  raw(subtreeFiles['skills/pdf/SKILL.md']),raw(subtreeFiles['skills/pdf/references/a.md'])])
 const result=await new GithubSourceService(pool,{now},http).resolve(ownerId(),{requestId:randomUUID(),owner:'openai',repo:'skills',ref:'main',path:'skills/pdf'})
 assert.deepEqual(http.calls.slice(2,7).map(call=>call.url),[treeUrl('root'),treeUrl('skills'),treeUrl('skills/pdf',true),treeUrl('skills/pdf'),treeUrl('skills/pdf/references')])
 assert.deepEqual(result.files.map(file=>file.path),['skills/pdf/SKILL.md','skills/pdf/references/a.md'])
})

test('子目录模式：逐级展开仍拒绝环路，超过 500 文件、遇到链接或子模块时提前停止且不再请求',async()=>{
 const truncated=()=>json({sha:treeSha('skills/pdf'),truncated:true,tree:[]})
 for(const [label,listing,message] of [
  ['环路',[treeEntry('SKILL.md','x'),dir('loop','skills/pdf')],/skills\/pdf\/loop 的树 sha 与其祖先重复（环路）/],
  ['环路到祖先',[treeEntry('SKILL.md','x'),dir('up','skills')],/skills\/pdf\/up 的树 sha 与其祖先重复（环路）/],
  ['超过 500 文件',Array.from({length:501},(_,index)=>treeEntry('f'+index+'.md','x')),/子目录 skills\/pdf 超过 500 个文件，已停止展开/],
  ['符号链接早停',[treeEntry('link','target',{mode:'120000'}),dir('later','skills/pdf/later')],/符号链接（skills\/pdf\/link）/],
  ['子模块早停',[{path:'vendor',mode:'160000',type:'commit',sha:'1'.repeat(40)},dir('later','skills/pdf/later')],/子模块（skills\/pdf\/vendor）/],
  ['声明为树但模式非法',[dir('bad','skills/pdf/bad',{mode:'100644'}),dir('later','skills/pdf/later')],/^GitHub 子目录 skills\/pdf\/bad 声明为树但模式或 sha 非法。$/],
  ['条目名含分隔符与 DEL',[treeEntry('x/\u007f','x'),dir('later','skills/pdf/later')],/条目含路径分隔符："x\/\\u007f"$/],
 ] as const){
  const http=new Http([resolved(),commitObject(),...descent(truncated()),json({sha:treeSha('skills/pdf'),truncated:false,tree:listing})])
  await assert.rejects(new GithubSourceService(pool,{now},http).resolve(ownerId(),{requestId:randomUUID(),owner:'openai',repo:'skills',ref:'main',path:'skills/pdf'}),{code:'teloa/source-unavailable',message},label)
  assert.equal(http.calls.length,6,label+'：失败后不再请求 later 子树或 raw')
 }
})

test('子目录模式：逐级展开请求失败与重复路径的文案里，上游目录名与文件路径经转义显示',async()=>{
 const truncated=json({sha:treeSha('skills/pdf'),truncated:true,tree:[]}),name='a\u2028b'
 const expand=new Http([resolved(),commitObject(),...descent(truncated),json({sha:treeSha('skills/pdf'),truncated:false,tree:[dir(name,'skills/pdf/'+name)]}),response(500,bytes(''))])
 await assert.rejects(new GithubSourceService(pool,{now},expand).resolve(ownerId(),{requestId:randomUUID(),owner:'openai',repo:'skills',ref:'main',path:'skills/pdf'}),{code:'teloa/source-unavailable',message:/^GitHub 目录树 "skills\/pdf\/a\\u2028b" 请求失败（HTTP 500）：/})
 const duplicate=new Http([resolved(),commitObject(),...descent([treeEntry('Dup\u0085.md','x'),treeEntry('dup\u0085.md','x')])])
 await assert.rejects(new GithubSourceService(pool,{now},duplicate).resolve(ownerId(),{requestId:randomUUID(),owner:'openai',repo:'skills',ref:'main',path:'skills/pdf'}),{code:'teloa/source-unavailable',message:/^子目录包含重复或大小写冲突路径："skills\/pdf\/dup\\u0085\.md"$/})
})

test('子目录模式：祖先或目标声明为树但模式或 sha 非法属上游损坏，一律 source-unavailable 且文案一致',async()=>{
 for(const [label,entry,path] of [
  ['祖先模式非法',dir('pdf','skills/pdf',{mode:'100644'}),'skills/pdf/deeper'],
  ['祖先 sha 非法',dir('pdf','skills/pdf',{sha:'main'}),'skills/pdf/deeper'],
  ['目标模式非法',dir('pdf','skills/pdf',{mode:'100644'}),'skills/pdf'],
  ['目标 sha 非法',dir('pdf','skills/pdf',{sha:'main'}),'skills/pdf'],
 ] as const){
  const http=new Http([resolved(),commitObject(),...descent(pdfTree(),[entry]).slice(0,2)])
  await assert.rejects(new GithubSourceService(pool,{now},http).resolve(ownerId(),{requestId:randomUUID(),owner:'openai',repo:'skills',ref:'main',path}),{code:'teloa/source-unavailable',message:/^GitHub 子目录 skills\/pdf 声明为树但模式或 sha 非法。$/},label)
  assert.equal(http.calls.length,4,label)
 }
})

test('子目录模式：截断回包的部分条目已超过 500 文件或 1000 目录时直接失败，不逐级展开',async()=>{
 for(const [label,partial,message] of [
  ['部分文件 >500',Array.from({length:501},(_,index)=>treeEntry('f'+index+'.md','x')),/子目录 skills\/pdf 的递归列表被 GitHub 截断，已返回的部分就含 501 个文件、0 个目录，超过 500 文件\/1000 目录的安装上限，不再逐级展开/],
  ['部分目录 >=1000',Array.from({length:1000},(_,index)=>dir('d'+index,'skills/pdf/d'+index)),/已返回的部分就含 0 个文件、1000 个目录/],
 ] as const){
  const http=new Http([resolved(),commitObject(),...descent(json({sha:treeSha('skills/pdf'),truncated:true,tree:partial}))])
  await assert.rejects(new GithubSourceService(pool,{now},http).resolve(ownerId(),{requestId:randomUUID(),owner:'openai',repo:'skills',ref:'main',path:'skills/pdf'}),{code:'teloa/source-unavailable',message},label)
  assert.equal(http.calls.length,5,label)
 }
 // 部分条目仍在可安装规模内（500 文件、999 目录）才逐级展开：第一棵就把预算用光，说明展开确实开始了。
 const within=[...Array.from({length:500},(_,index)=>treeEntry('f'+index+'.md','x')),...Array.from({length:999},(_,index)=>dir('d'+index,'skills/pdf/d'+index))]
 const http=new Http([resolved(),commitObject(),...descent(json({sha:treeSha('skills/pdf'),truncated:true,tree:within})),json({sha:treeSha('skills/pdf'),truncated:false,tree:Array.from({length:501},(_,index)=>treeEntry('g'+index+'.md','x'))})])
 await assert.rejects(new GithubSourceService(pool,{now},http).resolve(ownerId(),{requestId:randomUUID(),owner:'openai',repo:'skills',ref:'main',path:'skills/pdf'}),{message:/超过 500 个文件，已停止展开/})
 assert.equal(http.calls.length,6)
})

test('子目录模式：逐级展开的目录树数受 1000 棵上限约束，达到即停并说明',async()=>{
 const subdirectories=Array.from({length:1200},(_,index)=>dir('d'+index,'skills/pdf/d'+index)),seen:string[]=[]
 const http:GithubHttpPort={request:async request=>{
  seen.push(request.url)
  if(request.url.endsWith('/commits/main'))return resolved()
  if(request.url.endsWith('/git/commits/'+commit))return commitObject()
  if(request.url.endsWith('/git/trees/'+treeSha('root')))return json({sha:treeSha('root'),truncated:false,tree:[dir('skills','skills')]})
  if(request.url.endsWith('/git/trees/'+treeSha('skills')))return json({sha:treeSha('skills'),truncated:false,tree:[dir('pdf','skills/pdf')]})
  if(request.url.endsWith('/git/trees/'+treeSha('skills/pdf')+'?recursive=1'))return json({sha:treeSha('skills/pdf'),truncated:true,tree:[]})
  if(request.url.endsWith('/git/trees/'+treeSha('skills/pdf')))return json({sha:treeSha('skills/pdf'),truncated:false,tree:subdirectories})
  const sha=request.url.split('/git/trees/')[1]!,index=subdirectories.findIndex(item=>item.sha===sha)
  assert.ok(index>=0,'只读展开中的子树：'+request.url)
  return json({sha,truncated:false,tree:[]})
 }}
 await assert.rejects(new GithubSourceService(pool,{now},http).resolve(ownerId(),{requestId:randomUUID(),owner:'openai',repo:'skills',ref:'main',path:'skills/pdf'}),{code:'teloa/source-unavailable',message:/目录树读取已达 1000 棵上限（目录树 skills\/pdf\/d\d+），已停止/})
 assert.equal(seen.filter(url=>url.includes('/git/trees/')).length,1000)
 assert.equal(seen.filter(url=>url.includes('raw.githubusercontent.com')).length,0)
})

test('子目录模式：根树按 commit 对象的 tree sha 请求，回包 sha 必须与之相等；不得按 commit 请求根树',async()=>{
 const http=new Http([resolved(),commitObject('e'.repeat(40)),...descent()])
 await assert.rejects(new GithubSourceService(pool,{now},http).resolve(ownerId(),{requestId:randomUUID(),owner:'openai',repo:'skills',ref:'main',path:'skills/pdf'}),{code:'teloa/source-unavailable',message:new RegExp('根树（commit 0123456789ab） 回包 sha '+treeSha('root')+' 与预期 e{40} 不一致')})
 assert.equal(http.calls.length,3);assert.equal(http.calls[2]?.url,'https://api.github.com/repos/openai/skills/git/trees/'+'e'.repeat(40),'根树按 tree sha 请求，GitHub 才会回根树 sha')
 // GitHub 行为锚点：按 commit 请求 /git/trees/{commit} 时回包 sha 是 commit 本身；若实现仍按 commit 请求根树，这里就会以 sha 不一致失败。
 const echoing:GithubHttpPort={request:async request=>{
  if(request.url.endsWith('/commits/main'))return resolved()
  if(request.url.endsWith('/git/commits/'+commit))return commitObject()
  const ref=request.url.split('/git/trees/')[1]?.split('?')[0]
  if(ref===commit)return json({sha:commit,truncated:false,tree:[treeEntry('README.md','x'),dir('skills','skills')]})
  if(ref===treeSha('root'))return json({sha:treeSha('root'),truncated:false,tree:[treeEntry('README.md','x'),dir('skills','skills')]})
  if(ref===treeSha('skills'))return json({sha:treeSha('skills'),truncated:false,tree:[dir('pdf','skills/pdf')]})
  if(ref===treeSha('skills/pdf'))return json({sha:treeSha('skills/pdf'),truncated:false,tree:pdfTree()})
  return raw(subtreeFiles[decodeURIComponent(request.url.split('/'+commit+'/')[1]!) as keyof typeof subtreeFiles]!)
 }}
 const result=await new GithubSourceService(pool,{now},echoing).resolve(ownerId(),{requestId:randomUUID(),owner:'openai',repo:'skills',ref:'main',path:'skills/pdf'})
 assert.deepEqual(result.files.map(file=>file.path),['skills/pdf/SKILL.md','skills/pdf/references/a.md'])
 for(const body of [json({sha:'0'.repeat(40),tree:{sha:treeSha('root')}}),json({sha:commit}),json({sha:commit,tree:{sha:'main'}})]){
  await assert.rejects(new GithubSourceService(pool,{now},new Http([resolved(),body])).resolve(ownerId(),{requestId:randomUUID(),owner:'openai',repo:'skills',ref:'main',path:'skills/pdf'}),{code:'teloa/source-unavailable',message:/commit 对象 0123456789ab 缺少匹配的 sha 或根树 sha/})
 }
})

test('子目录模式：上游条目名含控制字符、换行或超长时文案按 JSON 字面量截断显示',async()=>{
 const control='bad\u0007name\nnext.md',long='x'.repeat(260)+'.md'
 for(const [listing,message] of [
  [pdfTree([treeEntry(control,'x',{mode:'120000'})]),/符号链接（"skills\/pdf\/bad\\u0007name\\nnext\.md"），无法固定/],
  [pdfTree([treeEntry(long,'x',{mode:'120000'})]),new RegExp('符号链接（"skills/pdf/x{'+(200-'skills/pdf/'.length)+'}"…），无法固定')],
 ] as const){
  const http=new Http([resolved(),commitObject(),...descent(listing)])
  const error=await new GithubSourceService(pool,{now},http).resolve(ownerId(),{requestId:randomUUID(),owner:'openai',repo:'skills',ref:'main',path:'skills/pdf'}).then(()=>undefined,(reason:Error)=>reason)
  assert.ok(error instanceof Error);assert.match(error.message,message);assert.ok(!/[\u0000-\u001f]/.test(error.message),'文案不得含原始控制字符')
 }
})

test('子目录模式：递归列表里的越界、绝对、控制字符与反斜线路径在下载前拒绝',async()=>{
 for(const path of ['../evil.md','/abs.md','a\u0000b.md','a\\b.md','./dot.md']){
  const http=new Http([resolved(),commitObject(),...descent(pdfTree([treeEntry(path,'x')]))])
  await assert.rejects(new GithubSourceService(pool,{now},http).resolve(ownerId(),{requestId:randomUUID(),owner:'openai',repo:'skills',ref:'main',path:'skills/pdf'}),{code:'teloa/source-unavailable',message:new RegExp('来源包含不安全路径：'+JSON.stringify('skills/pdf/'+path).replace(/[\\^$.*+?()[\]{}|]/g,'\\$&'))},path)
  assert.equal(http.calls.filter(call=>call.url.includes('raw.githubusercontent.com')).length,0,path)
 }
})

test('子目录模式：目标不存在、大小写/NFC 不符或目标是文件时按 invalid-input 定位',async()=>{
 const cases:[string,unknown[]|undefined,string,RegExp][]=[
  ['不存在',undefined,'skills/none',/^固定提交中不存在目录 skills\/none：skills\/none 不存在。$/],
  ['祖先不存在',undefined,'docs/pdf',/^固定提交中不存在目录 docs\/pdf：docs 不存在。$/],
  ['大小写不符',undefined,'skills/PDF',/^固定提交中不存在目录 skills\/PDF：skills\/PDF 不存在；仓库中有大小写或 Unicode 规范化不同的 skills\/pdf，路径区分大小写，请按仓库实际名称填写。$/],
  ['目标是文件',[treeEntry('pdf','x')],'skills/pdf',/^skills\/pdf 不是目录（文件），无法按子目录导入。$/],
  ['祖先是文件',[treeEntry('pdf','x')],'skills/pdf/deeper',/^skills\/pdf 不是目录（文件），无法按子目录导入 skills\/pdf\/deeper。$/],
  ['祖先是符号链接',[treeEntry('pdf','target',{mode:'120000'})],'skills/pdf/deeper',/^skills\/pdf 不是目录（符号链接），无法按子目录导入 skills\/pdf\/deeper。$/],
 ]
 for(const [label,skills,path,message] of cases){
  const http=new Http([resolved(),commitObject(),...descent(pdfTree(),skills??[dir('pdf','skills/pdf')]).slice(0,2)])
  await assert.rejects(new GithubSourceService(pool,{now},http).resolve(ownerId(),{requestId:randomUUID(),owner:'openai',repo:'skills',ref:'main',path}),{code:'teloa/invalid-input',message},label)
 }
})

test('子目录模式：树被截断、符号链接、子模块、超大文件、字节不符、重定向、空目录、越界路径一律失败且不落就绪记录',async()=>{
 const big={...treeEntry('big.bin','x'),size:3*1024*1024}
 const cases:[string,Array<GithubHttpResponse>,string?][]=[
  ['根树截断',[resolved(),commitObject(),json({sha:treeSha('root'),truncated:true,tree:[]})]],
  ['符号链接',[resolved(),commitObject(),...descent(pdfTree([treeEntry('link','target',{mode:'120000'})]))]],
  ['子模块',[resolved(),commitObject(),...descent(pdfTree([{path:'vendor',mode:'160000',type:'commit',sha:'1'.repeat(40)}]))]],
  ['超大',[resolved(),commitObject(),...descent(pdfTree([big]))]],
  ['字节不符',[resolved(),commitObject(),...descent(),raw('tampered'),raw(subtreeFiles['skills/pdf/references/a.md'])]],
  ['重定向',[resolved(),commitObject(),...descent(),response(302,bytes(''),{location:'https://evil.example/'})]],
  ['子树 SHA 不符',[resolved(),commitObject(),...descent(json({sha:treeSha('other'),truncated:false,tree:pdfTree()}))]],
  ['目标是符号链接',[resolved(),commitObject(),...descent(pdfTree(),[treeEntry('pdf','target',{mode:'120000'})]).slice(0,2)],'teloa/invalid-input'],
  ['目标是子模块',[resolved(),commitObject(),...descent(pdfTree(),[{path:'pdf',mode:'160000',type:'commit',sha:'1'.repeat(40)}]).slice(0,2)],'teloa/invalid-input'],
  ['目标与大小写冲突并存',[resolved(),commitObject(),...descent(pdfTree(),[dir('pdf','skills/pdf'),dir('PDF','skills/PDF')]).slice(0,2)]],
  ['空目录',[resolved(),commitObject(),json({sha:treeSha('root'),truncated:false,tree:[treeEntry('README.md','x')]})],'teloa/invalid-input'],
  ['目录无普通文件',[resolved(),commitObject(),...descent([dir('empty','skills/pdf/empty')]),json({sha:treeSha('skills/pdf/empty'),truncated:false,tree:[]})],'teloa/invalid-input'],
 ]
 for(const [label,replies,code] of cases){
  const self=ownerId(),requestId=randomUUID()
  await assert.rejects(new GithubSourceService(pool,{now},new Http(replies)).resolve(self,{requestId,owner:'openai',repo:'skills',ref:'main',path:'skills/pdf'}),{code:code??'teloa/source-unavailable'},label)
  const stage=(await pool.query('select stage from teloa_github_source_requests where owner_id=$1 and request_id=$2',[self,requestId])).rows[0]?.stage
  assert.notEqual(stage,'ready',label)
 }
 for(const path of ['../etc','/abs','skills/pdf/','a//b','a\\b']){
  await assert.rejects(new GithubSourceService(pool,{now},new Http([])).resolve(ownerId(),{requestId:randomUUID(),owner:'openai',repo:'skills',ref:'main',path}),{code:'teloa/invalid-input'},path)
 }
})

test('子目录模式：Git 树里的 NFD 路径按 NFC 比对，raw 请求沿用树里的原始路径',async()=>{
 const nfd='cafe\u0301',text='---\nname: cafe\ndescription: d\n---\nbody\n'
 const http=new Http([resolved(),commitObject(),...descent([treeEntry('SKILL.md',text)],[dir(nfd,'skills/pdf')]),raw(text)])
 const result=await new GithubSourceService(pool,{now},http).resolve(ownerId(),{requestId:randomUUID(),owner:'openai',repo:'skills',ref:'main',path:'skills/caf\u00e9'})
 assert.equal(http.calls[5]?.url,'https://raw.githubusercontent.com/openai/skills/'+commit+'/skills/'+encodeURIComponent(nfd)+'/SKILL.md')
 assert.deepEqual(result.files.map(file=>file.path),['skills/caf\u00e9/SKILL.md'])
})

test('子目录模式：最多 4 路并发读取，一路失败后其余路不再取新文件',async()=>{
 const names=Array.from({length:12},(_,index)=>'skills/many/f'+index+'.md'),text='x'
 let active=0,peak=0,served=0
 const http:GithubHttpPort={request:async request=>{
  if(request.url.endsWith('/commits/main'))return resolved()
  if(request.url.endsWith('/git/commits/'+commit))return commitObject()
  if(request.url.endsWith('/git/trees/'+treeSha('root')))return json({sha:treeSha('root'),truncated:false,tree:[dir('skills','skills')]})
  if(request.url.endsWith('/git/trees/'+treeSha('skills')))return json({sha:treeSha('skills'),truncated:false,tree:[dir('many','skills/many')]})
  if(request.url.endsWith('/git/trees/'+treeSha('skills/many')+'?recursive=1'))return json({sha:treeSha('skills/many'),truncated:false,tree:names.map(name=>treeEntry(name.slice('skills/many/'.length),text))})
  active++;peak=Math.max(peak,active);const order=++served
  await new Promise(resolve=>setTimeout(resolve,5))
  active--
  return order===2?raw('tampered'):raw(text)
 }}
 await assert.rejects(new GithubSourceService(pool,{now},http).resolve(ownerId(),{requestId:randomUUID(),owner:'openai',repo:'skills',ref:'main',path:'skills/many'}),{code:'teloa/source-unavailable'})
 await new Promise(resolve=>setTimeout(resolve,50))
 assert.ok(peak<=4,'并发不超过 4 路，实得 '+peak)
 assert.ok(served<names.length,'失败后其余路不再读完全部文件，实读 '+served)
})
