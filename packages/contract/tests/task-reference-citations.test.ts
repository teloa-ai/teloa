import test from 'node:test'
import assert from 'node:assert/strict'
import {taskReferenceCitationPath,readTaskReferenceCitationPath,readTaskReferenceCitation} from '../src/local-retrieval.ts'
const taskId='11111111-1111-4111-8111-111111111111',resourceId='22222222-2222-4222-8222-222222222222',sourceVersion='a'.repeat(64)
const identity={taskId,resourceId,resourceVersion:2,sourceVersion}
test('任务引用是固定资料身份，可往返且拒绝非规范路径',()=>{
 const path=taskReferenceCitationPath(identity)
 assert.deepEqual(readTaskReferenceCitationPath(path),identity)
 for(const v of [path+'/extra',path.replace('/2/','/02/'),path.replace(taskId,'..'),path.replace(sourceVersion,'A'.repeat(64)),path+'?owner=other'])assert.equal(readTaskReferenceCitationPath(v),undefined)
})
test('来源回执核对会话与全部固定身份，额外授权字段不被接受',()=>{
 const value={...identity,sessionId:'task-run-original',sourceId:'local_material_test',title:'固定资料',text:'正文',citationPath:taskReferenceCitationPath(identity)}
 assert.deepEqual(readTaskReferenceCitation(value),value)
 for(const patch of [{resourceVersion:3},{taskId:resourceId},{owner:'forged'},{citationPath:value.citationPath+'/extra'}])assert.throws(()=>readTaskReferenceCitation({...value,...patch}))
})
