import test from 'node:test'
import assert from 'node:assert/strict'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {resourceUsagePage} from '../src/resource-usage.ts'
import {isResourceUsagePage} from '@teloa/contract'
const resource={id:'11111111-1111-4111-a111-111111111111',ownerId:'owner',scopeIds:['general'],version:3} as any
const conversation=(id:string,patch={})=>({ownerId:'owner',status:'ready',sessionId:id,title:'会话 '+id,scopeIds:['general'],...patch}) as any
const event=(id=resource.id,version=1)=>({type:'user/message',seq:1,time:1000,data:createUserMessage({source:{kind:'user'},content:[{type:'text',text:`核对此资料 [[teloa-resource:${id}@${version}]]`}]})})

test('反向引用保留旧版本，只查本人可访问会话，不泄露正文或继承消息',async()=>{
 const calls:string[]=[],sessions=[conversation('original'),conversation('fork'),conversation('wrong'),conversation('hidden',{ownerId:'other'}),conversation('private',{scopeIds:['private']})]
 const value=await resourceUsagePage('owner',resource,sessions,async id=>{calls.push(id);if(id==='private')throw Error('访问未获准');return {id,inheritedEventCount:id==='fork'?1:0,snapshotEvents:()=>[event(id==='wrong'?'22222222-2222-4222-a222-222222222222':resource.id)]} as any})
 assert.deepEqual(value.items.map(item=>[item.sessionId,item.version]),[['original',1]])
 assert.deepEqual(calls.sort(),['fork','original','private','wrong']);assert.equal(value.unavailable,1);assert.equal(isResourceUsagePage(value),true)
 assert.equal(JSON.stringify(value).includes('核对此资料'),false)
 await assert.rejects(resourceUsagePage('other',resource,sessions,async()=>{throw Error()}),/不可访问/)
})

test('反向查询每页最多二十个历史，最多四个并行；失败和未读历史明确保留',async()=>{
 let active=0,max=0
 const rows=Array.from({length:23},(_,index)=>conversation('session'+String(index).padStart(2,'0')))
 const read=async(id:string)=>{active++;max=Math.max(max,active);await new Promise(resolve=>setImmediate(resolve));active--;if(id==='session05')throw Error('不可读');return {id,snapshotEvents:()=>[event()]} as any}
 const first=await resourceUsagePage('owner',resource,rows,read)
 assert.equal(first.scanned,20);assert.equal(first.unavailable,1);assert.equal(first.nextCursor,'session19');assert.equal(max,4)
 const rest=await resourceUsagePage('owner',resource,rows,read,first.nextCursor!)
 assert.equal(rest.scanned,3);assert.equal(rest.nextCursor,null);assert.equal(first.items.length+rest.items.length,22)
 assert.ok(rest.items.every(item=>!first.items.some(old=>old.sessionId===item.sessionId)))
})
