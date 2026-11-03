import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createGroupHandler,groupEndpoints} from '../src/groups.ts'
import {groupMessageSourcesEndpoint} from '@teloa/contract'

test('来源入口 writing=false；只读分发固定本人身份，非法载荷先拒绝且不进入创建/发消息/模型准入',async()=>{
 const calls:Array<{owner:string;input:unknown}>=[],never=async()=>{throw Error('来源读取不得写或调用其他服务')},input={groupId:randomUUID(),messageId:randomUUID()},handler=createGroupHandler('current-owner',async()=>({list:never,get:never,create:never,change:never,messages:never,messageBody:never,send:never,resources:never,resource:never,saveResource:never,withdrawResource:never,reactions:never,toggleReaction:never,routing:never,routingStatus:never,retryRouting:never,messageSources:async(owner,input)=>{calls.push({owner,input});return 'read-only'}}),()=>{throw Error('不经过模型或新消息准入')})
 assert.equal(groupMessageSourcesEndpoint.writing,false);assert.ok(groupEndpoints.includes(groupMessageSourcesEndpoint.name))
 assert.equal(await handler(groupMessageSourcesEndpoint.name,input),'read-only');assert.deepEqual(calls,[{owner:'current-owner',input}])
 await assert.rejects(handler(groupMessageSourcesEndpoint.name,{...input,requestId:randomUUID()}),{code:'teloa/invalid-input'});assert.equal(calls.length,1)
})
