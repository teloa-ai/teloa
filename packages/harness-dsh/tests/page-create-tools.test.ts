import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {brandString} from '@deepseek-ai/dsh-brand'
import type {SessionRequestId} from '@deepseek-ai/dsh-api-session-controller'
import {ToolRuntime,assertObjectJsonSchema,validateJsonSchemaValue} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId,createUserMessage} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {registerPageCreateTools,pageCreateToolNames,shareConnectorDirectory,type PageCreateToolsPorts} from '../src/page-create-tools.ts'
import {roleGrantToolNames,validateReferenceToolRules} from '../src/role-tool-grants.ts'
import {readTemplateShare,roleWriteDefinition,readPageCreateAtomicSkillDraft,readPageCreatePlanDraft,readPageCreateBody,pageCreateCanonicalBody,encodePageCreateDraftReference,readPageCreateDraftReferences} from '@teloa/contract'
import type {BuiltinSkillCreator} from '../src/builtin-skill-creator.ts'
import {configurePlanDraftExample} from '../src/plan-draft-guide.ts'

const owner='local:teloa-owner'
const creator={definition:{name:'teloa-skill-creator',description:'d',content:'c',source:'custom',provider:'teloa-builtin',invocation:{modelInvocable:true,userInvocable:true}},rendered:'<skill_content name="teloa-skill-creator">固定创建器</skill_content>'} as unknown as BuiltinSkillCreator
test('跨本人普通会话按名称发现已存草案，返回固定身份与状态但不返回正文或创建新草案',async t=>{
 const draft={id:'11111111-1111-4111-8111-111111111111',ownerId:owner,requestId:'22222222-2222-4222-8222-222222222222',entity:'skill',title:'开发验收·结构化事实核对',body:'私人正文不属于目录',bodyHash:'a'.repeat(64),status:'draft',createdAt:'2026-10-12T00:00:00Z',updatedAt:'2026-10-12T00:00:00Z'} as const
 let reads=0
 const e=await setup({draftDirectory:async(input,signal)=>{assert.deepEqual(input,{entity:'skill'});assert.equal(signal?.aborted,false);reads++;return {schema:'teloa.page-create-drafts/v1',entity:'skill',readAt:'2026-10-12T00:00:00Z',drafts:[draft]}}});t.after(()=>e.ctx.fiber.dispose())
 const result=await e.call('teloa_create_drafts',{entity:'skill'})
 assert.equal(result.isError,false)
 const value=JSON.parse(result.value as string)
 assert.equal(value.drafts[0].id,draft.id);assert.equal(value.drafts[0].title,draft.title);assert.equal(value.drafts[0].status,'draft')
 assert.equal(value.limit,16);assert.equal(value.coverage,'recent-saved-drafts')
 assert.equal('body'in value.drafts[0],false);assert.equal('ownerId'in value.drafts[0],false);assert.equal('requestId'in value.drafts[0],false)
 assert.equal(reads,1);assert.deepEqual(e.calls,[])
 const description=e.ctx.tools.schemas(e.agent).find(row=>row.name==='teloa_create_drafts')!.description??''
 assert.match(description,/teloa_create_preview/);assert.match(description,/未命中.*不能.*从未保存/)
})
test('草案目录跨本人/业务混入拒绝，失败与任务身份不伪装成空目录',async t=>{
 for(const cause of ['owner','scope','offline','task','subagent']){
  let reads=0
  const e=await setup({...(cause==='task'?{readTaskPolicy:async()=>({kind:'history'}) as never}:{}),draftDirectory:async()=>{
   reads++;if(cause==='offline')throw Error('offline')
   return {schema:'teloa.page-create-drafts/v1',entity:'skill',readAt:'2026-10-12T00:00:00Z',drafts:[{id:'11111111-1111-4111-8111-111111111111',ownerId:cause==='owner'?'other':owner,entity:'skill',title:'草稿',status:'draft',body:'不得返回',scope:cause==='scope'?'foreign':undefined}]} as never
  }},{subagent:cause==='subagent'});t.after(()=>e.ctx.fiber.dispose())
  const result=await e.call('teloa_create_drafts',{entity:'skill'})
  assert.equal(result.isError,true,cause);assert.equal(reads,cause==='task'||cause==='subagent'?0:1,cause);assert.deepEqual(e.calls,[])
 }
})
test('已存草案检索不依赖创建器，六类资源保持范围与状态，损坏响应严格失败',async t=>{
 const base={id:'11111111-1111-4111-8111-111111111111',ownerId:owner,requestId:'22222222-2222-4222-8222-222222222222',entity:'skill' as const,title:'同名原稿',body:'私有正文',bodyHash:'a'.repeat(64),status:'applied' as const,appliedRef:'existing-resource',createdAt:'2026-10-12T00:00:00Z',updatedAt:'2026-10-12T00:00:00Z'}
 const page={schema:'teloa.page-create-drafts/v1' as const,entity:'skill' as const,readAt:base.updatedAt,drafts:[base]}
 const e=await setup({skillCreator:null,draftDirectory:async input=>({...page,...input,drafts:[{...base,...input}]})});t.after(()=>e.ctx.fiber.dispose())
 for(const entity of ['role','skill','extension','business-definition','business-domain','connector']){
  const input={entity,...(['business-definition','business-domain','connector'].includes(entity)?{scope:'SOC'}:{})}
  const result=await e.call('teloa_create_drafts',input,entity)
  assert.equal(result.isError,false,entity)
  const value=JSON.parse(result.value as string);assert.equal(value.drafts[0].appliedRef,'existing-resource');assert.equal(value.scope,input.scope)
  assert.equal(JSON.stringify(value).includes('私有正文'),false)
 }
 for(const bad of [{...page,entity:'role'}, {...page,drafts:[base,base]}, {...page,drafts:Array(17).fill(base)}, {...page,drafts:[{...base,status:'running'}]}, {...page,drafts:[{...base,appliedRef:undefined}]}, {...page,drafts:[{...base,id:'bad'}]}, {...page,drafts:[{...base,bodyHash:'bad'}]}, {...page,drafts:[{...base,createdAt:'bad'}]}]){
  const corrupt=await setup({draftDirectory:async()=>bad as never});t.after(()=>corrupt.ctx.fiber.dispose())
  assert.equal((await corrupt.call('teloa_create_drafts',{entity:'skill'})).isError,true)
  assert.deepEqual(corrupt.calls,[])
 }
 const cancelled=await setup({draftDirectory:async()=>{throw new DOMException('Cancelled','AbortError')}});t.after(()=>cancelled.ctx.fiber.dispose())
 assert.equal((await cancelled.call('teloa_create_drafts',{entity:'skill'})).isError,true);assert.deepEqual(cancelled.calls,[])
 assert.deepEqual(e.calls,[])
})
const lookupDraft=()=>({id:'11111111-1111-4111-8111-111111111111',ownerId:owner,requestId:'22222222-2222-4222-8222-222222222222',entity:'skill' as const,title:'明确原稿',body:skillBody,bodyHash:'a'.repeat(64),status:'draft' as const,createdAt:'2026-10-12T00:00:00.000Z',updatedAt:'2026-10-12T00:00:00.000Z'})
const lookupPreview=(draft=lookupDraft())=>({schema:'teloa.page-create-draft-preview/v1' as const,draft,fields:[],fieldsTruncated:false,consequences:[],next:{endpoint:'skill-installations/install',consentKeys:[]},computedAt:draft.updatedAt})
test('按明确名称查看原稿一次返回独立只读结果，保留正式原稿但不携带安装下一步',async t=>{
 const draft=lookupDraft();let previews=0
 const e=await setup({draftDirectory:async()=>({schema:'teloa.page-create-drafts/v1',entity:'skill',readAt:draft.updatedAt,drafts:[draft,{...draft,id:'33333333-3333-4333-8333-333333333333',title:'相似原稿'}]}),preview:async(input,signal)=>{previews++;assert.deepEqual(input,{draftId:draft.id});assert.equal(signal?.aborted,false);return lookupPreview(draft)}});t.after(()=>e.ctx.fiber.dispose())
 const result=await e.call('teloa_create_drafts',{entity:'skill',title:'明确原稿',preview:true})
 assert.equal(result.isError,false);const read=JSON.parse(result.value as string);assert.equal(read.schema,'teloa.page-create-draft-read/v1');assert.deepEqual(read.draft,draft);assert.equal(read.ownerId,owner);assert.equal(read.sessionId,e.agent.session.id);assert.equal(read.readAt,draft.updatedAt);assert.equal(read.next.kind,'open-original');assert.equal(read.next.title,draft.title);assert.equal('consequences'in read,false);assert.equal('fields'in read,false);assert.equal('endpoint'in read.next,false);assert.equal(previews,1);assert.deepEqual(e.calls,[])
 const summary=await e.call('teloa_create_drafts',{entity:'skill',title:'明确原稿',preview:false},'status-only')
 assert.equal(summary.isError,false);const value=JSON.parse(summary.value as string);assert.equal(value.schema,'teloa.page-create-draft-reference/v1');assert.equal(value.ownerId,owner);assert.equal(value.sessionId,e.agent.session.id);assert.equal(value.draft.title,'明确原稿');assert.equal('body'in value.draft,false);assert.equal(previews,1)
})
test('明确原稿重名或未命中只给匹配摘要，未明确查看及无效参数均不读取正文',async t=>{
 const draft=lookupDraft();let previews=0,reads=0
 const e=await setup({draftDirectory:async()=>{reads++;return {schema:'teloa.page-create-drafts/v1',entity:'skill',readAt:draft.updatedAt,drafts:[draft,{...draft,id:'33333333-3333-4333-8333-333333333333'}]}},preview:async()=>{previews++;return lookupPreview()}});t.after(()=>e.ctx.fiber.dispose())
 for(const title of ['明确原稿','未保存']){
  const result=await e.call('teloa_create_drafts',{entity:'skill',title,preview:true},title)
  assert.equal(result.isError,false);const value=JSON.parse(result.value as string);assert.equal(value.drafts.length,title==='明确原稿'?2:0);assert.equal(value.previewState,title==='明确原稿'?'ambiguous':'not-found');assert.equal(previews,0)
 }
 const before=reads
 for(const args of [{entity:'skill',preview:true},{entity:'skill',title:' '},{entity:'skill',title:'x',preview:'true'},{entity:'skill',title:'x'.repeat(241)},{entity:'role',title:'员工',preview:true},{entity:'skill',title:'x',preview:true,ownerId:'other'}])assert.equal((await e.call('teloa_create_drafts',args)).isError,true)
 assert.equal(reads,before);assert.equal(previews,0);assert.deepEqual(e.calls,[])
})
test('按名称读取和预览间指令变化、取消及回包身份摘要漂移均拒绝返回正文',async t=>{
 for(const cause of ['instruction','instruction-after','owner','id','hash','body','title','entity','scope','applied-ref','aborted']){
  let previews=0;const draft=lookupDraft()
  let agent:any
  const e=await setup({draftDirectory:async()=>{if(cause==='instruction')agent.session.append('user/message',createUserMessage({source:{kind:'user',rpcId:brandString<SessionRequestId>('changed')},content:[{type:'text',text:'现在不要读取'}]}),{surfaceOp:'append'});return {schema:'teloa.page-create-drafts/v1',entity:'skill',readAt:draft.updatedAt,drafts:[draft]}},preview:async()=>{previews++;if(cause==='instruction-after')agent.session.append('user/message',createUserMessage({source:{kind:'user',rpcId:brandString<SessionRequestId>('changed-after')},content:[{type:'text',text:'取消读取原稿'}]}),{surfaceOp:'append'});if(cause==='aborted')throw new DOMException('Cancelled','AbortError');return lookupPreview({...draft,...(cause==='owner'?{ownerId:'other'}:cause==='id'?{id:'33333333-3333-4333-8333-333333333333'}:cause==='hash'?{bodyHash:'b'.repeat(64)}:cause==='body'?{body:'不同正文'}:cause==='title'?{title:'changed'}:cause==='entity'?{entity:'extension'}:cause==='scope'?{scope:'foreign'}:cause==='applied-ref'?{appliedRef:'another-installation'}:{})} as never)}});agent=e.agent;t.after(()=>e.ctx.fiber.dispose())
  const result=await e.call('teloa_create_drafts',{entity:'skill',title:draft.title,preview:true})
  assert.equal(result.isError,true,cause);assert.equal(previews,cause==='instruction'?0:1,cause);assert.deepEqual(e.calls,[])
 }
})
test('Skill 工具说明中的完整示例能被实际草案校验器接受',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 const description=e.ctx.tools.schemas(e.agent).find(item=>item.name==='teloa_create_draft')!.description
 const example=/最小技能示例：\n([^\n]+)\n/.exec(description??'')
 assert.ok(example,'工具必须提供可独立使用的技能正文结构')
 const body=JSON.parse(example[1]!)
 assert.equal(typeof body.files[0].content,'string','模型应直接写 Markdown，不生成或复制编码')
 inject(e.agent)
 const result=await e.call('teloa_create_draft',{entity:'skill',body:example[1]!})
 assert.equal(result.isError,false,JSON.stringify(result.content))
 assert.doesNotThrow(()=>readPageCreateAtomicSkillDraft((e.calls[0]!.input as {body:unknown}).body))
})

