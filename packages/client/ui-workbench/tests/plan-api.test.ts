import test from 'node:test'
import assert from 'node:assert/strict'
import {createPlanApi,projectSavedPlan,type PlanCreateFields,type PlanSource} from '../src/client/plan-api.ts'

const planId='11111111-1111-4111-8111-111111111111',roleId='22222222-2222-4222-8222-222222222222',requestId='33333333-3333-4333-8333-333333333333'
const at='2026-09-11T00:00:00.000Z',later='2026-09-11T01:00:00.000Z'
const trigger={kind:'schedule' as const,cadence:'daily' as const,weekday:1,time:'09:00',timezone:'Asia/Singapore' as const}
const fields:PlanCreateFields={title:'每日核对',goal:'核对新增资料。',scope:'general',dataScope:'本人已授权资料。',delivery:'变化与待核对项。',roleId,expectedRoleVersion:3,trigger,notificationPolicy:'attention'}
const source:PlanSource={kind:'market-content',contentId:'44444444-4444-4444-8444-444444444444',contentHash:'a'.repeat(64),resourceId:'daily-review',resourceVersion:'1.0.0'}
const row={id:planId,ownerId:'local:owner',title:fields.title,goal:fields.goal,scope:fields.scope,dataScope:fields.dataScope,delivery:fields.delivery,roleId,roleVersion:3,trigger,notificationPolicy:fields.notificationPolicy,source,version:1,configVersion:1,state:'paused' as const,archivedReason:null,archivedAt:null,createdAt:at,updatedAt:at}

test('目录与详情严格校验身份、本人间接范围、重复项和固定字段',async()=>{
 const calls:unknown[][]=[],api=createPlanApi(async(endpoint,payload)=>{calls.push([endpoint,payload]);return endpoint==='plans/list'?[row]:row})
 assert.deepEqual(await api.list(),[row]);assert.deepEqual(await api.get(planId),row)
 assert.deepEqual(calls,[['plans/list',{}],['plans/get',{planId}]])
 await assert.rejects(createPlanApi(async()=>[row,row]).list(),/重复/)
 await assert.rejects(createPlanApi(async()=>[row,{...row,id:'55555555-5555-4555-8555-555555555555',ownerId:'other'}]).list(),/本人|范围/)
 await assert.rejects(createPlanApi(async()=>({...row,unexpected:true})).get(planId),/格式/)
 await assert.rejects(createPlanApi(async()=>({...row,version:0})).get(planId),/格式/)
 await assert.rejects(createPlanApi(async()=>({...row,title:' '+row.title})).get(planId),/格式/)
 await assert.rejects(createPlanApi(async()=>({...row,notificationPolicy:'unknown'})).get(planId),/格式/)
 const legacy={...row} as Record<string,unknown>;delete legacy.notificationPolicy
 assert.deepEqual(await createPlanApi(async()=>legacy).get(planId),legacy)
})

test('完成策略来自真实计划回包，旧值缺省不新增字段，未知验证器拒绝',async()=>{
 const completionPolicy={kind:'verified' as const,verifier:'system-digest' as const,verifierVersion:1,authorizationVersion:1}
 const saved=await createPlanApi(async()=>({...row,completionPolicy})).get(planId)
 assert.deepEqual(saved.completionPolicy,completionPolicy)
 assert.deepEqual(await createPlanApi(async()=>row).get(planId),row)
 assert.equal(Object.hasOwn(await createPlanApi(async()=>row).get(planId),'completionPolicy'),false)
 await assert.rejects(createPlanApi(async()=>({...row,completionPolicy:{...completionPolicy,verifier:'model-says-done'}})).get(planId),/格式/)
 await assert.rejects(createPlanApi(async()=>({...row,completionPolicy:{...completionPolicy,authorizationVersion:0}})).get(planId),/格式/)
})

