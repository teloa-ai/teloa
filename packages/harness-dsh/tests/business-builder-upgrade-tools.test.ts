import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId,createUserMessage} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {WorkError,industryUpdateCanonical,readBusinessConfigurationCandidateVersioned,readBusinessConfigurationPatchVersioned} from '@teloa/contract'
import type {BusinessConfigurationDraft} from '@teloa/backend'
import {registerBusinessBuilderTools,type BusinessBuilderToolsPorts} from '../src/business-builder-tools.ts'

const read='teloa_business_builder_read',revise='teloa_business_builder_revise',upgrade='teloa_business_builder_upgrade'
const v1='teloa.business-configuration/v1',v2='teloa.business-configuration/v2',scope='business_0123456789abcdef0123456789abcdef'
const hash=(candidate:unknown)=>createHash('sha256').update(industryUpdateCanonical(candidate)).digest('hex')
const body=(result:{content:readonly {type:string;text?:string}[]})=>JSON.parse(result.content.filter(item=>item.type==='text').map(item=>item.text).join(''))
async function fixture(format:typeof v1|typeof v2=v1,origin?:'subagent'){
 const owner='builder:'+randomUUID(),now='2026-09-30T00:00:00.000Z'
 const candidate=readBusinessConfigurationCandidateVersioned({format,scope,title:'客户跟进',sources:[{sourceId:'records',kind:'local-records'}],definitions:[{kind:'object-type',definition:{format:format===v1?'teloa.business-object-type/v1':'teloa.business-object-type/v2',id:'customer',version:'1.0.0',domain:scope,title:'客户',unit:'位',lead:'跟进',sourceId:'records',fields:[{name:'name',label:'姓名',type:'text',required:true,from:'姓名'}]}}],pages:[{id:'customers',title:'客户名单',kind:'records',objectType:'customer',fields:['name'],allowCreate:true,allowEdit:true,allowArchive:true}],homePageId:'customers'})
 let draft:BusinessConfigurationDraft={ownerId:owner,id:randomUUID(),scope,revision:1,baseVersion:0,candidate,hash:hash(candidate),status:'draft',createdAt:now,updatedAt:now}
 const original=structuredClone(draft),receipts=new Map<string,BusinessConfigurationDraft>(),reviseCommands=new Map<string,string>(),upgrades:unknown[]=[],revisions:unknown[]=[],receiptReads:unknown[]=[],approvals:unknown[]=[]
 const ctx=new Context();await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('upgrade-builder-'+randomUUID()),...(origin?{meta:{origin,delegationDepth:1}}:{}),agentOptions:{provider:'test',model:'test'}})
 const turn=()=>{agent.session.append('turn/start',{turn:0} as never);agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'增加金额与多选'}]}),{surfaceOp:'append'})};turn()
 const binding={requestId:randomUUID(),kind:'builder' as const,title:'客户跟进',draftId:draft.id,sessionId:agent.session.id,createdAt:now,updatedAt:now}
 const ports:BusinessBuilderToolsPorts={owner,conversation:async sessionId=>({ownerId:owner,sessionId,status:'ready'}),readTaskPolicy:async()=>null,isRoleConversation:async()=>false,isTaskConversation:async()=>false,binding:async()=>binding,draft:async()=>structuredClone(draft),revise:async input=>{
  revisions.push(input);const prior=receipts.get(input.requestId);if(prior){if(reviseCommands.get(input.requestId)!==hash({draftId:input.draftId,expectedRevision:input.expectedRevision,patch:input.patch}))throw new WorkError('teloa/conflict','原修订请求内容不一致');return structuredClone(prior)}
  if(input.expectedRevision!==draft.revision)throw new WorkError('teloa/version-conflict','草案已变化')
  const candidate=readBusinessConfigurationCandidateVersioned({...draft.candidate,...(input.patch.title?{title:input.patch.title}:{}),...(input.patch.upsertDefinitions?{definitions:input.patch.upsertDefinitions}:{}),...(input.patch.upsertPages?{pages:input.patch.upsertPages}:{}),...(input.patch.homePageId?{homePageId:input.patch.homePageId}:{})})
  draft={...draft,candidate,hash:hash(candidate),revision:draft.revision+1};receipts.set(input.requestId,structuredClone(draft));reviseCommands.set(input.requestId,hash({draftId:input.draftId,expectedRevision:input.expectedRevision,patch:input.patch}));return structuredClone(draft)
 },reviseReceipt:async input=>{
  receiptReads.push(input);const prior=receipts.get(input.requestId);if(!prior)return undefined
  const patch=readBusinessConfigurationPatchVersioned(input.patch,prior.candidate.format)
  if(reviseCommands.get(input.requestId)!==hash({draftId:input.draftId,expectedRevision:input.expectedRevision,patch}))throw new WorkError('teloa/conflict','原修订请求内容不一致')
  return structuredClone(prior)
 },upgradeFormat:async input=>{
  upgrades.push(input);const prior=receipts.get(input.requestId);if(prior)return structuredClone(prior)
  if(input.expectedRevision!==draft.revision||draft.candidate.format!==v1)throw new WorkError('teloa/version-conflict','草案已变化')
  const candidate=readBusinessConfigurationCandidateVersioned({...draft.candidate,format:v2,definitions:draft.candidate.definitions.map(item=>item.kind==='object-type'?{...item,definition:{...item.definition,format:'teloa.business-object-type/v2'}}:item)})
  draft={...draft,candidate,hash:hash(candidate),revision:draft.revision+1};receipts.set(input.requestId,structuredClone(draft));return structuredClone(draft)
 }}
 registerBusinessBuilderTools(ctx,ports)
 let approval:()=>Promise<string>=async()=> 'allowed-once';ctx.provide('approval',{request:async(input:unknown)=>{approvals.push((input as {reason?:string}).reason);return approval()}})
 const call=(name:string,args:Record<string,unknown>={})=>ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId(randomUUID()),signal:AbortSignal.timeout(5000)})
 return {ctx,agent,ports,binding,original,upgrades,revisions,receiptReads,approvals,turn,call,args:{draftId:original.id,expectedRevision:1},approve:(fn:typeof approval)=>{approval=fn},current:()=>structuredClone(draft),change:(fn:(current:BusinessConfigurationDraft)=>BusinessConfigurationDraft)=>{draft=fn(structuredClone(draft))}}
}

