import test,{after,before,type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {Context} from '@deepseek-ai/cordis'
import {LlmRuntime,ToolCallId,createUserMessage} from '@deepseek-ai/dsh-llm'
import {ToolRuntime,assertObjectJsonSchema,validateJsonSchemaValue} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {PageCreateDraftService,PageCreatePreviewService,initializePageCreateDrafts} from '@teloa/backend'
import {registerPageCreateTools} from '../src/page-create-tools.ts'

// 与实际保存相同的工具、严格正文读取器、Postgres 服务及预览；没有 mock draft/save 端口。
type DbPool=ConstructorParameters<typeof PageCreateDraftService>[0]
const {Pool}=createRequire(new URL('../../backend/package.json',import.meta.url))('pg') as {Pool:new(config:{connectionString:string})=>DbPool}
let container:StartedPostgreSqlContainer,pool:DbPool
before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializePageCreateDrafts(pool)},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})
const text='---\nname: meeting-notes\ndescription: 只整理用户提供的会议记录。\n---\n中文、繁體、emoji 🐿️ 与 "引号"、反斜线 \\。\n只列三条要点，缺少事实时写待确认。\n'
function template(){
 const id='meeting-notes-app',version='1.0.0',title='会议要点应用',description='只整理本人提供的记录，不读取其他文件或发送消息。'
 return {format:'teloa.template-share/v2',subject:'app',id,version,title,description,requirements:['本人提供会议记录。'],license:'MIT',trust:{publisher:'本人创作'},provenance:{sources:[]},sourceFiles:[],compatibility:{manifestFormat:'teloa.business-package/v2',capabilities:[]},manifest:{format:'teloa.business-package/v2',id,version,title,description,domain:'general',resources:[{id:'meeting-notes',kind:'skill',title:'会议要点',version,required:true,source:{kind:'local',path:'skills/meeting-notes/SKILL.md'}}],relations:[],entrypoints:[]},files:[{path:'skills/meeting-notes/SKILL.md',text}]}
}
async function tools(t:TestContext){
 const owner='local:'+randomUUID(),actor={ownerId:owner,scopeIds:[]},drafts=new PageCreateDraftService(pool,{id:randomUUID,now:()=>new Date().toISOString()}),preview=new PageCreatePreviewService(pool,{now:()=>new Date().toISOString()},drafts),ctx=new Context()
 t.after(()=>ctx.fiber.dispose())
 for(const plugin of [LlmRuntime,SystemPrompt,ToolRuntime,SessionStore,SessionProjectionRegistry,AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(AgentLoop,{agents:[]});const {agent}=await ctx.agents.create({sessionId:SessionId('typed-app-'+randomUUID()),agentOptions:{provider:'test',model:'test'}});agent.session.append('turn/start',{turn:1});agent.session.append('user/message',createUserMessage({source:{kind:'user',rpcId:'typed-app-request'},content:[{type:'text',text:'保存我的会议应用静态草案，不安装、不启用、不发布。'}]}),{surfaceOp:'append'})
 registerPageCreateTools(ctx,{owner,conversation:async sessionId=>({ownerId:owner,sessionId,status:'ready'}),readTaskPolicy:async()=>null,skillCreator:null,directory:input=>drafts.directory(actor,input),draftDirectory:(input,signal)=>drafts.directory(actor,input,signal),preview:(input,signal)=>preview.preview(actor,input,signal),draft:input=>drafts.draft(actor,input)})
 const call=(args:Record<string,unknown>,id:string)=>ctx.tools.execute({agent,name:'teloa_create_draft',arguments:args,callId:ToolCallId(id),signal:AbortSignal.timeout(5000)})
 return {ctx,agent,actor,drafts,preview,call}
}
test('强类型应用经真实DSH工具→严格草案服务→Postgres→固定预览回读，Unicode不改写且重试只有原稿',async t=>{
 const e=await tools(t),args={entity:'share',template:template()},schema=e.ctx.tools.schemas(e.agent).find(row=>row.name==='teloa_create_draft')!
 assertObjectJsonSchema(schema.parameters);assert.deepEqual(validateJsonSchemaValue(schema.parameters,args),[])
 const result=await e.call(args,'same-original-call');assert.equal(result.isError,false,JSON.stringify(result.content));const saved=JSON.parse(result.value as string)
 const read=await e.drafts.read(e.actor,{draftId:saved.id}),body=JSON.parse(read.body)
 assert.equal(read.entity,'share');assert.equal(read.status,'draft');assert.equal(read.appliedRef,undefined);assert.equal(read.title,args.template.title);assert.equal(read.bodyHash,createHash('sha256').update(read.body).digest('hex'));assert.equal(body.package.subject,'app');assert.equal('manifest'in body.package,false)
 assert.equal(body.package.files.filter((file:{path:string})=>file.path==='teloa.json').length,1);assert.deepEqual(JSON.parse(body.package.files.find((file:{path:string})=>file.path==='teloa.json').text),args.template.manifest);assert.equal(body.package.files.find((file:{path:string})=>file.path.endsWith('SKILL.md')).text,text)
 const original=await e.preview.preview(e.actor,{draftId:read.id});assert.equal(original.draft.body,read.body);assert.equal(original.draft.bodyHash,read.bodyHash);assert.equal(original.next.endpoint,'page-create-drafts/read');assert.deepEqual(original.next.consentKeys,[])
 const retry=await e.call(args,'same-original-call');assert.equal(retry.isError,false);assert.equal(JSON.parse(retry.value as string).id,read.id);assert.equal((await e.drafts.directory(e.actor,{entity:'share'})).drafts.length,1)
 await assert.rejects(()=>e.drafts.read({ownerId:'local:other',scopeIds:[]},{draftId:read.id}),{code:'teloa/forbidden'})
 const tables=(await pool.query("select table_name from information_schema.tables where table_schema='public' order by table_name")).rows.map(row=>row.table_name);assert.deepEqual(tables,['teloa_page_create_drafts'],'静态草案测试不创建安装、授权、角色或运行实体')
})
test('真实后端仍拒绝坏关系/缺文件/私有身份，旧body/json/text严格兼容并能原稿预览',async t=>{
 const e=await tools(t),source=template(),{manifest,...pkg}=source
 const legacy={...pkg,files:[{path:'teloa.json',json:manifest},...pkg.files]}
 const first=await e.call({entity:'share',template:legacy},'legacy-json');assert.equal(first.isError,false,JSON.stringify(first.content))
 const oldBody={package:{...pkg,files:[{path:'teloa.json',text:JSON.stringify(manifest)},...pkg.files]}}
 const old=await e.call({entity:'share',body:JSON.stringify(oldBody)},'legacy-body');assert.equal(old.isError,false,JSON.stringify(old.content))
 const textFile=await e.call({entity:'share',template:{...pkg,files:oldBody.package.files}},'legacy-text');assert.equal(textFile.isError,false)
 for(const changed of [
  {...manifest,relations:[{kind:'role-skill',from:'missing',to:'meeting-notes'}]},
  {...manifest,resources:[{...manifest.resources[0]!,source:{kind:'local',path:'skills/missing/SKILL.md'}}]},
  {...manifest,ownerId:'private-owner'},
 ]){
  const body={package:{...pkg,files:[{path:'teloa.json',text:JSON.stringify(changed)},...pkg.files]}}
  await assert.rejects(()=>e.drafts.draft(e.actor,{entity:'share',body,requestId:randomUUID()}),{code:'teloa/invalid-input'})
 }
 const rows=(await e.drafts.directory(e.actor,{entity:'share'})).drafts;assert.equal(rows.length,3);for(const row of rows){assert.equal(row.status,'draft');assert.equal((await e.preview.preview(e.actor,{draftId:row.id})).draft.bodyHash,row.bodyHash)}
})
