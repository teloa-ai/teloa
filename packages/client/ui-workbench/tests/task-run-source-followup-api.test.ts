import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {sourceFollowupNotice,resultFollowupNotice,errorRecoveryNotice,stoppedContinuationNotice,type SourceFollowupKind} from '@teloa/contract'
import {createTaskRunApi} from '../src/client/task-run-api.ts'
const stamp='2026-10-25T10:00:00.000Z'
function fixture(kind:SourceFollowupKind){
 const taskId=randomUUID(),roleId=randomUUID(),id=randomUUID(),native=randomUUID(),sessionId='original-session',disposition={schema:'teloa.task-run-submission-disposition/v1',requestId:randomUUID(),runId:id,sessionId,nativeRequestId:native,inputSha256:'a'.repeat(64),runtimeId:randomUUID(),logCut:-1,logSha256:'b'.repeat(64),acknowledgedUnknown:true,closedAt:stamp},unknown=kind==='unknown-verification'
 const candidate={schema:'teloa.task-run-source-followup-candidate/v1',kind,taskId,expectedTaskVersion:6,runId:id,sessionId,originalNativeRequestId:native,originalInputSha256:'a'.repeat(64),originalEvidenceSha256:unknown?null:'c'.repeat(64),...(unknown?{disposition}:{}),...(kind==='stopped-continuation'?{originalStopRequestedAt:stamp}:{}),sourceUpdateId:randomUUID(),sourceTaskVersion:4,sourceEventId:randomUUID(),reference:{scope:'SOC',type:'alert',id:'alert-a2',version:2,snapshotHash:'d'.repeat(64)}}
 const task={id:taskId,version:4,title:'原告警',goal:'原限制继续有效',scope:'SOC'},role={id:roleId,version:1,name:'调查岗',duty:'调查',dataScope:'固定来源',executionScope:'只读'}
 const original={id,taskId,roleId,taskVersion:4,roleVersion:1,linkVersion:1,sessionId,nativeRequestId:native,state:unknown?'submission_unknown':'ended',evidence:unknown?null:{state:'ended',turn:1,messageSeq:1,endSeq:2,reason:kind==='error-recovery'||kind==='stopped-continuation'?'error':'completed'},stopRequestedAt:unknown||kind==='stopped-continuation'?stamp:null,...(unknown?{submissionDisposition:disposition}:{}),allowedTools:[],memory:[],inputText:JSON.stringify({task,role}),createdAt:stamp}
 const response=(command:Record<string,unknown>)=>{const f={schema:'teloa.task-run-source-followup/v1',kind,taskId,taskVersion:6,sessionId,requestId:command.requestId,originalRunId:id,originalNativeRequestId:native,originalInputSha256:candidate.originalInputSha256,originalEvidenceSha256:candidate.originalEvidenceSha256,...(unknown?{disposition}:{}),...(kind==='stopped-continuation'?{originalStopRequestedAt:stamp}:{}),sourceUpdateId:candidate.sourceUpdateId,sourceTaskVersion:4,sourceEventId:candidate.sourceEventId,reference:candidate.reference,instruction:command.instruction,confirmedAt:stamp,notice:unknown?sourceFollowupNotice:kind==='stopped-continuation'?stoppedContinuationNotice:kind==='error-recovery'?errorRecoveryNotice:resultFollowupNotice};return {...original,id:randomUUID(),taskVersion:6,nativeRequestId:randomUUID(),state:'prepared',evidence:null,stopRequestedAt:null,submissionDisposition:undefined,sourceFollowup:f,inputText:JSON.stringify({task:{...task,version:6},role,sourceFollowup:f})}}
 return {original,candidate,response,taskId,id}
}
for(const kind of ['unknown-verification','result-verification','error-recovery','stopped-continuation'] as const)test('本人已确认后断线只恢复同一request/原Session，草稿隔离且不自动start：'+kind,async()=>{
 const f=fixture(kind),calls:Array<[string,unknown]>=[];let raw:string|null=null,drafts:string|null=null,offline=true
 const journal={read:()=>raw,write:(v:string)=>{raw=v},clear:()=>{raw=null}},draftJournal={read:()=>drafts,write:(v:string)=>{drafts=v},clear:()=>{drafts=null}}
 const call=async(method:string,payload:unknown)=>{calls.push([method,payload]);if(method==='task-runs/list')return [f.original];if(method==='task-runs/source-followup/get')return f.candidate;if(method==='task-runs/source-followup/prepare'){if(offline)throw Error('断线');return f.response(payload as Record<string,unknown>)}throw Error('禁止自动开始')}
 let api=createTaskRunApi(call,undefined,undefined,undefined,journal,draftJournal),run=(await api.list(f.taskId))[0]!,candidate=await api.sourceFollowup.get(run)
 api.sourceFollowup.saveDraft(f.taskId,f.id,'本轮核验正文');api.sourceFollowup.saveDraft(randomUUID(),randomUUID(),'另一告警草稿')
 await assert.rejects(api.sourceFollowup.prepare(candidate,'本轮核验正文'),/断线/);const pending=api.sourceFollowup.pending()!;assert.ok(raw)
 api=createTaskRunApi(call,undefined,undefined,undefined,journal,draftJournal);assert.equal(api.sourceFollowup.draft(f.taskId,f.id),'本轮核验正文');offline=false
 const prepared=await api.sourceFollowup.recover();assert.equal(prepared.sessionId,run.sessionId);assert.notEqual(prepared.nativeRequestId,run.nativeRequestId);assert.equal(prepared.sourceFollowup?.requestId,pending.command.requestId);assert.equal(api.sourceFollowup.pending(),undefined)
 assert.equal(calls.filter(([method])=>method==='task-runs/start').length,0);assert.deepEqual(calls.filter(([method])=>method==='task-runs/source-followup/prepare').map(([,payload])=>payload),[pending.command,pending.command]);assert.equal(raw,null)
})
test('伪造原Session或丢失typed固定输入的回包保持待核对，不自动新建请求',async()=>{
 const f=fixture('result-verification');let raw:string|null=null
 const api=createTaskRunApi(async(method,payload)=>method==='task-runs/list'?[f.original]:{...f.response(payload as Record<string,unknown>),sessionId:'another-session'},undefined,undefined,undefined,{read:()=>raw,write:v=>{raw=v},clear:()=>{raw=null}})
 await assert.rejects(api.sourceFollowup.prepare(f.candidate as never,'核对证据'))
 assert.ok(api.sourceFollowup.pending());assert.ok(raw)
})