test('本人确认自动结项创建的未知请求恢复固定确认端点，不降级普通调用',async()=>{
 const completionPolicy={kind:'verified' as const,verifier:'material-version-summary' as const,verifierVersion:1,authorizationVersion:1},manual={kind:'manual' as const}
 let raw:string|null=null,lost=true;const calls:unknown[][]=[],journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
 const call=async(endpoint:string,payload:unknown)=>{calls.push([endpoint,payload]);if(lost){lost=false;throw Error('确认回包未知')}return {...row,source:manual,completionPolicy}}
 await assert.rejects(createPlanApi(call,journal,()=>requestId).createConfirmed({...fields,completionPolicy},manual),/未知/)
 assert.ok(raw);assert.equal(JSON.parse(raw!).schema,'teloa.plan-command/v2')
 assert.deepEqual((await createPlanApi(call,journal).recover()).completionPolicy,completionPolicy)
 assert.equal(raw,null);assert.deepEqual(calls[0],calls[1]);assert.equal(calls[0]?.[0],'plans/create-confirmed')
 const forged=JSON.stringify({schema:'teloa.plan-command/v1',request:{kind:'create',requestId,fields:{...fields,completionPolicy},source:manual,confirmed:true}})
 const api=createPlanApi(call,{read:()=>forged,write(){},clear(){}});assert.ok(api.recoveryMessage());await assert.rejects(api.recover(),/Recovery journal/)
})

test('长期定义本人确认的未知回包恢复原请求，并刷新当前持久状态',async()=>{
 const configuration={completion:{kind:'manual' as const},triggers:[{kind:'local-event' as const,eventKind:'material-version' as const,sourceId:roleId,coalesce:'latest' as const}],budget:{maxGoalRounds:32,maxTokens:2000000,maxElapsedMs:21600000,maxConcurrent:1,maxRetries:3,stagnationRounds:3,money:null},overlap:'forbid' as const,missed:'coalesce' as const,safeRecovery:false}
 const workDefinition={schema:'teloa.plan-work/v2' as const,definitionVersion:2,definitionControlId:planId,budgetAccountId:roleId,authorization:{kind:'delegation' as const,delegationId:requestId,delegationVersion:1},...configuration},receipt={...row,version:2,configVersion:2,completionPolicy:configuration.completion,workDefinition},current={...receipt,state:'active' as const,version:3}
 let raw:string|null=null,lost=true;const calls:unknown[][]=[],journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}},call=async(endpoint:string,payload:unknown)=>{calls.push([endpoint,payload]);if(lost){lost=false;throw Error('定义回包未知')}return endpoint==='plans/get'?current:receipt}
 await assert.rejects(createPlanApi(call,journal,()=>requestId).configureWorkConfirmed(row,configuration),/未知/)
 assert.equal(JSON.parse(raw!).schema,'teloa.plan-command/v2')
 assert.deepEqual(await createPlanApi(call,journal).recover(),current);assert.equal(raw,null)
 assert.deepEqual(calls[0],calls[1]);assert.equal(calls[0]?.[0],'plans/configure-work-confirmed');assert.deepEqual(calls[2],['plans/get',{planId}])
})

