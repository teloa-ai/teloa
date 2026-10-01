import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {mkdir,mkdtemp,rm,writeFile,readFile,readdir} from 'node:fs/promises'
import {homedir} from 'node:os'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId,createUserMessage,type Message,type ReasoningEffortId} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry,type AgentHandle} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SkillRegistry} from '@deepseek-ai/dsh-skill'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import type {FileSystem} from '@deepseek-ai/dsh-fs'
import {brandString} from '@deepseek-ai/dsh-brand'
import type {SessionRequestId} from '@deepseek-ai/dsh-api-session-controller'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {readMarketCatalogEntry,type MarketCatalogUpstreamSkillEntry} from '@teloa/contract'
import {adoptRemoteUpstreamEntries,listUpstreamEntries} from '../../backend/src/market/official-upstream.ts'
import {apply} from '../src/index.ts'
import {compositionEntries} from './fixtures/production-host.ts'
import {installNativeHostServices} from './fixtures/native-host-services.ts'
import {acceptanceFetch,modelAcceptanceFetch,readAcceptanceTags,withLiveAcceptance} from './helpers/live-acceptance.ts'

/**
 * 官方市场与创建器一期的真库真宿主链路（计划 功能验证 / 调研报告验收 A12）：
 * 官方目录 → 添加 → 受管安装 → 原生目录；GitHub 固定提交子目录 → 原子 Skill → 安装；
 * 内置创建器只进本人普通会话的 agent 层；技能草案只在创建器正文可见时进入本人确认。
 */
const owner='local:teloa-owner'
const repositoryRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..','..','..')
const hostRequire=createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const {LocalFileSystem}=await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-fs-local')).href) as {LocalFileSystem:new(ctx:Context,config:{cwd:string})=>FileSystem}

type RpcReply={ok:boolean;value?:unknown;receipt?:{requestId:string};error?:{code?:string;message?:string}}
type RpcHandler=(endpoint:string,payload:unknown,signal:AbortSignal)=>Promise<RpcReply>
let container:StartedPostgreSqlContainer,root:string,ctx:Context,rpc:RpcHandler,previousProjectRoot:string|undefined
const agents=new Map<string,AgentHandle>(),originalFetch=globalThis.fetch

async function call(endpoint:string,payload:unknown,signal:AbortSignal=new AbortController().signal):Promise<unknown>{
 signal.throwIfAborted()
 const reply=await rpc(endpoint,payload,signal)
 signal.throwIfAborted()
 assert.equal(reply.ok,true,`RPC ${endpoint} 失败：${JSON.stringify(reply.error)}`)
 if(reply.receipt)assert.equal((await rpc('requests/pending/ack',{requestId:reply.receipt.requestId},signal)).ok,true)
 return reply.value
}
async function install(contentId:string){
 const preview=await call('skill-installations/preview',{source:{kind:'atomic',contentId}}) as {bundleHash:string;trustHash?:string}
 const result=await call('skill-installations/install',{requestId:randomUUID(),source:{kind:'atomic',contentId},expectedBundleHash:preview.bundleHash,...(preview.trustHash?{expectedTrustHash:preview.trustHash}:{})}) as {installation:{id:string;state:string}}
 return result.installation
}

before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').withDatabase('teloa').start()
 root=await mkdtemp(join(process.cwd(),'.tmp-market-creator-chain-'))
 await mkdir(join(root,'.runtime/teloa/skills'),{recursive:true,mode:0o700})
 await writeFile(join(root,'.runtime/teloa/database.json'),JSON.stringify({connectionString:container.getConnectionUri()}),{mode:0o600})
 await mkdir(join(root,'.runtime/dsh/profiles/teloa'),{recursive:true,mode:0o700})
 await writeFile(join(root,'.runtime/dsh/profiles/teloa/package.json'),JSON.stringify({dsh:{profile:{bundles:[],patchReload:'startup'}}}),{mode:0o600})
 previousProjectRoot=process.env.TELOA_PROJECT_ROOT
 process.env.TELOA_PROJECT_ROOT=repositoryRoot
 ctx=new Context()
 ctx.provide('loader',compositionEntries())
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(SkillRegistry)
 await ctx.plugin(AgentLoop,{agents:[]})
 await ctx.plugin(LocalFileSystem,{cwd:root})
 await ctx.plugin(ToolSkill)
 await installNativeHostServices(ctx,join(root,'.runtime/dsh'))
 const workspaces=new Map<string,{id:string;path:string}>()
 ctx.provide('workspaceRegistry',{
  create:async(path:string)=>{const found=[...workspaces.values()].find(entry=>entry.path===path);if(found)return found;const entry={id:'market-workspace-'+(workspaces.size+1),path};workspaces.set(entry.id,entry);return entry},
  get:(id:string)=>workspaces.get(id),list:()=>[...workspaces.values()],
 })
 ctx.provide('sessionController',{
  create:async(input:{sessionId?:string}={})=>{
   const sessionId=input.sessionId??randomUUID()
   agents.set(sessionId,await ctx.agents.create({sessionId:SessionId(sessionId),meta:{cwd:root},agentOptions:{provider:'test',model:'test'}}))
   return {sessionId}
  },
  fork:async()=>({sessionId:randomUUID()}),inspect:async(sessionId:string)=>({meta:{id:sessionId}}),
  resolveAgent:async(sessionId:string)=>{const handle=agents.get(sessionId);return handle?{agent:handle.agent}:{error:'not-found'}},
  modelCatalog:async()=>({default:{provider:'test',model:'test'}}),prompt:async()=>{},
 })
 ctx.provide('agentPresets',{serviceFor:()=>undefined,acquireScope:async()=>({key:{},async [Symbol.asyncDispose](){}}),resolve:async(id?:string)=>({id:id??'teloa-standard'})})
 ctx.provide('fileReferences',{})
 let registered:RpcHandler|undefined
 ctx.provide('connection',{fetch:{register:()=>async()=>{}},rpc:{handle:(path:string,handler:RpcHandler)=>{assert.equal(path,'/teloa');registered=handler;return ()=>{}}}})
 await apply(ctx,{projectRoot:root})
 assert.ok(registered,'/teloa handler 尚未注册')
 rpc=registered
},{timeout:300000})
after(async()=>{
 globalThis.fetch=originalFetch
 await ctx?.fiber.dispose()
 await container?.stop()
 if(root)await rm(root,{recursive:true,force:true})
 if(previousProjectRoot===undefined)delete process.env.TELOA_PROJECT_ROOT;else process.env.TELOA_PROJECT_ROOT=previousProjectRoot
},{timeout:120000})

