import test from 'node:test'
import assert from 'node:assert/strict'
import {projectRuntimeSettingsInput,projectMembershipInput,readProjectRuntimeSettings,readProjectMembership} from '../src/project-runtime.ts'
const id='11111111-1111-4111-8111-111111111111',requestId='22222222-2222-4222-8222-222222222222'
test('运行设置和项目归属严格校验，不接受模型伪造本人或未知策略',()=>{
 const input={projectId:id,requestId,expectedVersion:0,automatic:'decisions',readPersonal:false,resources:[]}
 assert.deepEqual(projectRuntimeSettingsInput(input),input)
 assert.throws(()=>projectRuntimeSettingsInput({...input,owner:'other'}))
 assert.throws(()=>projectRuntimeSettingsInput({...input,automatic:'everything'}))
 const binding={requestId,sessionId:'session-one',projectId:id,expectedVersion:0,memoryMode:'off'}
 assert.deepEqual(projectMembershipInput(binding),binding)
 assert.throws(()=>projectMembershipInput({...binding,memoryMode:'unknown'}))
 assert.throws(()=>projectMembershipInput({...binding,sessionId:'../private'}))
 assert.deepEqual(readProjectRuntimeSettings({projectId:id,version:0,automatic:'decisions',readPersonal:false,resources:[]}),{projectId:id,version:0,automatic:'decisions',readPersonal:false,resources:[]})
 assert.equal(readProjectMembership({sessionId:'session-one',projectId:id,version:1,memoryMode:'off',generation:1,title:'项目会话'}).memoryMode,'off')
})
