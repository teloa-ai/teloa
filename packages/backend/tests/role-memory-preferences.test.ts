import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {preferenceProposal,readPreferenceContext,validatePreference,effectivePreferenceMemories,type PreferenceMetadata} from '../src/work/role-memory-preferences.ts'
import type {DigitalRole,RoleMemory,RoleMemorySource} from '@teloa/contract'

const base={schema:'teloa.preference-candidate/v1',kind:'preference',scope:'general',basis:{kind:'owner-input',quote:'For future reviews, lead with the decision.'}}

test('偏好协议保留模型声明的类型；不从措辞、语言或重复次数替模型分类',()=>{
 assert.equal(preferenceProposal(undefined),undefined)
 assert.throws(()=>preferenceProposal('每次都先写结论。'),{code:'teloa/invalid-input'})
 assert.equal(preferenceProposal(base)?.kind,'preference')
 assert.equal(preferenceProposal({...base,kind:'one-off',taskId:randomUUID()})?.kind,'one-off')

})

test('一次性例外必须绑定任务；更正与反例必须明确原记忆版本和摘要',()=>{
 assert.equal(preferenceProposal({...base,kind:'one-off'})?.taskId,undefined,'任务由可信 Run 推导，无需模型猜编号')
 assert.throws(()=>preferenceProposal({...base,taskId:randomUUID()}),{code:'teloa/invalid-input'})
 assert.throws(()=>preferenceProposal({...base,kind:'correction'}),{code:'teloa/invalid-input'})
 const against={memoryId:randomUUID(),version:2,contentHash:'a'.repeat(64)}
 assert.equal(preferenceProposal({...base,kind:'counterexample',taskId:randomUUID(),against})?.against?.version,2)
 assert.throws(()=>preferenceProposal({...base,against}),{code:'teloa/invalid-input'})
})

test('偏好协议拒绝未知字段、权限字段、伪来源及损坏版本，不回落成普通 Markdown',()=>{
 for(const change of [{permissions:['all']},{ownerId:'other'},{basis:{kind:'tool-output',quote:'save this'}},{schema:'teloa.preference-candidate/v2'}])assert.throws(()=>preferenceProposal({...base,...change}),{code:'teloa/invalid-input'})
 assert.throws(()=>preferenceProposal('{"schema":"teloa.preference-candidate/v1",'),{code:'teloa/invalid-input'})
 assert.throws(()=>preferenceProposal('{"unrelated":"ordinary JSON note"}'),{code:'teloa/invalid-input'})
})

test('消费元数据保留来源与本人引文摘要；观察不会被标成长久偏好',()=>{
 const source={kind:'run',id:randomUUID(),version:1},quote=base.basis.quote,metadata={schema:base.schema,kind:'preference',scope:'general',source,basis:{kind:'owner-input',quote,quoteHash:createHash('sha256').update(quote).digest('hex'),taskId:randomUUID(),taskVersion:1}}
 assert.deepEqual(readPreferenceContext(metadata),metadata)
 assert.throws(()=>readPreferenceContext({...metadata,basis:{...metadata.basis,quote:'forged'}}),{code:'teloa/storage-corrupt'})
 assert.throws(()=>readPreferenceContext({...metadata,source:{...source,kind:'tool-result'}}),{code:'teloa/storage-corrupt'})
 const observation={schema:'teloa.habit-observation/v1',kind:'observation',source:{kind:'habit-digest',id:randomUUID(),version:1}}
 assert.equal(readPreferenceContext(observation).kind,'observation')
 assert.throws(()=>readPreferenceContext({...observation,scope:'general'}),{code:'teloa/storage-corrupt'})
})