const markdownSkill=(content:string)=>({id:'fact-review',title:'开发验收·事实核对',version:'1.0.0',categories:[],files:[{path:'SKILL.md',content}]})
const reviewMarkdown='---\nname: fact-review\ndescription: 整理本人提供的资料，不联网不读文件。\n---\n# 事实核对\n\n事实、待办与待确认。没有证据就写待确认。\n'+('合成资料：中文、繁體、emoji 🐿️，符号 + / = 与换行均原样保存。\n'.repeat(35))

test('模型可见的结构化技能调用通过DSH嵌套参数校验，无需JSON字符串嵌套',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose());inject(e.agent)
 const schema=e.ctx.tools.schemas(e.agent).find(item=>item.name==='teloa_create_draft')!
 const example=/最小结构化技能调用：\n([^\n]+)\n/.exec(schema.description??'')
 assert.ok(example,'工具应提供可直接传入的完整结构化调用')
 const args=JSON.parse(example[1]!)
 assert.equal(args.entity,'skill');assert.equal(typeof args.skill,'object');assert.equal('body'in args,false)
 assertObjectJsonSchema(schema.parameters)
 assert.deepEqual(validateJsonSchemaValue(schema.parameters,args),[])
 const result=await e.call('teloa_create_draft',args)
 assert.equal(result.isError,false,JSON.stringify(result.content))
 const saved=(e.calls[0]!.input as {body:{files:{base64:string}[]}}).body
 assert.equal(Buffer.from(saved.files[0]!.base64,'base64').toString('utf8'),args.skill.files[0].content)
})

test('结构化技能严格接收对象且保留引号、反斜线、换行与Unicode原文',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose());inject(e.agent)
 const content=reviewMarkdown+'\n“事实”与 "待办"；路径写法 C:\\test，不读取。\n'
 const args=JSON.parse(JSON.stringify({entity:'skill',skill:markdownSkill(content)}))
 assert.equal((await e.call('teloa_create_draft',args)).isError,false)
 const saved=(e.calls[0]!.input as {body:{files:{base64:string}[]}}).body
 assert.equal(Buffer.from(saved.files[0]!.base64,'base64').toString('utf8'),content)
})

test('结构化skill与旧body恰一，额外字段、非法数组和跨实体输入失败不写草案',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose());inject(e.agent)
 const valid=markdownSkill(reviewMarkdown)
 const cases=[
  {entity:'skill',skill:valid,body:JSON.stringify(valid)},
  {entity:'skill'},
  {entity:'skill',skill:JSON.stringify(valid)},
  {entity:'skill',skill:{...valid,extra:'unsafe'}},
  {entity:'skill',skill:{...valid,categories:[1]}},
  {entity:'skill',skill:{...valid,files:{0:valid.files[0],length:1}}},
  {entity:'skill',skill:{...valid,files:[{...valid.files[0],base64:'eA=='}]}},
  {entity:'skill',body:valid},
  {entity:'role',skill:valid,body:JSON.stringify(role)},
 ]
 for(const [i,args]of cases.entries())assert.equal((await e.call('teloa_create_draft',args,'structured-invalid-'+i)).isError,true,'case '+i)
 assert.equal(e.calls.length,0)
})

