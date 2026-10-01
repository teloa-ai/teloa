/**
 * 群附件一期 功能验证：真 PostgreSQL ＋ 真 `/teloa` RPC handler ＋ 真 `AttachmentPorts` 的跨四包全链路。
 *
 * 这条用例守的是「接缝」——逐任务评审各看自己的包，跨包的错位只有真实宿主才暴露。
 * 因此这里不桩后端服务、不桩契约解析器、不桩附件仓：
 * - 数据库是 testcontainers 起的真 PostgreSQL，建表由 `apply()` 自己的 `initializeTeloaDatabase` 完成；
 * - 端点一律经 `apply()` 注册在 `/teloa` 上的那一个 handler（`ok/value/error` 回包），不直接调服务类；
 * - 附件字节经 T1 的 `createAttachmentPorts`，接的是真 `@deepseek-ai/dsh-attachment-local`（临时 `DSH_HOME`）。
 *
 * `sessionController.prompt` 由模型桩观察，原生日志通过真实 Session 追加并由 JSONL 落盘；
 * `ctx.llm.resolveModelInfo` 按用例切换视觉三态，Jobs、Team 和权限服务使用官方实现，
 * `ctx.fs` 是落在真实临时工作目录上的窄实现（三道路径闸与四个位置码走的仍是生产代码）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {createHash,randomBytes,randomUUID} from 'node:crypto'
import {readFileSync,realpathSync} from 'node:fs'
import {createRequire} from 'node:module'
import {mkdir,mkdtemp,readFile,rm,stat,symlink,writeFile} from 'node:fs/promises'
import {homedir} from 'node:os'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import {createAssistantMessage,createUserMessage} from '@deepseek-ai/dsh-llm'
import {SessionId,type Session} from '@deepseek-ai/dsh-session'
import {brandString} from '@deepseek-ai/dsh-brand'
import type {SessionRequestId} from '@deepseek-ai/dsh-api-session-controller'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {openResourceDatabase,groupFileHandleLine,groupModelNoVisionNotice,groupReferenceNotice,readStoredRunGroupContext,runGroupContextHash,type RunGroupContext} from '@teloa/backend'
import {groupAttachmentUploadRoutePath,groupRunMessageInput,workErrorCodes} from '@teloa/contract'
import {apply} from '../src/index.ts'
import {compositionEntries} from './fixtures/production-host.ts'
import {installNativeSessions,installNativeHostServices,controlTaskQueue} from './fixtures/native-host-services.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'

const repositoryRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..','..','..')
const owner='local:teloa-owner'
const sha256=(bytes:Uint8Array|string):string=>createHash('sha256').update(bytes).digest('hex')
const contains=(bytes:Uint8Array,marker:string):boolean=>Buffer.from(bytes).includes(Buffer.from(marker,'latin1'))
const wait=(ms:number)=>new Promise<void>(done=>{setTimeout(done,ms)})

/** 八个正式码；其余只允许 `workErrorCodes` 里已登记的既有位置码。 */
const officialCodes=['teloa/invalid-input','teloa/forbidden','teloa/version-conflict','teloa/conflict','teloa/dependency-unavailable','teloa/storage-corrupt','teloa/source-unavailable','teloa/invalid-host-response']
/** 既有位置码，逐字照抄 `contract/src/work-error.ts:11-39`；显式写出才有区分力，不能拿 `workErrorCodes` 顶替。 */
const positionCodes=['teloa/storage-unavailable','teloa/not-found','teloa/run-configuration-failed','teloa/binding-pending','teloa/cancelled','teloa/copy-in-progress','teloa/copy-lineage-mismatch','teloa/copy-result-unknown','teloa/execution-pending','teloa/file-changed','teloa/file-scope','teloa/file-too-large','teloa/file-unavailable','teloa/flow-not-required','teloa/host-unavailable','teloa/invalid-reference','teloa/not-bound','teloa/preset-unavailable','teloa/resource-withdrawn','teloa/session-not-adoptable','teloa/session-unavailable','teloa/skill-unavailable','teloa/snapshot-conflict','teloa/source-conflict','teloa/source-invalid','teloa/unavailable','teloa/workspace-unavailable']

/**
 * 在 JPEG 的 SOI 之后插一段合法 APP1 Exif（IFD0 只有一个 Orientation 项）。
 * 逐字照抄 `scripts/探针-群附件仓往返.mjs`，让本用例与 T1 探针看同一份输入。
 */
function withExif(jpeg:Buffer):Buffer{
 const tiff=Buffer.from([0x49,0x49,0x2a,0x00,0x08,0x00,0x00,0x00,0x01,0x00,0x12,0x01,0x03,0x00,0x01,0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x00,0x00,0x00,0x00])
 const payload=Buffer.concat([Buffer.from('Exif\0\0','latin1'),tiff])
 const header=Buffer.from([0xff,0xe1,(payload.length+2)>>8,(payload.length+2)&0xff])
 return Buffer.concat([jpeg.subarray(0,2),header,payload,jpeg.subarray(2)])
}

/** 通过当前锁定宿主解析传递依赖，pnpm 存储可同时保留历史版本。 */
async function loadLocalAttachmentStore():Promise<new(...args:never[])=>unknown>{
 const hostRequire=createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
 const module=await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-attachment-local')).href) as {default:new(...args:never[])=>unknown}
 return module.default
}

type PromptRecord={sessionId:string;requestId:string;content:Array<Record<string,unknown>>}
type FsTargetLike={targetKey:string;displayPath:string}

/** 模型结果由用例控制，追加和落盘仍经官方 Session。 */
function finishSession(session:Session,text:string){
 session.append('assistant/message',{turn:1,step:1,message:createAssistantMessage({source:{provider:'stub',model:'stub-model'},content:[{type:'text',text}]}),stream:[]},{surfaceOp:'append'})
 session.append('turn/end',{turn:1,reason:{kind:'completed'}})
}

/**
 * 会话、附件仓和后台服务使用官方实例；模型侧和能力侧由用例逐步切换。
 */