test('第 1–3 步：官方目录列出固定技能快照，添加内部沟通稿并安装后出现在原生目录',{timeout:180000},async()=>{
 const listed=await call('market-catalog/list',{}) as {catalogVersion:string;items:{entry:{id:string;kind:string;delivery:string};addedContentId:string|null}[]}
 // 方案条目另由第 9 步覆盖，这里只核对技能条目
 assert.deepEqual(listed.items.filter(item=>item.entry.kind==='skill').map(item=>[item.entry.id,item.entry.delivery,item.addedContentId]),[['anthropic.commit','install',null],['anthropic.feature-dev','install',null],['anthropic.internal-comms','install',null],['anthropic.mcp-builder','install',null],['anthropic.modernize-assess','install',null],['anthropic.modernize-extract-rules','install',null],['anthropic.review-pr','install',null],['hermes.grounded-citations','install',null],['hermes.meeting-action-items','install',null],['hermes.simplify-code','install',null],['openai.security-best-practices','install',null],['openai.security-threat-model','install',null],['openai.skill-creator','builtin',null],['openclaw.github','install',null],['teloa.dashboard-designer','builtin',null]])
 const requestId=randomUUID()
 const first=await call('market-catalog/add',{requestId,entryId:'anthropic.internal-comms'}) as {receipt:{contentId:string;source:{kind:string}}}
 const again=await call('market-catalog/add',{requestId,entryId:'anthropic.internal-comms'}) as {receipt:{contentId:string}}
 assert.equal(again.receipt.contentId,first.receipt.contentId);assert.equal(first.receipt.source.kind,'catalog')
 const relisted=await call('market-catalog/list',{}) as typeof listed
 assert.equal(relisted.items.find(item=>item.entry.id==='anthropic.internal-comms')?.addedContentId,first.receipt.contentId)
 const installed=await install(first.receipt.contentId)
 assert.equal(installed.state,'installed')
 const native=(await ctx.skills.list()).find(skill=>skill.name==='internal-comms')
 assert.equal(native?.provider,'teloa-market')
 const observed=await call('skill-installations/observe',{installationId:installed.id}) as {state:string}
 assert.equal(observed.state,'available')
 const refused=await rpc('market-catalog/add',{requestId:randomUUID(),entryId:'openai.skill-creator'},new AbortController().signal)
 assert.equal(refused.ok,false);assert.equal(refused.error?.code,'teloa/invalid-input')
})

test('第 4 步：GitHub 固定提交子目录导入为 Skill 并安装',{timeout:180000},async()=>{
 const commit='0123456789abcdef0123456789abcdef01234567'
 const files:Record<string,string>={'skills/weekly-digest/SKILL.md':'---\nname: weekly-digest\ndescription: Summarize a week of notes into a digest.\n---\nGroup notes by project and list open questions.\n','skills/weekly-digest/references/format.md':'# Format\n'}
 const blob=(text:string)=>{const bytes=Buffer.from(text);return createHash('sha1').update('blob '+bytes.byteLength+'\0').update(bytes).digest('hex')}
 // 子目录导入从固定根非递归下降，只对目标子树递归列出（路径相对该子树），不读整仓递归树。
 const treeRoot='1'.repeat(40),treeSkills='2'.repeat(40),treeDigest='3'.repeat(40)
 const trees:Record<string,unknown>={
  // 未审导入按 commit 对象给出的根树 sha 请求根树；GitHub 对 /git/trees/{x} 的回包 sha 是 x 本身。
  [treeRoot]:{sha:treeRoot,truncated:false,tree:[{path:'README.md',mode:'100644',type:'blob',sha:blob('r'),size:1},{path:'skills',mode:'040000',type:'tree',sha:treeSkills}]},
  [treeSkills]:{sha:treeSkills,truncated:false,tree:[{path:'weekly-digest',mode:'040000',type:'tree',sha:treeDigest}]},
  [treeDigest+'?recursive=1']:{sha:treeDigest,truncated:false,tree:[{path:'references',mode:'040000',type:'tree',sha:'4'.repeat(40)},...Object.entries(files).map(([path,text])=>({path:path.slice('skills/weekly-digest/'.length),mode:'100644',type:'blob',sha:blob(text),size:Buffer.byteLength(text)}))]},
 }
 const seen:string[]=[],rateLimitReset=Math.floor(Date.now()/1000)+1800
 globalThis.fetch=(async(input:string|URL|Request,init?:RequestInit)=>{
  const url=String(input instanceof Request?input.url:input)
  if(!url.startsWith('https://api.github.com/')&&!url.startsWith('https://raw.githubusercontent.com/'))return originalFetch(input,init)
  seen.push(url)
  // commit 解析只回 40 字节 sha；commit 对象给出根树 sha 供根树回包交叉核对；rate-limited 分支模拟 GitHub 未认证限流回包。
  if(url==='https://api.github.com/repos/example-org/skills/commits/main')return new Response(commit)
  if(url==='https://api.github.com/repos/example-org/skills/commits/rate-limited')return new Response('API rate limit exceeded',{status:403,headers:{'x-ratelimit-limit':'60','x-ratelimit-remaining':'0','x-ratelimit-reset':String(rateLimitReset)}})
  if(url==='https://api.github.com/repos/example-org/skills/git/commits/'+commit)return Response.json({sha:commit,tree:{sha:treeRoot}})
  const treePrefix='https://api.github.com/repos/example-org/skills/git/trees/'
  if(url.startsWith(treePrefix)){const tree=trees[url.slice(treePrefix.length)];assert.ok(tree,'只读固定根、沿途祖先与目标子树：'+url);return Response.json(tree)}
  const prefix='https://raw.githubusercontent.com/example-org/skills/'+commit+'/',path=url.startsWith(prefix)?decodeURIComponent(url.slice(prefix.length)):''
  return files[path]!==undefined?new Response(files[path]):new Response('missing',{status:404})
 }) as typeof fetch
 try{
  const githubRequestId=randomUUID()
  const receipt=await call('market/github/resolve',{requestId:githubRequestId,owner:'example-org',repo:'skills',ref:'main',path:'skills/weekly-digest'}) as {provenance:{path?:string;resolvedCommit:string}}
  assert.equal(receipt.provenance.path,'skills/weekly-digest');assert.equal(receipt.provenance.resolvedCommit,commit)
  assert.ok(!seen.some(url=>url.includes('codeload')),'子目录模式不下载整仓归档')
  assert.equal(seen.filter(url=>url.includes('/git/trees/')).length,3,'根、skills 与目标子树各一次')
  assert.equal(seen.filter(url=>url.includes('/git/commits/')).length,1,'commit 对象只读一次，供根树交叉核对')
  assert.equal(seen.filter(url=>url.includes('/git/trees/'+commit)).length,0,'根树须按 tree sha 请求，按 commit 请求时 GitHub 回包 sha 是 commit、无法核对')
  // 宿主适配器须转发 x-ratelimit-*，后端才能把 403 定位为限流并给出重置时间。
  const limited=await rpc('market/github/resolve',{requestId:randomUUID(),owner:'example-org',repo:'skills',ref:'rate-limited',path:'skills/weekly-digest'},new AbortController().signal)
  assert.equal(limited.ok,false);assert.equal(limited.error?.code,'teloa/source-unavailable')
  assert.match(limited.error?.message??'',new RegExp('GitHub API 限流（HTTP 403，剩余配额 0），约 (29|30) 分钟后（'+new Date(rateLimitReset*1000).toISOString().replace(/[.]/g,'\\.')+'）重置；commit 解析 rate-limited 未读取：/repos/example-org/skills/commits/rate-limited'))
  const imported=await call('market-content/import-github-skill',{requestId:randomUUID(),githubRequestId,skillPath:'skills/weekly-digest/SKILL.md'}) as {content:{id:string;logicalId:string;version:string}}
  assert.equal(imported.content.logicalId,'weekly-digest');assert.equal(imported.content.version,'0.0.0+'+commit.slice(0,12))
  assert.equal((await install(imported.content.id)).state,'installed')
  assert.ok((await ctx.skills.list()).some(skill=>skill.name==='weekly-digest'))
 }finally{globalThis.fetch=originalFetch}
})