test('技能 Markdown 在真实工具边界由宿主完整编码，兼容二进制旧格式',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose());inject(e.agent)
 const body=markdownSkill(reviewMarkdown)
 body.files.push({path:'references/note.md',content:'待确认\r\n无证据 🐿️'})
 const result=await e.call('teloa_create_draft',{entity:'skill',body:JSON.stringify(body)})
 assert.equal(result.isError,false,JSON.stringify(result.content))
 const saved=(e.calls[0]!.input as {body:{files:{path:string;base64:string}[]}}).body
 assert.equal(Buffer.from(saved.files[0]!.base64,'base64').toString('utf8'),reviewMarkdown)
 assert.equal(Buffer.from(saved.files[1]!.base64,'base64').toString('utf8'),body.files[1]!.content)
 assert.deepEqual(Object.keys(saved.files[0]!).sort(),['base64','path'])
 const old=JSON.parse(skillBody);old.files.push({path:'assets/image.bin',base64:Buffer.from([0,255,128]).toString('base64')})
 assert.equal((await e.call('teloa_create_draft',{entity:'skill',body:JSON.stringify(old)},'binary')).isError,false)
 assert.deepEqual((e.calls.at(-1)!.input as {body:unknown}).body,old)
 assert.equal((await e.call('teloa_create_draft',{entity:'skill',skill:old},'structured-binary')).isError,false)
 assert.deepEqual((e.calls.at(-1)!.input as {body:unknown}).body,old)
})

test('技能文本输入仍严格拒绝混合字段、错误类型、非法编码与不安全目录，失败不写草案',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose());inject(e.agent)
 const cases:unknown[]=[
  {...markdownSkill(reviewMarkdown),files:[{path:'SKILL.md',content:reviewMarkdown,base64:'eA=='}]},
  {...markdownSkill(reviewMarkdown),files:[{path:'SKILL.md',content:1}]},
  {...markdownSkill(reviewMarkdown),files:[{path:'SKILL.md',content:reviewMarkdown,other:true}]},
  {...markdownSkill(reviewMarkdown),files:[{path:'../SKILL.md',content:reviewMarkdown}]},
  {...markdownSkill(reviewMarkdown),files:[{path:'SKILL.md',content:reviewMarkdown+'\ud800'}]},
  {...markdownSkill(reviewMarkdown),files:[{path:'SKILL.md',content:'---\nname: another\ndescription: d\n---\nx'}]},
  {...markdownSkill(reviewMarkdown),files:{0:{path:'SKILL.md',content:reviewMarkdown},length:1}},
 ]
 for(const [index,body] of cases.entries())assert.equal((await e.call('teloa_create_draft',{entity:'skill',body:JSON.stringify(body)},'bad-'+index)).isError,true,'invalid case '+index)
 assert.equal(e.calls.length,0)
 assert.equal((await e.call('teloa_create_draft',{entity:'skill',body:JSON.stringify(markdownSkill(reviewMarkdown))},'valid')).isError,false)
 assert.equal(e.calls.length,1)
})

test('文本通道保留非技能正文和固定正文大小边界，不截断或扩展其他实体',async t=>{
 const e=await setup({draft:async input=>{
  const {pageCreateCanonicalBody,roleWriteDefinition}=await import('@teloa/contract')
  if(input.entity==='skill')pageCreateCanonicalBody(input.body)
  if(input.entity==='role')roleWriteDefinition(input.body)
  return {status:'draft'}
 }});t.after(()=>e.ctx.fiber.dispose());inject(e.agent)
 const ordinary=await e.call('teloa_create_draft',{entity:'role',body:JSON.stringify({...role,files:[{path:'SKILL.md',content:reviewMarkdown}]})},'role-invalid')
 assert.equal(ordinary.isError,true,'其他实体不接受技能文本schema')
 const tooLarge=markdownSkill(reviewMarkdown+'中'.repeat(40000))
 const oversized=await e.call('teloa_create_draft',{entity:'skill',body:JSON.stringify(tooLarge)},'oversized')
 assert.equal(oversized.isError,true,'UTF-8规范化正文仍受原128KiB限制，不截断')
 assert.match(JSON.stringify(oversized.content),/128 KiB/)
 const structuredOversized=await e.call('teloa_create_draft',{entity:'skill',skill:tooLarge},'structured-oversized')
 assert.equal(structuredOversized.isError,true,'结构化输入仍受同一UTF-8规范化正文大小限制')
 assert.match(JSON.stringify(structuredOversized.content),/128 KiB/)
 assert.equal((await e.call('teloa_create_draft',{entity:'skill',skill:markdownSkill(reviewMarkdown+'x'.repeat(131072))},'structured-input-oversized')).isError,true,'结构化传输同样保留原输入长度上限')
})

test('无效 Skill 正文在请求审批前被拒绝，不让用户确认必然失败的操作',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose());let approvals=0
 e.ctx.provide('approval',{request:async()=>{approvals++;return 'allowed-once'}})
 const result=await e.call('teloa_create_draft',{entity:'skill',body:JSON.stringify('# Skill')})
 assert.equal(result.isError,true)
 assert.equal(approvals,0)
 assert.equal(e.calls.length,0)
})
const role={name:'SOC 调查岗',kind:'employee',scopes:['SOC'],duty:'调查告警',dataScope:'只读告警',executionScope:'不处置',skills:['alert-triage'],knowledge:['soc-runbook'],responsibility:{triggers:['新告警'],autonomousActions:['取证'],confirmationPoints:['处置前确认'],escalationRules:['高危升级'],deliveryChecks:['结论有依据']}}

const meetingAppText='---\nname: meeting-summary\ndescription: 将本人提供的会议记录整理为三条要点。\n---\n# 会议要点\n\n中文、繁體、emoji 🐿️、"引号"、反斜线 \\ 与换行。\r\n只根据本人提供的记录列三条要点，不读取文件或对外发送。\n'
function meetingAppTemplate(text=meetingAppText){
 const id='meeting-summary-app',version='1.0.0',title='会议三条要点应用',description='只整理本人提供的会议记录，不连接外部账号。'
 return {format:'teloa.template-share/v2',subject:'app',id,version,title,description,requirements:['本人提供会议记录纯文本。'],license:'MIT',trust:{publisher:'本人创作'},provenance:{sources:[]},sourceFiles:[],compatibility:{manifestFormat:'teloa.business-package/v2',capabilities:[]},files:[
  {path:'teloa.json',json:{format:'teloa.business-package/v2',id,version,title,description,domain:'general',scope:'general',resources:[{id:'meeting-summary',kind:'skill',title:'会议三条要点',version,required:true,source:{kind:'local',path:'skills/meeting-summary/SKILL.md'}}],relations:[],entrypoints:[]}},
  {path:'skills/meeting-summary/SKILL.md',text},
 ]}
}
const oldMeetingAppBody=()=>({package:{...meetingAppTemplate(),files:meetingAppTemplate().files.map(file=>'json'in file?{path:file.path,text:JSON.stringify(file.json)}:file)}})
function typedMeetingAppTemplate(){const template=meetingAppTemplate();return {...template,manifest:template.files[0]!.json!,files:template.files.slice(1)}}

function typedEmployeeTemplate(team=false){
 const app=typedMeetingAppTemplate(),id=team?'review-team':'review-assistant',title=team?'资料核对团队':'资料核对员工'
 const definitions=(team?['lead','reviewer']:['reviewer']).map(name=>({path:'roles/'+name+'.json',definition:{format:'teloa.role/v1',name,duty:'核对本人提供的资料。\n“事实”与 "待确认" 分开。',kind:'employee',dataScope:'仅本次提供的资料',executionScope:'只分析与代拟，不对外发送',responsibility:{triggers:['本人明确交办'],autonomousActions:['核对原文并标明出处'],confirmationPoints:['对外发送前确认'],escalationRules:['资料不足时说明缺项'],deliveryChecks:['事实均有来源']}}}))
 return {...app,subject:team?'team':'employee',id,title,compatibility:{...app.compatibility,capabilities:['people']},manifest:{...app.manifest,id,title,resources:definitions.map(({path,definition},index)=>({id:'employee-'+index,kind:'role',title:definition.name,version:app.version,required:true,source:{kind:'local',path}})),relations:[],entrypoints:[]},roles:definitions,files:[] as {path:string;json?:unknown;text?:string}[]}
}

