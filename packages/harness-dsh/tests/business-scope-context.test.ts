import test from 'node:test'
import assert from 'node:assert/strict'
import type {ToolExecution} from '@deepseek-ai/dsh-tools'
import type {ConversationWorkContext} from '@teloa/backend'
import {authorizeConversationBusinessScope,readBusinessScopeContext} from '../src/business-scope-context.ts'
import type {BusinessConversationAuthorizationPorts} from '../src/business-conversation-authorization.ts'
import {businessScopeTime} from '../src/business-scope-time.ts'
function fixture(){
 let context:ConversationWorkContext|null={sessionId:'session',scopeId:'SOC',roleId:null,version:1,locked:false}
 let scopes=['SOC','AppSec'],role=false,task=false,owner='owner'
 const ports:BusinessConversationAuthorizationPorts={owner:'owner',conversation:async sessionId=>({ownerId:owner,sessionId,status:'ready'}),readTaskPolicy:async()=>null,isRoleConversation:async()=>role,isTaskConversation:async()=>task,binding:async()=>undefined,context:async()=>context,scopes:async()=>scopes.map(scope=>({scope,title:scope}))}
 const exec={agent:{session:{id:'session',header:{}}},signal:AbortSignal.timeout(5000)} as Pick<ToolExecution,'agent'|'signal'>
 return {ports,exec,get context(){return context},set context(value){context=value},set scopes(value:string[]){scopes=value},set role(value:boolean){role=value},set task(value:boolean){task=value},set owner(value:string){owner=value}}
}
test('当前业务默认且只授权单业务；显式跨业务、他人、角色和Task均拒绝',async()=>{
 const f=fixture(),lease=await authorizeConversationBusinessScope(f.ports,f.exec)
 assert.equal(lease.scope,'SOC');assert.deepEqual(lease.actor,{ownerId:'owner',scopeIds:['SOC']})
 await assert.rejects(()=>authorizeConversationBusinessScope(f.ports,f.exec,'AppSec'))
 f.owner='other';await assert.rejects(()=>lease.assertCurrent());f.owner='owner'
 f.role=true;await assert.rejects(()=>lease.assertCurrent());f.role=false
 f.task=true;await assert.rejects(()=>lease.assertCurrent())
})
test('旧会话业务/版本或授权撤回使原lease失效；通用显式业务保留且不投全集',async()=>{
 const f=fixture(),lease=await authorizeConversationBusinessScope(f.ports,f.exec)
 f.context={...f.context!,version:2};await assert.rejects(()=>lease.assertCurrent())
 f.context={...f.context!,scopeId:'general'}
 assert.equal((await authorizeConversationBusinessScope(f.ports,f.exec)).scope,undefined)
 assert.deepEqual((await authorizeConversationBusinessScope(f.ports,f.exec,'AppSec')).actor.scopeIds,['AppSec'])
 f.scopes=['SOC'];await assert.rejects(()=>authorizeConversationBusinessScope(f.ports,f.exec,'AppSec'))
})
test('目录来源随当前业务投影并在SDK发送前复核，资源正文不自动预读',async()=>{
 const f=fixture();let title='告警手册',calls=0
 const ports={authorization:f.ports,now:()=> '2026-10-31T16:01:00.000Z',timezone:()=> 'Asia/Singapore',resources:async(actor:{scopeIds:string[]})=>{calls++;assert.deepEqual(actor.scopeIds,['SOC']);return [{id:'resource',ownerId:'owner',version:1,status:'active' as const,title,sourceId:'knowledge-source',sourceVersion:'a'.repeat(64),scopeIds:['SOC'],createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'}]},definitions:async()=>[]}
 const context=await readBusinessScopeContext(ports,f.exec,f.context)
 assert.ok(context);const value=context.value as {scope:string;clock:{currentDate:string};resources:unknown[];applications:unknown[]}
 assert.equal(value.scope,'SOC');assert.equal(value.clock.currentDate,'2026-11-01');assert.equal(value.resources.length,1);assert.deepEqual(value.applications,[])
 await context.assertCurrent();assert.equal(calls,2)
 title='已修订手册';await assert.rejects(()=>context.assertCurrent())
 f.scopes=[];await assert.rejects(()=>context.assertCurrent())
})
test('跨业务资源与不匹配发送版本不能进入当前上下文',async()=>{
 const f=fixture(),ports={authorization:f.ports,now:()=> '2026-11-01T00:00:00.000Z',resources:async()=>[{id:'resource',ownerId:'owner',version:1,status:'active' as const,title:'他业务',sourceId:'source',sourceVersion:'a'.repeat(64),scopeIds:['AppSec'],createdAt:'',updatedAt:''}],definitions:async()=>[]}
 await assert.rejects(()=>readBusinessScopeContext(ports,f.exec,f.context))
 await assert.rejects(()=>readBusinessScopeContext({...ports,resources:async()=>[]},f.exec,{...f.context!,version:2}))
})
test('本地本月跨UTC月界、DST和年界，使用真实IANA边界',()=>{
 const sg=businessScopeTime('2026-10-31T16:00:00.000Z','Asia/Singapore')
 assert.equal(sg.currentDate,'2026-11-01');assert.deepEqual(sg.thisMonth,{from:'2026-10-31T16:00:00.000Z',to:'2026-11-30T16:00:00.000Z'})
 assert.deepEqual(businessScopeTime('2026-03-15T12:00:00.000Z','America/New_York').thisMonth,{from:'2026-03-01T05:00:00.000Z',to:'2026-04-01T04:00:00.000Z'})
 assert.deepEqual(businessScopeTime('2026-12-31T15:59:59.999Z','Asia/Singapore').thisMonth,{from:'2026-11-30T16:00:00.000Z',to:'2026-12-31T16:00:00.000Z'})
 assert.throws(()=>businessScopeTime('not-a-clock','Asia/Singapore'))
})

test('发送等候跨本地日期/月边界时旧时间上下文失效，不静默沿用旧月',async()=>{
 const f=fixture();let now='2026-10-31T15:59:59.999Z'
 const read=await readBusinessScopeContext({authorization:f.ports,now:()=>now,timezone:()=> 'Asia/Singapore',resources:async()=>[],definitions:async()=>[]},f.exec,f.context)
 now='2026-10-31T16:00:00.000Z';await assert.rejects(()=>read!.assertCurrent())
})

test('已绑定业务却缺失context不能降级general或显式借用另一业务',async()=>{
 const f=fixture();f.context=null
 f.ports.binding=async()=>({kind:'daily',sessionId:'session',scope:'SOC'}) as never
 await assert.rejects(()=>authorizeConversationBusinessScope(f.ports,f.exec))
 await assert.rejects(()=>authorizeConversationBusinessScope(f.ports,f.exec,'AppSec'))
})