test('调度摘要只读取指定计划的服务端事实且严格校验回包',async()=>{
 const calls:unknown[][]=[],api=createPlanApi(async(endpoint,payload)=>{calls.push([endpoint,payload]);return {available:false,overview:null,health:null}})
 assert.deepEqual(await api.schedule(planId),{available:false,overview:null,health:null})
 assert.deepEqual(calls,[['plans/schedule',{planId}]])
 await assert.rejects(api.schedule('bad-id'),/身份/)
 await assert.rejects(createPlanApi(async()=>({available:true,overview:{planId:'55555555-5555-4555-8555-555555555555',planVersion:1,state:'active',nextAt:null,latest:null,latestSkip:null},health:null})).schedule(planId),/调度摘要/)
})
test('长期计划目标编辑未知恢复保留原四字段及本人配置端点',async()=>{
 const configuration={completion:{kind:'manual' as const},triggers:[{kind:'schedule' as const,schedule:trigger}],budget:{maxGoalRounds:32,maxTokens:2000000,maxElapsedMs:21600000,maxConcurrent:1,maxRetries:3,stagnationRounds:3,money:null},overlap:'forbid' as const,missed:'coalesce' as const,safeRecovery:false},fields={title:'新目标',goal:'核对新来源',dataScope:'当前委托原件',delivery:'本轮交付'},workDefinition={schema:'teloa.plan-work/v2' as const,definitionVersion:2,definitionControlId:planId,budgetAccountId:roleId,authorization:{kind:'delegation' as const,delegationId:requestId,delegationVersion:1},...configuration},result={...row,...fields,version:2,configVersion:2,completionPolicy:configuration.completion,workDefinition}
 let raw:string|null=null,lost=true;const calls:unknown[][]=[],journal={read:()=>raw,write:(v:string)=>{raw=v},clear:()=>{raw=null}},call=async(endpoint:string,payload:unknown)=>{calls.push([endpoint,payload]);if(lost){lost=false;throw Error('未知')}return result}
 await assert.rejects(createPlanApi(call,journal,()=>requestId).configureWorkConfirmed(row,configuration,fields),/未知/);assert.deepEqual(await createPlanApi(call,journal).recover(),result);assert.deepEqual(calls[0],calls[1]);assert.deepEqual((calls[0]![1] as {fields:unknown}).fields,fields);assert.equal(raw,null)
})

test('执行历史使用默认和显式分页参数并严格解析回包',async()=>{
 const claimId='55555555-5555-4555-8555-555555555555',calls:unknown[][]=[]
 const page={items:[],errors:[{claimId,code:'teloa/storage-corrupt' as const}],cursor:{claimedAt:later,claimId}}
 const api=createPlanApi(async(endpoint,payload)=>{calls.push([endpoint,payload]);return calls.length===1?page:{items:[]}})
 assert.deepEqual(await api.executions(planId),page)
 assert.deepEqual(await api.executions(planId,50,page.cursor),{items:[]})
 assert.deepEqual(calls,[['plans/executions',{planId,limit:20}],['plans/executions',{planId,limit:50,cursor:page.cursor}]])
 await assert.rejects(api.executions(planId,0),/分页/)
 await assert.rejects(api.executions(planId,51),/分页/)
 await assert.rejects(api.executions(planId,1,{claimedAt:'bad',claimId}),/分页/)
 await assert.rejects(createPlanApi(async()=>({items:[{claimId,planId:'66666666-6666-4666-8666-666666666666'}]})).executions(planId),/执行历史/)
 await assert.rejects(createPlanApi(async()=>({items:[{claimId:'55555555-5555-4555-8555-555555555555',planId,occurrenceId:'tick',planVersion:1,configVersion:1,scheduledAt:at,claimedAt:later,task:null,run:null},{claimId:'66666666-6666-4666-8666-666666666666',planId,occurrenceId:'tick-2',planVersion:1,configVersion:1,scheduledAt:at,claimedAt:at,task:null,run:null}]})).executions(planId,1),/执行历史/)
})

test('跨计划执行目录规范化筛选且不发送计划身份或空查询',async()=>{
 const calls:unknown[][]=[],otherPlanId='66666666-6666-4666-8666-666666666666'
 const page={items:[{claimId:'55555555-5555-4555-8555-555555555555',planId:otherPlanId,occurrenceId:'daily:1',planVersion:1,configVersion:1,scheduledAt:at,claimedAt:later,task:null,run:null}]}
 const api=createPlanApi(async(endpoint,payload)=>{calls.push([endpoint,payload]);return page})
 assert.deepEqual(await api.directory({limit:20,scope:'space_ops',roleId,query:'  每日核对  ',runState:'not-started'}),page)
 assert.deepEqual(calls,[['plans/executions',{limit:20,scope:'space_ops',roleId,query:'每日核对',runState:'not-started'}]])
 calls.length=0
 await api.directory({limit:1,query:'   '})
 assert.deepEqual(calls,[['plans/executions',{limit:1}]])
 await createPlanApi(async(_endpoint,payload)=>({items:[{claimId:'55555555-5555-4555-8555-555555555555',planId,occurrenceId:'daily:failed',planVersion:1,configVersion:1,scheduledAt:at,claimedAt:later,task:{id:roleId,state:'ready'},run:{id:'66666666-6666-4666-8666-666666666666',state:'configuration_failed',sessionId:'plan-failed',createdAt:later}}]})).directory({limit:1,runState:'configuration_failed'})
})