test('员工与团队模板各有完整强类型示例，原生工具编码角色原文且只保存静态原稿',async t=>{
 const e=await setup({skillCreator:null});t.after(()=>e.ctx.fiber.dispose())
 const schema=e.ctx.tools.schemas(e.agent).find(row=>row.name==='teloa_create_draft')!
 for(const [label,subject,count]of [['员工','employee',1],['团队','team',2]] as const){
  const match=new RegExp('最小结构化'+label+'模板调用：\\n([^\\n]+)\\n').exec(schema.description??'')
  assert.ok(match,'必须提供当前主体完整示例，不借用直接创建员工或应用格式')
  const args=JSON.parse(match[1]!)
  assert.equal(args.template.subject,subject);assert.equal(args.template.roles.length,count)
  assert.equal('scope'in args,false);assert.equal('body'in args,false)
  assert.deepEqual(validateJsonSchemaValue(schema.parameters,args),[])
  const result=await e.call('teloa_create_draft',args,'typed-'+subject)
  assert.equal(result.isError,false,JSON.stringify(result.content))
  const saved=e.calls.at(-1)!.input as {body:{package:{roles?:unknown;manifest?:unknown;files:{path:string;text:string}[]}};entity:string}
  assert.equal(saved.entity,'share');assert.equal(saved.body.package.roles,undefined);assert.equal(saved.body.package.manifest,undefined)
  for(const role of args.template.roles)assert.deepEqual(JSON.parse(saved.body.package.files.find(file=>file.path===role.path)!.text),role.definition)
  assert.doesNotThrow(()=>readPageCreateBody('share',saved.body))
 }
 assert.equal(e.calls.length,2)
})

test('强类型模板角色公开真实数组结构，宿主编码Unicode和换行一次且不携带运行身份',async t=>{
 const e=await setup({skillCreator:null});t.after(()=>e.ctx.fiber.dispose())
 const template=typedEmployeeTemplate(),schema=e.ctx.tools.schemas(e.agent).find(row=>row.name==='teloa_create_draft')!
 assertObjectJsonSchema(schema.parameters)
 const roles=schema.parameters.properties!.template!.properties!.roles
 assert.ok(roles,'角色定义必须可由模型直接看见')
 const definition=roles.items!.properties!.definition!
 assert.equal(definition.additionalProperties,false)
 assert.equal(definition.properties!.format!.enum![0],'teloa.role/v1')
 for(const key of ['triggers','autonomousActions','confirmationPoints','escalationRules','deliveryChecks'])assert.equal(definition.properties!.responsibility!.properties![key]!.type,'array')
 const result=await e.call('teloa_create_draft',{entity:'share',template})
 assert.equal(result.isError,false,JSON.stringify(result.content))
 const saved=e.calls[0]!.input as {body:{package:{files:{path:string;text:string}[]}}}
 assert.equal(JSON.parse(saved.body.package.files.find(file=>file.path===template.roles[0]!.path)!.text).duty,template.roles[0]!.definition.duty)
 assert.doesNotThrow(()=>readPageCreateBody('share',saved.body))
})

test('真实失败的portable角色形状指出format和字段数组路径，不删除字段或写入草案',async t=>{
 const e=await setup({skillCreator:null});t.after(()=>e.ctx.fiber.dispose())
 const {roles,...base}=typedEmployeeTemplate(),{format,...portable}=roles[0]!.definition
 const failed={...portable,scopes:{item:'general'},skills:'',knowledge:'',responsibility:Object.fromEntries(Object.entries(portable.responsibility).map(([key,values])=>[key,{item:values}]))}
 const template={...base,files:[{path:roles[0]!.path,json:failed}]},before=structuredClone(template)
 const result=await e.call('teloa_create_draft',{entity:'share',template})
 assert.equal(result.isError,true)
 const message=JSON.stringify(result.content)
 for(const key of ['format','scopes','skills','knowledge','responsibility.triggers'])assert.ok(message.includes('template.files[0].json.'+key),message)
 assert.deepEqual(template,before);assert.equal(e.calls.length,0)
})

test('旧角色JSON文本与body同样给字段路径，people仅为原兼容声明且manifest可缺省scope',async t=>{
 const e=await setup({skillCreator:null});t.after(()=>e.ctx.fiber.dispose())
 const {roles,...base}=typedEmployeeTemplate(),path=roles[0]!.path
 const invalid={...roles[0]!.definition,ownerId:'private-owner'}
 for(const [index,args]of [
  {entity:'share',template:{...base,files:[{path,text:JSON.stringify(invalid)}]}},
  {entity:'share',body:JSON.stringify({package:{...Object.fromEntries(Object.entries(base).filter(([key])=>key!=='manifest')),files:[{path:'teloa.json',text:JSON.stringify(base.manifest)},{path,text:JSON.stringify(invalid)}]}})},
 ].entries()){
  const result=await e.call('teloa_create_draft',args,'legacy-role-'+index)
  assert.equal(result.isError,true);assert.match(JSON.stringify(result.content),/files\[\d+\]\.text\.ownerId/)
 }
 const missingPeople=await e.call('teloa_create_draft',{entity:'share',template:{...base,compatibility:{...base.compatibility,capabilities:[]},files:[{path,json:roles[0]!.definition}]}},'missing-people')
 assert.equal(missingPeople.isError,true);assert.match(JSON.stringify(missingPeople.content),/template\.compatibility\.capabilities/)
 assert.equal(e.calls.length,0)
 const {scope,...manifest}=base.manifest
 const valid=await e.call('teloa_create_draft',{entity:'share',template:{...base,manifest,roles,files:[]}},'default-manifest-scope')
 assert.equal(valid.isError,false,JSON.stringify(valid.content));assert.equal(e.calls.length,1)
})

test('typed角色与files重复路径、未声明路径、私人字段、伪数组和twin均拒绝不保存',async t=>{
 const e=await setup({skillCreator:null});t.after(()=>e.ctx.fiber.dispose())
 const template=typedEmployeeTemplate(),role=template.roles[0]!
 for(const [index,invalid]of [
  {...template,files:[{path:role.path,json:role.definition}]},
  {...template,roles:[{...role,path:'roles/not-declared.json'}]},
  {...template,roles:[role,role]},
  {...template,roles:[{...role,definition:{...role.definition,ownerId:'private-owner'}}]},
  {...template,roles:[{...role,definition:{...role.definition,runtimeConfig:{agentPresetId:'secret'}}}]},
  {...template,roles:[{...role,definition:{...role.definition,responsibility:{...role.definition.responsibility,triggers:{item:['start']}}}}]},
  {...template,roles:[{...role,definition:{...role.definition,kind:'twin'}}]},
 ].entries())assert.equal((await e.call('teloa_create_draft',{entity:'share',template:invalid},'invalid-role-'+index)).isError,true,'case '+index)
 assert.equal(e.calls.length,0)
})

test('应用清单向模型公开强类型字段，宿主生成唯一清单并保留原声明与正文',async t=>{
 const e=await setup({skillCreator:null});t.after(()=>e.ctx.fiber.dispose())
 const schema=e.ctx.tools.schemas(e.agent).find(row=>row.name==='teloa_create_draft')!,args={entity:'share',template:typedMeetingAppTemplate()}
 assertObjectJsonSchema(schema.parameters);assert.deepEqual(validateJsonSchemaValue(schema.parameters,args),[])
 const manifest=schema.parameters.properties!.template!.properties!.manifest!
 assert.ok(manifest);assert.equal(manifest.properties!.relations!.type,'array');assert.equal(manifest.properties!.entrypoints!.type,'array');assert.equal(manifest.properties!.resources!.type,'array')
 const result=await e.call('teloa_create_draft',args);assert.equal(result.isError,false,JSON.stringify(result.content))
 const body=(e.calls[0]!.input as {body:{package:{files:{path:string;text:string}[];manifest?:unknown}}}).body
 assert.equal(body.package.files.filter(file=>file.path==='teloa.json').length,1);assert.equal(body.package.manifest,undefined)
 assert.deepEqual(JSON.parse(body.package.files.find(file=>file.path==='teloa.json')!.text),args.template.manifest)
 assert.equal(body.package.files.find(file=>file.path.endsWith('SKILL.md'))!.text,meetingAppText)
 assert.deepEqual(readPageCreateBody('share',JSON.parse(pageCreateCanonicalBody(body))),body)
})
test('真实首call的清单空字符串不做转换，工具指明两个实际字段路径后才允许本人修正重试',async t=>{
 const e=await setup({skillCreator:null});t.after(()=>e.ctx.fiber.dispose());const template=meetingAppTemplate()
 Object.assign(template.files[0]!.json!,{relations:'',entrypoints:''})
 const result=await e.call('teloa_create_draft',{entity:'share',template});assert.equal(result.isError,true)
 const error=JSON.stringify(result.content);assert.match(error,/template\.files\[0\]\.json\.relations/);assert.match(error,/template\.files\[0\]\.json\.entrypoints/);assert.equal(e.calls.length,0)
 assert.equal(template.files[0]!.json!.relations,'');assert.equal(template.files[0]!.json!.entrypoints,'')
 Object.assign(template.files[0]!.json!,{relations:[],entrypoints:[]})
 assert.equal((await e.call('teloa_create_draft',{entity:'share',template},'corrected-original-call')).isError,false);assert.equal(e.calls.length,1)
})
test('typed manifest与同名文件互斥，坏类型、资源关系和声明仍沿严格原parser拒绝',async t=>{
 const e=await setup({skillCreator:null});t.after(()=>e.ctx.fiber.dispose())
 for(const [index,template]of [
  {...typedMeetingAppTemplate(),files:meetingAppTemplate().files},
  {...typedMeetingAppTemplate(),manifest:{...typedMeetingAppTemplate().manifest,entrypoints:''}},
  {...typedMeetingAppTemplate(),manifest:{...typedMeetingAppTemplate().manifest,relations:[{kind:'role-skill',from:'missing',to:'meeting-summary'}]}},
  {...typedMeetingAppTemplate(),manifest:{...typedMeetingAppTemplate().manifest,ownerId:'private-owner'}},
 ].entries())assert.equal((await e.call('teloa_create_draft',{entity:'share',template},'strict-manifest-'+index)).isError,true,'case '+index)
 assert.equal(e.calls.length,0)
})

