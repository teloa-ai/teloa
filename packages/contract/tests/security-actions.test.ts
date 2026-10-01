import test from 'node:test'
import assert from 'node:assert/strict'
import {
  WorkError,
  readSecurityAction,
  readSecurityActionExecution,
  readSecurityActionPanel,
  readSecurityApproval,
  securityActionProposalInput,
  securityActionStates,
  securityActionTransitions,
  securityApprovalDecisions,
  securityApprovalDecisionInput,
  securityApprovalTtlMinutes,
  securityExecutionTransitions,
  securityFailureAcknowledgementInput,
  securityObservationInput,
  securityActionSubmitInput,
  securityActionWithdrawInput,
  securityExecutionInput,
  securityRiskTiers,
} from '../src/index.ts'

const requestId='11111111-1111-4111-8111-111111111111'
const taskId='22222222-2222-4222-8222-222222222222'
const actionId='33333333-3333-4333-8333-333333333333'
const approvalId='44444444-4444-4444-8444-444444444444'
const operationId='55555555-5555-4555-8555-555555555555'
const at='2026-09-13T08:00:00.000Z'
const hash='a'.repeat(64)
const fingerprint=`sha256:${hash}`

const validProposal={
  requestId,
  taskId,
  expectedTaskVersion:1,
  title:'隔离受影响端点',
  goal:'阻断横向移动。',
  tool:'security.endpoint.isolate',
  targetSet:['prod-03'],
  params:{reason:'检测到横向移动'},
}

test('动作提议不能自报风险、可逆性、剧本、本人或范围',()=>{
  for(const extra of [
    {riskTier:'low'}, {reversible:'reversible'},
    {playbookVersion:'old'}, {ownerId:'other'},
    {proposerId:'agent'}, {scope:'SOC'},
  ])assert.throws(()=>securityActionProposalInput({...validProposal,...extra}),error=>error instanceof WorkError&&error.code==='teloa/invalid-input')
})

test('首片状态机只有已定义边',()=>{
  assert.deepEqual(securityActionTransitions.effect_unknown,['executing','succeeded','failed'])
  assert.deepEqual(securityExecutionTransitions.effect_unknown,['accepted','succeeded','failed'])
  assert.equal(securityActionStates.includes('draft' as never),false)
  assert.equal(securityApprovalDecisions.includes('changes' as never),false)
})

test('写入解析器拒绝未列出的字段并收窄每种命令输入',()=>{
  assert.deepEqual(securityActionProposalInput(validProposal),validProposal)
  assert.throws(()=>securityActionProposalInput({...validProposal,title:'隔离\n端点'}),{code:'teloa/invalid-input'})
  assert.throws(()=>securityActionProposalInput({...validProposal,targetSet:['prod-03','prod-03']}),{code:'teloa/invalid-input'})
  assert.throws(()=>securityActionProposalInput({...validProposal,params:{bad:Infinity}}),{code:'teloa/invalid-input'})
  assert.deepEqual(securityActionSubmitInput({requestId,actionId,expectedActionVersion:1}),{requestId,actionId,expectedActionVersion:1})
  assert.deepEqual(securityApprovalDecisionInput({requestId,actionId,expectedActionVersion:1,decision:'approved',reason:'已核对影响范围。',impactConfirmed:true}),{requestId,actionId,expectedActionVersion:1,decision:'approved',reason:'已核对影响范围。',impactConfirmed:true})
  assert.deepEqual(securityActionWithdrawInput({requestId,actionId,expectedActionVersion:1}),{requestId,actionId,expectedActionVersion:1})
  assert.deepEqual(securityExecutionInput({requestId,actionId,expectedActionVersion:1}),{requestId,actionId,expectedActionVersion:1})
  assert.deepEqual(securityObservationInput({requestId,operationId,expectedRevision:1}),{requestId,operationId,expectedRevision:1})
  assert.deepEqual(securityFailureAcknowledgementInput({requestId,actionId,expectedActionVersion:1}),{requestId,actionId,expectedActionVersion:1})
  assert.throws(()=>securityApprovalDecisionInput({requestId,actionId,expectedActionVersion:1,decision:'approved',reason:'已核对影响范围。',impactConfirmed:true,approverId:'forged'}),{code:'teloa/invalid-input'})
  assert.throws(()=>securityObservationInput({requestId,operationId,expectedRevision:1,actionId}),{code:'teloa/invalid-input'})
})