test('跨计划执行目录拒绝越界筛选和非法原生状态',async()=>{
 const api=createPlanApi(async()=>({items:[]}))
 await assert.rejects(api.directory({limit:0}),/分页/)
 await assert.rejects(api.directory({limit:1,scope:'bad scope'}),/筛选/)
 await assert.rejects(api.directory({limit:1,roleId:'bad'}),/筛选/)
 await assert.rejects(api.directory({limit:1,query:'x'.repeat(241)}),/筛选/)
 await assert.rejects(api.directory({limit:1,runState:'completed' as 'ended'}),/筛选/)
 await assert.rejects(createPlanApi(async()=>({items:[{claimId:'55555555-5555-4555-8555-555555555555',planId,occurrenceId:'daily:1',planVersion:1,configVersion:1,scheduledAt:at,claimedAt:later,task:null,run:null}]})).directory({limit:1,runState:'active'}),/执行历史/)
})

test('跳过历史使用复合游标并严格限制计划和分页参数',async()=>{
 const cursor={skippedAt:later,configVersion:2,occurrenceId:'2026-09-11T09:00[Asia/Singapore]'},calls:unknown[][]=[]
 const api=createPlanApi(async(endpoint,payload)=>{calls.push([endpoint,payload]);return calls.length===1?{items:[],errors:[{...cursor,code:'teloa/storage-corrupt'}],cursor}:{items:[]}})
 assert.deepEqual(await api.skips(planId,1),{items:[],errors:[{...cursor,code:'teloa/storage-corrupt'}],cursor})
 assert.deepEqual(await api.skips(planId,20,cursor),{items:[]})
 assert.deepEqual(calls,[['plans/skips',{planId,limit:1}],['plans/skips',{planId,limit:20,cursor}]])
 await assert.rejects(api.skips('bad'),/身份/)
 await assert.rejects(api.skips(planId,51),/分页/)
 await assert.rejects(api.skips(planId,20,{...cursor,configVersion:0}),/分页/)
})

test('创建回包丢失后只保存必要命令，原请求重试可接受已变化的当前状态',async()=>{
 let raw:string|null=null,first=true;const calls:unknown[][]=[],journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
 const call=async(endpoint:string,payload:unknown)=>{calls.push([endpoint,payload]);if(first){first=false;throw Error('回包丢失')}return {...row,version:2,state:'active',updatedAt:later}}
 await assert.rejects(createPlanApi(call,journal,()=>requestId).create(fields,source),/回包丢失/)
 assert.ok(raw);assert.match(raw!,/"kind":"create"/);assert.doesNotMatch(raw!,/token|secret|password|apiKey/i)
 const api=createPlanApi(call,journal,()=>crypto.randomUUID())
 await assert.rejects(api.create({...fields,title:'另一计划'},source),/原请求/)
 const current=await api.recover()
 assert.equal(current.state,'active');assert.equal(current.version,2)
 assert.deepEqual(calls[0],calls[1]);assert.equal(raw,null)
})

test('状态请求恢复先读取固定回执再刷新详情，不让旧回执覆盖新状态',async()=>{
 let raw:string|null=null,phase='lost';const calls:unknown[][]=[],journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
 const receipt={...row,version:2,state:'active' as const,updatedAt:later}
 const current={...row,version:3,state:'paused' as const,updatedAt:'2026-09-11T02:00:00.000Z'}
 const call=async(endpoint:string,payload:unknown)=>{calls.push([endpoint,payload]);if(phase==='lost'){phase='ready';throw Error('回包丢失')}return endpoint==='plans/change'?receipt:current}
 await assert.rejects(createPlanApi(call,journal,()=>requestId).change(planId,1,'enable'),/回包丢失/)
 const api=createPlanApi(call,journal)
 assert.equal(api.pending()?.kind,'change')
 const refreshed=await api.recover()
 assert.equal(refreshed.state,'paused');assert.equal(refreshed.version,3)
 assert.deepEqual(calls,[['plans/change',{planId,requestId,expectedVersion:1,action:'enable'}],['plans/change',{planId,requestId,expectedVersion:1,action:'enable'}],['plans/get',{planId}]])
 assert.equal(raw,null)
})

