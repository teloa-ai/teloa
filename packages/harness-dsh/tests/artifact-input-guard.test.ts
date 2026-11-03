import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {LlmRuntime,LlmAdapter,ToolCallId,createAssistantMessage,createToolResultMessage,createUserMessage,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {SessionId} from '@deepseek-ai/dsh-session'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {Pool,stopTestContainer} from '../../backend/tests/postgres-test-lifecycle.ts'
import {ArtifactService,initializeArtifacts} from '../../backend/src/work/artifacts.ts'
import {initializeArtifactSnapshots} from '../../backend/src/work/artifact-snapshots.ts'
import {CollaborationService,initializeCollaboration} from '../../backend/src/work/collaboration.ts'
import {initializeRoles} from '../../backend/src/work/roles.ts'
import {ArtifactFeedbackService,initializeArtifactFeedback} from '../../backend/src/work/artifact-feedback.ts'
import {ArtifactRevisionRequestService} from '../../backend/src/work/artifact-revision-requests.ts'
import {artifactInputReferences,installArtifactInputGuard,bindArtifactInputSources} from '../src/artifact-input-guard.ts'

let container:StartedPostgreSqlContainer,pool:Pool
before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeArtifactSnapshots(pool);await initializeArtifacts(pool);await initializeRoles(pool);await initializeCollaboration(pool);await initializeArtifactFeedback(pool)})
after(async()=>{await pool?.end();await stopTestContainer(container)})
class Adapter extends LlmAdapter{
 calls:GenerateOptions[]=[];fail=false
 override async resolveModel(provider:string,model:string){return {provider,id:model,name:model,inputModalities:['text'] as const}}
 async *stream(request:GenerateOptions):AsyncIterable<StreamChunk>{this.calls.push(request);if(this.fail)throw Error('synthetic provider receipt lost');yield {type:'text-delta',index:0,text:'synthetic'};yield {type:'finish',reason:{kind:'stop'}}}
}
async function fixture(t:{after:(fn:()=>unknown)=>void},history:unknown[]=[],beforeGuard?:(ctx:Context)=>void){
 const owner=randomUUID(),source={kind:'session' as const,id:randomUUID(),scope:'general',version:'fixture-v1',title:'本轮合成来源'},artifacts=new ArtifactService(pool,{id:randomUUID,now:()=>new Date().toISOString()},async()=>({source,sessionIds:[source.id]}))
 const saved=await artifacts.create(owner,{requestId:randomUUID(),source,content:{title:'合成成果',sections:[{id:'body',title:'正文',text:'合成原稿'}],snapshotIds:[],note:'本轮'}})
 const ctx=new Context();t.after(()=>ctx.fiber.dispose());await ctx.plugin(LlmRuntime);const adapter=new Adapter();ctx.llm.registerAdapter(['artifact-fixture'],adapter)
 beforeGuard?.(ctx)
 installArtifactInputGuard(ctx,{owner,pool,resolveRun:async()=>null,history:()=>history})
 const consume=async(text:string,sessionId:string|null=randomUUID())=>{const output=[];for await(const chunk of ctx.llm.stream({provider:'artifact-fixture',model:'synthetic',messages:[{role:'user',content:[{type:'text',text}]}],...(sessionId?{sessionId:SessionId(sessionId)}:{})}))output.push(chunk);return output}
 return {owner,source,artifacts,saved,ctx,adapter,consume,withdraw:()=>artifacts.withdraw(owner,{requestId:randomUUID(),artifactId:saved.artifactId,expectedVersion:1,source})}
}
test('识别正式固定引用/legacy Reader JSON/Run group+memory+revision，裸UUID不授予来源',()=>{
 const id=randomUUID(),other=randomUUID(),value=['[teloa-method-source:'+id+':v1]\n'+JSON.stringify({artifactId:id,version:2,source:{kind:'session',id:randomUUID()}}),JSON.stringify({groupContext:{files:[{kind:'artifact',id:other,version:3}]},memory:[{source:{kind:'artifact',id,version:1}}],artifactRevision:{artifactId:other,baseVersion:4}})]
 assert.deepEqual(artifactInputReferences(value),[{artifactId:id,version:1},{artifactId:id,version:2},{artifactId:other,version:3},{artifactId:other,version:4}].sort((a,b)=>a.artifactId.localeCompare(b.artifactId)||a.version-b.version))
 assert.deepEqual(artifactInputReferences({text:'仅提到 '+id}),[])
})
test('真实SDK llm/stream在owner输入已准备后撤回时拒绝provider，辅助无session也不能绕过',async t=>{
 const f=await fixture(t),prepared='[teloa-artifact-source:'+f.saved.artifactId+':v1]'
 await f.withdraw()
 await assert.rejects(f.consume(prepared),error=>typeof error==='object'&&error!==null&&Reflect.get(error,'code')==='teloa/source-unavailable')
 await assert.rejects(f.consume(prepared,null),error=>typeof error==='object'&&error!==null&&Reflect.get(error,'code')==='teloa/source-unavailable')
 assert.equal(f.adapter.calls.length,0)
})
test('真实SDK输入来源绑定保留，后续不带marker也拒绝；provider未知失败释放锁且不丢来源',async t=>{
 const f=await fixture(t),sessionId=randomUUID(),reference='[teloa-artifact-source:'+f.saved.artifactId+':v1]'
 f.adapter.fail=true;const failed=await f.consume(reference,sessionId),terminal=failed.at(-1)
 assert.equal(terminal?.type,'finish');assert.equal(terminal?.type==='finish'?terminal.reason.kind:undefined,'error')
 assert.equal(f.adapter.calls.length,1)
 await f.withdraw();f.adapter.fail=false
 await assert.rejects(f.consume('继续刚才的工作',sessionId),error=>typeof error==='object'&&error!==null&&Reflect.get(error,'code')==='teloa/source-unavailable')
 assert.equal(f.adapter.calls.length,1)
 assert.deepEqual(await f.artifacts.list(f.owner,{artifactId:f.saved.artifactId}),[f.saved])
})