test('v1 草案先声明升级顺序，经原生本人确认仅升级同一草案，再读取真实 v2 能力与原页面',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose())
 const before=body(await f.call(read));assert.equal(before.capabilities.format,v1);assert.equal(before.capabilities.fieldTypes.includes('money'),false);assert.match(before.capabilities.rules,/teloa_business_builder_upgrade/)
 const result=await f.call(upgrade,f.args);assert.equal(result.isError,false,JSON.stringify(result));const saved=body(result)
 assert.equal(saved.draftId,f.original.id);assert.equal(saved.revision,2);assert.equal(saved.baseVersion,0);assert.equal(saved.status,'draft');assert.equal(saved.hash,f.current().hash);assert.equal(saved.format,v2)
 assert.equal(f.upgrades.length,1);assert.equal(f.revisions.length,0);assert.equal(f.approvals.length,1)
 assert.match(JSON.stringify(f.approvals[0]),/增加金额、多选支持/);assert.match(JSON.stringify(f.approvals[0]),/现有记录不会改变/);assert.match(JSON.stringify(f.approvals[0]),/保存业务前仍需预览/)
 assert.equal(f.current().ownerId,f.original.ownerId);assert.equal(f.current().scope,f.original.scope);assert.deepEqual(f.current().candidate.sources,f.original.candidate.sources);assert.deepEqual(f.current().candidate.pages,f.original.candidate.pages)
 const after=body(await f.call(read));assert.equal(after.capabilities.format,v2);assert.ok(after.capabilities.fieldTypes.includes('money'));assert.ok(after.capabilities.fieldTypes.includes('multi-enum'));assert.match(after.capabilities.rules,/records/);assert.deepEqual(after.capabilities.viewFormats,['teloa.business-view/v1','teloa.business-view/v2']);assert.match(after.capabilities.rules,/view-ref/);assert.match(after.capabilities.rules,/保留现有页面和定义/);assert.match(after.capabilities.rules,/不得.*删除/)
 assert.equal(body(await f.call(read,{definition:{kind:'object-type',localId:'customer'}})).definition.definition.format,'teloa.business-object-type/v2')
 assert.deepEqual(body(await f.call(read,{pageId:'customers'})).page,f.original.candidate.pages[0])
})

