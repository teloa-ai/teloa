import test from 'node:test'
import assert from 'node:assert/strict'
import {
 roleDailyLogKinds,roleDailyLogStates,roleDailyLogEvidenceKinds,
 isRoleDailyLog,isRoleDailyLogSummary,
 roleDailyLogListInput,roleDailyLogGetInput,roleDailyLogDiscardInput,
 type RoleDailyLog,
} from '../src/role-daily-log.ts'
import {roleMemorySource,roleMemorySourceKinds} from '../src/role-memory.ts'

const id='16057272-ed9d-44a3-abe4-2ab04e056105'
const roleId='26057272-ed9d-44a3-abe4-2ab04e056105'
const runId='36057272-ed9d-44a3-abe4-2ab04e056105'
const memoryId='46057272-ed9d-44a3-abe4-2ab04e056105'

test('岗位记忆来源种类扩到七项且顺序固定',()=>{
 assert.deepEqual(roleMemorySourceKinds,['task','run','artifact','knowledge','self-feedback','daily-digest','habit-digest'])
})

test('daily-digest 与 habit-digest 来源版本恒为 1',()=>{
 assert.deepEqual(roleMemorySource({kind:'daily-digest',id,version:1}),{kind:'daily-digest',id,version:1})
 assert.throws(()=>roleMemorySource({kind:'daily-digest',id,version:2}),{code:'teloa/invalid-input'})
 assert.deepEqual(roleMemorySource({kind:'habit-digest',id,version:1}),{kind:'habit-digest',id,version:1})
 assert.throws(()=>roleMemorySource({kind:'habit-digest',id,version:2}),{code:'teloa/invalid-input'})
})

test('每日日志种类与状态与证据种类逐字固定',()=>{
 assert.deepEqual(roleDailyLogKinds,['daily-digest','habit-digest'])
 assert.deepEqual(roleDailyLogStates,['kept','discarded'])
 assert.deepEqual(roleDailyLogEvidenceKinds,['run','artifact','approval','revision','group-message'])
})

const baseEvidence=[{kind:'run' as const,id:runId,version:1,title:'当天运行'}]
const baseHint=[{memoryId,memoryStateVersion:1,reason:'已被日结覆盖'}]

function makeLog(overrides:Partial<RoleDailyLog>={}):RoleDailyLog{
 return {
  id,ownerId:'local:owner',roleId,roleVersion:1,kind:'daily-digest',day:'2026-09-20',
  state:'kept',runId,title:'今日小结',markdown:'今天完成了复核。',
  scopeIds:['SOC','general'],evidence:baseEvidence,pruneHints:baseHint,
  createdAt:'2026-09-20T15:30:00.000Z',discardedAt:null,
  ...overrides,
 }
}

test('isRoleDailyLog 对 daily-digest 与 habit-digest 各返回 true',()=>{
 assert.equal(isRoleDailyLog(makeLog()),true)
 assert.equal(isRoleDailyLog(makeLog({kind:'habit-digest',runId:null})),true)
})

test('isRoleDailyLog 对多种异常一律返回 false',()=>{
 const valid=makeLog()
 assert.equal(isRoleDailyLog({...valid,extra:'x'}),false)
 const {discardedAt,...missingKey}=valid
 assert.equal(isRoleDailyLog(missingKey),false)
 assert.equal(isRoleDailyLog({...valid,kind:'habit-digest'}),false)
 assert.equal(isRoleDailyLog({...valid,runId:null}),false)
 assert.equal(isRoleDailyLog({...valid,day:'2026-9-1'}),false)
 assert.equal(isRoleDailyLog({...valid,day:'2026-02-30'}),false)
 assert.equal(isRoleDailyLog({...valid,markdown:'a'.repeat(16001)}),false)
 assert.equal(isRoleDailyLog({...valid,evidence:Array.from({length:61},(_,i)=>({kind:'run' as const,id:String(i),version:1,title:'x'}))}),false)
 assert.equal(isRoleDailyLog({...valid,evidence:[baseEvidence[0],baseEvidence[0]]}),false)
 assert.equal(isRoleDailyLog({...valid,pruneHints:[baseHint[0],{memoryId:'x',memoryStateVersion:1,reason:'r'},{memoryId:'y',memoryStateVersion:1,reason:'r'},{memoryId:'z',memoryStateVersion:1,reason:'r'}]}),false)
 assert.equal(isRoleDailyLog({...valid,pruneHints:[baseHint[0],baseHint[0]]}),false)
 assert.equal(isRoleDailyLog({...valid,scopeIds:Array.from({length:31},(_,i)=>`s${i}`)}),false)
 assert.equal(isRoleDailyLog({...valid,scopeIds:['SOC','SOC']}),false)
 assert.equal(isRoleDailyLog({...valid,scopeIds:['general','SOC']}),false)
 assert.equal(isRoleDailyLog({...valid,state:'discarded',discardedAt:null}),false)
 assert.equal(isRoleDailyLog({...valid,state:'discarded',discardedAt:'2026-09-19T00:00:00.000Z'}),false)
})

test('三个 input 解析器对未知键、非 uuid、expectedState 非法各抛错',()=>{
 assert.deepEqual(roleDailyLogListInput({roleId}),{roleId})
 assert.throws(()=>roleDailyLogListInput({roleId,extra:1}),{code:'teloa/invalid-input'})
 assert.throws(()=>roleDailyLogListInput({roleId:'not-uuid'}),{code:'teloa/invalid-input'})

 assert.deepEqual(roleDailyLogGetInput({roleId,logId:id}),{roleId,logId:id})
 assert.throws(()=>roleDailyLogGetInput({roleId,logId:id,extra:1}),{code:'teloa/invalid-input'})
 assert.throws(()=>roleDailyLogGetInput({roleId,logId:'not-uuid'}),{code:'teloa/invalid-input'})

 assert.deepEqual(roleDailyLogDiscardInput({requestId:id,logId:runId,expectedState:'kept'}),{requestId:id,logId:runId,expectedState:'kept'})
 assert.throws(()=>roleDailyLogDiscardInput({requestId:id,logId:runId,expectedState:'kept',extra:1}),{code:'teloa/invalid-input'})
 assert.throws(()=>roleDailyLogDiscardInput({requestId:'not-uuid',logId:runId,expectedState:'kept'}),{code:'teloa/invalid-input'})
 assert.throws(()=>roleDailyLogDiscardInput({requestId:id,logId:runId,expectedState:'discarded'}),{code:'teloa/invalid-input'})
})

test('isRoleDailyLogSummary 只认六键',()=>{
 const summary={id,kind:'daily-digest' as const,day:'2026-09-20',state:'kept' as const,title:'今日小结',createdAt:'2026-09-20T15:30:00.000Z'}
 assert.equal(isRoleDailyLogSummary(summary),true)
 assert.equal(isRoleDailyLogSummary({...summary,extra:1}),false)
 const {createdAt,...missing}=summary
 assert.equal(isRoleDailyLogSummary(missing),false)
})