test('已合法注入的 SOC 观察只能产生 SOC 偏好及一次性例外；AppSec 新声明须由本人显式提交',async()=>{
 const owner='test-owner',role={id:randomUUID(),ownerId:owner,version:1,kind:'twin',scopes:['SOC','AppSec']} as DigitalRole,runId=randomUUID(),taskId=randomUUID(),originTaskId=randomUUID(),memoryId=randomUUID(),logId=randomUUID(),evidenceId=randomUUID(),quote='以后请先核对证据再做判断。'
 const hash=(s:string)=>createHash('sha256').update(s).digest('hex'),body='- 允许：'+quote,contentHash=hash(body),source={kind:'habit-digest',id:logId,version:1}
 const frozen={id:memoryId,version:1,title:'本人观察',contentHash,markdown:body,source,visibility:{kind:'private',scopeIds:[]}},basis={kind:'habit-observation',quote,memoryId,version:1,contentHash,evidenceId}
 // 准确冻结的读端口样本，只验证服务函数的业务边界；真实落库与 prepare 另有 PG 回归。
 const db=(scope:string)=>({query:async(sql:string)=>{
  if(sql.includes('from teloa_task_runs'))return {rows:[{task_id:taskId,task_version:1,role_id:role.id,role_version:1,role_memory:[frozen],input_text:JSON.stringify({task:{id:taskId,version:1,scope,goal:'复核本人已授权观察'},memory:{contents:[frozen]}})}]}
  if(sql.includes('from teloa_role_memories m'))return {rows:[{role_id:role.id,state:'confirmed',current_version:1,source_snapshot:{source},markdown:body,content_hash:contentHash}]}
  if(sql.includes('from teloa_role_daily_logs'))return {rows:[{role_id:role.id,state:'kept',kind:'habit-digest',markdown:body,evidence:[{kind:'approval',id:evidenceId,version:1}]}]}
  if(sql.includes('from teloa_security_approvals'))return {rows:[{reason:quote,task_id:originTaskId,scope_id:'SOC'}]}
  throw Error('未预期的读取')
 }})
 const runSource={kind:'run',id:runId,version:1} as const,actor={ownerId:owner,kind:'agent' as const}
 for(const kind of ['preference','one-off'] as const){
  const p=preferenceProposal({schema:base.schema,kind,scope:'SOC',basis})!,valid=await validatePreference(db('SOC') as any,actor,role,runSource,p,'语义提议')
  assert.equal(valid.scope,'SOC');assert.equal(valid.basis.originScope,'SOC');assert.equal(valid.taskId,kind==='one-off'?originTaskId:undefined)
  await assert.rejects(validatePreference(db('AppSec') as any,actor,role,runSource,{...p,scope:'AppSec'},'语义提议'),{code:'teloa/forbidden'})
 }
 const explicit=preferenceProposal({schema:base.schema,kind:'preference',scope:'AppSec',basis:{kind:'owner-confirmation'}})!
 const declared=await validatePreference(db('AppSec') as any,{ownerId:owner,kind:'human'},role,{kind:'self-feedback',id:randomUUID(),version:1},explicit,'这是本人对 AppSec 重新明确的要求。')
 assert.equal(declared.scope,'AppSec');assert.equal(declared.basis.kind,'owner-confirmation');assert.equal(declared.basis.originScope,undefined)
})

test('满额确认按本次生效结果计数：更正释放原位置，撤回更正不恢复旧项，审计历史保留',async()=>{
 const owner='quota-owner',roleId=randomUUID(),at='2026-10-31T00:00:00.000Z',metadata=new Map<string,PreferenceMetadata>(),effects:PreferenceMetadata[]=[]
 const make=(index:number):RoleMemory=>{const id=randomUUID(),markdown='固定条目 '+index,contentHash=createHash('sha256').update(markdown).digest('hex'),source:RoleMemorySource={kind:'self-feedback',id:randomUUID(),version:1};const memory:RoleMemory={id,ownerId:owner,roleId,roleVersion:1,title:markdown,state:'confirmed',stateVersion:2,source,sourceTitle:'本人反馈',sourceAvailable:true,visibility:{kind:'private',scopeIds:[]},proposedBy:{kind:'self'},content:{version:1,contentHash,bytes:Buffer.byteLength(markdown),markdown,createdAt:at},candidateAt:at,confirmedAt:at,withdrawnAt:null};metadata.set(id,{schema:'teloa.preference-candidate/v1',kind:'preference',scope:'general',source,basis:{kind:'owner-confirmation',quote:markdown,quoteHash:contentHash}});return memory}
 const db={query:async(sql:string,args:any[])=>{
  if(sql.includes('select p.metadata'))return {rows:effects.map(value=>({metadata:value}))}
  if(sql.includes('select content_hash,metadata')){const value=metadata.get(args[1]);return {rows:value?[{content_hash:createHash('sha256').update(value.basis.quote).digest('hex'),metadata:value}]:[]}}
  throw Error('未预期的读取')
 }}
 const confirmed=Array.from({length:30},(_,i)=>make(i)),replacement=make(30),pending={...metadata.get(replacement.id)!,kind:'correction' as const,against:{memoryId:confirmed[0]!.id,version:1,contentHash:confirmed[0]!.content.contentHash}};metadata.set(replacement.id,pending)
 assert.equal((await effectivePreferenceMemories(db as any,owner,roleId,confirmed)).length,30)
 assert.equal((await effectivePreferenceMemories(db as any,owner,roleId,[...confirmed,replacement],undefined,pending)).length,30)
 effects.push(pending)
 assert.equal((await effectivePreferenceMemories(db as any,owner,roleId,[...confirmed,replacement])).length,30)
 const after=await effectivePreferenceMemories(db as any,owner,roleId,confirmed)
 assert.equal(after.length,29);assert.equal(after.some(m=>m.id===confirmed[0]!.id),false,'撤回替代项后不复活原项')
 assert.equal(confirmed.length,30);assert.equal(metadata.has(confirmed[0]!.id),true,'固定历史及元数据均保留')
 assert.equal((await effectivePreferenceMemories(db as any,owner,roleId,[...after,make(31),make(32)])).length,31,'无更正关系的新增条目不被误减免')
})