test('原生 read→upgrade→read→revise 使用同一草案为 records 增加金额和多选',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose());await f.call(read)
 assert.equal((await f.call(upgrade,f.args)).isError,false);assert.equal(body(await f.call(read)).revision,2)
 const object=f.current().candidate.definitions[0]!.definition
 if(!('fields' in object))throw Error('应为记录对象')
 const patch={upsertDefinitions:[{kind:'object-type',definition:{...object,fields:[...object.fields,{format:'teloa.business-rich-field/v2',name:'amount',label:'金额',type:'money',required:false,from:'金额',currencies:['CNY','USD']},{format:'teloa.business-rich-field/v2',name:'channels',label:'渠道',type:'multi-enum',required:false,from:'渠道',values:['网站','公众号']}]}}],upsertPages:[{...f.original.candidate.pages[0],fields:['name','amount','channels']}]}
 const result=await f.call(revise,{...f.args,expectedRevision:2,patch});assert.equal(result.isError,false,JSON.stringify(result));assert.equal(body(result).revision,3)
 assert.equal(f.upgrades.length,1);assert.equal(f.revisions.length,1);assert.equal(f.approvals.length,2);assert.equal(f.current().candidate.format,v2)
 assert.deepEqual((f.revisions[0] as {patch:unknown}).patch,patch)
 const instruction=f.agent.session.snapshotEvents().find(event=>event.type==='user/message')!;if(instruction.type!=='user/message')throw Error('缺少原指令')
 const digest=createHash('sha256').update(JSON.stringify(['teloa-business-builder/v1',f.original.ownerId,f.agent.session.id,instruction.data.id,instruction.seq,'teloa_business_builder_upgrade',f.original.id.toLowerCase(),1])).digest('hex')
 assert.equal((f.upgrades[0] as {requestId:string}).requestId,digest.slice(0,8)+'-'+digest.slice(8,12)+'-5'+digest.slice(13,16)+'-a'+digest.slice(17,20)+'-'+digest.slice(20,32))
})

test('升级只收当前草案与预期版本，伪造身份、范围、会话、目标格式和跨草案均在审批前拒绝',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose())
 for(const args of [{...f.args,owner:'other'},{...f.args,scope:'general'},{...f.args,sessionId:f.agent.session.id},{...f.args,targetFormat:v2},{...f.args,format:v2},{...f.args,patch:{}},{...f.args,draftId:randomUUID()},{...f.args,expectedRevision:0},{...f.args,expectedRevision:1.5},{...f.args,expectedRevision:Number.MAX_SAFE_INTEGER+1},{...f.args,expectedRevision:2},{draftId:f.original.id},{expectedRevision:1}])assert.equal((await f.call(upgrade,args)).isError,true)
 assert.equal(f.upgrades.length,0);assert.equal(f.approvals.length,0);assert.equal(f.current().revision,1)
})

test('已支持 v2 的草案拒绝新的升级，旧版本且没有同请求回执不声称成功',async t=>{
 const f=await fixture(v2);t.after(()=>f.ctx.fiber.dispose())
 const result=await f.call(upgrade,f.args);assert.equal(result.isError,true);assert.match(JSON.stringify(result),/已支持.*无需升级/);assert.equal(f.upgrades.length,0);assert.equal(f.approvals.length,0)
 f.change(draft=>({...draft,revision:2}));assert.equal((await f.call(upgrade,f.args)).isError,true);assert.equal(f.current().revision,2)
})

