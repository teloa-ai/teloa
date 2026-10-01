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
import {WorkError,readBusinessImportApplyInput,readBusinessImportGetInput,readBusinessImportReceiptInput,readBusinessImportDraftV2,readBusinessImportAnyDraft,readBusinessImportAnyReceipt,type BusinessImportAnyDraft,type BusinessImportAnyReceipt,type BusinessImportDraft,type BusinessImportApplyInput} from '@teloa/contract'
import type {BusinessImportToolsPorts} from '../src/business-import-tools.ts'

const module=await import('../src/business-import-tools.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {} as typeof import('../src/business-import-tools.ts');throw error})
const read='teloa_business_import_read',apply='teloa_business_import_apply',stamp='2026-09-30T00:00:00.000Z'
const first='10000000-0000-4000-8000-000000000001',second='10000000-0000-4000-8000-000000000002',hash='1'.repeat(64)
const body=(result:{content:readonly {type:string;text?:string}[]})=>JSON.parse(result.content.map(block=>block.type==='text'?block.text:'').join(''))
function draft(id=first):BusinessImportDraft{
 const mapping={delimiter:',' as const,headerRow:1,primaryKey:[{column:0,trim:false}],title:{column:1,trim:false},fields:[{field:'amount',value:{column:2,trim:false},currency:{fixed:'CNY'}}]}
 return {format:'teloa.business-record-import/v1',id,stageRequestId:randomUUID(),ownerId:'self',scope:'sales',type:'orders',sourceIdentity:hash,revision:2,status:'previewed',file:{attachmentId:'saved-file',name:'订单.csv',bytes:100,sha256:hash},mapping,preview:{revision:2,digest:hash,schemaFingerprint:hash,writeSchemaFingerprint:hash,configurationVersion:1,sourceIdentity:hash,sourcePolicyDigest:hash,contentKey:hash,mapping,rows:[{rowNumber:2,primaryKey:[' 001 '],operation:{operation:'create',type:'orders',title:'原始订单',summary:'完整摘要',fields:[{name:'amount',value:'{"currency":"CNY","decimal":"123456789012345678.1234"}'}]}},{rowNumber:3,primaryKey:['002'],operation:{operation:'create',type:'orders',title:'最后一行订单',summary:'含换行\n的原文',fields:[{name:'amount',value:'{"currency":"CNY","decimal":"1"}'}]}}],issues:[],canApply:true},createdAt:stamp,updatedAt:stamp}
}
async function fixture(overrides:Partial<BusinessImportToolsPorts>={},origin?:'subagent'){
 assert.equal(typeof module.registerBusinessImportTools,'function','缺少原生导入工具注册能力')
 const ctx=new Context();await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('imports-'+randomUUID()),...(origin?{meta:{origin,delegationDepth:1}}:{}),agentOptions:{provider:'test',model:'test'}})
 let instruction:{sessionId:string;messageId:string;seq:number}
 const turn=()=>{agent.session.append('turn/start',{turn:0} as never);const message=createUserMessage({source:{kind:'user'},content:[{type:'file',attachment:{id:'never-read'}} as never,{type:'text',text:'确认导入这批订单'}]});const event=agent.session.append('user/message',message,{surfaceOp:'append'});instruction={sessionId:agent.session.id,messageId:message.id,seq:event.seq}}
 turn()
 const drafts=new Map<string,BusinessImportAnyDraft>([[first,draft()],[second,draft(second)]]),saved=new Map<string,{input:BusinessImportApplyInput;result:BusinessImportAnyReceipt}>(),committed:BusinessImportApplyInput[]=[],requests:BusinessImportApplyInput[]=[]
 let failure:WorkError|undefined
 const actor=(value:unknown)=>assert.deepEqual(value,{ownerId:'self',scopeIds:['sales']})
 const ports:BusinessImportToolsPorts={owner:'self',conversation:async sessionId=>({ownerId:'self',sessionId,status:'ready'}),readTaskPolicy:async()=>null,isRoleConversation:async()=>false,isTaskConversation:async()=>false,binding:async()=>undefined,context:async sessionId=>({sessionId,scopeId:'sales',roleId:null,version:1,locked:true}),scopes:async()=>[{scope:'sales',title:'销售业务'}],imports:{get:async(a,raw)=>{actor(a);const input=readBusinessImportGetInput(raw),value=drafts.get(input.draftId);if(!value)throw new WorkError('teloa/not-found','草案不存在');return structuredClone(value)},receipt:async(a,raw)=>{actor(a);const input=readBusinessImportReceiptInput(raw);assert.equal(input.scope,'sales');return structuredClone(saved.get(input.requestId)?.result)},apply:async(a,raw,signal)=>{actor(a);signal?.throwIfAborted();const input=readBusinessImportApplyInput(raw);requests.push(input);const prior=saved.get(input.requestId);if(prior){if(JSON.stringify(prior.input)!==JSON.stringify(input))throw new WorkError('teloa/conflict','同指令的冻结请求不同');return structuredClone(prior.result)}if(failure)throw failure;const value=drafts.get(input.draftId)!;const result=readBusinessImportAnyReceipt({requestId:input.requestId,canonicalRequestId:input.requestId,draftId:input.draftId,scope:value.scope,type:value.type,fileHash:value.file.sha256,previewDigest:input.previewDigest,sourceIdentity:value.sourceIdentity,sourcePolicyDigest:value.preview!.sourcePolicyDigest,contentKey:value.preview!.contentKey,created:value.preview!.rows.length,references:value.preview!.rows.map(()=>({scope:value.scope,type:value.type,id:randomUUID(),version:1,snapshotHash:hash})),appliedAt:stamp,...(value.format==='teloa.business-record-import/v2'?{format:'teloa.business-import-receipt/v2' as const,source:value.source,policy:value.policy,rawCellsDigest:value.preview!.rawCellsDigest!}:{})});committed.push(input);saved.set(input.requestId,{input,result:structuredClone(result)});drafts.set(value.id,readBusinessImportAnyDraft({...value,status:'applied',revision:value.revision+1,receipt:result}));return structuredClone(result)}},...overrides}
 const dispose=module.registerBusinessImportTools(ctx,ports)
 let approve:()=>Promise<string>=async()=> 'allowed-once';const approvals:string[]=[]
 ctx.provide('approval',{request:async(input:{reason:string})=>{approvals.push(input.reason);return approve()}})
 const call=(name:string,args:Record<string,unknown>={},signal:AbortSignal=AbortSignal.timeout(3000),selected=agent)=>ctx.tools.execute({agent:selected,name,arguments:args,callId:ToolCallId(randomUUID()),signal})
 const choose=(id=first)=>({draftId:id,previewRevision:2,previewDigest:hash})
 return {ctx,agent,ports,drafts,saved,committed,requests,approvals,call,turn,choose,dispose,instruction:()=>instruction,approve:(value:typeof approve)=>approve=value,rejectService:(value:WorkError)=>failure=value}
}