test('应用模板工具提供完整可调用示例，真实DSH结构校验与原分享校验均接受',async t=>{
 const e=await setup({skillCreator:null});t.after(()=>e.ctx.fiber.dispose())
 const schema=e.ctx.tools.schemas(e.agent).find(item=>item.name==='teloa_create_draft')!
 const example=/最小结构化应用调用：\n([^\n]+)\n/.exec(schema.description??'')
 assert.ok(example,'模型无需查源码或shell猜应用格式')
 const args=JSON.parse(example[1]!);assert.equal(args.entity,'share');assert.equal(args.template.subject,'app');assert.equal('body'in args,false)
 assertObjectJsonSchema(schema.parameters);assert.deepEqual(validateJsonSchemaValue(schema.parameters,args),[])
 const result=await e.call('teloa_create_draft',args)
 assert.equal(result.isError,false,JSON.stringify(result.content));assert.equal(e.calls.length,1)
 assert.doesNotThrow(()=>readPageCreateBody('share',(e.calls[0]!.input as {body:unknown}).body))
 assert.match(schema.description??'',/requirements.*字符串数组/);assert.match(schema.description??'',/sourceFiles.*字符串数组/)
})
test('分享模板帮助按当前对象选择主体，应用示例不覆盖员工模板',async t=>{
 const e=await setup({skillCreator:null});t.after(()=>e.ctx.fiber.dispose())
 const schema=e.ctx.tools.schemas(e.agent).find(item=>item.name==='teloa_create_draft')!
 const guidance=(schema.description??'').split('最小结构化应用调用：\n')[1]??''
 assert.match(guidance,/仅当当前需求为应用时[^。]*subject=app/)
 assert.match(guidance,/employee\/team\/skill\/mcp[^。]*对应 subject[^。]*原有结构校验/)
 const app=typedMeetingAppTemplate(),id='review-assistant',title='资料核对助理'
 const employee={format:'teloa.role/v1',name:title,kind:'employee',duty:role.duty,dataScope:role.dataScope,executionScope:role.executionScope,responsibility:role.responsibility}
 const template={...app,subject:'employee',id,title,compatibility:{...app.compatibility,capabilities:['people']},manifest:{...app.manifest,id,title,resources:[{id,kind:'role',title,version:app.version,required:true,source:{kind:'local',path:'roles/'+id+'.json'}}]},files:[{path:'roles/'+id+'.json',json:employee}]}
 const result=await e.call('teloa_create_draft',{entity:'share',template})
 assert.equal(result.isError,false,JSON.stringify(result.content));assert.equal(e.calls.length,1)
 const body=(e.calls[0]!.input as {body:{package:{subject:string}}}).body
 assert.equal(body.package.subject,'employee');assert.doesNotThrow(()=>readPageCreateBody('share',body))
})
test('应用模板结构化json清单由宿主编码一次，Unicode换行与文本逐字保留',async t=>{
 const e=await setup({skillCreator:null});t.after(()=>e.ctx.fiber.dispose())
 const template=meetingAppTemplate(),args=JSON.parse(JSON.stringify({entity:'share',template}))
 const schema=e.ctx.tools.schemas(e.agent).find(item=>item.name==='teloa_create_draft')!
 assert.deepEqual(validateJsonSchemaValue(schema.parameters,args),[])
 const result=await e.call('teloa_create_draft',args)
 assert.equal(result.isError,false,JSON.stringify(result.content))
 const body=(e.calls[0]!.input as {body:{package:{subject:string;files:{path:string;text:string}[]}}}).body
 assert.equal(body.package.subject,'app');assert.equal(body.package.files.find(file=>file.path.endsWith('SKILL.md'))!.text,meetingAppText)
 assert.deepEqual(JSON.parse(body.package.files.find(file=>file.path==='teloa.json')!.text),template.files[0]!.json)
 assert.deepEqual(readPageCreateBody('share',JSON.parse(pageCreateCanonicalBody(body))),body)
 assert.equal('template'in (e.calls[0]!.input as object),false,'只把既有package正文交给草案服务')
})
test('应用模板兼容旧body原文，body与template恰一且不得跨实体混用',async t=>{
 const e=await setup({skillCreator:null});t.after(()=>e.ctx.fiber.dispose());const body=oldMeetingAppBody()
 assert.equal((await e.call('teloa_create_draft',{entity:'share',body:JSON.stringify(body)},'old-share')).isError,false)
 assert.deepEqual((e.calls[0]!.input as {body:unknown}).body,body)
 for(const [index,args]of [
  {entity:'share',template:meetingAppTemplate(),body:JSON.stringify(body)},
  {entity:'share'},
  {entity:'share',template:JSON.stringify(meetingAppTemplate())},
  {entity:'role',template:meetingAppTemplate(),body:JSON.stringify(role)},
  {entity:'skill',template:meetingAppTemplate(),skill:markdownSkill(reviewMarkdown)},
  {entity:'share',template:meetingAppTemplate(),skill:markdownSkill(reviewMarkdown)},
 ].entries())assert.equal((await e.call('teloa_create_draft',args,'share-exclusive-'+index)).isError,true,'case '+index)
 assert.equal(e.calls.length,1)
})
test('应用模板拒绝真实失败稿形状：schema错名、requirements字符串与sourceFiles对象不做容错',async t=>{
 const e=await setup({skillCreator:null});t.after(()=>e.ctx.fiber.dispose())
 const source=oldMeetingAppBody().package
 const {format:_,...rest}=source
 const failed={package:{...rest,schema:'teloa.template-share/v2',subject:'skill',requirements:'会议记录纯文本',sourceFiles:[{path:'teloa.json'}],compatibility:{manifestFormat:'teloa.template-share/v2',capabilities:[]}}}
 assert.equal((await e.call('teloa_create_draft',{entity:'share',body:JSON.stringify(failed)},'failed-share-body')).isError,true)
 for(const [index,template]of [
  {...meetingAppTemplate(),schema:'teloa.template-share/v2'},
  {...meetingAppTemplate(),requirements:'会议记录纯文本'},
  {...meetingAppTemplate(),sourceFiles:[{path:'source/original.json'}]},
  {...meetingAppTemplate(),subject:'employee'},
  {...meetingAppTemplate(),compatibility:{manifestFormat:'teloa.template-share/v2',capabilities:[]}},
  {...meetingAppTemplate(),ownerId:'private-owner'},
 ].entries())assert.equal((await e.call('teloa_create_draft',{entity:'share',template},'failed-share-structured-'+index)).isError,true,'case '+index)
 assert.equal(e.calls.length,0,'格式错误不得进入持久草案服务')
})
test('应用模板json和text恰一，非法文件与超限正文不写入不截断',async t=>{
 const e=await setup({skillCreator:null});t.after(()=>e.ctx.fiber.dispose());const app=meetingAppTemplate()
 for(const [index,template]of [
  {...app,files:[{...app.files[0],text:'{}'},app.files[1]]},
  {...app,files:[{path:'teloa.json',json:'{}'},app.files[1]]},
  {...app,files:[{path:'teloa.json',json:[]},app.files[1]]},
  {...app,files:[app.files[0],{path:'skills/meeting-summary/SKILL.md',json:{content:'不得当作文本'}}]},
  {...app,files:[app.files[0],{path:'../SKILL.md',text:meetingAppText}]},
  {...app,files:[app.files[0],{path:'skills/meeting-summary/SKILL.md',text:meetingAppText+'\ud800'}]},
  meetingAppTemplate(meetingAppText+'中'.repeat(50000)),
 ].entries())assert.equal((await e.call('teloa_create_draft',{entity:'share',template},'bad-share-files-'+index)).isError,true,'case '+index)
 assert.equal(e.calls.length,0)
})