const step=(handle:AgentHandle,text:string)=>{
 const messages=[createUserMessage({source:{kind:'user'},content:[{type:'text',text}]})]
 return ctx.waterfall('agent/pre-step',{agent:handle.agent,messages,turn:1,step:1,signal:new AbortController().signal},async()=>({kind:'enter' as const,messages}))
}

test('GitHub 目录真实链路：确认后按审核清单添加、安装并由 DSH 读取；拒绝无副作用，重试不重复',{timeout:180000},async()=>{
 const previous=listUpstreamEntries(),commit='a'.repeat(40),prefix='skills/reviewed-notes/'
 const files:Record<string,string>={
  'SKILL.md':'---\nname: reviewed-notes\ndescription: Summarize reviewed notes.\n---\nUse references/format.md and preserve source citations.\n',
  'LICENSE':'MIT License\nCopyright (c) Example\n',
  'references/format.md':'# Notes\nGroup by project; keep open questions.\n',
  'licenses/upstream/NOTICE':'Repository attribution\nCopyright (c) Fixture Authors\n',
 }
 const blob=(body:string)=>createHash('sha1').update('blob '+Buffer.byteLength(body)+'\0').update(body).digest('hex')
 const loc=(body:string)=>({'zh-CN':body,en:body})
 const entry=readMarketCatalogEntry({format:'teloa.market-catalog-entry/v1',id:'codex.reviewed-notes',kind:'skill',delivery:'upstream',version:'1.2.0',taxonomy:{functions:['office-docs'],industries:['general']},skill:{name:'reviewed-notes',title:loc('审核后的笔记技能'),summary:loc('按项目整理笔记并保留引用')},
  upstream:{kind:'github',repository:{host:'github.com',owner:'example-org',repo:'skills'},commit,path:'skills/reviewed-notes',files:Object.entries(files).map(([path,body])=>({path,gitBlob:blob(body),sha256:createHash('sha256').update(body).digest('hex'),size:Buffer.byteLength(body),...(path==='licenses/upstream/NOTICE'?{repositoryPath:'NOTICE'}:{})}))},
  origin:{marketplace:'codex',installs:null,installsLabel:'未公开',countedAt:'2026-09-27'},alternatives:[],unsupportedComponents:[{kind:'scripts',count:1}],modifications:[],license:{spdx:'MIT',files:['LICENSE','licenses/upstream/NOTICE']},compatibility:{status:'content-only',teloa:'>=0.2.0-alpha.7',dsh:'0.1.7-rc.1',conditions:[]},requires:{tools:[],network:false,runtimes:[]},review:{status:'approved',reviewedAt:'2026-09-27',reviewer:'Isolated test fixture'}}) as MarketCatalogUpstreamSkillEntry
 // 这里只替换隔离进程的已解析目录；索引验签与旧版过滤由索引发布专项覆盖。
 adoptRemoteUpstreamEntries([...previous,entry])
 const treeRoot='f'.repeat(40),treeSkills='b'.repeat(40),treeNotes='c'.repeat(40),treeReferences='d'.repeat(40)
 const treeFile=(path:string,key:string)=>({path,mode:'100644',type:'blob',sha:blob(files[key]!),size:Buffer.byteLength(files[key]!)})
 const treeDirectory=(path:string,sha:string)=>({path,mode:'040000',type:'tree',sha})
 const trees:Record<string,unknown>={
  // 已审路径按 commit 请求根树，GitHub 回包 sha 是 commit 本身。
  [commit]:{sha:commit,truncated:false,tree:[treeDirectory('skills',treeSkills),treeFile('NOTICE','licenses/upstream/NOTICE')]},
  [treeSkills]:{sha:treeSkills,truncated:false,tree:[treeDirectory('reviewed-notes',treeNotes)]},
  [treeNotes]:{sha:treeNotes,truncated:false,tree:[treeFile('SKILL.md','SKILL.md'),treeFile('LICENSE','LICENSE'),treeDirectory('references',treeReferences),treeDirectory('scripts','e'.repeat(40)),{path:'.env',mode:'100644',type:'blob',sha:blob('private'),size:7}]},
  [treeReferences]:{sha:treeReferences,truncated:false,tree:[treeFile('format.md','references/format.md')]},
 }
 const seen:string[]=[]
 globalThis.fetch=(async(input:string|URL|Request,init?:RequestInit)=>{
  const url=String(input instanceof Request?input.url:input)
  if(!url.startsWith('https://api.github.com/')&&!url.startsWith('https://raw.githubusercontent.com/'))return originalFetch(input,init)
  seen.push(url)
  const treePrefix='https://api.github.com/repos/example-org/skills/git/trees/'
  if(url.startsWith(treePrefix)){
   const tree=trees[url.slice(treePrefix.length)]
   assert.ok(tree,'只读取固定根与审核文件祖先树，不递归读取整仓：'+url)
   return Response.json(tree)
  }
  const rawPrefix='https://raw.githubusercontent.com/example-org/skills/'+commit+'/'+prefix,path=url==='https://raw.githubusercontent.com/example-org/skills/'+commit+'/NOTICE'?'licenses/upstream/NOTICE':url.startsWith(rawPrefix)?decodeURIComponent(url.slice(rawPrefix.length)):''
  assert.ok(Object.hasOwn(files,path),'只能下载固定提交中的审核文件：'+url)
  return new Response(files[path])
 }) as typeof fetch
 let allowed=false
 const reasons:string[]=[]
 const dispose=ctx.on('approval/request',async request=>{reasons.push(request.reason??'');return allowed?'allowed-once':'rejected'})
 try{
  const conversation=await call('conversations/create',{requestId:randomUUID(),title:'添加审核后的技能'}) as {sessionId:string}
  const handle=agents.get(conversation.sessionId)!,session=handle.agent.session
  session.append('turn/start',{turn:1})
  session.append('user/message',createUserMessage({source:{kind:'user',rpcId:brandString<SessionRequestId>('github-catalog-turn')},content:[{type:'text',text:'添加笔记技能'}]}),{surfaceOp:'append'})
  const run=(name:string,args:Record<string,unknown>,id:string)=>ctx.tools.execute({agent:handle.agent,name,arguments:args,callId:ToolCallId(id),signal:AbortSignal.timeout(30000)})
  const decode=(result:Awaited<ReturnType<typeof run>>)=>{assert.equal(result.isError,false,JSON.stringify(result.content));return JSON.parse(result.content.filter(item=>item.type==='text').map(item=>(item as {text:string}).text).join('\n'))}
  const resolved=decode(await run('teloa_market_resolve',{reference:entry.id},'resolve')).candidate
  assert.equal(resolved.kind,'catalog');assert.equal(resolved.entryId,entry.id)
  assert.equal(reasons.length,0);assert.equal(seen.length,0,'预览不联网下载')
  const args={candidate:{kind:'catalog',entryId:entry.id},expectedFingerprint:resolved.fingerprint}
  const rejected=await run('teloa_market_add',args,'declined')
  assert.equal(rejected.isError,true);assert.match(JSON.stringify(rejected.content),/user rejected/)
  assert.equal(reasons.length,1);assert.equal(seen.length,0,'拒绝确认不下载')
  assert.equal(await ctx.skills.get('reviewed-notes'),undefined)
  const rejectedListing=await call('market-catalog/list',{marketplace:'codex',query:entry.id}) as {items:{addedContentId:string|null}[]}
  assert.equal(rejectedListing.items[0]!.addedContentId,null,'拒绝确认不创建内容')
  allowed=true
  const first=decode(await run('teloa_market_add',args,'install'))
  assert.equal(first.installed,true);assert.equal(first.installation.state,'installed')
  assert.match(reasons[1]!,/reviewed-notes/);assert.match(reasons[1]!,/MIT/);assert.match(reasons[1]!,/4 个文件/)
  const native=await ctx.skills.get('reviewed-notes')
  assert.equal(native?.provider,'teloa-market');assert.equal(native?.resourceBase?.kind,'directory')
  const directory=native!.resourceBase!.kind==='directory'?native!.resourceBase!.path:''
  assert.deepEqual((await readdir(directory)).sort(),['LICENSE','SKILL.md','licenses','references'])
  for(const [path,body] of Object.entries(files))assert.equal(await readFile(join(directory,path),'utf8'),body)
  const downloads=seen.length
  for(const id of ['install','install-again']){
   const repeat=decode(await run('teloa_market_add',args,id))
   assert.equal(repeat.contentId,first.contentId);assert.equal(repeat.installation.id,first.installation.id)
  }
  assert.equal(seen.length,downloads,'重复安装复用已添加的固定内容')
  const installations=await call('skill-installations/list',{}) as {items:{id:string;native:{name:string}}[]}
  assert.equal(installations.items.filter(item=>item.native.name==='reviewed-notes').length,1)
  assert.equal((await call('skill-installations/observe',{installationId:first.installation.id}) as {state:string}).state,'available')
  assert.equal(seen.length,8,'四份祖先树、三份目录文件与一份根 NOTICE，不读取无关子树、分支 HEAD 或整仓包')
 }finally{dispose();globalThis.fetch=originalFetch;adoptRemoteUpstreamEntries(previous)}
})
// 显式验收才访问真实固定 GitHub 来源；常规回归不联网、不读取独立源仓。
test('真实资源验收：固定 GitHub 候选经模拟本人批准安装、原生读取和重试不重复',{skip:!process.env.TELOA_ACCEPTANCE_GITHUB_ENTRY,timeout:300000},async t=>{
 const previous=listUpstreamEntries(),seen:{url:string;status:number}[]=[],reasons:string[]=[]
 let dispose=()=>{}
 return withLiveAcceptance(t,async scope=>{
  const liveCall=(endpoint:string,payload:unknown)=>scope.run(120000,signal=>call(endpoint,payload,signal))
  const entry=readMarketCatalogEntry(JSON.parse(await scope.run(5000,signal=>readFile(process.env.TELOA_ACCEPTANCE_GITHUB_ENTRY!,{encoding:'utf8',signal}))))
  assert.ok(entry.kind==='skill'&&entry.delivery==='upstream'&&entry.upstream.kind==='github')
  assert.notEqual(entry.compatibility.status,'unsupported')
  const source=entry.upstream,commit=source.commit
  const {owner,repo}=source.repository
  const apiTreePrefix=`/repos/${owner}/${repo}/git/trees/`,rawPrefix=`/${owner}/${repo}/${commit}/`
  const expectedRawPaths=new Set(source.files.map(file=>rawPrefix+(file.repositoryPath??source.path+'/'+file.path)))
  const ancestorPaths=new Set<string>([''])
  for(const path of expectedRawPaths){const parts=path.slice(rawPrefix.length).split('/');for(let n=1;n<parts.length;n++)ancestorPaths.add(parts.slice(0,n).join('/'))}
  dispose=ctx.on('approval/request',async request=>{reasons.push(request.reason??'');return 'allowed-once'})
  adoptRemoteUpstreamEntries([...previous,entry])
  globalThis.fetch=acceptanceFetch(scope,async(input,init)=>{
   const response=await originalFetch(input,init)
   seen.push({url:input instanceof Request?input.url:String(input),status:response.status});return response
  },(url,method)=>{
   assert.ok(url.protocol==='https:'&&!url.port&&!url.username&&!url.password&&['api.github.com','raw.githubusercontent.com'].includes(url.hostname),'真实资源验收只访问公开 GitHub 来源')
   assert.equal(method,'GET');assert.ok(!url.search&&!url.hash)
   if(url.hostname==='api.github.com')assert.ok(url.pathname.startsWith(apiTreePrefix)&&/^[a-f0-9]{40}$/.test(url.pathname.slice(apiTreePrefix.length)),'只读本仓库固定 Git 树')
   else assert.ok(expectedRawPaths.has(decodeURIComponent(url.pathname)),'只下载固定提交中的声明文件')
  },120000)
  const conversation=await liveCall('conversations/create',{requestId:randomUUID(),title:'真实固定资源安装验收'}) as {sessionId:string}
  const handle=agents.get(conversation.sessionId)!,session=handle.agent.session
  session.append('turn/start',{turn:1})
  session.append('user/message',createUserMessage({source:{kind:'user',rpcId:brandString<SessionRequestId>('live-catalog-turn')},content:[{type:'text',text:'安装我已审查的 '+entry.id}]}),{surfaceOp:'append'})
  const run=(name:string,args:Record<string,unknown>,id:string)=>scope.run(120000,signal=>ctx.tools.execute({agent:handle.agent,name,arguments:args,callId:ToolCallId(id),signal}))
  const decode=(result:Awaited<ReturnType<typeof run>>)=>{assert.equal(result.isError,false,JSON.stringify(result.content));return JSON.parse(result.content.filter(item=>item.type==='text').map(item=>(item as {text:string}).text).join('\n'))}
  const resolved=decode(await run('teloa_market_resolve',{reference:entry.id},'live-resolve')).candidate
  assert.equal(reasons.length,0);assert.equal(seen.length,0)
  const args={candidate:{kind:'catalog',entryId:entry.id},expectedFingerprint:resolved.fingerprint}
  const first=decode(await run('teloa_market_add',args,'live-install'))
  assert.equal(first.installed,true);assert.equal(first.installation.state,'installed');assert.equal(reasons.length,1)
  assert.ok(reasons[0]!.includes(entry.skill.name));assert.ok(reasons[0]!.includes(entry.license.spdx))
  const native=await scope.run(5000,()=>ctx.skills.get(entry.skill.name))
  assert.equal(native?.provider,'teloa-market');assert.equal(native?.resourceBase?.kind,'directory')
  const directory=native!.resourceBase!.kind==='directory'?native!.resourceBase!.path:''
  const observed:{path:string;bytes:number;sha256:string}[]=[]
  for(const file of entry.upstream.files){
   const bytes=await scope.run(5000,signal=>readFile(join(directory,file.path),{signal}))
   assert.equal(bytes.length,file.size);assert.equal(createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex'),file.gitBlob)
   observed.push({path:file.path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')})
  }
  const loaded=await run('skill',{name:entry.skill.name},'live-load')
  assert.equal(loaded.isError,false,JSON.stringify(loaded.content));assert.ok(JSON.stringify(loaded.content).includes('<skill_content'))
  const downloads=seen.length
  for(const id of ['live-install','live-install-again']){
   const again=decode(await run('teloa_market_add',args,id))
   assert.equal(again.contentId,first.contentId);assert.equal(again.installation.id,first.installation.id)
  }
  assert.equal(seen.length,downloads)
  assert.equal(seen.filter(request=>new URL(request.url).hostname==='raw.githubusercontent.com').length,entry.upstream.files.length)
  // 生产按树 SHA 去重：不同目录共享同一树对象时请求少于祖先路径数，只断言根请求、不重复和上下界。
  const treeRefs=seen.filter(request=>new URL(request.url).hostname==='api.github.com').map(request=>new URL(request.url).pathname.slice(apiTreePrefix.length))
  assert.equal(treeRefs[0],commit,'首个树请求必须是固定提交根树');assert.equal(treeRefs.filter(ref=>ref===commit).length,1)
  assert.equal(new Set(treeRefs).size,treeRefs.length,'同一树 SHA 不得重复读取')
  assert.ok(treeRefs.length>=Math.max(...source.files.map(file=>(file.repositoryPath??source.path+'/'+file.path).split('/').length))&&treeRefs.length<=ancestorPaths.size,'树请求数须在最深祖先链与祖先路径数之间：'+treeRefs.length)
  assert.ok(seen.every(request=>request.status===200))
  const listing=await liveCall('skill-installations/list',{}) as {items:{native:{name:string}}[]}
  assert.equal(listing.items.filter(item=>item.native.name===entry.skill.name).length,1)
  assert.equal((await liveCall('skill-installations/observe',{installationId:first.installation.id}) as {state:string}).state,'available')
  let realModel:unknown=false
  if(process.env.TELOA_ACCEPTANCE_REVIEW_MODEL_URL){
   assert.equal(entry.id,'hermes.simplify-code','真实模型样例只核对已审查的代码清理技能')
   const address=new URL(process.env.TELOA_ACCEPTANCE_REVIEW_MODEL_URL)
   assert.equal(process.env.TELOA_ACCEPTANCE_REVIEW_MODEL_KEY,'local-acceptance-only','本地免认证服务只用固定测试占位值，不读取用户密钥')
   // 此处无聊天服务或 Agent 工具执行；验证的是原生技能读取后，经官方适配器的只读模型应用。
   globalThis.fetch=modelAcceptanceFetch(scope,originalFetch,address)
   const tags=await readAcceptanceTags(scope,globalThis.fetch,address)
   const model=tags.models.find(row=>row.name==='qwen3:4b')
   assert.equal(model?.digest,'359d7dd4bcdab3d86b87d73ac27966f4dbb9f5efdfcc75d34a8764a09474fae7')
   const modelCtx=new Context()
   try{
    await modelCtx.plugin(LlmRuntime)
    const piAi=await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-llm-pi-ai')).href)
    await modelCtx.plugin(piAi,{providers:{'review-local':{apiKeyEnv:'TELOA_ACCEPTANCE_REVIEW_MODEL_KEY',api:'openai-completions',baseURL:address.origin+'/v1',compat:{thinkingFormat:'deepseek'},models:[{id:'qwen3:4b',contextWindow:32768,maxTokens:4096,reasoningEfforts:{high:'high'}}]}}})
    const instructions=loaded.content.filter(item=>item.type==='text').map(item=>(item as {text:string}).text).join('\n')
    const task='Apply the installed skill below using its documented sequential fallback. No delegation or other tools are available. Review only this user-provided code, without running commands or modifying files. Return a JSON object with four nonempty string fields: reuse, quality, efficiency, altitude. Be specific about the duplicate loop and the appropriate small refactoring.\n\nfunction subtotal(items) { let total = 0; for (const item of items) total += item.price * item.quantity; return total; }\nfunction taxedTotal(items, taxRate) { let total = 0; for (const item of items) total += item.price * item.quantity; return total * (1 + taxRate); }\n\n'+instructions
    let response='',finish:unknown
    const start=Date.now()
    await scope.run(180000,async signal=>{
     for await(const chunk of modelCtx.llm.stream({provider:'review-local',model:'qwen3:4b',reasoningEffort:brandString<ReasoningEffortId>('high'),messages:[createUserMessage({source:{kind:'user'},content:[{type:'text',text:task}]})],tools:[],maxTokens:4096,signal})){
      if(chunk.type==='text-delta')response+=chunk.text
      if(chunk.type==='finish')finish=chunk.reason
     }
    })
    assert.deepEqual(finish,{kind:'stop'});assert.ok(response.trim(),JSON.stringify({finish}))
    const result=JSON.parse(response.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'')) as Record<string,unknown>
    for(const key of ['reuse','quality','efficiency','altitude'])assert.ok(typeof result[key]==='string'&&(result[key] as string).trim().length>0,key)
    // 允许用表达式或函数名定位重复代码，不把措辞差异当作链路失败；结论准确性另做人审。
    assert.match(response,/subtotal|taxedTotal|price\s*\*\s*(?:item\.)?quantity/);assert.match(response,/duplicat|reuse|重复|复用/i)
    realModel={provider:'official-pi-ai',model:model!.name,digest:model!.digest,elapsedMs:Date.now()-start,finish,result,qualityReview:'requires-manual-review',scope:'原生读取后的单次只读审查；未验证模型自主选技能或文件修改，不证明建议全部正确'}
   }finally{await modelCtx.fiber.dispose()}
  }
  if(process.env.TELOA_ACCEPTANCE_GITHUB_REPORT)await scope.run(5000,signal=>writeFile(process.env.TELOA_ACCEPTANCE_GITHUB_REPORT!,JSON.stringify({checkedAt:new Date().toISOString(),id:entry.id,commit,requests:seen,files:observed,installed:true,approvalEvidence:'simulated-owner-approval-event',nativeSkillRead:true,retryReused:true,realModel},null,2)+'\n',{signal}))
 },()=>{try{dispose()}finally{globalThis.fetch=originalFetch;adoptRemoteUpstreamEntries(previous)}})
})
// 显式真实验收：未审子目录导入经宿主真实 fetch 适配器（含限流头转发）走 market/github/resolve；用例文件形如 {cases:[{owner,repo,ref,path}]}。
test('真实资源验收：未审 GitHub 子目录导入按 commit 对象的根树 sha 下降，只读必要树与目标文件，重放不重复请求',{skip:!process.env.TELOA_ACCEPTANCE_GITHUB_UNREVIEWED,timeout:900000},async t=>{
 type Seen={url:string;status:number;rateLimitRemaining:string|null}
 const seen:Seen[]=[],results:unknown[]=[]
 let current:{owner:string;repo:string;ref:string;path:string}|undefined
 return withLiveAcceptance(t,async scope=>{
  const spec=JSON.parse(await scope.run(5000,signal=>readFile(process.env.TELOA_ACCEPTANCE_GITHUB_UNREVIEWED!,{encoding:'utf8',signal}))) as {cases:{owner:string;repo:string;ref:string;path:string}[]}
  assert.ok(Array.isArray(spec.cases)&&spec.cases.length>0)
  const liveCall=(endpoint:string,payload:unknown)=>scope.run(180000,signal=>call(endpoint,payload,signal))
  globalThis.fetch=acceptanceFetch(scope,async(input,init)=>{
   const response=await originalFetch(input,init)
   seen.push({url:input instanceof Request?input.url:String(input),status:response.status,rateLimitRemaining:response.headers.get('x-ratelimit-remaining')});return response
  },(url,method)=>{
   assert.ok(current,'只在用例执行期间访问网络')
   assert.ok(url.protocol==='https:'&&!url.port&&!url.username&&!url.password&&['api.github.com','raw.githubusercontent.com'].includes(url.hostname),'真实资源验收只访问公开 GitHub 来源')
   assert.equal(method,'GET');assert.ok(!url.hash)
   const {owner,repo,ref,path}=current
   if(url.hostname==='api.github.com'){
    const api=`/repos/${owner}/${repo}/`
    assert.ok(url.pathname.startsWith(api),'只访问本仓库：'+url.pathname)
    const rest=url.pathname.slice(api.length)
    if(rest.startsWith('git/trees/')){assert.match(rest.slice('git/trees/'.length),/^[a-f0-9]{40}$/,'树只按 40 位 sha 请求');assert.ok(url.search===''||url.search==='?recursive=1','树请求只允许省略或 recursive=1：'+url.search)}
    else{assert.ok(rest===`commits/${encodeURIComponent(ref)}`||/^git\/commits\/[a-f0-9]{40}$/.test(rest),'API 只允许 commit 解析、commit 对象与固定树：'+rest);assert.equal(url.search,'')}
   }else{
    assert.equal(url.search,'')
    assert.match(url.pathname,new RegExp(`^/${owner}/${repo.replace(/[.]/g,'\\.')}/[a-f0-9]{40}/${path.replace(/[.]/g,'\\.')}/`),'raw 只读固定提交下目标子目录内的文件：'+url.pathname)
   }
  },120000)
  for(const item of spec.cases){
   current=item;seen.length=0
   const started=Date.now(),requestId=randomUUID()
   const receipt=await liveCall('market/github/resolve',{requestId,...item}) as {provenance:{resolvedCommit:string;archiveHash:string;path?:string};files:{path:string;hash:string;base64:string}[]}
   const commit=receipt.provenance.resolvedCommit
   assert.match(commit,/^[a-f0-9]{40}$/);if(/^[a-f0-9]{40}$/.test(item.ref))assert.equal(commit,item.ref,'40 位 ref 必须原样固定')
   assert.equal(receipt.provenance.path,item.path)
   assert.ok(receipt.files.length>=1&&receipt.files.every(file=>file.path.startsWith(item.path+'/')),'文件都在目标子目录内')
   assert.ok(receipt.files.some(file=>file.path===item.path+'/SKILL.md'),'目标子目录须含 SKILL.md')
   const paths=seen.map(row=>new URL(row.url).pathname)
   assert.ok(seen.every(row=>row.status===200),'全部请求须 200：'+JSON.stringify(seen.filter(row=>row.status!==200)))
   assert.equal(paths[0],`/repos/${item.owner}/${item.repo}/commits/${encodeURIComponent(item.ref)}`,'第一步用 vnd.github.sha 解析 commit')
   assert.equal(paths[1],`/repos/${item.owner}/${item.repo}/git/commits/${commit}`,'第二步读 commit 对象取根树 sha')
   const treeRefs=seen.filter(row=>new URL(row.url).pathname.includes('/git/trees/')).map(row=>{const url=new URL(row.url);return url.pathname.split('/git/trees/')[1]!+url.search})
   assert.ok(treeRefs[0]&&/^[a-f0-9]{40}$/.test(treeRefs[0])&&treeRefs[0]!==commit,'根树必须按 commit 对象里的根树 sha 请求，而不是按 commit：'+treeRefs[0])
   assert.equal(new Set(treeRefs).size,treeRefs.length,'同一树 sha 不得重复读取')
   assert.equal(treeRefs.filter(ref=>ref.endsWith('?recursive=1')).length,1,'只对目标子树递归一次')
   assert.equal(treeRefs.length,item.path.split('/').length+1,'根 + 每级祖先 + 目标子树递归：'+treeRefs.join(','))
   assert.ok(paths.every(path=>!path.includes('codeload')),'不下整仓归档')
   assert.equal(seen.filter(row=>new URL(row.url).hostname==='raw.githubusercontent.com').length,receipt.files.length,'raw 请求数等于文件数')
   const requests=seen.length
   const again=await liveCall('market/github/resolve',{requestId,...item}) as {provenance:{archiveHash:string}}
   assert.equal(again.provenance.archiveHash,receipt.provenance.archiveHash);assert.equal(seen.length,requests,'重放同一请求不再访问网络')
   results.push({...item,ok:true,ms:Date.now()-started,resolvedCommit:commit,archiveHash:receipt.provenance.archiveHash,rootTree:treeRefs[0],files:receipt.files.map(file=>({path:file.path,bytes:Buffer.from(file.base64,'base64').byteLength,sha256:file.hash})),requests:seen.slice(0,requests),replayExtraRequests:seen.length-requests})
  }
  current=undefined
  if(process.env.TELOA_ACCEPTANCE_GITHUB_UNREVIEWED_REPORT)await scope.run(5000,signal=>writeFile(process.env.TELOA_ACCEPTANCE_GITHUB_UNREVIEWED_REPORT!,JSON.stringify({checkedAt:new Date().toISOString(),boundary:'未审子目录导入经宿主 market/github/resolve 与真实 fetch 适配器；进程内隔离宿主、testcontainers PG、无固定端口；TELOA_USAGE_STATS='+process.env.TELOA_USAGE_STATS,results},null,2)+'\n',{signal}))
 },()=>{globalThis.fetch=originalFetch})
})
const skillBody=JSON.stringify({id:'weekly-report-check',title:'周报核对',version:'1.0.0',categories:[],files:[{path:'SKILL.md',base64:Buffer.from('---\nname: weekly-report-check\ndescription: Check weekly reports against sources.\n---\nCompare each claim with the cited source.\n').toString('base64')}]})

test('第 5–6 步：创建器只进本人普通会话；技能草案在创建器正文可见后才进入本人确认并保存',{timeout:180000},async()=>{
 const conversation=await call('conversations/create',{requestId:randomUUID(),title:'新建技能'}) as {sessionId:string;status:string}
 assert.equal(conversation.status,'ready')
 const handle=agents.get(conversation.sessionId)!
 const decision=await step(handle,'/teloa-skill-creator\n帮我做一个周报核对技能')
 assert.equal(decision.kind,'enter')
 const injected=decision.kind==='enter'?decision.messages.filter(message=>message.source.kind==='skill-invocation'):[]
 assert.equal(injected.length,1,'普通会话里 /teloa-skill-creator 注入固定版本正文')
 assert.ok(!(await ctx.skills.list()).some(skill=>skill.name==='teloa-skill-creator'),'global 视图看不到创建器')
 const stranger=await ctx.agents.create({sessionId:SessionId(randomUUID()),meta:{cwd:root},agentOptions:{provider:'test',model:'test'}})
 const strangerDecision=await step(stranger,'/teloa-skill-creator 做技能')
 assert.equal(strangerDecision.kind==='enter'?strangerDecision.messages.filter(message=>message.source.kind==='skill-invocation').length:-1,0,'未绑定为本人普通会话的 agent 看不到创建器')
 // 模拟真实回合：本轮一条用户指令，模型直接调用草案工具（未加载创建器）。
 const session=handle.agent.session
 session.append('turn/start',{turn:1})
 session.append('user/message',createUserMessage({source:{kind:'user',rpcId:brandString<SessionRequestId>('market-creator-turn')},content:[{type:'text',text:'帮我做一个周报核对技能'}]}),{surfaceOp:'append'})
 let asks=0
 ctx.on('approval/request',async()=>{asks++;return 'allowed-once'})
 const run=(callId:string)=>ctx.tools.execute({agent:handle.agent,name:'teloa_create_draft',arguments:{entity:'skill',body:skillBody},callId:ToolCallId(callId),signal:AbortSignal.timeout(20000)}) as Promise<{isError:boolean;content:unknown}>
 const denied=await run('creator-1')
 assert.equal(denied.isError,true);assert.match(JSON.stringify(denied.content),/teloa-skill-creator/);assert.equal(asks,0)
 // 真实循环会把 pre-step 注入的创建器正文追加进会话；这里把宿主产出的那一条原样追加。
 session.append('user/message',injected[0] as Message as never,{surfaceOp:'append'})
 const accepted=await run('creator-2')
 assert.equal(accepted.isError,false,JSON.stringify(accepted.content));assert.equal(asks,1)
 assert.match(JSON.stringify(accepted.content),/weekly-report-check/,'草案已保存并回显技能标识')
})

test('第 7 步：快照被改时目录停用，已安装技能不受影响',{timeout:60000},async()=>{
 const {OfficialCatalogService}=await import('@teloa/backend')
 const snapshot=await import('../../backend/src/market/official-catalog-snapshot.ts')
 const tampered={indexSha256:snapshot.officialCatalogIndexSha256,index:{...(snapshot.officialCatalogIndex as object),catalogVersion:'tampered'},files:snapshot.officialCatalogFiles}
 const service=new OfficialCatalogService({import:async()=>{throw Error('unused')},findByIdentity:async()=>null,findByCatalogSources:async()=>new Map<string,string>()},tampered)
 await assert.rejects(service.list({ownerId:owner,kind:'human'}),{code:'teloa/storage-corrupt'})
 assert.ok((await ctx.skills.list()).some(skill=>skill.name==='internal-comms'),'目录停用不影响已安装技能')
})

test('第 8 步：teloa- 前缀保留给内置技能——本人上传同名技能不能安装，不会被内置创建器静默遮住',{timeout:60000},async()=>{
 const text='---\nname: teloa-skill-creator\ndescription: 冒名的创建器。\n---\nbody\n'
 const imported=await call('market-content/import',{kind:'atomic-skill',requestId:randomUUID(),source:{kind:'upload',name:'冒名'},metadata:{id:'shadow-creator',title:'冒名',version:'1.0.0',categories:[]},files:[{path:'shadow/SKILL.md',base64:Buffer.from(text).toString('base64')}]}) as {content:{id:string}}
 const reply=await rpc('skill-installations/preview',{source:{kind:'atomic',contentId:imported.content.id}},new AbortController().signal)
 assert.equal(reply.ok,false);assert.equal(reply.error?.code,'teloa/invalid-input');assert.match(reply.error?.message??'',/保留/)
})

test('第 9 步：目录里的每个官方方案都能添加、加载到业务、岗位待配置，并用 role-work 关联的任务模板真实建任务',{timeout:300000},async()=>{
 // 全量超过一页 50 条，按 kind 取方案
 const listing=await call('market-catalog/list',{kind:'solution'}) as {items:{entry:{id:string;kind:string;solution?:{packageId:string;scope:string}};addedContentId:string|null}[]}
 const solutions=listing.items.filter(item=>item.entry.kind==='solution')
 assert.equal(solutions.length,18,'首批七个方案、扩充的六个通用方案、第二批四个方案与第三批中国企业办公协同都在目录里')
 for(const {entry} of solutions){
  type Added={receipt:{contentId:string;source:{kind:string;entryId:string}};content:{id:string;kind:string;logicalId:string;hash:string}}
  const {receipt,content}=await call('market-catalog/add',{requestId:randomUUID(),entryId:entry.id}) as Added
  assert.equal(receipt.source.kind,'catalog',entry.id);assert.equal(receipt.source.entryId,entry.id)
  assert.equal(content.id,receipt.contentId,entry.id)
  // 换一个请求身份再添加，得到同一份固定内容
  assert.equal((await call('market-catalog/add',{requestId:randomUUID(),entryId:entry.id}) as Added).receipt.contentId,receipt.contentId,entry.id)
  assert.equal(content.kind,'industry-template',entry.id)
  assert.equal(content.logicalId,entry.solution!.packageId,entry.id)
  // 个人版只有一个工作空间：每次按当前版本加载到这个空间
  const space=await call('business-spaces/current',{}) as {id:string;version:number}
  const load=await call('industry-loads/create',{requestId:randomUUID(),contentId:content.id,contentHash:content.hash,target:{kind:'existing',spaceId:space.id,expectedVersion:space.version}}) as {id:string;items:{instanceId:string;kind:string;status:string}[];relations:{kind:string;from:string;to:string}[]}
  const roles=load.items.filter(item=>item.kind==='role')
  assert.ok(roles.length>0,entry.id+' 至少一个岗位')
  for(const role of roles)assert.equal(role.status,'pending-adapter',entry.id+' 岗位以待配置状态创建，不自动上岗')
  const works=load.items.filter(item=>item.kind==='work-template')
  const linked=works.find(work=>load.relations.some(relation=>relation.kind==='role-work'&&relation.to.toLowerCase()===work.instanceId.toLowerCase()))
  assert.ok(linked,entry.id+' 至少一个任务模板与岗位 role-work 关联')
  const preview=await call('industry-tasks/preview',{loadId:load.id,itemInstanceId:linked!.instanceId}) as {requirements:string[]}
  assert.ok(preview.requirements.length>0,entry.id+' 任务预览列出输入要求')
  const {task}=await call('industry-tasks/create',{requestId:randomUUID(),loadId:load.id,itemInstanceId:linked!.instanceId,goal:entry.id+' 链路验收',inputs:preview.requirements.map(()=>'合成验收输入')}) as {task:{id:string}}
  assert.ok(task.id,entry.id+' 可建任务')
 }
})