test('升级审批拒绝、取消及上游 deny/cancel 均零写入，保留上游 ask 理由',async t=>{
 for(const outcome of ['rejected','cancelled']){const f=await fixture();t.after(()=>f.ctx.fiber.dispose());f.approve(async()=>outcome);assert.equal((await f.call(upgrade,f.args)).isError,true);assert.equal(f.upgrades.length,0);assert.equal(f.current().revision,1)}
 for(const kind of ['deny','cancel'] as const){const f=await fixture();t.after(()=>f.ctx.fiber.dispose());f.ctx.on('tools/pre-execute',async()=>kind==='deny'?{kind,reason:'原生规则拒绝'}:{kind});assert.equal((await f.call(upgrade,f.args)).isError,true);assert.equal(f.upgrades.length,0);assert.equal(f.approvals.length,0)}
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose());f.ctx.on('tools/pre-execute',async()=>({kind:'ask',reason:'既有确认'}));assert.equal((await f.call(upgrade,f.args)).isError,false);assert.match(JSON.stringify(f.approvals[0]),/既有确认/)
})

test('升级审批期间 revision、格式、本轮指令或本人绑定改变均阻止后端调用',async t=>{
 for(const change of ['revision','format','turn','replace','binding','role','task','owner','sources','baseVersion','hash','status'] as const){
  const f=await fixture();t.after(()=>f.ctx.fiber.dispose())
  f.approve(async()=>{
   if(change==='revision')f.change(draft=>({...draft,revision:2}))
   if(change==='format')f.change(draft=>({...draft,candidate:readBusinessConfigurationCandidateVersioned({...draft.candidate,format:v2,definitions:[]}),hash:'b'.repeat(64)}))
   if(change==='turn')f.turn()
   if(change==='replace')f.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[]}),{surfaceOp:{op:'replace',startSeq:1,endSeq:1},sourceEventSeqs:[1]} as never)
   if(change==='binding')f.binding.draftId=randomUUID()
   if(change==='role')f.ports.isRoleConversation=async()=>true
   if(change==='task')f.ports.readTaskPolicy=async()=>({allowedTools:[]})
   if(change==='owner')f.ports.conversation=async sessionId=>({ownerId:'other',sessionId,status:'ready'})
   if(change==='sources')f.change(draft=>({...draft,candidate:{...draft.candidate,sources:[{sourceId:'other',kind:'local-records'}]}}))
   if(change==='baseVersion')f.change(draft=>({...draft,baseVersion:1}))
   if(change==='hash')f.change(draft=>({...draft,hash:'b'.repeat(64)}))
   if(change==='status')f.change(draft=>({...draft,status:'applied'}))
   return 'allowed-once'
  })
  assert.equal((await f.call(upgrade,f.args)).isError,true,change);assert.equal(f.upgrades.length,0,change)
 }
})

test('未绑定、只读历史、他人、同事、任务与子 Agent 均不能升级本人草案',async t=>{
 for(const change of ['unbound','daily','pending','owner','role','task','policy','no-instruction','subagent','applied'] as const){
  const f=await fixture(v1,change==='subagent'?'subagent':undefined);t.after(()=>f.ctx.fiber.dispose())
  if(change==='unbound')f.ports.binding=async()=>undefined
  if(change==='daily')f.ports.binding=async()=>({...f.binding,kind:'daily'})
  if(change==='pending')f.ports.conversation=async sessionId=>({ownerId:f.original.ownerId,sessionId,status:'pending'})
  if(change==='owner')f.ports.conversation=async sessionId=>({ownerId:'other',sessionId,status:'ready'})
  if(change==='role')f.ports.isRoleConversation=async()=>true
  if(change==='task')f.ports.isTaskConversation=async()=>true
  if(change==='policy')f.ports.readTaskPolicy=async()=>({allowedTools:[]})
  if(change==='no-instruction')f.agent.session.append('turn/start',{turn:1} as never)
  if(change==='applied')f.change(draft=>({...draft,status:'applied'}))
  assert.equal((await f.call(upgrade,f.args)).isError,true,change);assert.equal(f.upgrades.length,0,change);assert.equal(f.approvals.length,0,change)
 }
})

