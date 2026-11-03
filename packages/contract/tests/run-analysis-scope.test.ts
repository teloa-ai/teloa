import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readRunAnalysisScope,runAnalysisNotice} from '../src/run-analysis-scope.ts'
import {readRunTextCapability} from '../src/run-text-capability.ts'

const base=()=>({schema:'teloa.run-analysis-scope/v1',kind:'source-derived',ownerId:'synthetic-owner',taskId:randomUUID(),taskVersion:1,roleId:randomUUID(),roleVersion:1,groupId:randomUUID(),groupVersion:1,sourceMessageId:randomUUID(),sourceDigest:'a'.repeat(64),contextSha256:'b'.repeat(64),lineageSha256:'c'.repeat(64),controls:[{id:randomUUID(),generation:1}],files:[],notice:runAnalysisNotice})
test('来源派生scope不冒称本人批准；形状往返并拒绝审批字段/错误文件/坏控制',()=>{
 const value=base();assert.deepEqual(readRunAnalysisScope(value),value)
 for(const bad of [{...value,approvalId:randomUUID()},{...value,confirmedAt:new Date().toISOString()},{...value,files:[{kind:'work-resource',id:randomUUID(),version:1,bytes:3,sha256:'a'.repeat(64)}]},{...value,controls:[...value.controls,...value.controls]}])assert.throws(()=>readRunAnalysisScope(bad),{code:'teloa/invalid-input'})
})
test('旧本人确认cap不补派生字段、不更改canonical或确认身份',()=>{
 const value={schema:'teloa.run-text-capability/v1',kind:'text',approvalId:randomUUID(),ownerId:'synthetic-owner',taskId:randomUUID(),taskVersion:1,roleId:randomUUID(),roleVersion:1,groupId:randomUUID(),groupVersion:1,sourceMessageId:randomUUID(),sourceDigest:'a'.repeat(64),materials:[],confirmedAt:'2026-10-27T00:00:00.000Z'}
 assert.deepEqual(readRunTextCapability(value),value);assert.equal('analysisScope' in readRunTextCapability(value),false)
})
test('独立任务scope严格区分群来源，不接受伪群、审批、工具或缺失固定资料摘要',()=>{
 const {groupId,groupVersion,sourceMessageId,...common}=base(),value={...common,kind:'owner-task-derived',requestId:randomUUID(),materialsSha256:'d'.repeat(64),knowledgeSha256:'e'.repeat(64)}
 assert.deepEqual(readRunAnalysisScope(value),value)
 for(const bad of [{...value,groupId},{...value,groupVersion},{...value,sourceMessageId},{...value,dispatch:{}},{...value,approvalId:randomUUID()},{...value,allowedTools:['run_code']},{...value,knowledgeSha256:undefined},{...value,controls:[]}])assert.throws(()=>readRunAnalysisScope(bad),{code:'teloa/invalid-input'})
})