function teloaHost(attachmentStore:unknown,dshHome:string){
 const ctx=new Context()
 const tools:Array<{name:string;execute:(args:unknown,exec:unknown)=>Promise<unknown>}>=[]
 const workspaces=new Map<string,{id:string;path:string}>()
 const prompts:PromptRecord[]=[]
 let rpc:((endpoint:string,payload:unknown,signal:AbortSignal)=>Promise<{ok:boolean;value?:unknown;error?:{code:string;message:string;details:Record<string,unknown>}}>)|undefined
type UploadRoute={path:string;fetch:(request:Request)=>Promise<Response>}
let uploadRoute:UploadRoute|undefined
 /** 视觉能力三态：`undefined` 即读不出（`readModelVision` 按 `'unknown'` 判）。 */
 let modelInfo:{inputModalities:string[]}|undefined={inputModalities:['text','image']}
 /** 置真时，带 image 部件的那次 prompt 按上游的 `session/attachment-invalid` 拒绝。 */
 let rejectImages=false

 const agentOf=(id:string)=>{const agent=ctx.agents.get(SessionId(id));assert.ok(agent,'会话必须已经由原生 AgentRegistry 创建');return agent}
 const sessionOf=(id:string)=>agentOf(id).session

 ctx.provide('loader',compositionEntries())
 ctx.provide('workspaceRegistry',{
  create:async(path:string)=>{
   const found=[...workspaces.values()].find(entry=>entry.path===path)
   if(found)return found
   const entry={id:'teloa-workspace-'+String(workspaces.size+1),path}
   workspaces.set(entry.id,entry);return entry
  },
  get:(id:string)=>workspaces.get(id),
  list:()=>[...workspaces.values()],
 })
 ctx.provide('sessionController',{
  create:async(input:{sessionId?:string;agentPreset?:string;workspaceId?:string}={})=>{
   const id=input.sessionId??randomUUID()
   const cwd=(input.workspaceId===undefined?undefined:workspaces.get(input.workspaceId)?.path)??[...workspaces.values()][0]?.path
   await ctx.agents.create({sessionId:SessionId(id),meta:{...(cwd===undefined?{}:{cwd}),...(input.agentPreset===undefined?{}:{agentPreset:input.agentPreset})},agentOptions:{provider:'stub',model:'stub-model'}})
   controlTaskQueue(ctx,agentOf(id))
   return {sessionId:id,...(input.agentPreset===undefined?{}:{agentPreset:input.agentPreset})}
  },
  fork:async()=>({sessionId:randomUUID()}),
  inspect:async(sessionId:string)=>({meta:sessionOf(sessionId).header}),
  resolveAgent:async(sessionId:string)=>({agent:agentOf(sessionId)}),
  modelCatalog:async()=>({default:{provider:'stub',model:'stub-model'}}),
  cancel:()=>({accepted:true}),
  prompt:(request:{sessionId:string;requestId:string;content:Array<Record<string,unknown>>})=>{
   const images=request.content.some(part=>part.type==='image')
   if(images&&rejectImages)throw Object.assign(Error('images rejected'),{code:'session/attachment-invalid'})
   prompts.push({sessionId:request.sessionId,requestId:request.requestId,content:request.content})
   const session=sessionOf(request.sessionId)
   session.append('turn/start',{turn:1})
   session.append('user/message',createUserMessage({content:[],source:{kind:'user',rpcId:brandString<SessionRequestId>(request.requestId)}}),{surfaceOp:'append'})
  },
 })
 ctx.provide('tools',{register:(definition:unknown)=>{tools.push(definition as {name:string;execute:(args:unknown,exec:unknown)=>Promise<unknown>})},schemas:()=>[],guard:()=>()=>{},restrict:()=>()=>{}})
 ctx.provide('skills',{
  list:async()=>[],
  registerProvider:(factory:(control:{invalidate:()=>void;signal:AbortSignal})=>unknown)=>{factory({invalidate:()=>{},signal:new AbortController().signal});return ()=>{}},
 })
 ctx.provide('agentPresets',{serviceFor:()=>undefined,acquireScope:async()=>({key:{},async [Symbol.asyncDispose](){}}),resolve:async(id?:string)=>({id:id??'default-agent'})})
 ctx.provide('tokenMeter',{measure:()=>({totalTokens:0})})
 ctx.provide('llm',{resolveModelInfo:async()=>modelInfo,resolveCallConfig:async(config:unknown)=>config})
 // 真实临时工作目录上的窄文件系统：`artifact-files.ts` 的三道闸与位置码走的仍是生产代码。
 ctx.provide('fs',{
  resolve:async(path:string,opts?:{cwd?:string})=>({targetKey:resolve(opts?.cwd??'/',path),displayPath:path}) as FsTargetLike,
  contains:(root:FsTargetLike,target:FsTargetLike)=>target.targetKey===root.targetKey||target.targetKey.startsWith(root.targetKey+'/'),
  processPath:(target:FsTargetLike)=>{try{return realpathSync(target.targetKey)}catch{return target.targetKey}},
  stat:async(target:FsTargetLike)=>{
   try{const found=await stat(target.targetKey);return {version:`${String(found.mtimeMs)}-${String(found.size)}`,type:found.isDirectory()?'directory':'file',size:found.size}}
   catch{return undefined}
  },
  readBytes:async(target:FsTargetLike)=>new Uint8Array(await readFile(target.targetKey)),
 })
 ctx.provide('fileReferences',{list:async()=>[]})
 // 上传走宿主注册的 /api 专用流式路由（与浏览器同一条）：收下路由，runtime.rpc 把上传端点转给它，其余端点照走 /teloa。
 ctx.provide('connection',{
  fetch:{register:(route:UploadRoute)=>{assert.equal(route.path,groupAttachmentUploadRoutePath);uploadRoute=route;return async()=>{uploadRoute=undefined}}},
  rpc:{handle:(path:string,handler:typeof rpc)=>{assert.equal(path,'/teloa');rpc=handler;return ()=>{rpc=undefined}}},
 })
 // 真附件仓：`index.ts` 按 `Reflect.get(ctx,'attachments')` 取它，与生产同一条路。
 const ready=ctx.plugin(attachmentStore as never,{dshHome} as never)

 return {
  ctx,tools,prompts,sessionOf,
  ready:async()=>{await installNativeSessions(ctx);await installNativeHostServices(ctx,dshHome);await ready;assert.ok(Reflect.get(ctx,'attachments'),'真附件仓必须已挂上 ctx.attachments')},
  setVision:(value:'supported'|'unsupported'|'unknown')=>{modelInfo=value==='unknown'?undefined:{inputModalities:value==='supported'?['text','image']:['text']}},
  setRejectImages:(value:boolean)=>{rejectImages=value},
  get rpc(){
   assert.ok(rpc,'/teloa handler 尚未注册')
   const teloa=rpc
   return async(endpoint:string,payload:unknown,signal:AbortSignal)=>{
    if(endpoint!=='groups/attachments/upload')return teloa(endpoint,payload,signal)
    assert.ok(uploadRoute,'上传专用路由尚未注册')
    const body=JSON.stringify(payload)
    const response=await uploadRoute.fetch(new Request('http://127.0.0.1'+groupAttachmentUploadRoutePath,{method:'POST',headers:{'content-type':'application/json','content-length':String(Buffer.byteLength(body))},body,signal}))
    return await response.json() as {ok:boolean;value?:unknown;error?:{code:string;message:string;details:Record<string,unknown>}}
   }
  }
 }
}