async function setup(overrides:Partial<PageCreateToolsPorts>={},options:{subagent?:boolean;instructions?:number;beforeTools?:(ctx:Context)=>void}={}){
 const ctx=new Context();await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('page-create-session'),...(options.subagent?{meta:{origin:'subagent' as const,delegationDepth:1}}:{}),agentOptions:{provider:'test',model:'test'}})
 agent.session.append('turn/start',{turn:1})
 for(let index=0;index<(options.instructions??1);index++)agent.session.append('user/message',createUserMessage({source:{kind:'user',rpcId:'page-create-request'},content:[{type:'text',text:'帮我新建 SOC 调查岗位'}]}),{surfaceOp:'append'})
 const calls:Array<{kind:'directory'|'draft';input:unknown}>=[]
 const ports:PageCreateToolsPorts={owner,conversation:async sessionId=>({ownerId:owner,sessionId,status:'ready'}),readTaskPolicy:async()=>null,skillCreator:creator,preview:async()=>{throw Error('预览端口未配置')},draftDirectory:async input=>({schema:'teloa.page-create-drafts/v1',...input,readAt:'2026-10-12T00:00:00Z',drafts:[]}),directory:async input=>{calls.push({kind:'directory',input});return {entity:input.entity,scopes:['SOC']}},draft:async input=>{calls.push({kind:'draft',input});return {id:'11111111-1111-4111-8111-111111111111',ownerId:owner,requestId:input.requestId,entity:input.entity,status:'draft'}},...overrides}
 options.beforeTools?.(ctx)
 registerPageCreateTools(ctx,ports)
 const call=(name:string,args:Record<string,unknown>,callId='call')=>ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId(callId),signal:AbortSignal.timeout(5000)})
 return {ctx,agent,calls,call}
}

test('真实工具注册创建目录、已存草案目录和草案保存；不提供 apply/revert',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 assert.deepEqual(e.ctx.tools.schemas(e.agent).filter(item=>item.name.startsWith('teloa_create_')).map(item=>item.name),[...pageCreateToolNames])
 const result=await e.call('teloa_create_directory',{entity:'role'})
 assert.equal(result.isError,false);assert.deepEqual(e.calls,[{kind:'directory',input:{entity:'role'}}])
 for(const name of ['teloa_create_apply','teloa_create_revert'])assert.equal((await e.call(name,{draftId:'11111111-1111-4111-8111-111111111111'})).isError,true)
})

test('计划配置的结构化和旧正文入口均保留明确money，缺省不能清除已有费用上限',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 const complete=structuredClone(configurePlanDraftExample);complete.work.budget.money={currency:'SGD',maxMinorUnits:300}
 for(const [index,input]of [{plan:complete},{body:JSON.stringify(complete)}].entries()){
  assert.equal((await e.call('teloa_create_draft',{entity:'plan',...input},'config-'+index)).isError,false)
  const saved=e.calls.at(-1)!.input as {body:unknown}
  assert.deepEqual(readPageCreatePlanDraft(saved.body).work.budget.money,complete.work.budget.money)
 }
 const incomplete=JSON.parse(JSON.stringify(complete));delete incomplete.work.budget.money
 for(const [index,input]of [{plan:incomplete},{body:JSON.stringify(incomplete)}].entries())assert.equal((await e.call('teloa_create_draft',{entity:'plan',...input},'missing-money-'+index)).isError,true)
 assert.equal(e.calls.length,2)
})

test('模型可见的岗位草案示例通过正式写入契约，无需猜字段或读取源码',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 const description=e.ctx.tools.schemas(e.agent).find(item=>item.name==='teloa_create_draft')!.description
 const example=/最小员工示例：\n([^\n]+)\n/.exec(description??'')
 assert.ok(example,'工具必须提供完整可用的岗位定义示例')
 const parsed=JSON.parse(example[1]!)
 assert.deepEqual(roleWriteDefinition(parsed),parsed)
 assert.deepEqual(parsed.skills,[]);assert.deepEqual(parsed.knowledge,[])
 assert.ok(!('runtimeConfig' in parsed),'示例不应编造宿主预设')
})

test('草案保存沿用原生判断；同一调用重试稳定，同轮多调用互不覆盖',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose());let approvals=0
 e.ctx.provide('approval',{request:async()=>{approvals++;return 'allowed-once'}})
 const one=await e.call('teloa_create_draft',{entity:'role',body:JSON.stringify(role)},'one'),two=await e.call('teloa_create_draft',{entity:'role',body:JSON.stringify(role)},'two'),retry=await e.call('teloa_create_draft',{entity:'role',body:JSON.stringify(role)},'one')
 assert.equal(one.isError,false);assert.equal(two.isError,false);assert.equal(retry.isError,false)
 assert.equal(approvals,0,'保存草案不额外附加无差别审批')
 const drafts=e.calls.filter(call=>call.kind==='draft').map(call=>call.input as {requestId:string;entity:string;body:unknown})
 assert.equal(drafts[0]?.entity,'role');assert.deepEqual(drafts[0]?.body,role)
 assert.notEqual(drafts[0]?.requestId,drafts[1]?.requestId)
 assert.equal(drafts[0]?.requestId,drafts[2]?.requestId)
 e.ctx.on('tools/pre-execute',async(exec,next)=>exec.name==='teloa_create_draft'?{kind:'deny',reason:'原生拒绝'}:next())
 assert.equal((await e.call('teloa_create_draft',{entity:'role',body:JSON.stringify(role)},'three')).isError,true)
 assert.equal(e.calls.length,3)
})

test('子 Agent、多条指令、任务会话和无效范围都不能读取目录或写草案',async t=>{
 const cases:Array<{overrides?:Partial<PageCreateToolsPorts>;options?:Parameters<typeof setup>[1]}>=
  [{options:{subagent:true}},{options:{instructions:0}},{options:{instructions:2}},{overrides:{readTaskPolicy:async()=>({allowedTools:[],nativeRequestId:'task-run'})}}]
 for(const item of cases){
  const e=await setup(item.overrides,item.options);t.after(()=>e.ctx.fiber.dispose());e.ctx.provide('approval',{request:async()=> 'allowed-once'})
  assert.equal((await e.call('teloa_create_directory',{entity:'connector',scope:'SOC'})).isError,true)
  assert.equal((await e.call('teloa_create_draft',{entity:'role',body:JSON.stringify(role)})).isError,true)
  assert.equal(e.calls.length,0)
 }
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 assert.equal((await e.call('teloa_create_directory',{entity:'unknown'})).isError,true)
 const roleGeneral=await e.call('teloa_create_directory',{entity:'role',scope:'general'})
 assert.equal(roleGeneral.isError,false);assert.deepEqual(e.calls.at(-1),{kind:'directory',input:{entity:'role'}})
 const skillScoped=await e.call('teloa_create_directory',{entity:'skill',scope:'SOC'})
 assert.equal(skillScoped.isError,false);assert.deepEqual(e.calls.at(-1),{kind:'directory',input:{entity:'skill'}})
 const connectorGeneral=await e.call('teloa_create_directory',{entity:'connector',scope:'general'})
 assert.equal(connectorGeneral.isError,true);assert.ok(JSON.stringify(connectorGeneral).includes('不能是通用工作'))
 e.ctx.provide('approval',{request:async()=>'allowed-once'})
 const draftGeneral=await e.call('teloa_create_draft',{entity:'role',scope:'general',body:'{}'})
 assert.equal(draftGeneral.isError,false);const saved=e.calls.at(-1) as {input:{requestId:string;origin:{sessionId:string;messageId:string;messageSeq:number;requestId:string}}};assert.equal(saved.input.origin.sessionId,e.agent.session.id);assert.equal(saved.input.origin.requestId,'page-create-request');assert.deepEqual(e.calls.at(-1),{kind:'draft',input:{entity:'role',body:{},requestId:saved.input.requestId,origin:saved.input.origin}})
})

