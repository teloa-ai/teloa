import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {registerHooks} from 'node:module'
import {existsSync} from 'node:fs'
registerHooks({resolve(specifier,context,next){
 if(specifier.endsWith('.js')&&specifier.startsWith('.')&&context.parentURL?.includes('/ui-workbench/src/client/')){const source=new URL(specifier.slice(0,-3)+'.ts',context.parentURL);if(existsSync(source))return next(source.href,context)}
 return next(specifier,context)
}})
const {createGroupApi}=await import('../src/client/group-api.ts')

test('来源 API 只调用本人只读口，核原群/回复/Run与正文摘要，不创建请求或恢复 journal',async()=>{
 const groupId=randomUUID(),messageId=randomUUID(),runId=randomUUID(),id=randomUUID(),message={id,groupId,rootId:null,authorId:'self',text:'原始给定20元',references:[],mentions:[],createdAt:'2026-10-20T00:00:00.000Z'},value={schema:'teloa.group-message-sources/v1',groupId,messageId,runId,items:[{message,rootId:null,sha256:createHash('sha256').update(message.text).digest('hex')}],unavailableCount:0},calls:Array<{endpoint:string;input:unknown}>=[]
 let response:unknown=value
 const api=createGroupApi(async(endpoint,input)=>{calls.push({endpoint,input});return response},undefined,()=>{throw Error('读取不创建新 nonce')})
 assert.deepEqual(await api.messageSources(groupId,messageId,runId),value)
 assert.deepEqual(calls,[{endpoint:'groups/messages/sources',input:{groupId,messageId}}])
 for(const bad of [{...value,runId:randomUUID()},{...value,groupId:randomUUID()},{...value,messageId:randomUUID()},{...value,items:[{...value.items[0],sha256:'f'.repeat(64)}]}]){response=bad;await assert.rejects(api.messageSources(groupId,messageId,runId))}
 response={...value,runId:null,items:[],unavailableCount:1};assert.equal((await api.messageSources(groupId,messageId,runId)).runId,null)
 assert.ok(calls.every(call=>call.endpoint==='groups/messages/sources'))
})
