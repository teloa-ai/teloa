import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeMarketContents,MarketContentStore,type MarketActor} from '../src/market/content-store.ts'
import {GithubSourceService,initializeGithubSources} from '../src/market/github-source.ts'
import {GithubImportService} from '../src/market/github-import.ts'
import {useLocalContainerRuntime} from './testcontainers-env.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date('2026-09-14T09:00:00.000Z').toISOString()}
const actor=():MarketActor=>({ownerId:randomUUID(),kind:'human'})
const commit='0123456789abcdef0123456789abcdef01234567',archiveHash='f'.repeat(64)
const encoder=new TextEncoder()
const manifest={format:'teloa.business-package/v2',id:'github-industry',title:'GitHub 行业模板',version:'1.0.0',domain:'general',description:'来自固定 GitHub 归档的行业模板',resources:[{id:'method',kind:'skill',title:'方法',version:'1.0.0',required:true,source:{kind:'local',path:'method/SKILL.md'}}],relations:[],entrypoints:['method']}

// 与 github-source.ts 固定记录摘要保持一致的计算方式；测试不得放宽任何完整性校验。
const sha=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex')
const stable=(value:unknown):string=>JSON.stringify(value,(_,item)=>!!item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item as Record<string,unknown>).sort(([a],[b])=>a<b?-1:a>b?1:0)):item)
const treeHash=(files:{path:string;hash:string;bytes:Uint8Array}[])=>sha(stable(files.map(file=>[file.path,file.hash,file.bytes.byteLength])))
const readyHash=(requestId:string,ownerId:string,spec:unknown,tree:string)=>sha(stable([requestId,ownerId,spec,'ready',commit,archiveHash,tree]))

const sourceFiles=(texts:Record<string,string>)=>Object.entries(texts).map(([path,text])=>{const bytes=encoder.encode(text);return {path,hash:sha(bytes),bytes}}).sort((left,right)=>left.path<right.path?-1:left.path>right.path?1:0)

async function fixture(ownerId:string,stage:'ready'|'resolving'='ready',texts:Record<string,string>={'teloa.json':JSON.stringify(manifest),'method/SKILL.md':'# 方法\n'},repo='starter'){
 const requestId=randomUUID(),spec={owner:'teloa-ai',repo,ref:'main'},files=sourceFiles(texts)
 if(stage==='resolving'){
  await pool.query("insert into teloa_github_source_requests(owner_id,request_id,request_spec,stage,created_at,updated_at) values($1,$2,$3,'resolving',$4,$4)",[ownerId,requestId,JSON.stringify(spec),identity.now()])
  return {requestId,files}
 }
 const tree=treeHash(files)
 await pool.query("insert into teloa_github_source_requests(owner_id,request_id,request_spec,stage,resolved_commit,archive_hash,tree_hash,record_hash,created_at,updated_at) values($1,$2,$3,'ready',$4,$5,$6,$7,$8,$8)",[ownerId,requestId,JSON.stringify(spec),commit,archiveHash,tree,readyHash(requestId,ownerId,spec,tree),identity.now()])
 for(const file of files)await pool.query('insert into teloa_github_source_files(owner_id,request_id,path,file_hash,bytes) values($1,$2,$3,$4,$5)',[ownerId,requestId,file.path,file.hash,Buffer.from(file.bytes)])
 return {requestId,files}
}
const service=()=>{const store=new MarketContentStore(pool,identity),sources=new GithubSourceService(pool,{now:identity.now},{request:async()=>{throw Error('导入不应访问网络')}});return new GithubImportService(store,{read:(ownerId,input)=>sources.read(ownerId,input)})}

before(async()=>{
 useLocalContainerRuntime()
 container=await new PostgreSqlContainer('postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeMarketContents(pool);await initializeGithubSources(pool)
},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop()})

