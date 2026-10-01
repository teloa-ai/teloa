import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
import {createGroupApi} from '../src/client/group-api.ts'
import {readRecoveryGroupDirectory} from '../src/client/attention-recovery-group-directory.ts'

const groupId='11111111-1111-4111-8111-111111111111'
const requestId='22222222-2222-4222-8222-222222222222'
const at='2026-09-12T00:00:00.000Z'
const command={kind:'change' as const,request:{requestId,groupId,expectedVersion:1,fields:{name:'值守群',announcement:'更新',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},memberRoleIds:[],pinned:false,archived:false}}}
const group={id:groupId,ownerId:'self',version:2,name:'值守群',scope:'SOC',announcement:'更新',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},pinned:false,archived:false,createdAt:at,updatedAt:at}

test('刷新后直接进入需要你会读取群目录，只为可访问目标返回恢复目录',async()=>{
 let raw:string|null=JSON.stringify({schema:'teloa.groups/v1',command}),calls=0
 const api=createGroupApi(async endpoint=>{assert.equal(endpoint,'groups/list');calls++;return [group]},{read:()=>raw,write:value=>{raw=value},clear:()=>{raw=null}})
 const result=await readRecoveryGroupDirectory(api,api.pending())
 assert.deepEqual(result,{requestId,items:[group],status:'found'})
 assert.equal(calls,1)
})

test('刷新目录中缺失或归档的群会清除 journal，读取失败保留 journal 且不产生恢复目录',async()=>{
 for(const rows of [[],[{...group,archived:true}]]){
  let raw:string|null=JSON.stringify({schema:'teloa.groups/v1',command})
  const api=createGroupApi(async()=>rows,{read:()=>raw,write:value=>{raw=value},clear:()=>{raw=null}})
  assert.deepEqual(await readRecoveryGroupDirectory(api,api.pending()),{requestId,items:rows,status:'missing'})
  assert.ok(raw)
 }
 let raw:string|null=JSON.stringify({schema:'teloa.groups/v1',command})
 const api=createGroupApi(async()=>{throw Error('网络中断')},{read:()=>raw,write:value=>{raw=value},clear:()=>{raw=null}})
 await assert.rejects(readRecoveryGroupDirectory(api,api.pending()),/网络中断/)
 assert.ok(raw)
})

test('同一请求的迟到 missing 读取不能清除已由新读取确认 found 的恢复项',async()=>{
 let raw:string|null=JSON.stringify({schema:'teloa.groups/v1',command})
 let resolveOld:(value:unknown)=>void=()=>{},resolveNew:(value:unknown)=>void=()=>{},calls=0
 const old=new Promise<unknown>(resolve=>{resolveOld=resolve}),fresh=new Promise<unknown>(resolve=>{resolveNew=resolve})
 const api=createGroupApi(async()=>++calls===1?old:fresh,{read:()=>raw,write:value=>{raw=value},clear:()=>{raw=null}})
 let generation=0,visible:unknown
 const begin=()=>{const current=++generation,request=api.pending();return readRecoveryGroupDirectory(api,request).then(result=>{const pending=api.pending();if(current!==generation||!result||!pending||pending.kind==='create'||pending.request.requestId!==result.requestId)return;if(result.status==='missing')api.discardInaccessibleRecovery(result.items);else visible=result})}
 const first=begin(),second=begin()
 resolveNew([group]);await second
 resolveOld([]);await first
 assert.ok(raw)
 assert.deepEqual(visible,{requestId,items:[group],status:'found'})
})

test('WorkbenchFrame 将群目录读取接入世代保护的 React 状态，而不是依赖协作页面预读',async()=>{
 const frame=await readFile(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8')
 assert.match(frame,/readRecoveryGroupDirectory\(groupApi,groupRequest\)/)
 assert.match(frame,/groupRecoveryGeneration\.current/)
 assert.match(frame,/if\(directory\.status==='missing'\)groupApi\.discardInaccessibleRecovery\(directory\.items\);else setRecoveryGroupDirectory\(directory\)/)
})
