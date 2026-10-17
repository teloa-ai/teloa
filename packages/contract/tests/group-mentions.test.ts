import test from 'node:test'
import assert from 'node:assert/strict'
import {groupRunResultManifest,isGroupMessage} from '../src/index.ts'

const id='11111111-1111-4111-8111-111111111111'
test('结构化本人提及只在员工消息真值出现，不从姓名或本人回复推导',()=>{
 assert.deepEqual(groupRunResultManifest({files:[],noVision:false,mentionSelf:true}),{files:[],noVision:false,mentionSelf:true})
 assert.deepEqual(groupRunResultManifest({files:[],noVision:false}),{files:[],noVision:false})
 assert.throws(()=>groupRunResultManifest({files:[],noVision:false,mentionSelf:'Max'}))
 const base={id,groupId:id,rootId:null,authorId:id,taskId:id,runId:id,text:'@Max 请看',references:[],createdAt:'2026-10-16T00:00:00.000Z'}
 assert.equal(isGroupMessage({...base,mentionSelf:true}),true)
 assert.equal(isGroupMessage({...base,mentionSelf:false}),false)
 const {taskId,runId,...human}=base
 assert.equal(isGroupMessage({...human,authorId:'self',mentions:[],mentionSelf:true}),false)
})