test('apply_requires_native_ask_even_when_next_allows：官方allow仍完整确认全部批次',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose());f.ctx.on('tools/pre-execute',async()=>({kind:'allow' as const}))
 const result=await f.call(apply,f.choose());assert.equal(result.isError,false,JSON.stringify(result));assert.equal(f.approvals.length,1);assert.equal(f.committed.length,1)
 const reason=f.approvals[0]!;for(const value of ['销售业务','订单.csv','原始订单','最后一行订单',' 001 ','123456789012345678.1234'])assert.ok(reason.includes(value),value)
 assert.ok(reason.includes('\\n'),'审批保留换行原文');assert.equal(body(result).requestId,f.committed[0]!.requestId);assert.equal(body(result).result.created,2)
})
test('deny_or_cancel_writes_zero：原守卫与本人拒绝保持零写',async t=>{
 for(const kind of ['deny','cancel'] as const){const f=await fixture();t.after(()=>f.ctx.fiber.dispose());let next=0;f.ctx.on('tools/pre-execute',async()=>{next++;return {kind,reason:'原策略'}});const result=await f.call(apply,f.choose());assert.equal(result.isError,true);assert.equal(next,1);assert.equal(f.approvals.length,0);assert.equal(f.requests.length,0)}
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose());f.approve(async()=> 'rejected');assert.equal((await f.call(apply,f.choose())).isError,true);assert.equal(f.requests.length,0)
})
test('request_identity_is_fixed_per_human_instruction：重复toolCall固定请求且新轮改变身份',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose());assert.equal((await f.call(apply,f.choose())).isError,false);assert.equal((await f.call(apply,f.choose())).isError,false);assert.equal(f.committed.length,1)
 const instruction=f.instruction(),digest=createHash('sha256').update(JSON.stringify(['teloa.business-import-apply/v1','self',instruction.sessionId,instruction.messageId,instruction.seq])).digest('hex'),expected=`${digest.slice(0,8)}-${digest.slice(8,12)}-5${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`
 assert.equal(f.committed[0]!.requestId,expected);assert.equal(f.requests[1]!.requestId,expected)
 f.turn();assert.equal((await f.call(apply,f.choose(second))).isError,false);assert.notEqual(f.committed[1]!.requestId,expected);assert.equal(f.approvals.length,3,'每次采用都要求原生ask')
})
test('unknown_identity_and_raw_input_are_rejected：参数不能指定归属、请求、行或附件',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose())
 for(const [key,value] of Object.entries({owner:'foreign',ownerId:'foreign',scope:'other',requestId:randomUUID(),rows:[],rawRows:[],attachmentId:'foreign',preview:{}})){
  assert.equal((await f.call(apply,{...f.choose(),[key]:value})).isError,true,key)
  assert.equal((await f.call(read,{mode:'get',draftId:first,[key]:value})).isError,true,key)
 }
 for(const args of [{mode:'receipt',requestId:randomUUID(),draftId:first},{mode:'get',draftId:first,previewRevision:2},{mode:'receipt',requestId:'bad'},{draftId:first},{mode:'get',draftId:'bad'}])assert.equal((await f.call(read,args)).isError,true)
 assert.equal(f.requests.length,0);assert.equal(f.approvals.length,0)
})
test('session_scope_or_instruction_change_during_approval_denies：批准期间归属与本人轮变化零写',async t=>{
 for(const change of ['turn','replace','owner','session','scope','context-version','binding','access','role','task','policy']){
  const f=await fixture();t.after(()=>f.ctx.fiber.dispose());f.approve(async()=>{
   if(change==='turn')f.turn()
   if(change==='replace')f.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[]}),{surfaceOp:{op:'replace',startSeq:1,endSeq:1},sourceEventSeqs:[1]} as never)
   if(change==='owner')f.ports.conversation=async sessionId=>({ownerId:'foreign',sessionId,status:'ready'})
   if(change==='session')f.ports.conversation=async()=>({ownerId:'self',sessionId:'foreign-session',status:'ready'})
   if(change==='scope')f.ports.context=async sessionId=>({sessionId,scopeId:'other',roleId:null,version:2,locked:true})
   if(change==='context-version')f.ports.context=async sessionId=>({sessionId,scopeId:'sales',roleId:null,version:2,locked:true})
   if(change==='binding')f.ports.binding=async()=>({requestId:randomUUID(),kind:'daily',scope:'sales',title:'pending',createdAt:stamp,updatedAt:stamp})
   if(change==='access')f.ports.scopes=async()=>[]
   if(change==='role')f.ports.isRoleConversation=async()=>true
   if(change==='task')f.ports.isTaskConversation=async()=>true
   if(change==='policy')f.ports.readTaskPolicy=async()=>({allowedTools:[]})
   return 'allowed-once'
  });assert.equal((await f.call(apply,f.choose())).isError,true,change);assert.equal(f.requests.length,0,change)
 }
})
test('preview_or_target_change_during_approval_denies：同digest也核完整固定批次',async t=>{
 for(const change of ['owner','scope','type','revision','digest','row','mapping','schema','file','cancelled']){
  const f=await fixture();t.after(()=>f.ctx.fiber.dispose());f.approve(async()=>{
   const value=f.drafts.get(first)!
   if(change==='owner')value.ownerId='foreign'
   if(change==='scope')value.scope='other'
   if(change==='type'){value.type='other';for(const row of value.preview!.rows)row.operation.type='other'}
   if(change==='revision'){value.revision++;value.preview!.revision++}
   if(change==='digest')value.preview!.digest='2'.repeat(64)
   if(change==='row')value.preview!.rows[1]!.operation.title='替换的末行'
   if(change==='mapping'){value.mapping!.title.trim=true;value.preview!.mapping.title.trim=true}
   if(change==='schema')value.preview!.schemaFingerprint='2'.repeat(64)
   if(change==='file')value.file.sha256='2'.repeat(64)
   if(change==='cancelled')value.status='cancelled'
   return 'allowed-once'
  });assert.equal((await f.call(apply,f.choose())).isError,true,change);assert.equal(f.requests.length,0,change)
 }
})
test('schema_or_relation_archived_after_approval_denies：事务服务最终拒绝不得写成功',async t=>{
 for(const code of ['teloa/version-conflict','teloa/forbidden','teloa/conflict'] as const){
  const f=await fixture();t.after(()=>f.ctx.fiber.dispose());f.approve(async()=>{f.rejectService(new WorkError(code,'定义或关联目标已变化'));return 'allowed-once'})
  const result=await f.call(apply,f.choose());assert.equal(result.isError,true);assert.match(JSON.stringify(result),/定义或关联目标已变化/);assert.equal(f.requests.length,1);assert.equal(f.committed.length,0)
 }
})
test('same_instruction_changed_draft_conflicts：同轮不能通过新草案或digest新增',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose());assert.equal((await f.call(apply,f.choose())).isError,false)
 assert.equal((await f.call(apply,f.choose(second))).isError,true);assert.equal(f.committed.length,1)
 const value=f.drafts.get(first)!;value.preview!.digest='2'.repeat(64);value.receipt!.previewDigest='2'.repeat(64)
 assert.equal((await f.call(apply,{...f.choose(),previewDigest:'2'.repeat(64)})).isError,true);assert.equal(f.committed.length,1)
})
test('unknown_apply_reads_original_receipt_without_new_request：失回包保留身份且新Agent只读原回执',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose());const persist=f.ports.imports.apply
 f.ports.imports.apply=async(...args)=>{await persist(...args);throw new WorkError('teloa/host-unavailable','lost response')}
 const result=await f.call(apply,f.choose());assert.equal(result.isError,true);const original=f.committed[0]!.requestId;assert.ok(JSON.stringify(result).includes(original))
 const {agent:cold}=await f.ctx.agents.create({sessionId:SessionId('cold-'+randomUUID()),agentOptions:{provider:'test',model:'test'}})
 cold.session.append('turn/start',{turn:0} as never);cold.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'核对原批次'}]}),{surfaceOp:'append'})
 const receipt=await f.call(read,{mode:'receipt',requestId:original},AbortSignal.timeout(3000),cold);assert.equal(receipt.isError,false);assert.equal(body(receipt).result.canonicalRequestId,original);assert.equal(f.committed.length,1);assert.equal(f.requests.length,1);assert.equal(f.approvals.length,1)
 const unknown=await f.call(read,{mode:'receipt',requestId:randomUUID()});assert.equal(unknown.isError,false);assert.equal(body(unknown).result,null);assert.match(body(unknown).note,/不能.*未|未.*不能/)
})
test('approval_is_full_and_bounded：末行完整与下游理由超128KiB拒绝而不截断',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose());const row=f.drafts.get(first)!.preview!.rows[0]!
 f.drafts.get(first)!.preview!.rows=Array.from({length:50},(_,index)=>({...structuredClone(row),rowNumber:index+2,primaryKey:[String(index)],operation:{...structuredClone(row.operation),summary:'整'.repeat(1000)}}))
 assert.equal((await f.call(apply,f.choose())).isError,true);assert.equal(f.approvals.length,0);assert.equal(f.requests.length,0)
 const g=await fixture();t.after(()=>g.ctx.fiber.dispose());const off=g.ctx.on('tools/pre-execute',async()=>({kind:'ask' as const,reason:'上游理由'}));assert.equal((await g.call(apply,g.choose())).isError,false);assert.ok(g.approvals[0]!.includes('上游理由'));off()
 g.turn();g.ctx.on('tools/pre-execute',async()=>({kind:'ask' as const,reason:'长'.repeat(44000)}));assert.equal((await g.call(apply,g.choose(second))).isError,true);assert.equal(g.approvals.length,1);assert.equal(g.committed.length,1)
})
test('abort_during_approval_or_final_authorization_writes_zero',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose());const abort=new AbortController();f.approve(async()=>{abort.abort();return 'allowed-once'});assert.equal((await f.call(apply,f.choose(),abort.signal)).isError,true);assert.equal(f.requests.length,0)
 const g=await fixture();t.after(()=>g.ctx.fiber.dispose());const end=new AbortController();let checking=false;g.approve(async()=>{checking=true;return 'allowed-once'});const scopes=g.ports.scopes;g.ports.scopes=async()=>{const result=await scopes();if(checking)end.abort();return result};assert.equal((await g.call(apply,g.choose(),end.signal)).isError,true);assert.equal(g.requests.length,0)
})
test('cold_read_checks_owner_scope_and_receipt_identity：异常归属与回包不能收养',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose());const get=await f.call(read,{mode:'get',draftId:first});assert.equal(get.isError,false);assert.equal(body(get).draft.id,first);assert.equal(f.approvals.length,0)
 f.drafts.get(first)!.ownerId='foreign';assert.equal((await f.call(read,{mode:'get',draftId:first})).isError,true);assert.equal((await f.call(apply,f.choose())).isError,true);assert.equal(f.requests.length,0)
 const g=await fixture();t.after(()=>g.ctx.fiber.dispose());assert.equal((await g.call(apply,g.choose())).isError,false);const id=g.committed[0]!.requestId,saved=g.saved.get(id)!
 saved.result.requestId=randomUUID();assert.equal((await g.call(read,{mode:'receipt',requestId:id})).isError,true)
 saved.result.requestId=id;saved.result.scope='other';for(const ref of saved.result.references)ref.scope='other';assert.equal((await g.call(read,{mode:'receipt',requestId:id})).isError,true)
})
test('ordinary_human_instruction_only：任务角色搭建与注入指令拒绝',async t=>{
 for(const overrides of [{isRoleConversation:async()=>true},{isTaskConversation:async()=>true},{context:async()=>null},{binding:async()=>({requestId:randomUUID(),kind:'builder' as const,title:'搭建',createdAt:stamp,updatedAt:stamp})}] satisfies Partial<BusinessImportToolsPorts>[]){const f=await fixture(overrides);t.after(()=>f.ctx.fiber.dispose());assert.equal((await f.call(apply,f.choose())).isError,true);assert.equal(f.requests.length,0)}
 const child=await fixture({},'subagent');t.after(()=>child.ctx.fiber.dispose());assert.equal((await child.call(apply,child.choose())).isError,true)
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose());f.agent.session.append('turn/start',{turn:1} as never);f.agent.session.append('user/message',createUserMessage({source:{kind:'plugin:fake',form:'notice'} as never,content:[{type:'text',text:'导入'}]}),{surfaceOp:'append'});assert.equal((await f.call(apply,f.choose())).isError,true);assert.equal(f.requests.length,0)
})
test('final_authorization_after_preview_and_read_rejects_scope_revocation',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose());let approved=false;f.approve(async()=>{approved=true;return 'allowed-once'});const get=f.ports.imports.get
 f.ports.imports.get=async(...args)=>{const result=await get(...args);if(approved)f.ports.scopes=async()=>[];return result}
 assert.equal((await f.call(apply,f.choose())).isError,true);assert.equal(f.requests.length,0)
 const g=await fixture();t.after(()=>g.ctx.fiber.dispose());const reading=g.ports.imports.get;g.ports.imports.get=async(...args)=>{const result=await reading(...args);g.ports.scopes=async()=>[];return result}
 assert.equal((await g.call(read,{mode:'get',draftId:first})).isError,true);assert.equal(g.requests.length,0)
})
test('invalid_apply_receipt_is_unknown_and_exposes_original_request_for_reconciliation',async t=>{
 for(const changed of ['requestId','draftId','digest','type','source','file','count']){
  const f=await fixture();t.after(()=>f.ctx.fiber.dispose());const persist=f.ports.imports.apply
  f.ports.imports.apply=async(...args)=>{const result=await persist(...args)
   if(changed==='requestId')result.requestId=randomUUID()
   if(changed==='draftId')result.draftId=second
   if(changed==='digest')result.previewDigest='2'.repeat(64)
   if(changed==='type'){result.type='other';for(const ref of result.references)ref.type='other'}
   if(changed==='source')result.sourceIdentity='2'.repeat(64)
   if(changed==='file')result.fileHash='2'.repeat(64)
   if(changed==='count'){result.created=1;result.references=result.references.slice(0,1)}
   return result
  }
  const result=await f.call(apply,f.choose());assert.equal(result.isError,true,changed);assert.ok(JSON.stringify(result).includes(f.committed[0]!.requestId),changed)
  const found=await f.call(read,{mode:'receipt',requestId:f.committed[0]!.requestId});assert.equal(found.isError,false,changed);assert.equal(body(found).result.created,2);assert.equal(f.committed.length,1)
 }
})

