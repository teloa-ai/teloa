import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createProjectContextHandler} from '../src/project-context.ts'
test('项目上下文只接本人 RPC，拒绝未知接口及伪造本人，转交取消信号',async()=>{
 const calls:unknown[][]=[],result={projectId:randomUUID(),version:0,brief:'',entries:[],shares:[]}
 const handler=createProjectContextHandler('owner',async()=>({get:async(...args)=>{calls.push(args);return result},mutate:async(...args)=>{calls.push(args);return {projectId:result.projectId,requestId:randomUUID(),version:1}}}))
 assert.deepEqual(await handler('project-context/get',{projectId:result.projectId}),result)
 assert.equal(calls[0]![0],'owner')
 await assert.rejects(handler('project-context/get',{projectId:result.projectId,owner:'other'}))
 await assert.rejects(handler('project-context/save',{}),{code:'teloa/not-found'})
 const signal=new AbortController().signal,input={projectId:result.projectId,requestId:randomUUID(),expectedVersion:0,change:{kind:'save-brief',brief:'介绍'}}
 await handler('project-context/mutate',input,signal);assert.equal(calls[1]![2],signal)
 const cancel=new AbortController();cancel.abort();await assert.rejects(handler('project-context/get',{projectId:result.projectId},cancel.signal),{name:'AbortError'});assert.equal(calls.length,2)
})