test('合法 GitHub 仓库名含点、下划线时照常导入并保留原仓库身份',async()=>{
 for(const repo of ['next.js','socket_io.client','.github','tools-']){
  const self=actor(),{requestId:githubRequestId}=await fixture(self.ownerId,'ready',undefined,repo)
  const created=await service().importIndustry(self,{requestId:randomUUID(),githubRequestId,manifestPath:'teloa.json'})
  assert.equal((created.receipt.source as {repo:string}).repo,repo);assert.equal(created.content.trust.repository?.repo,repo)
  assert.equal((await new MarketContentStore(pool,identity).get(self,{contentId:created.content.id})).trust.repository?.repo,repo)
 }
})

test('固定就绪的 GitHub 来源导入为行业模板，回执记录仓库出处且同一请求可重放',async()=>{
 const self=actor(),{requestId:githubRequestId}=await fixture(self.ownerId),requestId=randomUUID(),importer=service()
 const created=await importer.importIndustry(self,{requestId,githubRequestId,manifestPath:'teloa.json'})
 assert.equal(created.content.kind,'industry-template')
 assert.equal(created.content.logicalId,'github-industry')
 assert.deepEqual(created.receipt.source,{kind:'github',owner:'teloa-ai',repo:'starter',requestedRef:'main',resolvedCommit:commit,archiveHash})
 assert.deepEqual(created.content.provides,[{resourceId:'method',kind:'skill',version:'1.0.0',path:'method/SKILL.md'}])
 assert.equal(created.content.trust.repository?.repo,'starter')
 const stored=await new MarketContentStore(pool,identity).get(self,{contentId:created.content.id})
 assert.deepEqual(stored.files.map(file=>file.path),['method/SKILL.md','teloa.json'])
 assert.equal(new TextDecoder().decode(stored.files[0]!.bytes),'# 方法\n')
 const replay=await importer.importIndustry(self,{requestId,githubRequestId,manifestPath:'teloa.json'})
 assert.deepEqual(replay.receipt,created.receipt)
 const restored=await new MarketContentStore(pool,identity).getImport(self,{requestId})
 assert.deepEqual(restored.receipt,created.receipt)
})

test('清单缺失、来源未就绪和字节被篡改分别按输入、来源与存储问题拒绝',async()=>{
 const self=actor(),{requestId:githubRequestId}=await fixture(self.ownerId),importer=service()
 await assert.rejects(importer.importIndustry(self,{requestId:randomUUID(),githubRequestId,manifestPath:'missing.json'}),{code:'teloa/invalid-input'})
 await assert.rejects(importer.importIndustry(self,{requestId:randomUUID(),githubRequestId,manifestPath:'teloa.json',extra:true}),{code:'teloa/invalid-input'})
 // 可信度只由固定来源的回执决定：调用方自报可信度是未知字段，一律拒绝。
 await assert.rejects(importer.importIndustry(self,{requestId:randomUUID(),githubRequestId,manifestPath:'teloa.json',trust:{status:'verified'}}),{code:'teloa/invalid-input'})
 await assert.rejects(importer.importIndustry(self,{requestId:randomUUID(),githubRequestId:randomUUID(),manifestPath:'teloa.json'}),{code:'teloa/source-unavailable'})
 const pendingOwner=actor(),{requestId:pendingRequest}=await fixture(pendingOwner.ownerId,'resolving')
 await assert.rejects(importer.importIndustry(pendingOwner,{requestId:randomUUID(),githubRequestId:pendingRequest,manifestPath:'teloa.json'}),{code:'teloa/source-unavailable'})
 await assert.rejects(importer.importIndustry(actor(),{requestId:randomUUID(),githubRequestId,manifestPath:'teloa.json'}),{code:'teloa/source-unavailable'})
 await pool.query('update teloa_github_source_files set bytes=$3 where owner_id=$1 and request_id=$2 and path=$4',[self.ownerId,githubRequestId,Buffer.from('# 被改写'),'method/SKILL.md'])
 await assert.rejects(importer.importIndustry(self,{requestId:randomUUID(),githubRequestId,manifestPath:'teloa.json'}),{code:'teloa/storage-corrupt'})
})