test('result回包替换原input/evidence摘要不能移植确认；仍保留原request待核对',async()=>{
 for(const field of ['originalInputSha256','originalEvidenceSha256']){
  const f=fixture('result-verification');let raw:string|null=null
  const api=createTaskRunApi(async(_method,payload)=>{const row=f.response(payload as Record<string,unknown>),sourceFollowup={...row.sourceFollowup,[field]:'e'.repeat(64)},input=JSON.parse(row.inputText);return {...row,sourceFollowup,inputText:JSON.stringify({...input,sourceFollowup})}},undefined,undefined,undefined,{read:()=>raw,write:value=>{raw=value},clear:()=>{raw=null}})
  await assert.rejects(api.sourceFollowup.prepare(f.candidate as never,'按固定来源核验'),/回执与原确认不一致/);assert.ok(raw);assert.ok(api.sourceFollowup.pending())
 }
})

test('unknown处置字段仅JSON键序变化时，候选及成功prepare仍绑定原确认',async()=>{
 const f=fixture('unknown-verification'),calls:string[]=[]
 const candidate={...f.candidate,disposition:Object.fromEntries(Object.entries(f.candidate.disposition!).reverse())}
 const api=createTaskRunApi(async(method,payload)=>{calls.push(method);if(method==='task-runs/list')return [f.original];if(method==='task-runs/source-followup/get')return candidate;return f.response(payload as Record<string,unknown>)})
 const run=(await api.list(f.taskId))[0]!,checked=await api.sourceFollowup.get(run)
 const saved=await api.sourceFollowup.prepare(checked,'仅核对原固定来源')
 assert.equal(saved.sourceFollowup?.originalRunId,f.id);assert.equal(api.sourceFollowup.pending(),undefined)
 assert.deepEqual(calls,['task-runs/list','task-runs/source-followup/get','task-runs/source-followup/prepare'])
})

test('unknown处置日志截点、摘要、runtime或关闭时刻变值仍拒绝且保留原确认',async()=>{
 for(const [field,value] of [['logCut',0],['logSha256','e'.repeat(64)],['runtimeId',randomUUID()],['closedAt','2026-10-25T10:00:01.000Z']] as const){
  const f=fixture('unknown-verification');let raw:string|null=null
  const api=createTaskRunApi(async(_method,payload)=>{
   const run=f.response(payload as Record<string,unknown>),disposition={...run.sourceFollowup.disposition,[field]:value},sourceFollowup={...run.sourceFollowup,disposition},input=JSON.parse(run.inputText)
   return {...run,sourceFollowup,inputText:JSON.stringify({...input,sourceFollowup})}
  },undefined,undefined,undefined,{read:()=>raw,write:value=>{raw=value},clear:()=>{raw=null}})
  await assert.rejects(api.sourceFollowup.prepare(f.candidate as never,'按原处置核验'),/回执与原确认不一致/)
  assert.ok(raw);assert.equal(api.sourceFollowup.pending()?.candidate.runId,f.id)
 }
})