test('页内新建与草案检索工具都不在岗位自授权白名单内',()=>{
 for(const name of pageCreateToolNames){
  assert.equal(roleGrantToolNames.includes(name),false)
  assert.throws(()=>validateReferenceToolRules([{name,allowed:[{scope:'SOC'}]}],[{name,allowed:[{scope:'SOC'}]}]),{code:'teloa/forbidden'})
 }
})

const skillBody=JSON.stringify({id:'content-review',title:'内容核对',version:'1.0.0',categories:[],files:[{path:'SKILL.md',base64:Buffer.from('---\nname: content-review\ndescription: Review drafts.\n---\nCheck facts.\n').toString('base64')}]})
const inject=(agent:{session:{append:(...args:any[])=>unknown}},text=creator.rendered)=>agent.session.append('user/message',createUserMessage({source:{kind:'skill-invocation',name:'teloa-skill-creator',form:'instructions'} as never,content:[{type:'text',text}]}),{surfaceOp:'append'})

test('技能草案没有创建器加载证据时在审批前拒绝，并告诉模型先加载创建器',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose());let approvals=0
 e.ctx.provide('approval',{request:async()=>{approvals++;return 'allowed-once'}})
 const result=await e.call('teloa_create_draft',{entity:'skill',body:skillBody})
 assert.equal(result.isError,true);assert.equal(approvals,0);assert.equal(e.calls.length,0)
 assert.match(JSON.stringify(result.content),/teloa-skill-creator/)
 inject(e.agent,creator.rendered.replace('固定','改过'))
 assert.equal((await e.call('teloa_create_draft',{entity:'skill',body:skillBody},'call-2')).isError,true)
 assert.equal(e.calls.length,0)
})

test('创建器正文在当前上下文中时，技能草案按原生规则保存',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose());let approvals=0
 e.ctx.provide('approval',{request:async()=>{approvals++;return 'allowed-once'}})
 inject(e.agent)
 const result=await e.call('teloa_create_draft',{entity:'skill',body:skillBody})
 assert.equal(result.isError,false,JSON.stringify(result.content));assert.equal(approvals,0)
 assert.equal(e.calls.length,1);assert.equal((e.calls[0]!.input as {entity:string}).entity,'skill')
})

test('创建器不可用时技能草案一律拒绝，其他实体不受影响',async t=>{
 const e=await setup({skillCreator:null});t.after(()=>e.ctx.fiber.dispose())
 e.ctx.provide('approval',{request:async()=>'allowed-once'})
 inject(e.agent)
 const skill=await e.call('teloa_create_draft',{entity:'skill',body:skillBody})
 assert.equal(skill.isError,true);assert.match(JSON.stringify(skill.content),/技能创建器不可用/)
 const directory=await e.call('teloa_create_directory',{entity:'skill'},'call-2')
 assert.equal(directory.isError,false)
})

test('技能创建器在多模态真实用户轮次仍有效，预审等待后新轮次不能重绑旧草案',async t=>{
 let release!:()=>void,entered!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve}),waiting=new Promise<void>(resolve=>{entered=resolve})
 const e=await setup({}, {beforeTools:ctx=>{ctx.on('tools/pre-execute',async(exec,next)=>{if(exec.name==='teloa_create_draft'){entered();await gate}return next()})}});t.after(()=>e.ctx.fiber.dispose())
 e.agent.session.append('turn/start',{turn:2})
 e.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'把图片与附件中的办法整理成技能 [引用](teloa://resource/a)'},{type:'image',attachment:{id:'never-read-image'}} as never,{type:'file',attachment:{id:'never-read-file'}} as never]}),{surfaceOp:'append'})
 inject(e.agent)
 const pending=e.call('teloa_create_draft',{entity:'skill',body:skillBody})
 await waiting
 e.agent.session.append('turn/start',{turn:3});e.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'这是后来的一条用户指令'}]}),{surfaceOp:'append'})
 release()
 assert.equal((await pending).isError,true);assert.equal(e.calls.length,0)
 const accepted=await setup();t.after(()=>accepted.ctx.fiber.dispose())
 accepted.agent.session.append('turn/start',{turn:2});accepted.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'创建技能'},{type:'image',attachment:{id:'never-read-image'}} as never,{type:'file',attachment:{id:'never-read-file'}} as never]}),{surfaceOp:'append'});inject(accepted.agent)
 assert.equal((await accepted.call('teloa_create_draft',{entity:'skill',body:skillBody})).isError,false);assert.equal(accepted.calls.length,1)
})

test('草稿修改工具绑定当前真实本人消息与原稿摘要，不调用新建、确认或安装',async t=>{
 let accepted:any,currentChecks=0
 const e=await setup({revise:async(input,signal,current)=>{accepted=input;assert.equal(signal.aborted,false);await current();currentChecks++;return {...lookupDraft(),entity:'role',id:input.draftId,bodyHash:'b'.repeat(64)}}});t.after(()=>e.ctx.fiber.dispose())
 const args={draftId:'11111111-1111-4111-8111-111111111111',expectedBodyHash:'a'.repeat(64),entity:'role',body:JSON.stringify(role)},result=await e.call('teloa_create_revise',args)
 assert.equal(result.isError,false,JSON.stringify(result.content));assert.equal(accepted.draftId,args.draftId);assert.equal(accepted.expectedBodyHash,args.expectedBodyHash);assert.deepEqual(accepted.body,role);assert.equal(accepted.acceptedSource.sessionId,e.agent.session.id);assert.equal(accepted.acceptedSource.requestId,'page-create-request');assert.ok(accepted.acceptedSource.messageId);assert.equal(typeof accepted.acceptedSource.messageSeq,'number');assert.equal(currentChecks,1);assert.deepEqual(e.calls,[])
})
test('草稿修改的任务/子代理身份、伪造本人来源和核对中撤回均拒绝',async t=>{
 for(const cause of ['task','subagent','forged','changed','replaced']){
  let calls=0,agent:any
  const e=await setup({...(cause==='task'?{readTaskPolicy:async()=>({kind:'history'}) as never}:{}),revise:async(_input,_signal,current)=>{calls++;if(cause==='changed')agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'取消刚才的修改'}]}),{surfaceOp:'append'});if(cause==='replaced'){const original=agent.session.snapshotEvents().findLast((event:any)=>event.type==='user/message'&&event.data.source.kind==='user').seq;agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'替换原引用消息'}]}),{surfaceOp:{op:'replace',startSeq:original,endSeq:original},sourceEventSeqs:[original]})}await current();return lookupDraft()}},{subagent:cause==='subagent'});agent=e.agent;t.after(()=>e.ctx.fiber.dispose())
  const result=await e.call('teloa_create_revise',{draftId:'11111111-1111-4111-8111-111111111111',expectedBodyHash:'a'.repeat(64),entity:'role',body:JSON.stringify(role),...(cause==='forged'?{acceptedSource:{sessionId:'forged'}}:{})})
  assert.equal(result.isError,true,cause);assert.equal(calls,cause==='changed'||cause==='replaced'?1:0,cause);assert.deepEqual(e.calls,[])
 }
})
test('同名同时间的原稿以本人显式引用锁定目标与摘要，不接受模型换稿或刷新成新摘要',async t=>{
 const selected={id:'11111111-1111-4111-8111-111111111111',title:'相同名称',bodyHash:'a'.repeat(64)},other={...selected,id:'22222222-2222-4222-8222-222222222222'},stamp='2026-10-17T00:00:00.000Z',saved=[selected,other].map(row=>({...lookupDraft(),...row,createdAt:stamp,updatedAt:stamp}));let calls=0
 const e=await setup({revise:async(input)=>{calls++;assert.equal(input.draftId,selected.id);return saved[0]}});t.after(()=>e.ctx.fiber.dispose())
 e.agent.session.append('turn/start',{turn:2});e.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'继续修改这份草稿，先保留未确认。\n'+encodePageCreateDraftReference(selected)},{type:'image',attachment:{id:'reference-with-image'}} as never]}),{surfaceOp:'append'})
 const args={draftId:selected.id,expectedBodyHash:selected.bodyHash,entity:'role',body:JSON.stringify(role)}
 assert.equal((await e.call('teloa_create_revise',{...args,draftId:other.id},'wrong-target')).isError,true)
 assert.equal((await e.call('teloa_create_revise',{...args,expectedBodyHash:'b'.repeat(64)},'stale-reference')).isError,true)
 assert.equal(calls,0)
 assert.equal((await e.call('teloa_create_revise',args,'chosen-target')).isError,false);assert.equal(calls,1)
 e.agent.session.append('turn/start',{turn:3});e.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:encodePageCreateDraftReference(selected)+'\n'+encodePageCreateDraftReference(other)}]}),{surfaceOp:'append'})
 assert.equal((await e.call('teloa_create_revise',args,'multiple-targets')).isError,true);assert.equal(calls,1)
})
test('原稿 Markdown 引用只显示转义标题，损坏身份或摘要明确失败',()=>{
 const value={id:'11111111-1111-4111-8111-111111111111',title:'核对[客户]\\资料',bodyHash:'a'.repeat(64)},markdown=encodePageCreateDraftReference(value)
 assert.ok(markdown.startsWith('[核对\\[客户\\]\\\\资料]('))
 assert.deepEqual(readPageCreateDraftReferences(markdown),[{draftId:value.id,bodyHash:value.bodyHash}])
 assert.throws(()=>readPageCreateDraftReferences(markdown.replace(value.bodyHash,'stale')),{code:'teloa/invalid-input'})
 assert.deepEqual(readPageCreateDraftReferences('只修改这份草稿的验证步骤。'),[])
})