test('群附件从上传到看图与同事贴回：真库、真端点、真附件仓的跨四包全链路',{timeout:600_000},async t=>{
 // ---------- 装配 ----------
 const previousProjectRoot=process.env.TELOA_PROJECT_ROOT
 process.env.TELOA_PROJECT_ROOT=repositoryRoot
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 // 受管目录逐层拒绝符号链接；macOS 的 /var/tmp 恰有系统链接，临时根放在工作树内（照 production-wiring）。
 const root=await mkdtemp(join(repositoryRoot,'.tmp-群附件链路-'))
 const dshHome=await mkdtemp(join(repositoryRoot,'.tmp-群附件仓-'))
 const container=await new PostgreSqlContainer('postgres:17-alpine').withDatabase('teloa').start()
 const connectionString=container.getConnectionUri()
 const config=join(root,'.runtime/teloa/database.json')
 await mkdir(join(root,'.runtime/teloa/skills'),{recursive:true,mode:0o700})
 await writeFile(config,JSON.stringify({connectionString}),{mode:0o600})
 await mkdir(join(root,'.runtime/dsh/profiles/teloa'),{recursive:true,mode:0o700})
 await writeFile(join(root,'.runtime/dsh/profiles/teloa/package.json'),JSON.stringify({dsh:{profile:{bundles:[],patchReload:'startup'}}}),{mode:0o600})

 const LocalAttachmentStore=await loadLocalAttachmentStore()
 const runtime=teloaHost(LocalAttachmentStore,dshHome)
 await runtime.ready()
 await apply(runtime.ctx,{projectRoot:root})
 const database=await openResourceDatabase(config,{id:randomUUID,now:()=>new Date().toISOString()})
 const pool=database.pool
 t.after(async()=>{
  if(previousProjectRoot===undefined)delete process.env.TELOA_PROJECT_ROOT;else process.env.TELOA_PROJECT_ROOT=previousProjectRoot
  await runtime.ctx.fiber.dispose().catch(()=>{})
  await pool.end().catch(()=>{})
  await container.stop()
  await rm(root,{recursive:true,force:true})
  await rm(dshHome,{recursive:true,force:true})
 })

 // ---------- RPC 调用与错误账本 ----------
 const calls=new Map<string,number>()
 const failures:Array<{endpoint:string;code:string;message:string;details:Record<string,unknown>}>=[]
 const rpcCall=async(endpoint:string,payload:unknown):Promise<unknown>=>{
  calls.set(endpoint,(calls.get(endpoint)??0)+1)
  const reply=await runtime.rpc(endpoint,payload,new AbortController().signal)
  if(reply.ok===true)return reply.value
  const error=reply.error as {code:string;message:string;details:Record<string,unknown>}
  failures.push({endpoint,code:error.code,message:error.message,details:error.details})
  throw Object.assign(new Error(`${endpoint} → ${error.code}：${error.message}`),{code:error.code,rpcDetails:error.details})
 }
 const rpcError=async(endpoint:string,payload:unknown):Promise<{code:string;message:string;details:Record<string,unknown>}>=>{
  try{await rpcCall(endpoint,payload)}catch(error){
   const code=(error as {code?:unknown}).code
   assert.equal(typeof code,'string',`${endpoint} 应当回一个 WorkError`)
   const recorded=failures[failures.length-1]!
   return {code:recorded.code,message:recorded.message,details:recorded.details}
  }
  throw new Error(`${endpoint} 本应被拒绝却成功了`)
 }
 const countOf=async(table:string):Promise<number>=>Number((await pool.query(`select count(*)::int as count from ${table} where owner_id=$1`,[owner])).rows[0].count)
 const counts=async()=>({snapshots:await countOf('teloa_artifact_snapshots'),versions:await countOf('teloa_artifact_versions'),attachments:await countOf('teloa_attachments'),messages:await countOf('teloa_group_messages')})

 // ---------- 第 1 步：建群 ＋ 拉一位在岗同事 ----------
 const role=await rpcCall('roles/create',{requestId:randomUUID(),fields:{name:'SOC 研判员',kind:'employee',scopes:['SOC'],duty:'研判固定告警资料',dataScope:'固定资料',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'soc-analyst'}}}) as {id:string;version:number;state:string}
 // 置在岗这一步是**直写 SQL**，不是走端点：岗位上岗另有一条与本期无关的流程，这里只要一个在岗同事做前置。
 await pool.query("update teloa_roles set state='active' where owner_id=$1 and id=$2",[owner,role.id])
 const activeRole={id:role.id,version:role.version}
 const rules={historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true}
 const groupA=await rpcCall('groups/create',{requestId:randomUUID(),expectedVersion:0,fields:{name:'SOC 研判群',scope:'SOC',announcement:'仅使用已固定资料。',rules,memberRoleIds:[activeRole.id]}}) as {id:string;version:number}
 const groupB=await rpcCall('groups/create',{requestId:randomUUID(),expectedVersion:0,fields:{name:'第二研判群',scope:'SOC',announcement:'跨群引用验收。',rules,memberRoleIds:[activeRole.id]}}) as {id:string;version:number}
 await t.test('第 1 步：建群并拉一位在岗同事',()=>{
  assert.equal(typeof groupA.id,'string');assert.equal(typeof groupB.id,'string')
  assert.notEqual(groupA.id,groupB.id)
 })

 // ---------- 第 2 步：三件原件上传 ----------
 const jpegSource=withExif(await readFile(join(repositoryRoot,'tests/fixtures/原生附件边界/格式验收.jpg')))
 const gifSource=await readFile(join(repositoryRoot,'tests/fixtures/原生附件边界/动画验收.gif'))
 const markdownSource=Buffer.from('# 样本\n\n这是一份进模型的文本附件正文。\n','utf8')
 assert.ok(contains(jpegSource,'Exif'),'夹具自身必须含 Exif 段，否则第 13 步无从证明')
 const uploadRequestIds={image:randomUUID(),gif:randomUUID(),markdown:randomUUID()}
 const uploadOf=async(requestId:string,mime:string,name:string,bytes:Buffer)=>await rpcCall('groups/attachments/upload',{requestId,groupId:groupA.id,expectedVersion:groupA.version,mime,name,dataBase64:bytes.toString('base64')}) as {attachment:Record<string,unknown>}
 const imageRow=(await uploadOf(uploadRequestIds.image,'image/jpeg','格式验收.jpg',jpegSource)).attachment
 await wait(5)
 const gifRow=(await uploadOf(uploadRequestIds.gif,'image/gif','动画验收.gif',gifSource)).attachment
 await wait(5)
 const markdownRow=(await uploadOf(uploadRequestIds.markdown,'text/markdown','样本.md',markdownSource)).attachment
 await t.test('第 2 步：三行元数据的 kind、摘要与像素事实',()=>{
  assert.equal(imageRow.kind,'image');assert.equal(gifRow.kind,'file');assert.equal(markdownRow.kind,'file')
  assert.equal(Object.keys(imageRow).length,14,'元数据回包仍是 14 键')
  assert.notEqual(imageRow.sha256,String(imageRow.attachmentId).replace(/^sha256:/,''),'图片的 sha256 是上传原字节的摘要，不等于归一化后的 attachmentId')
  assert.equal(imageRow.sha256,sha256(jpegSource))
  assert.equal(gifRow.width,null);assert.equal(gifRow.height,null)
  assert.equal(typeof imageRow.width,'number');assert.equal(typeof imageRow.height,'number')
 })

 // ---------- 第 3 步：list 倒序 ----------
 const listed=await rpcCall('groups/attachments/list',{groupId:groupA.id}) as {items:Array<Record<string,unknown>>}
 await t.test('第 3 步：list 按上传时刻倒序回三条',()=>{
  assert.deepEqual(listed.items.map(item=>item.name),['样本.md','动画验收.gif','格式验收.jpg'])
 })

 // ---------- 第 4 步：引用三条附件 ＋ 一条群资料发群消息 ----------
 const resource=await rpcCall('groups/resources/save',{requestId:randomUUID(),groupId:groupA.id,resourceId:randomUUID(),expectedVersion:0,title:'EDR 告警证据',markdown:'# alert-001\n\n进程树与主机证据。'}) as {id:string;version:number}
 const references=[
  {kind:'attachment',id:String(imageRow.attachmentId),version:1},
  {kind:'attachment',id:String(gifRow.attachmentId),version:1},
  {kind:'attachment',id:String(markdownRow.attachmentId),version:1},
  {kind:'group-resource',id:resource.id,version:resource.version},
 ]
 const rootMessage=await rpcCall('groups/messages/send',{requestId:randomUUID(),groupId:groupA.id,expectedVersion:groupA.version,text:'请结合附件分析 alert-001 的影响。',references}) as Record<string,unknown>
 await t.test('第 4 步：回包仍 8 键，四条引用各带 kind',()=>{
  assert.deepEqual(Object.keys(rootMessage).sort(),['authorId','createdAt','groupId','id','mentions','references','rootId','text'])
  assert.equal(rootMessage.authorId,'self')
  assert.deepEqual(rootMessage.references,references)
 })

 // ---------- 第 5 步：跨群引用 ----------
 const crossGroupAttachment=await rpcCall('groups/messages/send',{requestId:randomUUID(),groupId:groupB.id,expectedVersion:groupB.version,text:'跨群引用本人原件。',references:[{kind:'attachment',id:String(imageRow.attachmentId),version:1}]}) as Record<string,unknown>
 const crossGroupResource=await rpcError('groups/messages/send',{requestId:randomUUID(),groupId:groupB.id,expectedVersion:groupB.version,text:'跨群引用别群资料。',references:[{kind:'group-resource',id:resource.id,version:resource.version}]})
 await t.test('第 5 步：附件跨群可引用，群资料跨群被拒',()=>{
  assert.deepEqual(crossGroupAttachment.references,[{kind:'attachment',id:String(imageRow.attachmentId),version:1}])
  assert.equal(crossGroupResource.code,'teloa/forbidden')
 })

 // ---------- 第 5b 步：贴密钥群消息在待恢复登记之前拒收（规格 §6） ----------
 // 直接调 /teloa：这两次拒收带 details，不进第 22 步「不带 details」的错误账本。
 const rawError=async(endpoint:string,payload:unknown)=>{const reply=await runtime.rpc(endpoint,payload,new AbortController().signal);assert.equal(reply.ok,false,endpoint+' 本应被拒绝');return reply.error as {code:string;message:string;details:Record<string,unknown>}}
 const registryRows=async(requestId:string)=>Number((await pool.query('select count(*)::int as count from teloa_pending_request_registry where request_id=$1',[requestId])).rows[0].count)
 const leaked='gh'+'p_'+randomBytes(18).toString('hex'),beforeSecret=await counts()
 const secretRequestId=randomUUID()
 const secretSend=await rawError('groups/messages/send',{requestId:secretRequestId,groupId:groupA.id,expectedVersion:groupA.version,text:'看看这个 '+leaked})
 // 旧版本先登记、后拒收留下的同一请求（含原文）：恢复重放被拒即删除。
 const secretLegacyRequestId=randomUUID()
 await pool.query("insert into teloa_pending_request_registry(owner_id,request_id,endpoint,request_spec,state,created_at,updated_at) values($1,$2,'groups/messages/send',$3,'pending',now(),now())",[owner,secretLegacyRequestId,JSON.stringify({requestId:secretLegacyRequestId,groupId:groupA.id,expectedVersion:groupA.version,text:'旧的 '+leaked})])
 const legacyRecover=await rawError('requests/pending/recover',{requestId:secretLegacyRequestId})
 await t.test('第 5b 步：贴密钥群消息不入待恢复表、不落库；已登记的同一请求拒收后删除',async()=>{
  assert.equal(secretSend.code,'teloa/invalid-input')
  assert.deepEqual(secretSend.details,{reason:'secret-in-message',kinds:['github']})
  assert.equal(secretSend.message.includes(leaked.slice(4,12)),false)
  assert.equal(await registryRows(secretRequestId),0)
  assert.equal(legacyRecover.code,'teloa/invalid-input')
  assert.equal(await registryRows(secretLegacyRequestId),0)
  assert.deepEqual(await counts(),beforeSecret)
 })

 // ---------- 第 6 步：三种不可见引用给同一句话 ----------
 const withdrawnAttachmentId=String((await rpcCall('groups/attachments/upload',{requestId:randomUUID(),groupId:groupA.id,expectedVersion:groupA.version,mime:'text/plain',name:'待撤回.txt',dataBase64:Buffer.from('待撤回正文','utf8').toString('base64')}) as {attachment:{attachmentId:string}}).attachment.attachmentId)
 await rpcCall('groups/attachments/withdraw',{requestId:randomUUID(),attachmentId:withdrawnAttachmentId})
 const withdrawnResource=await rpcCall('groups/resources/save',{requestId:randomUUID(),groupId:groupA.id,resourceId:randomUUID(),expectedVersion:0,title:'待撤回资料',markdown:'# 待撤回\n\n正文。'}) as {id:string;version:number}
 await rpcCall('groups/resources/withdraw',{requestId:randomUUID(),groupId:groupA.id,resourceId:withdrawnResource.id,expectedVersion:withdrawnResource.version})
 const invisible=[
  await rpcError('groups/messages/send',{requestId:randomUUID(),groupId:groupA.id,expectedVersion:groupA.version,text:'引用已撤回附件。',references:[{kind:'attachment',id:withdrawnAttachmentId,version:1}]}),
  await rpcError('groups/messages/send',{requestId:randomUUID(),groupId:groupA.id,expectedVersion:groupA.version,text:'引用已撤回资料。',references:[{kind:'group-resource',id:withdrawnResource.id,version:withdrawnResource.version}]}),
  await rpcError('groups/messages/send',{requestId:randomUUID(),groupId:groupA.id,expectedVersion:groupA.version,text:'引用不存在的成果版本。',references:[{kind:'artifact',id:randomUUID(),version:1}]}),
 ]
 await t.test('第 6 步：三种不可见引用的 code 与 message 完全相同',()=>{
  // 一次比完三条：让失败的 diff 直接给出「哪一条与另外两条不同」。
  assert.deepEqual([invisible[1],invisible[2]],[invisible[0],invisible[0]])
 })

 // ---------- 第 7 步：按 {kind,id,version} 授权三条附件 ----------
 const attachmentGrants=references.filter(item=>item.kind==='attachment')
 const partialGrant=await rpcCall('groups/agent-grants/change',{requestId:randomUUID(),groupId:groupA.id,roleId:activeRole.id,expectedGroupVersion:groupA.version,expectedRoleVersion:activeRole.version,action:'save',resources:attachmentGrants,canPost:true,canAutoRun:false}) as Record<string,unknown>
 await t.test('第 7 步：授权回包仍 10 键',()=>{
  assert.deepEqual(Object.keys(partialGrant).sort(),['canAutoRun','canPost','createdAt','grantVersion','groupId','groupVersion','resources','roleId','roleVersion','state'])
  assert.deepEqual(partialGrant.resources,attachmentGrants)
 })

 // ---------- 第 8 步：从群消息建任务 ----------
 const created=await rpcCall('groups/tasks/create',{requestId:randomUUID(),groupId:groupA.id,messageId:String(rootMessage.id),expectedGroupVersion:groupA.version,goal:'给出可审计的研判结论。',assignee:{roleId:activeRole.id,expectedVersion:activeRole.version}}) as {task:{id:string;version:number;scope:string};source:Record<string,unknown>}
 const sourceRow=(await pool.query('select * from teloa_group_task_sources where owner_id=$1 and task_id=$2',[owner,created.task.id])).rows[0]
 const storedSource=await rpcCall('groups/tasks/source',{taskId:created.task.id}) as Record<string,unknown>
 await t.test('第 8 步：source 仍 13 键、四条引用都在、snapshot_digest 对得上',()=>{
  assert.equal(Object.keys(created.source).length,13)
  assert.deepEqual(created.source.references,references)
  assert.ok(sourceRow,'库里必须有这条来源快照')
  assert.match(String(sourceRow.snapshot_digest),/^[a-f0-9]{64}$/)
  assert.deepEqual(storedSource,created.source)
 })

 // ---------- 第 9 步：未授权的群资料整次拒绝，补授权后成功 ----------
 const refusedPrepare=await rpcError('task-runs/prepare',{requestId:randomUUID(),taskId:created.task.id,expectedTaskVersion:created.task.version})
 const fullGrant=await rpcCall('groups/agent-grants/change',{requestId:randomUUID(),groupId:groupA.id,roleId:activeRole.id,expectedGroupVersion:groupA.version,expectedRoleVersion:activeRole.version,action:'save',resources:references,canPost:true,canAutoRun:false}) as {grantVersion:number}
 const runOne=await rpcCall('task-runs/prepare',{requestId:randomUUID(),taskId:created.task.id,expectedTaskVersion:created.task.version}) as {id:string;sessionId:string;nativeRequestId:string;state:string;groupContext?:RunGroupContext;inputText:string}
 await t.test('第 9 步：少一条授权即整次拒绝，补齐后准备成功',()=>{
  assert.equal(refusedPrepare.code,'teloa/forbidden')
  assert.equal(runOne.state,'prepared')
  assert.ok(runOne.groupContext,'群任务必须带执行上下文')
 })

 // ---------- 第 10 步：RunGroupContext 的 materials 与 files ----------
 const contextOne=runOne.groupContext!
 await t.test('第 10 步：materials 结构逐字不变，files 三项按 kind 分流',()=>{
  assert.equal(contextOne.materials.length,1)
  assert.deepEqual(Object.keys(contextOne.materials[0]!).sort(),['markdown','resourceId','resourceVersion','title'])
  assert.equal(contextOne.files.length,3)
  const byName=new Map(contextOne.files.map(file=>[file.name,file]))
  const markdownFile=byName.get('样本.md')!,imageFile=byName.get('格式验收.jpg')!,gifFile=byName.get('动画验收.gif')!
  assert.equal(markdownFile.text,markdownSource.toString('utf8'))
  assert.equal(imageFile.text,undefined);assert.equal(gifFile.text,undefined)
  assert.equal(typeof imageFile.width,'number');assert.equal(typeof imageFile.height,'number')
  assert.equal(gifFile.width,undefined);assert.equal(gifFile.height,undefined)
 })

 // ---------- 第 11 步：input_text 的句柄行与提示语 ----------
 const runOneRow=(await pool.query('select input_text,group_context_hash from teloa_task_runs where owner_id=$1 and id=$2',[owner,runOne.id])).rows[0]
 const inputText=String(runOneRow.input_text)
 await t.test('第 11 步：input_text 含句柄行与 groupReferenceNotice，不含 base64；句柄行内 id 只给前 8 位',()=>{
  // 四条事实一次比完：失败时 diff 直接给出哪几条没成立，不被第一条挡住。
  // 第四条原为「input_text 不含完整 attachmentId」，编排者裁定改判为「句柄行内只给前 8 位」：
  // input_text 兼作 groupContext 的持久化真源，task-runs.ts:133 要靠完整 attachmentId 还原机器面
  // （哈希核验）、task-run-dsh.ts:174 要靠它发图，分离机器面需给 teloa_task_runs 加列，与计划 §7
  // 「既有表零改动，零加列」冲突；计划 :179「id 只给前 8 位」约束的本就是句柄行逐字格式本身。
  assert.deepEqual({
   含句柄行:contextOne.files.every(file=>inputText.includes(groupFileHandleLine(file))),
   含引用提示语:inputText.includes(groupReferenceNotice),
   含base64:inputText.includes(jpegSource.toString('base64').slice(0,64)),
   句柄行只给id前8位:contextOne.files.every(file=>{const line=groupFileHandleLine(file);return line.includes(`${file.kind}#${file.id.slice(0,8)} v${file.version}`)&&!line.includes(file.id)}),
  },{含句柄行:true,含引用提示语:true,含base64:false,句柄行只给id前8位:true})
 })

 // ---------- 第 12 步：哈希与 8 键旧快照锚 ----------
 const legacyContext={taskId:contextOne.taskId,groupId:contextOne.groupId,groupVersion:contextOne.groupVersion,roleId:contextOne.roleId,roleVersion:contextOne.roleVersion,grantVersion:contextOne.grantVersion,source:contextOne.source,materials:contextOne.materials}
 const legacyHash=sha256(JSON.stringify(legacyContext))
 const legacyRunId=randomUUID(),legacySessionId='legacy-session-'+legacyRunId,legacyRequestId=randomUUID()
 // 把 runOne 的 input_text 退回两步形状：groupContext 去掉 T7 才加的 files 键，整份去掉本期才加的 groupReference 段。
 // skills 一并清空（连同 role_skills 落 '[]'），免得旧行去查它自己没有的 Skill 引用行，把本条变成 Skill 用例。
 const legacyInput=JSON.parse(String(runOneRow.input_text))
 delete legacyInput.groupContext.files
 delete legacyInput.groupReference
 delete legacyInput.skills
 // 不吞失败：这一行必须真的落库，第 12 步才有东西可读回（漏列会当场炸，而不是让断言空转）。
 // state 落 'withdrawn'：teloa_task_run_active_task_v3 是 (owner_id,task_id) 的偏唯一索引，
 // 同一任务不能有第二条在用的执行；已撤回的行照样要能读回来，正是本条要钉的事。
 await pool.query(
  `insert into teloa_task_runs(id,owner_id,request_id,request_spec,task_id,task_version,role_id,role_version,link_version,session_id,native_request_id,state,input_text,created_at,group_context_hash,allowed_tools,role_skills,role_knowledge,role_memory,tool_argument_rules,agent_preset_id,evidence,task_state_version,plan_context_hash,industry_context_hash,business_context_hash,flow_id,stop_requested_at,configuration_error)
   select $1,owner_id,$2::uuid,jsonb_build_object('requestId',$2::uuid::text,'taskId',task_id::text,'expectedTaskVersion',task_version,'roleId',role_id::text,'expectedRoleVersion',role_version,'sessionId',$3::text,'expectedLinkVersion',link_version),
    task_id,task_version,role_id,role_version,link_version,$3,$4,'withdrawn',$5,created_at,$6,
    allowed_tools,'[]'::jsonb,role_knowledge,role_memory,tool_argument_rules,agent_preset_id,evidence,task_state_version,plan_context_hash,industry_context_hash,business_context_hash,flow_id,stop_requested_at,configuration_error
   from teloa_task_runs where owner_id=$7 and id=$8`,
  [legacyRunId,legacyRequestId,legacySessionId,randomUUID(),JSON.stringify(legacyInput),legacyHash,owner,runOne.id]
 )
 // 经真端点读回：旧行（无 files、无 groupReference）不得被判成 teloa/storage-corrupt，否则在途群 Run 整批读废。
 const listedRuns=await rpcCall('task-runs/list',{taskId:created.task.id}) as Array<{id:string;groupContext?:{files:unknown[]}}>
 const legacyStored=(await pool.query('select group_context_hash from teloa_task_runs where owner_id=$1 and id=$2',[owner,legacyRunId])).rows[0]
 await t.test('第 12 步：现行哈希对得上；8 键旧快照经真端点读得回来且哈希逐字相等',()=>{
  assert.equal(String(runOneRow.group_context_hash),runGroupContextHash(contextOne))
  const restored=readStoredRunGroupContext(legacyContext)!
  assert.equal(runGroupContextHash(restored),legacyHash,'旧快照（无 files 键）的哈希必须与改前逐字相同')
  assert.deepEqual(restored.files,[])
  assert.ok(legacyStored,'旧形状那一行必须真的落库')
  const legacyRun=listedRuns.find(item=>item.id===legacyRunId)
  assert.ok(legacyRun,'无 files / 无 groupReference 的旧行必须出现在 task-runs/list 的回包里')
  assert.deepEqual(legacyRun!.groupContext?.files,[],'旧行的 files 回落成空数组')
  assert.equal(String(legacyStored.group_context_hash),legacyHash)
 })

 // ---------- 第 13 步：EXIF 守卫与反向断言 ----------
 const imageBytes=await rpcCall('groups/attachments/read',{attachmentId:String(imageRow.attachmentId)}) as {bytes:{dataBase64:string;sha256:string;bytes:number}}
 const decodedImage=Buffer.from(imageBytes.bytes.dataBase64,'base64')
 const workspacePath=runtime.sessionOf(runOne.sessionId).header.cwd!
 await writeFile(join(workspacePath,'原图.jpg'),jpegSource)
 const capturedConversation=await rpcCall('conversations/create',{requestId:randomUUID(),title:'成果抓取会话'}) as {sessionId:string}
 assert.equal(runtime.sessionOf(capturedConversation.sessionId).header.cwd,workspacePath)
 const captured=await rpcCall('artifacts/capture',{sessionId:capturedConversation.sessionId,path:'原图.jpg',expectedSha256:sha256(jpegSource)}) as {snapshotId:string}
 const capturedBack=await rpcCall('artifacts/snapshot',{snapshotId:captured.snapshotId}) as {contentBase64:string}
 await t.test('第 13 步：附件读回已剥 EXIF 且摘要自洽；成果通道反向仍含 EXIF',()=>{
  assert.equal(contains(decodedImage,'Exif'),false,'附件读回的字节不得含 Exif')
  assert.equal(contains(decodedImage,'ICC_PROFILE'),false,'附件读回的字节不得含 ICC_PROFILE')
  // 反向断言先跑：规格 §7.2 逐字要求它，不能被下一条的红挡住。
  assert.ok(contains(Buffer.from(capturedBack.contentBase64,'base64'),'Exif'),'成果通道（artifacts/capture）读回的字节仍应含 EXIF')
  assert.equal(sha256(decodedImage),imageBytes.bytes.sha256,'读回包的 sha256 必须等于它自己 dataBase64 的摘要')
  // 上面那条在「回包 sha256 由回传字节现算」之后恒真，单独立不住；再钉两条有区分力的：
  assert.notEqual(imageBytes.bytes.sha256,imageRow.sha256,'图片的回包摘要必不等于元数据行的上传原字节摘要')
  assert.equal(imageBytes.bytes.sha256,String(imageRow.attachmentId).replace(/^sha256:/,''),'回包摘要即落盘（归一化后）字节的内容寻址值')
 })

 // ---------- 第 14 步（上半）：看图 ----------
 runtime.setVision('supported')
 await rpcCall('task-runs/start',{runId:runOne.id})
 const promptOne=runtime.prompts[runtime.prompts.length-1]!
 await t.test('第 14 步（上）：图片进 content，GIF 不进',()=>{
  const images=promptOne.content.filter(part=>part.type==='image')
  assert.equal(images.length,1,'只有白名单内的图片附件进 content')
  assert.ok(['image/png','image/jpeg','image/webp'].includes(String((images[0]!.attachment as Record<string,unknown>).mediaType)))
  assert.equal((images[0]!.attachment as Record<string,unknown>).name,'格式验收.jpg')
  const texts=promptOne.content.filter(part=>part.type==='text')
  assert.equal(texts.length,2,'固定输入与本次运行日期各一个 text 部件')
  assert.ok(String(texts[1]!.text).startsWith('本次运行日期：'))
  // GIF 走文件通道（编排者裁定 1）：它既不成为 image 部件，也不带 mediaType=image/gif。
  assert.equal(images.some(part=>(part.attachment as Record<string,unknown>).name==='动画验收.gif'||(part.attachment as Record<string,unknown>).mediaType==='image/gif'),false,'GIF 不得成为 image 部件')
 })

 // ---------- 第 15／16／17 步：同事贴回 ----------
 const attachTool=runtime.tools.find(item=>item.name==='teloa_group_attach')!
 const runOneSession=runtime.sessionOf(runOne.sessionId)
 const reportBody='# 研判报告\n\n结论与证据。\n',chartBytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC','base64')
 await writeFile(join(workspacePath,'报告.md'),reportBody)
 await writeFile(join(workspacePath,'图表.png'),chartBytes)
 await mkdir(join(workspacePath,'.runtime'),{recursive:true})
 await writeFile(join(workspacePath,'.runtime/内部.txt'),'不该被贴出的运行数据')
 await symlink(join(workspacePath,'.runtime/内部.txt'),join(workspacePath,'别名.txt'))
 const attachExec={agent:{session:runOneSession},signal:new AbortController().signal,callId:'call-1'}
 await attachTool.execute({path:'报告.md',sha256:sha256(Buffer.from(reportBody))},attachExec)
 await attachTool.execute({path:'图表.png',sha256:sha256(chartBytes)},attachExec)
 await attachTool.execute({path:'别名.txt',sha256:sha256(Buffer.from('不该被贴出的运行数据'))},attachExec)
 const beforePublish=await counts()
 finishSession(runOneSession,'已完成研判：需要核对父进程与横向连接。')
 await rpcCall('task-runs/reconcile',{runId:runOne.id})
 const messagesAfter=await rpcCall('groups/messages/list',{groupId:groupA.id,rootId:String(rootMessage.id)}) as Array<Record<string,unknown>>
 const posted=messagesAfter[messagesAfter.length-1]!
 const afterPublish=await counts()
 const artifactReference=(posted.references as Array<{kind:string;id:string;version:number}>).find(item=>item.kind==='artifact')
 await t.test('第 15 步：回帖带正文与一条成果引用，成果版本＋1、快照＋2、附件不增',()=>{
  assert.notEqual(posted.authorId,'self')
  assert.equal(posted.runId,runOne.id)
  assert.ok(String(posted.text).includes('已完成研判'))
  assert.ok(artifactReference,'回帖必须带一条 artifact 引用')
  assert.equal(afterPublish.snapshots-beforePublish.snapshots,2)
  assert.equal(afterPublish.versions-beforePublish.versions,1)
  assert.equal(afterPublish.attachments-beforePublish.attachments,0,'teloa_attachments 一行都不许增')
 })
 const versionRows=await rpcCall('artifacts/versions',{artifactId:artifactReference!.id}) as Array<{number:number;source:{kind:string;id:string};content:{snapshotIds:string[]}}>
 await t.test('第 15 步（续）：自动定版只一版，来源是本任务',()=>{
  assert.equal(versionRows.length,1)
  assert.equal(versionRows[0]!.source.kind,'task')
  assert.equal(versionRows[0]!.source.id,created.task.id)
 })
 const snapshotIds=versionRows[0]!.content.snapshotIds
 const snapshotFiles=[] as Array<{path:string;contentBase64:string}>
 for(const id of snapshotIds)snapshotFiles.push(await rpcCall('artifacts/snapshot',{snapshotId:id}) as {path:string;contentBase64:string})
 // 正向排除：请求计数只数得到用例自己发的那几条，证不了「客户端没走附件口」；
 // 改为钉住成果文件的 id 在附件读口上根本取不出字节——成果通道与附件通道确实是两条路。
 const artifactIdOnAttachmentRead=await rpcError('groups/attachments/read',{attachmentId:snapshotIds[0]!})
 await t.test('第 16 步：成果卡取字节打的是 artifacts/snapshot；成果文件 id 在附件读口上取不到字节',()=>{
  assert.deepEqual(snapshotFiles.map(file=>file.path).sort(),['图表.png','报告.md'].sort())
  assert.ok((calls.get('artifacts/snapshot')??0)>=snapshotIds.length)
  assert.equal(artifactIdOnAttachmentRead.code,'teloa/forbidden')
 })
 await t.test('第 17 步：运行数据目录里的文件不进成果，正文照发并前置固定文案',()=>{
  assert.ok(String(posted.text).startsWith('【有 1 件文件未能贴出。】'),'前置文案必须逐字')
  assert.equal(snapshotIds.length,2,'别名指向 .runtime 的那条不得进成果')
 })

 // ---------- 场景 25：刚定版的成果图片作为下一轮固定引用进入模型 ----------
 const fixedArtifactReference=artifactReference!
 const artifactVisionMessage=await rpcCall('groups/messages/send',{requestId:randomUUID(),groupId:groupA.id,expectedVersion:groupA.version,text:'请看成果里的图表。',references:[fixedArtifactReference]}) as {id:string}
 await rpcCall('groups/agent-grants/change',{requestId:randomUUID(),groupId:groupA.id,roleId:activeRole.id,expectedGroupVersion:groupA.version,expectedRoleVersion:activeRole.version,action:'save',resources:[...references,fixedArtifactReference],canPost:true,canAutoRun:false})
 const artifactVisionTask=await rpcCall('groups/tasks/create',{requestId:randomUUID(),groupId:groupA.id,messageId:artifactVisionMessage.id,expectedGroupVersion:groupA.version,goal:'核对成果图片。',assignee:{roleId:activeRole.id,expectedVersion:activeRole.version}}) as {task:{id:string;version:number}}
 const artifactVisionRun=await rpcCall('task-runs/prepare',{requestId:randomUUID(),taskId:artifactVisionTask.task.id,expectedTaskVersion:artifactVisionTask.task.version}) as {id:string;sessionId:string}
 runtime.setVision('supported')
 await rpcCall('task-runs/start',{runId:artifactVisionRun.id})
 const artifactPrompt=runtime.prompts[runtime.prompts.length-1]!,artifactImages=artifactPrompt.content.filter(part=>part.type==='image')
 await t.test('场景 25：成果固定版本里的图片经原生附件准入进入下一轮 content',async()=>{
  assert.equal(artifactImages.length,1,'成果里的 PNG 必须成为一个 image 部件')
  const reference=artifactImages[0]!.attachment as {name:string;mediaType:string;id:string}
  assert.equal(reference.name,'图表.png')
  assert.equal(reference.mediaType,'image/png')
  const stored=await runtime.ctx.attachments.readImage(reference as never)
  assert.deepEqual(Buffer.from(stored.data),chartBytes,'原生附件仓读回已固定的成果图片字节')
 })
 const artifactVisionSession=runtime.sessionOf(artifactVisionRun.sessionId)
 finishSession(artifactVisionSession,'已核对成果图片。')
 await rpcCall('task-runs/reconcile',{runId:artifactVisionRun.id})

 // ---------- 第 14 步（下半）：历史无模型快照 Run 的 unknown 视觉兼容 ----------
 const secondMessage=await rpcCall('groups/messages/send',{requestId:randomUUID(),groupId:groupA.id,expectedVersion:groupA.version,text:'第二轮：只看图。',references}) as {id:string}
 const secondTask=await rpcCall('groups/tasks/create',{requestId:randomUUID(),groupId:groupA.id,messageId:secondMessage.id,expectedGroupVersion:groupA.version,goal:'第二轮研判。',assignee:{roleId:activeRole.id,expectedVersion:activeRole.version}}) as {task:{id:string;version:number}}
 const runTwo=await rpcCall('task-runs/prepare',{requestId:randomUUID(),taskId:secondTask.task.id,expectedTaskVersion:secondTask.task.version}) as {id:string;sessionId:string}
 // 模拟升级前的固定输入，JSON 键序保持不变（claim 核对原文指纹）。
 const storedTwo=(await pool.query('select input_text from teloa_task_runs where id=$1',[runTwo.id])).rows[0]
 const legacyInputTwo=JSON.parse(storedTwo.input_text);delete legacyInputTwo.modelPolicy
 await pool.query('update teloa_task_runs set input_text=$2 where id=$1',[runTwo.id,JSON.stringify(legacyInputTwo)])
 runtime.setVision('unknown');runtime.setRejectImages(true)
 await rpcCall('task-runs/start',{runId:runTwo.id})
 const promptTwo=runtime.prompts[runtime.prompts.length-1]!
 const runTwoSession=runtime.sessionOf(runTwo.sessionId)
 const runTwoAnswer='第二轮只依据文件名与元数据给出结论。'
 finishSession(runTwoSession,runTwoAnswer)
 await rpcCall('task-runs/reconcile',{runId:runTwo.id})
 const secondThread=await rpcCall('groups/messages/list',{groupId:groupA.id,rootId:secondMessage.id}) as Array<Record<string,unknown>>
 const secondPosted=secondThread[secondThread.length-1]!
 runtime.setRejectImages(false)
 await t.test('第 14 步（下）：unknown 视觉被拒图后去图重发，无视觉那句由宿主前置',()=>{
  assert.equal(promptTwo.content.filter(part=>part.type==='image').length,0,'去图重发后 content 不得有 image 部件')
  assert.ok(String(secondPosted.text).startsWith(groupModelNoVisionNotice),'回帖正文必须前置无视觉固定文案')
  assert.equal(runTwoAnswer.includes(groupModelNoVisionNotice),false,'那句必须在 readTaskRunGroupResult 的文本之外')
  assert.ok(String(secondPosted.text).includes(runTwoAnswer))
 })

 // ---------- 第 18 步：canPost=false 整条不发 ----------
 const thirdMessage=await rpcCall('groups/messages/send',{requestId:randomUUID(),groupId:groupA.id,expectedVersion:groupA.version,text:'第三轮：无发言授权。',references}) as {id:string}
 const thirdTask=await rpcCall('groups/tasks/create',{requestId:randomUUID(),groupId:groupA.id,messageId:thirdMessage.id,expectedGroupVersion:groupA.version,goal:'第三轮研判。',assignee:{roleId:activeRole.id,expectedVersion:activeRole.version}}) as {task:{id:string;version:number}}
 await rpcCall('groups/agent-grants/change',{requestId:randomUUID(),groupId:groupA.id,roleId:activeRole.id,expectedGroupVersion:groupA.version,expectedRoleVersion:activeRole.version,action:'save',resources:references,canPost:false,canAutoRun:false})
 const runThree=await rpcCall('task-runs/prepare',{requestId:randomUUID(),taskId:thirdTask.task.id,expectedTaskVersion:thirdTask.task.version}) as {id:string;sessionId:string}
 runtime.setVision('supported')
 await rpcCall('task-runs/start',{runId:runThree.id})
 const runThreeSession=runtime.sessionOf(runThree.sessionId)
 finishSession(runThreeSession,'第三轮结论。')
 const beforeRefused=await counts()
 await rpcCall('task-runs/reconcile',{runId:runThree.id})
 const afterRefused=await counts()
 await t.test('第 18 步：没有发言授权时整条不发，成果版本与快照都不新增',()=>{
  assert.deepEqual(afterRefused,beforeRefused)
 })

 // ---------- 第 19 步：回帖输入没有引用字段 ----------
 await t.test('第 19 步：同事回帖输入不接受任何引用字段',()=>{
  assert.throws(()=>groupRunMessageInput({requestId:randomUUID(),runId:randomUUID(),text:'带引用的回帖。',references:[{kind:'attachment',id:'x',version:1}]}),{code:'teloa/invalid-input'})
  assert.doesNotThrow(()=>groupRunMessageInput({requestId:randomUUID(),runId:randomUUID(),text:'不带引用的回帖。'}))
 })

 // ---------- 第 20 步：撤回 .md ----------
 await rpcCall('groups/attachments/withdraw',{requestId:randomUUID(),attachmentId:String(markdownRow.attachmentId)})
 const listedAfterWithdraw=await rpcCall('groups/attachments/list',{groupId:groupA.id}) as {items:Array<{attachmentId:string}>}
 const snapshotAfterWithdraw=await rpcCall('groups/messages/list',{groupId:groupA.id,rootId:String(rootMessage.id)}) as Array<Record<string,unknown>>
 const fourthMessage=await rpcCall('groups/messages/send',{requestId:randomUUID(),groupId:groupA.id,expectedVersion:groupA.version,text:'第四轮：撤回后再准备。',references:references.filter(item=>item.id!==String(markdownRow.attachmentId))}) as {id:string}
 const fourthTask=await rpcCall('groups/tasks/create',{requestId:randomUUID(),groupId:groupA.id,messageId:fourthMessage.id,expectedGroupVersion:groupA.version,goal:'第四轮研判。',assignee:{roleId:activeRole.id,expectedVersion:activeRole.version}}) as {task:{id:string;version:number}}
 const staleTask=await rpcCall('groups/tasks/create',{requestId:randomUUID(),groupId:groupA.id,messageId:String(rootMessage.id),expectedGroupVersion:groupA.version,goal:'撤回后再跑原消息。',assignee:{roleId:activeRole.id,expectedVersion:activeRole.version}}).catch(()=>undefined) as {task:{id:string;version:number}}|undefined
 const staleRefusal=staleTask===undefined?undefined:await rpcError('task-runs/prepare',{requestId:randomUUID(),taskId:staleTask.task.id,expectedTaskVersion:staleTask.task.version})
 await t.test('第 20 步：撤回后 list 不再返回，已发消息的引用快照不改写，再准备执行即拒',()=>{
  assert.equal(listedAfterWithdraw.items.some(item=>item.attachmentId===String(markdownRow.attachmentId)),false)
  assert.deepEqual(snapshotAfterWithdraw[0]!.references,references,'已发出消息里的引用快照不得被改写')
  assert.ok(fourthTask.task.id)
  assert.equal(staleRefusal?.code,'teloa/forbidden')
 })

 // ---------- 第 21 步：断网重放 ----------
 const replayUpload=await rpcCall('groups/attachments/upload',{requestId:uploadRequestIds.image,groupId:groupA.id,expectedVersion:groupA.version,mime:'image/jpeg',name:'格式验收.jpg',dataBase64:jpegSource.toString('base64')}) as {attachment:Record<string,unknown>}
 const beforeReplay=await counts()
 await rpcCall('task-runs/reconcile',{runId:runOne.id})
 const afterReplay=await counts()
 await t.test('第 21 步：同 requestId 重发得同一行，重放回帖不产生第二版成果',()=>{
  assert.deepEqual(replayUpload.attachment,imageRow)
  assert.equal(afterReplay.versions,beforeReplay.versions,'重放不得再定一版成果')
  assert.equal(afterReplay.messages,beforeReplay.messages,'重放不得再发一条群消息')
 })

 // ---------- 第 22 步：错误码与 details ----------
 await t.test('第 22 步：全程只用八个正式码＋既有位置码，且没有一个带 details',t22=>{
  assert.ok(failures.length>0,'全链路必须至少观察到一个被拒请求')
  t22.diagnostic('全链路观察到的被拒请求：'+failures.map(failure=>`${failure.endpoint}=${failure.code}`).join('、'))
  for(const failure of failures){
   assert.ok((workErrorCodes as readonly string[]).includes(failure.code),`${failure.endpoint} 用了登记外的码 ${failure.code}`)
   assert.deepEqual(failure.details,{},`${failure.endpoint} 的 ${failure.code} 不得带 details`)
  }
  const used=[...new Set(failures.map(failure=>failure.code))]
  assert.ok(used.length>0,'观察到的码集合不得为空')
  // 右支原本写成 workErrorCodes，与上一条逐字重复因而永真；改成显式的既有位置码清单，
  // 将来往 workErrorCodes 里加一个新码，本条就会先红，而不是被同一份清单放行。
  for(const code of used)assert.ok(officialCodes.includes(code)||positionCodes.includes(code),`不在正式码也不在既有位置码：${code}`)
  assert.equal(used.some(code=>code.startsWith('teloa/host-unavailable')),false,'全链路不应出现宿主不可用')
 })
})