test('输出解析器只接收完整且关联一致的安全动作面板',()=>{
  const action={
    id:actionId,ownerId:'local:owner',taskId,version:2,state:'succeeded',title:'隔离受影响端点',goal:'阻断横向移动。',
    tool:'security.endpoint.isolate',riskTier:'high',reversible:'reversible',playbookVersion:'security.endpoint.isolate/v1',targetSet:['prod-03'],params:{reason:'检测到横向移动'},supersedesActionId:null,
    frozen:{taskDefinitionDigest:fingerprint,sourceSnapshotDigest:hash,objectSnapshotHash:hash,playbookVersion:'security.endpoint.isolate/v1',paramFingerprint:fingerprint,targetFingerprint:fingerprint},
    proposerId:'local:owner',createdAt:at,updatedAt:at,
  }
  const approval={id:approvalId,ownerId:'local:owner',actionId,actionVersion:2,decision:'approved',approverId:'local:owner',reason:'已核对影响范围。',impactConfirmed:true,frozen:action.frozen,createdAt:at}
  const receipt={status:'succeeded',receiptId:'adapter:1',detail:'端点已经隔离。',observedAt:at,targets:[{target:'prod-03',state:'succeeded'}]}
  const execution={operationId,ownerId:'local:owner',actionId,approvalId,approvalVersion:2,state:'succeeded',revision:3,frozen:action.frozen,dispatch:{operationId,actionId,tool:action.tool,playbookVersion:action.playbookVersion,targets:['prod-03'],params:{reason:'检测到横向移动'}},acceptanceReceipt:{...receipt,status:'accepted',targets:[{target:'prod-03',state:'unknown'}]},effectReceipt:receipt,createdAt:at,updatedAt:at}
  assert.deepEqual(readSecurityAction(action),action)
  assert.throws(()=>readSecurityAction({...action,state:'proposed'}),{code:'teloa/invalid-host-response'})
  assert.throws(()=>readSecurityAction({...action,frozen:null}),{code:'teloa/invalid-host-response'})
  assert.deepEqual(readSecurityApproval(approval),approval)
  assert.deepEqual(readSecurityActionExecution(execution),execution)
  assert.throws(()=>readSecurityActionExecution({...execution,effectReceipt:null}),{code:'teloa/invalid-host-response'})
  assert.throws(()=>readSecurityActionExecution({...execution,acceptanceReceipt:{...execution.acceptanceReceipt!,targets:[{target:'db-01',state:'unknown'}]}}),{code:'teloa/invalid-host-response'})
  const panel={taskId,actions:[action],approvals:[approval],executions:[execution],proposal:{tools:[{tool:'security.endpoint.isolate',allowedTargets:['prod-03']}]}}
  assert.deepEqual(readSecurityActionPanel(panel),panel)
  assert.throws(()=>readSecurityAction({...action,ownerId:''}),{code:'teloa/invalid-host-response'})
  const invalidPanel={...panel,approvals:[{...approval,actionId:taskId}]}
  assert.throws(()=>readSecurityActionPanel(invalidPanel),{code:'teloa/invalid-host-response'})
  assert.throws(()=>readSecurityActionPanel({...panel,approvals:[{...approval,frozen:{...approval.frozen,paramFingerprint:`sha256:${'b'.repeat(64)}`}}]}),{code:'teloa/invalid-host-response'})
  assert.throws(()=>readSecurityActionPanel({...panel,approvals:[{...approval,decision:'rejected',impactConfirmed:false}]}),{code:'teloa/invalid-host-response'})
  assert.throws(()=>readSecurityActionPanel({...panel,executions:[{...execution,approvalId:taskId}]}),{code:'teloa/invalid-host-response'})
  assert.throws(()=>readSecurityActionPanel({...panel,executions:[{...execution,approvalVersion:3}]}),{code:'teloa/invalid-host-response'})
  assert.throws(()=>readSecurityActionPanel({...panel,executions:[{...execution,dispatch:{...execution.dispatch,tool:'security.endpoint.release'}}]}),{code:'teloa/invalid-host-response'})
})

test('审批有效期常量覆盖全部三个风险等级且都是正整数分钟',()=>{
 const tiers=[...securityRiskTiers].sort()
 assert.deepEqual(Object.keys(securityApprovalTtlMinutes).sort(),tiers)
 assert.equal(securityApprovalTtlMinutes.high,15)
 assert.equal(securityApprovalTtlMinutes.med,60)
 assert.equal(securityApprovalTtlMinutes.low,1440)
 for(const value of Object.values(securityApprovalTtlMinutes))assert.ok(Number.isSafeInteger(value)&&value>0)
})

test('安全动作事项原因白名单含审批已过期，且服务端与客户端两份完全一致',async()=>{
 const {securityActionAttentionReasons}=await import('../../backend/src/security/action-attention.ts')
 const {securityAttentionReasons}=await import('../../client/ui-workbench/src/client/security-action-api.ts')
 assert.ok(securityActionAttentionReasons.includes('approval-expired'))
 assert.deepEqual([...securityActionAttentionReasons].sort(),[...securityAttentionReasons].sort())
})
