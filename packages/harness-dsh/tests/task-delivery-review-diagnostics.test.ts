import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import type {StreamChunk} from '@deepseek-ai/dsh-llm'
import type {SessionEvent} from '@deepseek-ai/dsh-session'
import {ToolArgsError,type JsonSchemaNode,type ToolDefinition} from '@deepseek-ai/dsh-tools'
import {createReviewSourceCatalog,deliveryReviewToolName,leaseTaskDeliveryReview,type DeliveryReviewTrace,type ReviewMaterial} from '../src/task-delivery-review.ts'
import {readTaskRunGroupResult} from '../src/task-run-group-result.ts'
import {registerTaskToolGuard} from '../src/task-tool-guard.ts'
import {loopWorkFixture} from './fixtures/native-loop-work-admission.ts'

type Reply=readonly StreamChunk[]
const text=(value:string):Reply=>[{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text:value},{type:'block-end',index:0,block:{type:'text',text:value}},{type:'finish',reason:{kind:'stop'}}]
let serial=0
const call=(args:unknown):Reply=>[{type:'block-start',index:0,blockType:'tool-call'},{type:'block-end',index:0,block:{type:'tool-call',id:'diagnostic-call-'+(++serial),name:deliveryReviewToolName,arguments:args}},{type:'finish',reason:{kind:'tool-calls'}}] as unknown as Reply
const goal='只有独立付款凭据可定A级；口述且无凭据应保留为待核。甲店只有口述付款，资料没有独立付款凭据。'
const catalog=createReviewSourceCatalog([{id:'goal',kind:'goal',title:'原目标',text:goal,origin:{field:'inputText',pointer:'/task/goal'}}])
const passage=catalog.passages.find(row=>row.sourceId==='goal');assert.ok(passage)
const material:ReviewMaterial={goal,inputs:{knowledge:0,group:false,context:false},methods:[],catalog}
const oldBlock='第21项：口述付款可定A级。',newBlock='第21项：待核；只有口述付款，没有独立付款凭据。'
const draft=Array.from({length:51},(_,index)=>index===20?oldBlock:`第${index+1}项：保留的合成内容。`).join('\n\n')
const fixed=draft.replace(oldBlock,newBlock)
/** 实测两次失败的结构：只把 affectedScope 改为显式编号，coverage.unknown 仍是非法空串。当前简写按模型可见 schema 显式写 unlisted:"retain"。内容均为合成资料。 */
const revision=(explicit:boolean,unknown:unknown)=>({phase:'revise',issues:[{problem:'分类超出原资料，需保留待核。',basis:[{sourceId:'goal',passageId:passage.id}],...explicit?{affectedBlockIds:[21,11]}:{affectedScope:'coverage'},coverage:{change:[21],retain:[11],unrelated:Array.from({length:51},(_,index)=>index+1).filter(id=>id!==21&&id!==11),unknown,...explicit?{}:{unlisted:'retain'}},edits:[{blockId:21,after:newBlock}]}]})
const acceptance={phase:'verify',verdict:'accept',checks:(['goal',1,2,3,4,5,6,7,8] as const).map(id=>({id,status:'pass'})),changeChecks:[{issueId:'r1:u1:i1',status:'verified',reviewedBlockIds:[11,21]}],findings:[]}
const errors=(events:readonly SessionEvent[])=>events.flatMap(event=>event.type==='tool/result'&&event.data.message.isError?[event.data.message.content.filter(part=>part.type==='text').map(part=>part.text).join('\n')]:[])
const result=(events:readonly SessionEvent[])=>readTaskRunGroupResult(events,'loop-input',undefined,undefined,{requireReview:true,runId:'diagnostics-run'})
async function runtime(t:TestContext,scripts:Reply[]){
 const f=await loopWorkFixture(t,true),traces:DeliveryReviewTrace[]=[]
 f.adapter.scripts.push(...scripts)
 registerTaskToolGuard(f.ctx,async()=>({allowedTools:[],nativeRequestId:'loop-input'}))
 leaseTaskDeliveryReview(f.agent,{runId:'diagnostics-run',requestId:'loop-input',material,trace:entry=>{traces.push(entry)},publish:async message=>{f.agent.inject(message)}})
 const caught:ToolArgsError[]=[];let wrapped:ToolDefinition|undefined
 f.ctx.on('system-prompt/assemble',async(_assembly,_context,next)=>{
  const prompt=await next(),definition=f.ctx.tools.get(deliveryReviewToolName,f.agent)
  if(definition&&definition!==wrapped){
   wrapped=definition;const execute=definition.execute
   definition.execute=async(args,exec)=>{try{return await execute(args,exec)}catch(error){if(error instanceof ToolArgsError)caught.push(error);throw error}}
  }
  return prompt
 })
 return {...f,traces,caught}
}
/** 当前 coverage 简写先按模型可见 schema 校验，直接报具体叶违规；历史显式编号或混用两种字段仍由 SDK oneOf 严格拒绝。 */
const oneOfViolation='"issues[0]" must match exactly one oneOf branch (matched 0)',unknownViolation='"issues[0].coverage.unknown" must be an array'
function originalError(error:ToolArgsError,message:string,violation:string){
 assert.equal(Object.getPrototypeOf(error),ToolArgsError.prototype)
 assert.equal(error.name,'ToolArgsError');assert.equal(error.code,'INVALID_ARGS')
 assert.deepEqual(error.violations,[violation],'原SDK violations不被诊断覆盖')
 assert.equal(message,'Error: '+error.message,'SDK仍渲染实际捕获实例的message，不以新回执替换原失败')
}
function leafDiagnostic(message:string,violation:string){
 assert.match(message,/invalid arguments:/,'保留原生参数错误，不能用普通提示替代失败')
 assert.ok(message.startsWith('Error: invalid arguments: '+violation+'\n'),'原严格错误仍在')
 assert.match(message,/"issues\[0\]\.coverage\.unknown" must be an array/,'具体叶路径与期望类型必须到达原生工具回执')
 assert.ok(!message.includes(newBlock)&&!message.includes(goal),'类型诊断不复制业务正文或依据')
}