function xlsxDraft(){
 const value=draft(),{delimiter:_,...mapping}=value.mapping!,source={kind:'xlsx' as const,sheet:{sheetId:'2',name:'准确销售表',part:'xl/worksheets/sheet2.xml'}},policy={parserVersion:'xlsx-scalar-v1' as const,scalarPolicy:'closed-scalar-v1' as const,datePolicy:'reject-date-v1' as const,formulaPolicy:'reject-formula-v1' as const}
 return readBusinessImportDraftV2({...value,format:'teloa.business-record-import/v2',source,policy,file:{...value.file,name:'订单.xlsx'},mapping,preview:{...value.preview,format:'teloa.business-import-preview/v2',source,policy,rawCellsDigest:hash,mapping}})
}
test('xlsx_read_and_approval_preserve_exact_sheet_and_all_rows：既有工具沿本人审批采用准确工作表',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose());f.drafts.set(first,xlsxDraft())
 const found=await f.call(read,{mode:'get',draftId:first});assert.equal(found.isError,false,JSON.stringify(found));assert.equal(body(found).draft.source.sheet.sheetId,'2');assert.equal(f.requests.length,0);assert.equal(f.approvals.length,0)
 const result=await f.call(apply,f.choose());assert.equal(result.isError,false,JSON.stringify(result));assert.equal(f.committed.length,1)
 for(const fact of ['订单.xlsx','准确销售表','xl/worksheets/sheet2.xml','最后一行订单','123456789012345678.1234'])assert.ok(f.approvals[0]!.includes(fact),fact)
 assert.equal(body(result).result.format,'teloa.business-import-receipt/v2');assert.equal(body(result).result.source.sheet.sheetId,'2')
})
test('xlsx_sheet_changed_during_approval_writes_zero：完整事实变更不能借相同digest批准',async t=>{
 const f=await fixture();t.after(()=>f.ctx.fiber.dispose());f.drafts.set(first,xlsxDraft());f.approve(async()=>{
  const value=f.drafts.get(first)!;assert.equal(value.format,'teloa.business-record-import/v2');if(value.format==='teloa.business-record-import/v2'){value.source.sheet.name='另一工作表';value.preview!.source.sheet.name='另一工作表'}return 'allowed-once'
 });assert.equal((await f.call(apply,f.choose())).isError,true);assert.equal(f.requests.length,0)
})
test('xlsx_wrong_receipt_version_sheet_or_raw_is_unknown：错sheet成功回包仍核原请求',async t=>{
 for(const changed of ['version','sheet','raw']){
  const f=await fixture();t.after(()=>f.ctx.fiber.dispose());f.drafts.set(first,xlsxDraft());const persist=f.ports.imports.apply
  f.ports.imports.apply=async(...args)=>{const result=await persist(...args);assert.ok('format' in result)
   if(!('format' in result))return result
   if(changed==='version'){const {format:_,source:__,policy:___,rawCellsDigest:____,...v1}=result;return v1}
   if(changed==='sheet')result.source.sheet.sheetId='1'
   if(changed==='raw')result.rawCellsDigest='2'.repeat(64)
   return result
  }
  const value=await f.call(apply,f.choose());assert.equal(value.isError,true,changed);assert.equal(f.committed.length,1);assert.ok(JSON.stringify(value).includes(f.committed[0]!.requestId))
  const recovered=await f.call(read,{mode:'receipt',requestId:f.committed[0]!.requestId});assert.equal(recovered.isError,false);assert.equal(body(recovered).result.source.sheet.sheetId,'2')
 }
})
