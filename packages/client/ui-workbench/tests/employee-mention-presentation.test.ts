import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {dirname,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import type {SessionEvent} from '@deepseek-ai/dsh-session'
import {bindEmployeeMentionEventSource,employeeMentionIdentity} from '../src/client/employee-mention-presentation.ts'
import {employeeMentionTextRule,employeeMentionDisplayName} from '../src/client/employee-mention-text.ts'
import type {DigitalRole} from '@teloa/contract'
const identity={schema:'teloa.employee-mention/v1',boundTo:'current-owner-message',roleId:'11111111-1111-4111-8111-111111111111',roleVersion:1,name:'研判员',scopeId:'security',state:'active'}
test('员工答复署名只来自实际host context，下一轮clear不沿用，用户文字不能伪造',()=>{
 const events=[{seq:0,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:JSON.stringify(identity)}]}},{seq:1,type:'assistant/message',data:{}}] as unknown as SessionEvent[]
 assert.equal(employeeMentionIdentity(events,1),null)
 events.push({seq:2,type:'user/message',data:{source:{kind:'runtime-context',form:'snapshot',sections:[{name:'teloa/employee-mention',text:JSON.stringify(identity)}]}}} as unknown as SessionEvent,{seq:3,type:'assistant/message',data:{}} as unknown as SessionEvent)
 assert.equal(employeeMentionIdentity(events,3)?.name,'研判员')
 events.push({seq:4,type:'user/message',data:{source:{kind:'runtime-context',form:'snapshot',sections:[{name:'teloa/employee-mention',text:'Current turn has no selected employee.'}]}}} as unknown as SessionEvent,{seq:5,type:'assistant/message',data:{}} as unknown as SessionEvent)
 assert.equal(employeeMentionIdentity(events,5),null);assert.equal(employeeMentionIdentity(events,3)?.roleVersion,1)
 const marker='[teloa-employee:'+identity.roleId+':1]',text='请让 '+marker+' 核对'
 const node=employeeMentionTextRule.match(text,0,{read:()=>undefined});assert.equal(node?.id,'teloa-employee');assert.equal(node?.start,3);assert.equal(node?.end,3+marker.length)
 if(node?.id!=='teloa-employee')throw Error('missing employee node')
 assert.equal(employeeMentionDisplayName(node.data,events,[{id:identity.roleId,version:2,kind:'employee',name:'新名字'} as unknown as DigitalRole]),'研判员')
 assert.equal(employeeMentionDisplayName(node.data,events,[{id:identity.roleId,version:1,kind:'employee',name:'同版本新名字'} as unknown as DigitalRole]),'同版本新名字','用户引用跟随当前同版本目录显示名')
 assert.equal(employeeMentionIdentity(events,3)?.name,'研判员','assistant历史答复仍按对应seq的受信身份冻结')
 assert.equal(employeeMentionIdentity(events,999),null,'不存在final答复时不冒用前一轮身份')
 assert.equal(employeeMentionDisplayName({...node.data,roleVersion:2},events,[{id:identity.roleId,version:2,kind:'employee',name:'新名字'} as unknown as DigitalRole]),'新名字')
 assert.equal(employeeMentionDisplayName({...node.data,roleVersion:3},events),undefined,'未知版本交给renderer显示@AI员工，不能倒填最新名字')
 assert.equal(employeeMentionTextRule.match('普通 @研判员',0,{read:()=>undefined}),undefined)
 assert.equal(employeeMentionTextRule.match(marker.replace(':1]',':01]'),0,{read:()=>undefined}),undefined)
})
test('新一轮尚无有效员工快照时，不沿用上一轮员工署名',()=>{
 const events=[
  {seq:0,type:'turn/start',data:{turn:1}},
  {seq:1,type:'user/message',data:{source:{kind:'runtime-context',form:'snapshot',sections:[{name:'teloa/employee-mention',text:JSON.stringify(identity)}]}}},
  {seq:2,type:'assistant/message',data:{turn:1}},
  {seq:3,type:'turn/start',data:{turn:2}},
  {seq:4,type:'user/message',data:{source:{kind:'runtime-context',form:'snapshot',sections:[{name:'other',text:'unrelated context'}]}}},
  {seq:5,type:'assistant/message',data:{turn:2}},
 ] as unknown as SessionEvent[]
 assert.equal(employeeMentionIdentity(events,2)?.name,'研判员')
 assert.equal(employeeMentionIdentity(events,5),null)
})
test('固定SDK真实prototype事件源保留receiver，更新署名且切源后清理旧订阅',async()=>{
 // 使用随固定SDK发布的原始模块，不复制类实现，也不加载浏览器插件宿主。
 const require=createRequire(import.meta.url)
 const url=pathToFileURL(join(dirname(require.resolve('@deepseek-ai/dsh-api-session-controller/package.json')),'lib/types/client/contract/events.js')).href
 const {MutableSessionEventSource}=await import(url) as Pick<typeof import('@deepseek-ai/dsh-api-session-controller/client'),'MutableSessionEventSource'>
 const first=new MutableSessionEventSource(),second=new MutableSessionEventSource()
 const unboundRead=first.getSnapshot,unboundSubscribe=first.subscribe
 assert.throws(()=>unboundRead(),TypeError)
 assert.throws(()=>unboundSubscribe(()=>{}),TypeError)
 const bound=bindEmployeeMentionEventSource(first)!
 assert.equal(bindEmployeeMentionEventSource(first),bound)
 assert.equal(bindEmployeeMentionEventSource(undefined),undefined)
 assert.notEqual(bindEmployeeMentionEventSource(second),bound)
 const {getSnapshot,subscribe}=bound
 assert.equal(getSnapshot(),first.getSnapshot(),'不复制或伪造SDK快照')
 let firstUpdates=0,secondUpdates=0
 const unsubscribe=subscribe(()=>firstUpdates++)
 const events=[
  {seq:0,type:'turn/start',data:{turn:1}},
  {seq:1,type:'user/message',data:{source:{kind:'runtime-context',form:'snapshot',sections:[{name:'teloa/employee-mention',text:JSON.stringify(identity)}]}}},
  {seq:2,type:'assistant/message',data:{turn:1}},
 ] as unknown as SessionEvent[]
 first.replace(events.map(event=>({type:'event',event})),false)
 const readIdentity=(seq:number)=>employeeMentionIdentity(getSnapshot().entries.flatMap(row=>row.type==='event'?[row.event]:[]),seq)
 assert.equal(firstUpdates,1);assert.equal(readIdentity(2)?.name,'研判员')
 first.append({type:'event',event:{seq:3,type:'turn/start',data:{turn:2}} as unknown as SessionEvent})
 first.append({type:'event',event:{seq:4,type:'assistant/message',data:{turn:2}} as unknown as SessionEvent})
 assert.equal(readIdentity(4),null,'新轮无marker不沿用旧员工')
 assert.equal(readIdentity(2)?.name,'研判员','历史回答仍按自身seq绑定')
 unsubscribe()
 const secondBound=bindEmployeeMentionEventSource(second)!,stopSecond=secondBound.subscribe(()=>secondUpdates++)
 first.replace([],false);assert.equal(firstUpdates,3,'切源清理后旧源不再通知')
 second.replace([],false);assert.equal(secondUpdates,1);assert.deepEqual(secondBound.getSnapshot().entries,[])
 stopSecond();second.replace([],false);assert.equal(secondUpdates,1)
})