test('群话题只剩messageId和裁剪正文时，真实SDK仍回溯原引用拒绝撤回来源',async t=>{
 const f=await fixture(t),groups=new CollaborationService(pool,{id:randomUUID,now:()=>new Date().toISOString()})
 const group=await groups.create(f.owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'本轮合成群',scope:'general',announcement:'合成引用',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},memberRoleIds:[]}})
 const message=await groups.send(f.owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'本条话题含固定成果引用',references:[{kind:'artifact',id:f.saved.artifactId,version:1}]})
 await f.withdraw()
 await assert.rejects(f.consume(JSON.stringify({schema:'teloa.group-routing-input/v1',trigger:{messageId:message.id},topic:[{messageId:message.id,text:message.text}]})),error=>typeof error==='object'&&error!==null&&Reflect.get(error,'code')==='teloa/source-unavailable')
 assert.equal(f.adapter.calls.length,0)
})
test('反馈续改只剩原请求marker时，真实SDK不把已撤回来源送进意图路由',async t=>{
 const f=await fixture(t),feedback=await new ArtifactFeedbackService(pool,{id:randomUUID,now:()=>new Date().toISOString()}).add(f.owner,{requestId:randomUUID(),artifactId:f.saved.artifactId,version:1,source:f.source,sectionId:'body',text:'合成改动要求'})
 const request=await new ArtifactRevisionRequestService(pool,()=>new Date().toISOString()).request(f.owner,{requestId:randomUUID(),artifactId:f.saved.artifactId,baseVersion:1,feedbackId:feedback.id,sessionId:randomUUID()})
 await f.withdraw()
 await assert.rejects(f.consume('[teloa-revision:'+request.id+']'),error=>typeof error==='object'&&error!==null&&Reflect.get(error,'code')==='teloa/source-unavailable')
 assert.equal(f.adapter.calls.length,0)
})

