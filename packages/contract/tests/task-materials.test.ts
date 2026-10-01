import test from 'node:test'
import assert from 'node:assert/strict'
import {
 isTaskMaterialAddInput,
 isTaskMaterialList,
 isTaskMaterialRef,
 isTaskMaterialResult,
} from '../src/task-materials.ts'

const taskId='bc3e088e-dd97-4f4a-b184-f30d9b6a3e70'
const resourceId='14a3b922-3769-44a1-8e08-3952f34ca340'
const requestId='87579619-56ba-4d19-9592-856c7efb1493'
const createdAt='2026-09-12T08:00:00.000Z'
const material={id:requestId,taskId,taskVersion:2,resourceId,resourceVersion:3,title:'发布检查',sourceId:'knowledge_'+resourceId,sourceVersion:'a'.repeat(64),scopeIds:['general'],available:true,createdAt}
const task={id:taskId,ownerId:'local:owner',title:'发布任务',goal:'核对发布材料',scope:'general',version:2,state:'ready',assigneeRoleId:null,assigneeRoleVersion:null,createdAt,updatedAt:createdAt}

test('任务知识引用只接受完整固定身份与可用性字段',()=>{
 assert.equal(isTaskMaterialRef(material),true)
 assert.equal(isTaskMaterialRef({...material,ownerId:'forged'}),false)
 assert.equal(isTaskMaterialRef({...material,resourceVersion:0}),false)
 assert.equal(isTaskMaterialRef({...material,scopeIds:['general','general']}),false)
 assert.equal(isTaskMaterialRef({...material,available:'yes'}),false)
 assert.equal(isTaskMaterialList([material]),true)
 assert.equal(isTaskMaterialList([{...material,unexpected:true}]),false)
 assert.equal(isTaskMaterialList([material,{...material,id:resourceId,taskVersion:3}]),false)
 assert.equal(isTaskMaterialList([material,{...material,id:resourceId,resourceId:requestId,taskId:requestId,taskVersion:3}]),false)
})

test('添加结果严格固定任务与引用，拒绝未知字段和损坏任务',()=>{
 assert.equal(isTaskMaterialResult({task,material}),true)
 assert.equal(isTaskMaterialResult({task,material,ownerId:'forged'}),false)
 assert.equal(isTaskMaterialResult({task:{...task,version:1},material}),false)
 assert.equal(isTaskMaterialResult({task:{...task,state:'unknown'},material}),false)
})

test('添加命令只接受请求、任务和资源的预期版本',()=>{
 const input={requestId,taskId,expectedTaskVersion:1,resourceId,expectedResourceVersion:3}
 assert.equal(isTaskMaterialAddInput(input),true)
 assert.equal(isTaskMaterialAddInput({...input,ownerId:'forged'}),false)
 assert.equal(isTaskMaterialAddInput({...input,expectedTaskVersion:0}),false)
 assert.equal(isTaskMaterialAddInput({...input,resourceId:'bad'}),false)
})