test('状态已生效但刷新失败时保留命令，恢复会重放同一请求后再刷新',async()=>{
 let raw:string|null=null,gets=0;const calls:unknown[][]=[],journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}},receipt={...row,version:2,state:'archived' as const,archivedReason:'工作结束',archivedAt:later,updatedAt:later}
 const call=async(endpoint:string,payload:unknown)=>{calls.push([endpoint,payload]);if(endpoint==='plans/change')return receipt;if(++gets===1)throw Error('详情刷新断线');return receipt}
 const first=createPlanApi(call,journal,()=>requestId)
 await assert.rejects(first.change(planId,1,'archive','工作结束'),/详情刷新断线/);assert.ok(first.pending());assert.ok(raw)
 const recovered=await createPlanApi(call,journal).recover();assert.equal(recovered.state,'archived');assert.equal(raw,null)
 assert.deepEqual(calls.filter(([endpoint])=>endpoint==='plans/change').map(([,payload])=>payload),Array(2).fill({planId,requestId,expectedVersion:1,action:'archive',note:'工作结束'}))
})

test('立即运行固定计划双版本与请求身份，回包丢失后只找回原任务',async()=>{
 let raw:string|null=null,first=true;const calls:unknown[][]=[],journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
 const receipt={planId,claimId:'55555555-5555-4555-8555-555555555555',taskId:'66666666-6666-4666-8666-666666666666',runId:'77777777-7777-4777-8777-777777777777'}
 const call=async(endpoint:string,payload:unknown)=>{calls.push([endpoint,payload]);if(first){first=false;throw Error('立即运行回包丢失')}return receipt}
 await assert.rejects(createPlanApi(call,journal,()=>requestId).trigger(row,at),/回包丢失/)
 assert.ok(raw);assert.match(raw!,/'kind':'trigger'|"kind":"trigger"/);assert.doesNotMatch(raw!,/token|secret|password|apiKey/i)
 const api=createPlanApi(call,journal)
 assert.equal(api.pending()?.kind,'trigger')
 await assert.rejects(async()=>api.recover(),/当前计划/)
 assert.deepEqual(await api.recoverTrigger(),receipt);assert.equal(raw,null)
 assert.deepEqual(calls,[['plans/trigger',{planId,requestId,expectedVersion:1,expectedConfigVersion:1,now:at}],['plans/trigger',{planId,requestId,expectedVersion:1,expectedConfigVersion:1,now:at}]])
 await assert.rejects(createPlanApi(async()=>({...receipt,planId:'88888888-8888-4888-8888-888888888888'}),undefined,()=>requestId).trigger(row,at),/回执/)
})

test('明确无副作用拒绝释放命令，未知失败和无效响应继续保留恢复',async()=>{
 let raw:string|null=null,calls=0;const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
 const denied=createPlanApi(async()=>{throw Object.assign(Error('版本变化'),{rejected:true,code:'teloa/version-conflict'})},journal,()=>requestId)
 await assert.rejects(denied.change(planId,1,'enable'),/版本变化/);assert.equal(denied.pending(),undefined);assert.equal(raw,null)
 const unknown=createPlanApi(async()=>{throw Error('连接中断')},journal,()=>requestId)
 await assert.rejects(unknown.create(fields,source),/连接中断/);assert.ok(unknown.pending());assert.ok(raw)
 raw=null
 const mismatched=createPlanApi(async()=>({...row,title:'伪造计划'}),journal,()=>requestId)
 await assert.rejects(mismatched.create(fields,source),/原请求|不一致/);assert.ok(mismatched.pending());assert.ok(raw)
 const broken=createPlanApi(async()=>{calls++;return row},{read:()=>'{',write:()=>{},clear:()=>{}})
 await assert.rejects(broken.create(fields,source),(error:unknown)=>(error as {code?:unknown})?.code==='teloa/storage-corrupt');assert.equal(calls,0)
})