test('真实RC2 Loop：oneOf叶错误到达同R1唯一纠参请求，修正unknown为数组后原R2可正式交付',async t=>{
 const first=revision(false,''),corrected=revision(true,[])
 const f=await runtime(t,[text(draft),call(first),call(corrected),call(acceptance)]);await f.send()
 assert.equal(f.adapter.requests.length,4)
 const failed=errors(f.events);assert.equal(failed.length,1);leafDiagnostic(failed[0]!,unknownViolation)
 assert.equal(f.caught.length,1);originalError(f.caught[0]!,failed[0]!,unknownViolation)
 const retry=JSON.stringify(f.adapter.requests[2]!.messages)
 assert.ok(retry.includes('issues[0].coverage.unknown')&&retry.includes('must be an array'),'模型实际收到叶错误，而非只在内部trace保存')
 assert.equal(first.issues[0]!.coverage.unknown,'','宿主没有把原非法参数coerce成数组')
 assert.deepEqual(f.events.flatMap(event=>event.type==='tool/result'?[event.data.message.isError]:[]),[true,false,false])
 assert.deepEqual(f.events.flatMap(event=>event.type==='turn/end'?[event.data.reason.kind]:[]),['completed'])
 assert.equal(result(f.events),fixed)
 assert.equal(result(JSON.parse(JSON.stringify(f.events)) as SessionEvent[]),fixed)
 assert.equal(f.traces.filter(entry=>entry.state==='planned'&&entry.round===1).length,1,'非法尝试不伪造成功R1计划')
 assert.ok(f.adapter.requests.slice(1).every(request=>request.tools?.length===1&&request.tools[0]!.name===deliveryReviewToolName))
 assert.ok(!f.adapter.requests[0]!.tools?.some(tool=>tool.name===deliveryReviewToolName),'普通起草不泄露复核工具')
 for(const request of f.adapter.requests.slice(1,3)){
  const schema=request.tools![0]!.parameters as JsonSchemaNode
  assert.deepEqual(Object.keys(schema.properties??{}),['phase','issues'])
  assert.equal(schema.properties?.issues?.items?.oneOf,undefined,'首次及唯一纠参都仅展示推荐结构')
  assert.equal(schema.properties?.issues?.items?.properties?.coverage?.properties?.unknown?.type,'array')
 }
 assert.deepEqual(Object.keys(f.adapter.requests[3]!.tools![0]!.parameters.properties??{}),['phase','verdict','checks','changeChecks','findings'])
 assert.ok('affectedBlockIds'in corrected.issues[0]!);assert.deepEqual(corrected.issues[0]!.affectedBlockIds,[21,11],'服务端仍接受历史显式编号的合法调用；模型侧投影不修改原参数')
})

