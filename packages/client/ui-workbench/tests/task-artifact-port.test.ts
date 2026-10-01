import test from 'node:test'
import assert from 'node:assert/strict'
import {BindingClient,type WorkPort} from '../src/client/binding-client.ts'
import {taskArtifactPort} from '../src/client/task-artifact-port.ts'
import type {Conversation} from '@teloa/contract'

test('任务成果可打开未出现在普通目录的受管执行会话，保留任务输入边界',async()=>{
 const id='task-run-test',blocks=new Map<string,string|undefined>()
 let opened:string|undefined
 const conversation={id:'work-test',sessionId:id,requestedSessionId:id,ownerId:'owner',title:'Lumen brief',scopeIds:['general'],version:1,status:'ready',purpose:'task-run',createdAt:'2026-09-24T00:00:00Z'} as Conversation
 const port={list:async()=>[],read:async()=>conversation,ensure:async()=>{throw Error('受管会话不得走普通绑定')},adopt:async(id:string)=>id,open:(id:string)=>{opened=id},current:()=>opened,block:(id:string,reason:string|undefined)=>blocks.set(id,reason),isNativeChild:()=>false} as unknown as WorkPort
 const work=new BindingClient(port),artifacts=taskArtifactPort(work,async()=>[id])
 assert.equal((await artifacts.list('task'))[0]?.id,id)
 assert.deepEqual(work.getDirectorySnapshot().rows,[])
 await artifacts.open(id)
 assert.equal(opened,id)
 assert.equal(work.getSnapshot().conversation?.purpose,'task-run')
 assert.match(blocks.get(id)??'',/任务/)
})