test('无效响应不能污染客户端观察到的本人范围，修正响应后仍可恢复',async()=>{
 let bad=true
 const api=createPlanApi(async()=>bad?{...row,ownerId:'poisoned-owner',title:'伪造计划'}:row,undefined,()=>requestId)
 await assert.rejects(api.create(fields,source),/不一致/)
 bad=false
 assert.deepEqual(await api.recover(),row)
})

test('持久计划投影使用配置版本和状态修订，不伪造调度历史',()=>{
 assert.deepEqual(projectSavedPlan({...row,version:4,configVersion:1,state:'archived',archivedReason:'工作结束',archivedAt:later,updatedAt:later}),{
 id:planId,version:1,revision:4,fields:{title:fields.title,goal:fields.goal,scope:'general',dataScope:fields.dataScope,delivery:fields.delivery,roleId,trigger,notificationPolicy:'attention'},enabled:false,archived:true,history:[],
 })
 assert.throws(()=>projectSavedPlan({...row,scope:'x'.repeat(81)}),/业务身份/);assert.throws(()=>projectSavedPlan({...row,scope:'  '}),/业务身份/)
})

test('更新使用双版本和固定请求恢复，只接受同状态的定义回执',async()=>{
 const updated={...row,title:'每周核对',goal:'核对本周新增资料。',dataScope:'本周获准资料。',delivery:'本周变化。',trigger:{kind:'schedule' as const,cadence:'weekly' as const,weekday:5,time:'10:30',timezone:'Asia/Singapore' as const},notificationPolicy:'failure' as const,version:2,configVersion:2,updatedAt:later}
 const fields={title:updated.title,goal:updated.goal,dataScope:updated.dataScope,delivery:updated.delivery,trigger:updated.trigger,notificationPolicy:updated.notificationPolicy}
 let raw:string|null=null,first=true;const calls:unknown[][]=[],journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
 const call=async(endpoint:string,payload:unknown)=>{calls.push([endpoint,payload]);if(first){first=false;throw Error('更新回包中断')}return endpoint==='plans/change'?updated:updated}
 await assert.rejects(createPlanApi(call,journal,()=>requestId).update(row,fields),/中断/)
 assert.ok(raw);assert.match(raw!,/"kind":"update"/);assert.doesNotMatch(raw!,/token|secret|password|apiKey/i)
 const recovered=await createPlanApi(call,journal).recover();assert.deepEqual(recovered,updated);assert.equal(raw,null)
 assert.deepEqual(calls[1],['plans/change',{planId,requestId,expectedVersion:1,expectedConfigVersion:1,action:'update',fields}])
 await assert.rejects(createPlanApi(async()=>({...updated,state:'active'})).update(row,fields),/更新回执/)
})

test('系统计划来源能进目录且原样读回，不因未知来源整目录报错',async()=>{
 const systemRoleId='66666666-6666-4666-8666-666666666666'
 const systemRow={...row,id:'77777777-7777-4777-8777-777777777777',source:{kind:'system-digest' as const,roleId:systemRoleId}}
 const api=createPlanApi(async(endpoint,payload)=>{void payload;return endpoint==='plans/list'?[row,systemRow]:systemRow})
 assert.deepEqual(await api.list(),[row,systemRow])
 assert.deepEqual(await api.get(systemRow.id),systemRow)
})

test('系统计划来源缺字段或多余键一律拒绝，不静默放行',async()=>{
 await assert.rejects(createPlanApi(async()=>({...row,source:{kind:'system-digest'}})).get(planId),/格式/)
 await assert.rejects(createPlanApi(async()=>({...row,source:{kind:'system-digest',roleId:'not-a-uuid'}})).get(planId),/格式/)
 await assert.rejects(createPlanApi(async()=>({...row,source:{kind:'system-digest',roleId,extra:1}})).get(planId),/格式/)
})