test('升级已提交失回包先读可核对，同原指令重试只恢复原回执，后续修订不被旧回执覆盖',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose());const save=f.ports.upgradeFormat;let lost=true
 f.ports.upgradeFormat=async input=>{const saved=await save(input);if(lost){lost=false;throw Error('lost response')}return saved}
 const unknown=await f.call(upgrade,f.args);assert.equal(unknown.isError,true);assert.match(JSON.stringify(unknown),/先读取当前草案核对/)
 assert.equal(body(await f.call(read)).capabilities.format,v2);assert.equal(f.current().revision,2)
 assert.equal((await f.call(upgrade,f.args)).isError,false);assert.equal(f.current().revision,2);assert.deepEqual(f.upgrades[0],f.upgrades[1])
 assert.equal((await f.call(revise,{...f.args,expectedRevision:2,patch:{title:'后续客户档案'}})).isError,false);assert.equal(f.current().revision,3)
 const replay=await f.call(upgrade,f.args);assert.equal(replay.isError,false);assert.equal(body(replay).revision,2);assert.equal(f.current().revision,3);assert.equal(f.current().candidate.title,'后续客户档案')
 f.turn();assert.equal((await f.call(upgrade,f.args)).isError,true);assert.equal(f.current().revision,3)
})

test('升级回执必须保持原身份、范围、基线和来源并通过真实 v2、revision 与 hash 校验',async t=>{
 for(const bad of ['owner','id','scope','candidateScope','baseVersion','sources','format','definition','revision','hash','status'] as const){
  const f=await fixture();t.after(()=>f.ctx.fiber.dispose());const save=f.ports.upgradeFormat
  f.ports.upgradeFormat=async input=>{
   const saved=await save(input)
   if(bad==='owner')saved.ownerId='other'
   if(bad==='id')saved.id=randomUUID()
   if(bad==='scope')saved.scope='general'
   if(bad==='candidateScope')saved.candidate.scope='general'
   if(bad==='baseVersion')saved.baseVersion=9
   if(bad==='sources')saved.candidate.sources=[{sourceId:'other',kind:'local-records'}]
   if(bad==='format')saved.candidate=f.original.candidate
   if(bad==='definition')(saved.candidate.definitions[0]!.definition as {format:string}).format='teloa.business-object-type/v1'
   if(bad==='revision')saved.revision=3
   if(bad==='hash')saved.hash='f'.repeat(64)
   if(bad==='status')saved.status='applied'
   return saved
  }
  const result=await f.call(upgrade,f.args);assert.equal(result.isError,true,bad);assert.match(JSON.stringify(result),/回执.*不一致/,bad)
 }
})

test('原有修订请求标识逐字节兼容，审批中 revision 改变仍可恢复原修订回执',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose());const args={...f.args,patch:{title:'客户档案'}}
 const instruction=f.agent.session.snapshotEvents().find(event=>event.type==='user/message')!;if(instruction.type!=='user/message')throw Error('缺少原指令')
 const digest=createHash('sha256').update(JSON.stringify(['teloa-business-builder/v1',f.original.ownerId,f.agent.session.id,instruction.data.id,instruction.seq,'teloa_business_builder_revise',f.original.id.toLowerCase(),1])).digest('hex')
 const expected=digest.slice(0,8)+'-'+digest.slice(8,12)+'-5'+digest.slice(13,16)+'-a'+digest.slice(17,20)+'-'+digest.slice(20,32)
 assert.equal((await f.call(revise,args)).isError,false);assert.equal((f.revisions[0] as {requestId:string}).requestId,expected)
 f.approve(async()=>{f.change(draft=>({...draft,revision:3}));return 'allowed-once'})
 assert.equal((await f.call(revise,args)).isError,false);assert.equal((f.revisions[1] as {requestId:string}).requestId,expected);assert.equal(f.current().revision,3)
})

test('v1 对象或仅标题修订成功后升级 v2，同原指令旧请求返回原回执且不覆盖新版草案',async t=>{
 for(const kind of ['object','title'] as const){
  const f=await fixture();t.after(()=>f.ctx.fiber.dispose())
  const patch=kind==='object'?{upsertDefinitions:[{...f.original.candidate.definitions[0],definition:{...f.original.candidate.definitions[0]!.definition,title:'旧版客户档案'}}]}:{title:'旧版客户档案'}
  const args={...f.args,patch},saved=await f.call(revise,args);assert.equal(saved.isError,false);const receipt=body(saved)
  assert.equal((await f.call(upgrade,{...f.args,expectedRevision:2})).isError,false);const current=f.current();assert.equal(current.candidate.format,v2)
  const replay=await f.call(revise,args);assert.equal(replay.isError,false,JSON.stringify(replay));assert.deepEqual(body(replay),receipt);assert.deepEqual(f.current(),current)
  assert.equal(f.receiptReads.length,1);assert.equal((f.revisions[0] as {requestId:string}).requestId,(f.revisions[1] as {requestId:string}).requestId)
  f.turn();assert.equal((await f.call(revise,args)).isError,true);assert.deepEqual(f.current(),current)
 }
})

