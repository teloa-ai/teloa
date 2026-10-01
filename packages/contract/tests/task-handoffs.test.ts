import assert from 'node:assert/strict'
import test from 'node:test'
import {isTaskHandoffChange,isTaskHandoffChangeResult,readTaskHandoffChangeInput} from '../src/task-handoffs.ts'

const requestId='12345678-1234-4234-8234-123456789012',taskId='22345678-1234-4234-8234-123456789012',roleId='32345678-1234-4234-8234-123456789012'

test('主动改派请求精确约束字段、规范化说明并区分本人和岗位目标',()=>{
 assert.deepEqual(readTaskHandoffChangeInput({requestId,taskId,expectedTaskVersion:2,target:{kind:'self'},note:'  本人接续  '}),{requestId,taskId,expectedTaskVersion:2,target:{kind:'self'},note:'本人接续'})
 assert.deepEqual(readTaskHandoffChangeInput({requestId,taskId,expectedTaskVersion:2,target:{kind:'role',roleId,expectedRoleVersion:3},note:'岗位接续'}),{requestId,taskId,expectedTaskVersion:2,target:{kind:'role',roleId,expectedRoleVersion:3},note:'岗位接续'})
 for(const input of [
  {requestId,taskId,expectedTaskVersion:2,target:{kind:'self',roleId},note:'说明'},
  {requestId,taskId,expectedTaskVersion:2,target:{kind:'role',roleId},note:'说明'},
  {requestId,taskId,expectedTaskVersion:2,target:{kind:'role',roleId,expectedRoleVersion:3,extra:true},note:'说明'},
  {requestId,taskId,expectedTaskVersion:0,target:{kind:'self'},note:'说明'},
  {requestId,taskId,expectedTaskVersion:2,target:{kind:'self'},note:' '},
  {requestId,taskId,expectedTaskVersion:2,target:{kind:'self'},note:'x'.repeat(4001)},
  {requestId,taskId,expectedTaskVersion:2,target:{kind:'self'},note:'说明',ownerId:'other'},
 ])assert.throws(()=>readTaskHandoffChangeInput(input),{code:'teloa/invalid-input'})
})

test('主动改派回执精确约束双方、正整数版本及任务结构',()=>{
 const createdAt='2026-09-13T00:00:00.000Z',task={id:taskId,ownerId:'owner',title:'调查',goal:'核对',scope:'SOC',version:3,state:'ready' as const,assigneeRoleId:roleId,assigneeRoleVersion:3,createdAt,updatedAt:createdAt}
 const change={requestId,taskId,baseVersion:2,appliedVersion:3,from:{kind:'self' as const},to:{kind:'role' as const,roleId,roleVersion:3},note:'岗位接续',createdAt}
 assert.equal(isTaskHandoffChange(change),true)
 assert.equal(isTaskHandoffChangeResult({task,change}),true)
 for(const value of [
  {...change,from:{kind:'self',roleId}},
  {...change,to:{kind:'role',roleId}},
  {...change,baseVersion:0},
  {...change,extra:true},
 ])assert.equal(isTaskHandoffChange(value),false)
 assert.equal(isTaskHandoffChangeResult({task,change:{...change,taskId:requestId}}),false)
 assert.equal(isTaskHandoffChangeResult({task,change,extra:true}),false)
})

test('主动改派回执拒绝同一责任方、空白主体和不完整时间',()=>{
 const createdAt='2026-09-13T00:00:00.000Z',task={id:taskId,ownerId:'owner',title:'调查',goal:'核对',scope:'SOC',version:3,state:'ready' as const,assigneeRoleId:roleId,assigneeRoleVersion:3,createdAt,updatedAt:createdAt}
 const change={requestId,taskId,baseVersion:2,appliedVersion:3,from:{kind:'self' as const},to:{kind:'role' as const,roleId,roleVersion:3},note:'岗位接续',createdAt}
 assert.equal(isTaskHandoffChange({...change,from:{kind:'self'},to:{kind:'self'}}),false)
 assert.equal(isTaskHandoffChange({...change,from:{kind:'role',roleId,roleVersion:2},to:{kind:'role',roleId,roleVersion:3}}),false)
 assert.equal(isTaskHandoffChange({...change,createdAt:'2026-09-13'}),false)
 assert.equal(isTaskHandoffChangeResult({task:{...task,ownerId:'   '},change}),false)
 assert.equal(isTaskHandoffChangeResult({task:{...task,createdAt:'2026-09-13'},change}),false)
})