test('清单在子目录时只固定该目录内的文件，路径前缀保留，目录外文件不进入内容',async()=>{
 const self=actor(),nested={...manifest,id:'nested-industry',resources:[{...manifest.resources[0]!,source:{kind:'local',path:'method/SKILL.md'}}]}
 const {requestId:githubRequestId}=await fixture(self.ownerId,'ready',{'README.md':'# 仓库说明\n','pkg/teloa.json':JSON.stringify(nested),'pkg/method/SKILL.md':'# 方法\n','other/notes.md':'目录外资料'})
 const requestId=randomUUID(),created=await service().importIndustry(self,{requestId,githubRequestId,manifestPath:'pkg/teloa.json'})
 assert.equal(created.content.logicalId,'nested-industry')
 assert.equal(created.content.manifestPath,'pkg/teloa.json')
 assert.deepEqual(created.content.files.map(file=>file.path),['pkg/method/SKILL.md','pkg/teloa.json'])
 assert.deepEqual(created.content.provides,[{resourceId:'method',kind:'skill',version:'1.0.0',path:'pkg/method/SKILL.md'}])
 const restored=await new MarketContentStore(pool,identity).getImport(self,{requestId})
 assert.equal(restored.content.manifestPath,'pkg/teloa.json')
 assert.deepEqual(restored.content.files.map(file=>file.path),['pkg/method/SKILL.md','pkg/teloa.json'])
})

test('Agent 主体在读取固定来源字节之前就被拒绝',async()=>{
 const self=actor(),{requestId:githubRequestId}=await fixture(self.ownerId)
 let reads=0
 const store=new MarketContentStore(pool,identity)
 const guarded=new GithubImportService(store,{read:async()=>{reads++;throw Error('不应读取来源')}})
 await assert.rejects(guarded.importIndustry({ownerId:self.ownerId,kind:'agent'},{requestId:randomUUID(),githubRequestId,manifestPath:'teloa.json'}),{code:'teloa/forbidden'})
 assert.equal(reads,0)
})

const blob=(text:string)=>{const value=encoder.encode(text);return createHash('sha1').update('blob '+value.byteLength+'\0').update(value).digest('hex')}
const stream=async function*(value:Uint8Array){yield value}
const reply=(value:unknown)=>({status:200,headers:{},body:stream(typeof value==='string'?encoder.encode(value):encoder.encode(JSON.stringify(value)))})
async function subtree(ownerId:string,texts:Record<string,string>,path='skills/meeting'){
 // 按 URL 模拟固定提交的 Git 树：根与祖先非递归列出，目标子树可递归列出（路径相对该子树）。
 const treeSha=(directory:string)=>createHash('sha1').update('fixture-tree:'+directory).digest('hex'),directories=new Map([[commit,''],[treeSha(''),'']])
 const listing=(directory:string,recursive:boolean)=>{
  const prefix=directory?directory+'/':'',items=new Map<string,Record<string,unknown>>()
  for(const [file,text] of Object.entries(texts)){
   if(!file.startsWith(prefix))continue
   const parts=file.slice(prefix.length).split('/')
   for(let depth=1;depth<parts.length&&(recursive||depth===1);depth++){const name=parts.slice(0,depth).join('/'),full=prefix+name;directories.set(treeSha(full),full);items.set(name,{path:name,mode:'040000',type:'tree',sha:treeSha(full)})}
   if(recursive||parts.length===1)items.set(parts.join('/'),{path:parts.join('/'),mode:'100644',type:'blob',sha:blob(text),size:encoder.encode(text).byteLength})
  }
  return {sha:treeSha(directory),truncated:false,tree:[...items.values()]}
 }
 const http={request:async(request:{url:string})=>{
  const url=new URL(request.url)
  if(url.pathname.endsWith('/commits/main'))return reply(commit)
  if(url.pathname.endsWith('/git/commits/'+commit))return reply({sha:commit,tree:{sha:treeSha('')}})
  const tree=url.pathname.split('/git/trees/')[1]
  // GitHub 回包 sha 是请求参数本身（按 commit 请求根树时回 commit）。
  if(tree!==undefined){const directory=directories.get(tree);if(directory===undefined)throw Error('unexpected tree '+request.url);return reply({...listing(directory,url.search==='?recursive=1'),sha:tree})}
  const file=decodeURIComponent(url.pathname.split('/'+commit+'/')[1]??'');if(!Object.hasOwn(texts,file))throw Error('unexpected '+request.url);return reply(texts[file]!)
 }}
 const sources=new GithubSourceService(pool,{now:identity.now},http)
 const requestId=randomUUID();await sources.resolve(ownerId,{requestId,owner:'NousResearch',repo:'hermes-agent',ref:'main',path})
 return {requestId,service:new GithubImportService(new MarketContentStore(pool,identity),{read:(owner,input)=>sources.read(owner,input)})}
}