test('同原Session新核验显示本次本人正文与固定限制，显式旧Run仍显示旧目标',async()=>{
 const f=fixture('result-verification'),instruction='只核对本轮固定来源，必要时补齐本地成果，不重做既有外部动作。'
 const preset=(run:ReturnType<typeof f.response>|typeof f.original)=>{const input=JSON.parse(run.inputText);return {...run,agentPresetId:'standard',inputText:JSON.stringify({...input,role:{...input.role,runtimeConfig:{agentPresetId:'standard'}}})}}
 const anchor=preset(f.original),current=preset(f.response({requestId:randomUUID(),instruction})),binding={id:f.id,ownerId:'local:teloa-owner',title:'原告警',scopeIds:['general'],version:1,status:'ready',requestedSessionId:anchor.sessionId,sessionId:anchor.sessionId,createdAt:stamp,requestId:f.id,purpose:'task-run',run:{taskId:f.taskId,taskVersion:4,roleId:anchor.roleId,roleVersion:1,agentPresetId:'standard'}}
 const before=JSON.stringify(binding),api=createTaskRunApi(async(method,payload)=>{if(method==='conversations/read')return binding;if(method==='task-runs/list')return [anchor,current];assert.equal(method,'task-runs/session');return {schema:'teloa.task-run-session/v1',conversation:binding,anchor,currentRunId:current.id,run:(payload as {runId?:string}).runId===anchor.id?anchor:current}})
 const latest=await api.chatPresentation(anchor.sessionId)
 assert.equal(latest?.runId,current.id);assert.equal(latest.goal,[instruction,resultFollowupNotice,'原限制继续有效'].join('\n\n'))
 assert.equal((await api.chatPresentation(anchor.sessionId,anchor.id))?.goal,'原限制继续有效');assert.equal(JSON.stringify(binding),before)
})

test('未发布撤回须有服务端可续办投影；新确认只prepare，不伪error或重发旧request',async()=>{
 const f=fixture('error-recovery'),original={...f.original,state:'withdrawn',evidence:null,stopRequestedAt:stamp,submissionRecovery:'not-published'},calls:string[]=[]
 const api=createTaskRunApi(async(method,payload)=>{calls.push(method);if(method==='task-runs/list')return [original];if(method==='task-runs/source-followup/get')return f.candidate;if(method==='task-runs/source-followup/prepare')return f.response(payload as Record<string,unknown>);throw Error('不得自动start')})
 const row=(await api.list(f.taskId))[0]!,candidate=await api.sourceFollowup.get(row),prepared=await api.sourceFollowup.prepare(candidate,'按原来源继续尚未完成工作，不重放旧请求。')
 assert.equal(row.state,'withdrawn');assert.equal(row.evidence,null);assert.equal(prepared.state,'prepared');assert.equal(prepared.sessionId,row.sessionId);assert.notEqual(prepared.nativeRequestId,row.nativeRequestId);assert.equal(calls.includes('task-runs/start'),false)
 const {submissionRecovery:_projection,...ordinary}=row;await assert.rejects(api.sourceFollowup.get(ordinary),'普通撤回无typed可续办投影不得当error')
})

test('停止后新续办回包篡改停止时间拒绝，保留原确认；不调用start',async()=>{
 const f=fixture('stopped-continuation'),calls:string[]=[]
 const api=createTaskRunApi(async(method,payload)=>{calls.push(method);if(method==='task-runs/list')return [f.original];if(method==='task-runs/source-followup/get')return f.candidate;if(method==='task-runs/source-followup/prepare'){const row=f.response(payload as Record<string,unknown>);row.sourceFollowup.originalStopRequestedAt='2026-11-03T00:00:00.000Z';return row}throw Error('不得自动start')})
 const original=(await api.list(f.taskId))[0]!,candidate=await api.sourceFollowup.get(original)
 await assert.rejects(api.sourceFollowup.prepare(candidate,'本人新续办，不重启旧执行。'),/回执|固定执行/)
 assert.ok(api.sourceFollowup.pending());assert.equal(calls.includes('task-runs/start'),false);assert.equal(original.stopRequestedAt,stamp)
})
