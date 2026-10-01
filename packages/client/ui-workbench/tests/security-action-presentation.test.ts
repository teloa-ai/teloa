import test from 'node:test'
import assert from 'node:assert/strict'
import {securityExecutionPresentation,securityActionControls,securitySupersedableStates} from '../src/client/security-action-presentation.ts'
import {action,panel,execution,taskId,actionId} from './security-action-fixtures.ts'
test('受理与未知只可核对，效果已确认不可重复执行',()=>{for(const state of ['accepted','effect_unknown','succeeded'] as const){const result=securityExecutionPresentation({...execution,state});assert.equal(result.status,'security.execution.'+state);assert.equal(result.canExecute,false);assert.equal(result.canObserve,state!=='succeeded')}})
test('执行入口要求 approved、无执行、精确且已知的 execution-required 交集',()=>{
 const rows=[{taskId,actionId,kind:'security-action' as const,reason:'execution-required' as const}]
 assert.equal(securityActionControls(action,panel,rows,true).execute,true)
 for(const [p,r,known] of [[panel,rows,false],[panel,[{...rows[0]!,actionId:taskId}],true],[panel,[{...rows[0]!,reason:'adapter-unavailable' as const}],true],[{...panel,executions:[execution]},rows,true]] as const)assert.equal(securityActionControls(action,{...p,executions:[...p.executions]},r,known).execute,false)
 assert.equal(securityActionControls({...action,state:'failed'},panel,[],true).acknowledge,true)
})
test('可接续状态集合与服务端一致：已拒绝、已撤回、已失败',()=>{
 assert.deepEqual([...securitySupersedableStates].sort(),['failed','rejected','withdrawn'])
 for(const state of securitySupersedableStates){
  const supersedable={...action,state} as typeof action
  assert.equal(securityActionControls(supersedable,{...panel,actions:[supersedable]},[],true).repropose,true)
 }
})