test('子目录固定来源导入为原子 Skill：名称取 frontmatter，版本记提交，来源保留子目录',async()=>{
 const self=actor(),{requestId,service}=await subtree(self.ownerId,{'skills/meeting/SKILL.md':'---\nname: meeting-action-items\ndescription: d\n---\n# body\n','skills/meeting/references/x.md':'x','README.md':'r'})
 const imported=await service.importSkill(self,{requestId:randomUUID(),githubRequestId:requestId,skillPath:'skills/meeting/SKILL.md'})
 assert.equal(imported.content.kind,'atomic-skill');assert.equal(imported.content.logicalId,'meeting-action-items')
 assert.equal(imported.content.version,'0.0.0+'+commit.slice(0,12))
 assert.deepEqual(imported.content.files.map(file=>file.path),['skills/meeting/SKILL.md','skills/meeting/references/x.md'])
 assert.equal(imported.receipt.source.kind,'github')
 assert.equal((imported.receipt.source as {path?:string}).path,'skills/meeting')
 assert.equal(imported.content.trust.review.conclusion,'needs-review')
})

test('子目录导入 Skill 的拒绝路径',async()=>{
 const self=actor(),{requestId,service}=await subtree(self.ownerId,{'skills/meeting/SKILL.md':'---\nname: meeting\ndescription: d\n---\nx\n','skills/meeting/inner/SKILL.md':'---\nname: inner\ndescription: d\n---\nx\n'})
 // 外层目录含两个 SKILL.md（嵌套技能），不能作为单入口技能导入；嵌套目录本身是合法的单入口技能。
 await assert.rejects(service.importSkill(self,{requestId:randomUUID(),githubRequestId:requestId,skillPath:'skills/meeting/SKILL.md'}),{code:'teloa/invalid-input'})
 assert.equal((await service.importSkill(self,{requestId:randomUUID(),githubRequestId:requestId,skillPath:'skills/meeting/inner/SKILL.md'})).content.logicalId,'inner')
 const upper=await subtree(self.ownerId,{'skills/meeting/SKILL.md':'---\nname: Meeting\ndescription: d\n---\nx\n'})
 await assert.rejects(upper.service.importSkill(self,{requestId:randomUUID(),githubRequestId:upper.requestId,skillPath:'skills/meeting/SKILL.md'}),{code:'teloa/invalid-input'})
 const reserved=await subtree(self.ownerId,{'skills/meeting/SKILL.md':'---\nname: teloa-skill-creator\ndescription: d\n---\nx\n'})
 await assert.rejects(reserved.service.importSkill(self,{requestId:randomUUID(),githubRequestId:reserved.requestId,skillPath:'skills/meeting/SKILL.md'}),/保留/)
 await assert.rejects(service.importSkill(self,{requestId:randomUUID(),githubRequestId:requestId,skillPath:'other/SKILL.md'}),{code:'teloa/invalid-input'})
 await assert.rejects(service.importSkill(self,{requestId:randomUUID(),githubRequestId:requestId,skillPath:'skills/meeting/README.md'}),{code:'teloa/invalid-input'})
 await assert.rejects(service.importSkill({ownerId:self.ownerId,kind:'agent'},{requestId:randomUUID(),githubRequestId:requestId,skillPath:'skills/meeting/SKILL.md'}),{code:'teloa/forbidden'})
})