test('历史修订回执拒绝错误请求内容、跨本人身份及伪造版本来源或 hash',async t=>{
 for(const bad of ['patch','owner','id','scope','sources','baseVersion','revision','hash'] as const){
  const f=await fixture();t.after(()=>f.ctx.fiber.dispose());const args={...f.args,patch:{title:'历史修订'}}
  assert.equal((await f.call(revise,args)).isError,false);assert.equal((await f.call(upgrade,{...f.args,expectedRevision:2})).isError,false)
  const current=f.current(),lookup=f.ports.reviseReceipt,writes=f.revisions.length,approvals=f.approvals.length
  f.ports.reviseReceipt=async input=>{
   const result=await lookup(input);if(!result)return undefined
   if(bad==='owner')result.ownerId='other'
   if(bad==='id')result.id=randomUUID()
   if(bad==='scope')result.scope='general'
   if(bad==='sources')result.candidate.sources=[{sourceId:'other',kind:'local-records'}]
   if(bad==='baseVersion')result.baseVersion=9
   if(bad==='revision')result.revision=9
   if(bad==='hash')result.hash='f'.repeat(64)
   return result
  }
  const result=await f.call(revise,bad==='patch'?{...args,patch:{title:'不同请求内容'}}:args)
  assert.equal(result.isError,true,bad);assert.equal(f.revisions.length,writes,bad);assert.equal(f.approvals.length,approvals,bad);assert.deepEqual(f.current(),current,bad)
 }
})

test('历史修订审批后身份变化或后端返回不同冻结回执均不得声明旧请求恢复成功',async t=>{
 for(const change of ['turn','binding','format','receipt'] as const){
  const f=await fixture();t.after(()=>f.ctx.fiber.dispose());const args={...f.args,patch:{title:'历史修订'}}
  assert.equal((await f.call(revise,args)).isError,false);assert.equal((await f.call(upgrade,{...f.args,expectedRevision:2})).isError,false)
  const current=f.current(),writes=f.revisions.length
  if(change==='receipt'){const save=f.ports.revise;f.ports.revise=async input=>{const result=await save(input);return {...result,hash:'f'.repeat(64)}}}
  f.approve(async()=>{if(change==='turn')f.turn();if(change==='binding')f.binding.draftId=randomUUID();if(change==='format')f.change(draft=>({...draft,candidate:f.original.candidate,hash:f.original.hash}));return 'allowed-once'})
  const result=await f.call(revise,args);assert.equal(result.isError,true,change);assert.equal(f.revisions.length,writes+(change==='receipt'?1:0),change)
  if(change!=='format')assert.deepEqual(f.current(),current,change)
 }
})

test('原生本人指引包含先读、升级、再读与修订顺序，保留本人预览采用入口',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose());const messages=[createUserMessage({source:{kind:'user'},content:[{type:'text',text:'增加金额'}]})]
 const decision=await f.ctx.waterfall('agent/pre-step',{agent:f.agent,messages,turn:1,step:1,signal:new AbortController().signal},async()=>({kind:'enter' as const,messages})) as {messages:unknown[]}
 const notice=JSON.stringify(decision.messages[1]);assert.match(notice,/teloa_business_builder_upgrade/);assert.match(notice,/升级后.*teloa_business_builder_read/);assert.match(notice,/本人.*预览/);assert.match(notice,/现有看板必须完整保留/);assert.match(notice,/v2 类型化统计.*能力表/);assert.match(notice,/旧 SQL 不支持富字段/);assert.match(notice,/multi-reference/);assert.match(notice,/uniqueFields/);assert.doesNotMatch(notice,/含看板的富字段草案.*目前无法采用|类型化指标支持仍待后续开发/);assert.ok(notice.length<2048)
})