test('独立副本工具结果和技能系统说明的历史origin不冒称活动原成果引用',async t=>{
 const f=await fixture(t);await f.withdraw()
 const copied=JSON.stringify({format:'synthetic-independent-copy/v1',origin:{artifactId:f.saved.artifactId,version:1},body:'独立副本自己的正文'}),callId=ToolCallId('read-owned-copy')
 const messages=[createAssistantMessage({source:{provider:'artifact-fixture',model:'synthetic'},content:[{type:'tool-call',id:callId,name:'read_public_copy',arguments:'{}'}]}),createToolResultMessage({callId,content:[{type:'text',text:copied}],isError:false})]
 const chunks=[];for await(const chunk of f.ctx.llm.stream({provider:'artifact-fixture',model:'synthetic',sessionId:SessionId(randomUUID()),system:'独立技能说明 '+copied,messages}))chunks.push(chunk)
 assert.equal(f.adapter.calls.length,1);assert.equal(chunks.at(-1)?.type,'finish')
})

test('旧会话压缩后丢失当前引用时，保留的原生方法tool-call元数据仍约束对象而不伪造版本',async t=>{
 const history:unknown[]=[],f=await fixture(t,history),sessionId=randomUUID(),callId=ToolCallId('legacy-source-read')
 const original=createAssistantMessage({source:{provider:'artifact-fixture',model:'synthetic'},content:[{type:'tool-call',id:callId,name:'teloa_method_source',arguments:JSON.stringify({artifactId:f.saved.artifactId})}]})
 history.push({type:'assistant/message',seq:1,data:{turn:1,message:original}})
 const frozen=JSON.stringify(history)
 await f.consume('旧上下文已压缩，此处没有artifactId',sessionId)
 assert.equal(f.adapter.calls.length,1)
 await f.withdraw()
 await assert.rejects(f.consume('继续当前上下文',sessionId),error=>typeof error==='object'&&error!==null&&Reflect.get(error,'code')==='teloa/source-unavailable')
 assert.equal(f.adapter.calls.length,1);assert.equal(JSON.stringify(history),frozen)
})

test('实际上下文stream监听刚读出的来源也必须在最内层provider准入前重新核对',async t=>{
 let f:Awaited<ReturnType<typeof fixture>>
 f=await fixture(t,[],ctx=>{ctx.on('llm/stream',async function*(request,next){
  await bindArtifactInputSources(f.owner,pool,String(request.sessionId),{artifactId:f.saved.artifactId,version:1})
  await f.withdraw()
  yield* next()
 },{global:true})})
 await assert.rejects(f.consume('本次上下文由真实宿主读取'),error=>typeof error==='object'&&error!==null&&Reflect.get(error,'code')==='teloa/source-unavailable')
 assert.equal(f.adapter.calls.length,0)
})

test('本人普通目标中的JSON示例不冒称受管成果引用，正式单行标记仍受守卫',async t=>{
 const f=await fixture(t);await f.withdraw()
 const text=JSON.stringify({artifactId:f.saved.artifactId,version:1,example:'只是格式说明，不是正式来源'})
 const messages=[createUserMessage({source:{kind:'user'},content:[{type:'text',text}]})]
 for await(const _ of f.ctx.llm.stream({provider:'artifact-fixture',model:'synthetic',sessionId:SessionId(randomUUID()),messages})){}
 assert.equal(f.adapter.calls.length,1)
 await assert.rejects(f.consume('[teloa-artifact-source:'+f.saved.artifactId+':v1]'),error=>typeof error==='object'&&error!==null&&Reflect.get(error,'code')==='teloa/source-unavailable')
 assert.equal(f.adapter.calls.length,1)
})
