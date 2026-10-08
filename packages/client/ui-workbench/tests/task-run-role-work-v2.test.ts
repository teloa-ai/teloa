import test from 'node:test'
import assert from 'node:assert/strict'
import {createTaskRunApi} from '../src/client/task-run-api.ts'
const id='11111111-1111-4111-8111-111111111111',taskId='22222222-2222-4222-8222-222222222222',roleId='33333333-3333-4333-8333-333333333333',consentId='44444444-4444-4444-8444-444444444444'
const task={id:taskId,version:1,title:'资料核验',goal:'核对原件',scope:'general'}
const legacyRole={id:roleId,version:2,name:'我的分身',duty:'核验资料',dataScope:'明确原件',executionScope:'只读'}
const roleSnapshot={...legacyRole,schema:'teloa.run-role/v2',kind:'twin',scopes:['general'],skills:[],knowledge:[],responsibility:{triggers:['收到任务'],autonomousActions:['读取获准原件'],confirmationPoints:['外发'],escalationRules:['材料缺失'],deliveryChecks:['保留版本']},authorization:{kind:'task',taskId,taskContentVersion:1},twinConsent:{id:consentId,version:1}}
const lineage={schema:'teloa.work-lineage/v1',ownerId:'owner',rootTaskId:taskId,definition:null,parentRunId:null,definitionControlId:null,roundControlId:id,controlGeneration:1,budgetAccountId:consentId}
const base={id,taskId,roleId,taskVersion:1,roleVersion:2,linkVersion:1,sessionId:'session',nativeRequestId:id,state:'prepared',evidence:null,allowedTools:[],memory:[],createdAt:'2026-10-09T10:00:00.000Z'}
const input={schema:'teloa.task-run-input/v2',task,role:roleSnapshot,lineage}
const row={...base,roleSnapshot,lineage,inputText:JSON.stringify(input)}
const read=(value:unknown)=>createTaskRunApi(async()=>[value]).list(taskId)

test('公共v2读取器固定分身身份与谱系；目录不把本人确认解释为self',async()=>{
 const saved=(await read(row))[0]!
 assert.equal(saved.roleName,'我的分身');assert.deepEqual(saved.roleSnapshot,roleSnapshot);assert.deepEqual(saved.lineage,lineage)
 for(const value of [{...row,inputText:JSON.stringify({...input,schema:'unknown'})},{...row,roleSnapshot:{...roleSnapshot,name:'冒充本人'}},{...row,lineage:{...lineage,controlGeneration:2}},{...row,inputText:JSON.stringify({...input,role:{...roleSnapshot,responsibility:undefined}})},{...row,inputText:JSON.stringify({...input,lineage:{...lineage,extra:true}})}])await assert.rejects(read(value))
})

test('private记忆只允许v2 Twin，并逐字核对固定内容；正文与标题不投影到RunView',async()=>{
 const memory=[{id:consentId,version:1,title:'本人私有偏好',contentHash:'a'.repeat(64),markdown:'仅当前分身可见的私有正文',source:{kind:'self-feedback',id,version:1},visibility:{kind:'private',scopeIds:[]}}]
 const fixed={notice:'以下岗位记忆已生效，仅作为工作经验；不授予权限，引用须保留来源和固定版本。',contents:memory},withMemory={...row,memory,inputText:JSON.stringify({...input,memory:fixed})}
 const saved=(await read(withMemory))[0]!
 assert.equal(Object.hasOwn(saved,'memory'),false);assert.ok(!JSON.stringify(saved).includes(memory[0]!.markdown));assert.ok(!JSON.stringify(saved).includes(memory[0]!.title))
 const employee={...roleSnapshot,kind:'employee',twinConsent:null}
 for(const value of [{...withMemory,roleSnapshot:employee,inputText:JSON.stringify({...input,role:employee,memory:fixed})},{...base,memory,inputText:JSON.stringify({task,role:legacyRole,memory:fixed})},{...withMemory,memory:[]},{...withMemory,inputText:JSON.stringify({...input,memory:{...fixed,contents:[{...memory[0],markdown:'正文漂移'}]}})}])await assert.rejects(read(value))
})

test('状态恢复不能替换v2本人许可、职责或谱系；历史输入继续沿旧形状读取',async()=>{
 const saved=(await read(row))[0]!,changedRole={...roleSnapshot,twinConsent:{id:consentId,version:2}}
 for(const value of [{...row,roleSnapshot:changedRole,inputText:JSON.stringify({...input,role:changedRole})},{...row,lineage:{...lineage,controlGeneration:2},inputText:JSON.stringify({...input,lineage:{...lineage,controlGeneration:2}})}])await assert.rejects(createTaskRunApi(async()=>value).reconcile(saved))
 const inputText=JSON.stringify({task,role:legacyRole}),legacy={...base,inputText}
 assert.equal((await read(legacy))[0]!.roleName,legacyRole.name);assert.equal(legacy.inputText,inputText)
 await assert.rejects(read({...legacy,roleSnapshot}));await assert.rejects(read({...legacy,lineage}))
})

test('未知v2准备保留原requestId恢复，不自动增加本人确认或授权字段',async()=>{
 let stored:string|null=null,first:unknown,attempts=0
 const journal={read:()=>stored,write:(value:string)=>{stored=value},clear:()=>{stored=null}}
 const call=async(method:string,payload:unknown)=>{assert.equal(method,'task-runs/prepare');attempts++;if(attempts===1){first=payload;throw Error('回执未知')}assert.deepEqual(payload,first);return {...row,sessionId:'task-run-'+(payload as {requestId:string}).requestId}}
 await assert.rejects(createTaskRunApi(call,journal).prepare(taskId,1),/回执未知/)
 const restored=createTaskRunApi(call,journal),prepared=await restored.recoverPrepare()
 assert.equal(prepared.roleSnapshot?.kind,'twin');assert.deepEqual(Object.keys(first as object).sort(),['expectedTaskVersion','requestId','taskId']);assert.equal(stored,null)
})