test('带连接应用示例只引用目录连接的服务名与工具，真实DSH结构校验与原分享校验均接受',async t=>{
 const e=await setup({skillCreator:null});t.after(()=>e.ctx.fiber.dispose())
 const schema=e.ctx.tools.schemas(e.agent).find(item=>item.name==='teloa_create_draft')!,description=schema.description??''
 const example=/最小结构化带连接应用调用：\n([^\n]+)\n/.exec(description)
 assert.ok(example,'有连接需求时模型可直接参照带连接示例')
 const args=JSON.parse(example[1]!),template=args.template
 assert.equal(template.subject,'app');assert.ok(template.compatibility.capabilities.includes('connections'))
 const mcp=template.manifest.resources.find((row:{kind:string})=>row.kind==='mcp')
 assert.equal(mcp.required,false)
 const file=template.files.find((row:{path:string})=>row.path===mcp.source.path)
 assert.deepEqual(Object.keys(file.json).sort(),['format','serverName','tools']);assert.equal(file.json.format,'teloa.mcp-connection/v1')
 assert.ok(template.requirements.some((row:string)=>row.includes(mcp.title)))
 assert.deepEqual(validateJsonSchemaValue(schema.parameters,args),[])
 const result=await e.call('teloa_create_draft',args)
 assert.equal(result.isError,false,JSON.stringify(result.content));assert.equal(e.calls.length,1)
 const body=(e.calls[0]!.input as {body:{package:unknown}}).body
 assert.doesNotThrow(()=>readTemplateShare(body.package));assert.doesNotThrow(()=>readPageCreateBody('share',body))
 assert.match(description,/teloa_create_directory[^。]*entity=share[^。]*serverName/)
 assert.match(description,/不得写[^。]*auth[^。]*token[^。]*url/)
 assert.match(description,/设置连接/)
})
test('带依赖应用的员工模板示例经 role-connection 声明应用，真实DSH结构校验与原分享校验均接受',async t=>{
 const e=await setup({skillCreator:null});t.after(()=>e.ctx.fiber.dispose())
 const schema=e.ctx.tools.schemas(e.agent).find(item=>item.name==='teloa_create_draft')!,description=schema.description??''
 const example=/最小结构化带依赖应用员工模板调用：\n([^\n]+)\n/.exec(description)
 assert.ok(example,'创建员工时可直接参照带依赖应用的示例')
 const args=JSON.parse(example[1]!),template=args.template
 assert.equal(template.subject,'employee');assert.deepEqual([...template.compatibility.capabilities].sort(),['connections','people'])
 const plugin=template.manifest.resources.find((row:{kind:string})=>row.kind==='plugin'),role=template.manifest.resources.find((row:{kind:string})=>row.kind==='role')
 assert.equal(plugin.required,false)
 assert.deepEqual(template.manifest.relations,[{kind:'role-connection',from:role.id,to:plugin.id}])
 const file=template.files.find((row:{path:string})=>row.path===plugin.source.path)
 assert.deepEqual(Object.keys(file.json).sort(),['format','packageName','registry','version']);assert.equal(file.json.version,plugin.version)
 assert.deepEqual(validateJsonSchemaValue(schema.parameters,args),[])
 const result=await e.call('teloa_create_draft',args)
 assert.equal(result.isError,false,JSON.stringify(result.content))
 const body=(e.calls[0]!.input as {body:{package:unknown}}).body
 assert.doesNotThrow(()=>readTemplateShare(body.package));assert.doesNotThrow(()=>readPageCreateBody('share',body))
 assert.match(description,/依赖的应用[^。]*role-connection/)
 assert.match(description,/本人[^。]*包名[^。]*不编造/)
})
test('模板能力与资源类型按原分享规则预校验，原因透传给模型且不写草案',async t=>{
 const e=await setup({skillCreator:null});t.after(()=>e.ctx.fiber.dispose())
 const schema=e.ctx.tools.schemas(e.agent).find(item=>item.name==='teloa_create_draft')!
 const template=JSON.parse(/最小结构化带连接应用调用：\n([^\n]+)\n/.exec(schema.description??'')![1]!).template
 const missing=await e.call('teloa_create_draft',{entity:'share',template:{...template,compatibility:{...template.compatibility,capabilities:[]}}},'missing-connections')
 assert.equal(missing.isError,true);assert.match(JSON.stringify(missing.content),/template\.compatibility\.capabilities[^"]*connections/)
 const mcpPath=template.manifest.resources.find((row:{kind:string})=>row.kind==='mcp').source.path
 const runtime=await e.call('teloa_create_draft',{entity:'share',template:{...template,files:template.files.map((row:{path:string;json?:object})=>row.path===mcpPath?{...row,json:{...row.json,url:'https://mcp.example.test/mcp'}}:row)}},'runtime-config')
 assert.equal(runtime.isError,true);assert.match(JSON.stringify(runtime.content),/原因：Template contains missing or unsupported fields/)
 assert.equal(e.calls.length,0)
})
test('分享目录列出可用已审连接的服务名、工具与鉴权方式，不含配方、地址或密钥',()=>{
 const text=(zh:string)=>({'zh-CN':zh,en:zh})
 const entry=(id:string,serverName:string,auth:unknown,patch:Record<string,unknown>={})=>({id,kind:'connector',version:'1.0.0',compatibility:{status:'needs-configuration',teloa:'>=0.2.0',dsh:'>=0.2.0',conditions:[]},connector:{serverName,title:text(serverName+' 服务'),summary:text('说明'),auth,recipe:{transport:'streamable-http',url:'https://mcp.example.test/'+serverName},tools:[{name:'search',description:text('搜索'),readOnly:true},{name:'update',description:text('更新'),readOnly:false}],upstreamUrl:'https://github.com/example/'+serverName},...patch}) as never
 const rows=shareConnectorDirectory([
  entry('teloa.mcp-docs','docs',{kind:'secret',vars:[{target:'env',envVarName:'DOCS_TOKEN',label:text('文档令牌'),required:true}]}),
  entry('teloa.mcp-open','open',{kind:'none'}),
  entry('teloa.mcp-mail','mail',{kind:'oauth',supported:true,scopes:['mail.read']}),
  entry('teloa.mcp-blocked','blocked',{kind:'oauth',supported:false,reason:'厂商未开放'}),
  entry('teloa.mcp-off','off',{kind:'none'},{compatibility:{status:'unsupported',teloa:'>=0.2.0',dsh:'>=0.2.0',conditions:[]}}),
 ])
 assert.deepEqual(rows,[
  {serverName:'docs',title:'docs 服务',tools:['search','update'],auth:'secret',secrets:['文档令牌']},
  {serverName:'open',title:'open 服务',tools:['search','update'],auth:'none'},
  {serverName:'mail',title:'mail 服务',tools:['search','update'],auth:'oauth'},
 ])
 const raw=JSON.stringify(rows);for(const hidden of ['DOCS_TOKEN','https://','recipe','mail.read','envVarName'])assert.equal(raw.includes(hidden),false,hidden)
})