test('真实RC2 Loop：实测失败pair仅换编号分支仍严格拒绝，两个原生失败保留且没有第三次纠参或R2',async t=>{
 const first=revision(false,''),second=revision(true,'')
 const f=await runtime(t,[text(draft),call(first),call(second),call(acceptance)]);await f.send()
 assert.equal(f.adapter.requests.length,3,'全lease唯一纠参耗尽，不发第四次provider')
 const failed=errors(f.events),violations=[unknownViolation,oneOfViolation];assert.equal(failed.length,2);failed.forEach((error,index)=>leafDiagnostic(error,violations[index]!))
 assert.equal(f.caught.length,2);f.caught.forEach((error,index)=>originalError(error,failed[index]!,violations[index]!))
 assert.deepEqual(f.events.flatMap(event=>event.type==='tool/result'?[event.data.message.isError]:[]),[true,true])
 assert.deepEqual(f.events.flatMap(event=>event.type==='turn/end'?[event.data.reason.kind]:[]),['error'])
 assert.equal(first.issues[0]!.coverage.unknown,'');assert.equal(second.issues[0]!.coverage.unknown,'')
 assert.ok(!f.traces.some(entry=>entry.state==='planned'||entry.state==='applied'||entry.state==='delivered'))
 assert.equal(result(f.events),undefined)
 assert.equal(result(JSON.parse(JSON.stringify(f.events)) as SessionEvent[]),undefined)
})

test('真实RC2 Loop：两个互斥编号字段同时给出时列出所有分支错误，不猜选或放行，唯一纠参仍可恢复',async t=>{
 const both=revision(false,[]);Reflect.set(both.issues[0]!,'affectedBlockIds',[21,11])
 const f=await runtime(t,[text(draft),call(both),call(revision(true,[])),call(acceptance)]);await f.send()
 assert.equal(f.adapter.requests.length,4)
 const failed=errors(f.events);assert.equal(failed.length,1);assert.equal(f.caught.length,1);originalError(f.caught[0]!,failed[0]!,oneOfViolation)
 assert.match(failed[0]!,/issues\[0\] 分支1：.*affectedBlockIds/)
 assert.match(failed[0]!,/issues\[0\] 分支2：.*affectedScope/)
 assert.ok(!failed[0]!.includes('coverage.unknown'),'合法数组不被误诊为类型错误')
 assert.deepEqual(f.events.flatMap(event=>event.type==='tool/result'?[event.data.message.isError]:[]),[true,false,false])
 assert.equal(Reflect.get(both.issues[0]!,'affectedScope'),'coverage');assert.deepEqual(Reflect.get(both.issues[0]!,'affectedBlockIds'),[21,11])
 assert.equal(result(f.events),fixed);assert.equal(result(JSON.parse(JSON.stringify(f.events)) as SessionEvent[]),fixed)
})
