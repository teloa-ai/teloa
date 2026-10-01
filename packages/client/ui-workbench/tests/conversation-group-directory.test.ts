import test from 'node:test'
import assert from 'node:assert/strict'
import {createConversationGroupDirectory} from '../src/client/conversation-group-directory.ts'
import {createGroupApi,type GroupDirectory} from '../src/client/group-api.ts'
import {visibleSavedGroups} from '../src/client/saved-collaboration-state.ts'
import {WORK_DIRECTORY_MESSAGE_ROWS} from '../src/client/i18n/locales/work-directory.ts'

const at='2026-09-18T00:00:00.000Z'
const group={id:'11111111-1111-4111-8111-111111111111',ownerId:'self',name:'调查协作',scope:'SOC',announcement:'核对证据',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},version:1,pinned:false,archived:false,createdAt:at,updatedAt:at}
const deferred=()=>{let resolve!:(value:GroupDirectory)=>void, reject!:(cause:unknown)=>void;const promise=new Promise<GroupDirectory>((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}

test('统一对话目录只读取已核验的持久群，刷新不产生会话、消息、任务或授权写入',async()=>{
 const calls:{endpoint:string;payload:unknown}[]=[]
 const directory=createConversationGroupDirectory(createGroupApi(async(endpoint,payload)=>{calls.push({endpoint,payload});return [group]}))
 assert.equal(directory.getSnapshot().status,'idle')
 let notices=0
 const unsubscribe=directory.subscribe(()=>notices++)
 await directory.refresh()
 assert.deepEqual(calls,[{endpoint:'groups/list',payload:{}}])
 assert.deepEqual(directory.getSnapshot(),{status:'ready',items:[group]})
 assert.equal(notices,2)
 const snapshot=directory.getSnapshot()
 assert.equal(directory.getSnapshot(),snapshot,'供 React 订阅读取的快照身份稳定')
 unsubscribe()
 await directory.refresh()
 assert.equal(notices,2)
})

test('群读取失败与空目录有区别，失败后刷新可恢复，非法回包不会混入目录',async()=>{
 let response:unknown=[group]
 const directory=createConversationGroupDirectory(createGroupApi(async()=>response))
 await directory.refresh()
 response=[{...group,ownerId:'someone-else'}]
 await directory.refresh()
 assert.equal(directory.getSnapshot().status,'failed')
 assert.ok(directory.getSnapshot().error)
 assert.deepEqual(directory.getSnapshot().items,[])
 response=[]
 await directory.refresh()
 assert.deepEqual(directory.getSnapshot(),{status:'ready',items:[]})
})

test('迟到的旧目录与旧错误都不能覆盖最近一次刷新',async()=>{
 const first=deferred(),second=deferred(),third=deferred(),fourth=deferred(),pending=[first,second,third,fourth]
 const directory=createConversationGroupDirectory({list:()=>pending.shift()!.promise})
 const a=directory.refresh(),b=directory.refresh()
 second.resolve({items:[group]});await b
 first.resolve({items:[]});await a
 assert.deepEqual(directory.getSnapshot().items,[group])
 const c=directory.refresh(),d=directory.refresh()
 fourth.resolve({items:[{...group,name:'已更新'}]});await d
 third.reject(Error('旧连接失败'));await c
 assert.equal(directory.getSnapshot().status,'ready')
 assert.equal(directory.getSnapshot().items[0]?.name,'已更新')
})

test('统一搜索按群名称与公告匹配，归档独立于执行位置，保留后端置顶顺序',()=>{
 const pinned={...group,id:'22222222-2222-4222-8222-222222222222',pinned:true,name:'AppSec 协作',scope:'AppSec'}
 const archived={...group,id:'33333333-3333-4333-8333-333333333333',archived:true}
 const rows=Object.freeze([pinned,group,archived])
 assert.deepEqual(visibleSavedGroups(rows,'  证据  ','all',false),[pinned,group])
 assert.deepEqual(visibleSavedGroups(rows,'appsec','all',false),[pinned])
 assert.deepEqual(visibleSavedGroups(rows,'调查','all',true),[archived])
 assert.deepEqual(visibleSavedGroups(rows,'不存在','all',false),[])
 assert.deepEqual(rows,[pinned,group,archived])
})

test('统一对话目录的新增文案完整覆盖十语言，不将群搜索描述成正文搜索',()=>{
 const rows=WORK_DIRECTORY_MESSAGE_ROWS.filter(row=>row[0].startsWith('conversationDirectory.'))
 const keys=new Set(rows.map(row=>row[0]))
 for(const key of ['conversationDirectory.direct','conversationDirectory.groups','conversationDirectory.subtitle','conversationDirectory.groupSearch','conversationDirectory.landingTitle','conversationDirectory.landingDescription'] as const)assert.ok(keys.has(key),key)
 for(const row of rows){assert.equal(row.length,11);for(const value of row.slice(1))assert.ok(value.trim(),row[0])}
 assert.equal(rows.find(row=>row[0]==='conversationDirectory.direct')?.[1],'一对一')
 assert.equal(rows.find(row=>row[0]==='conversationDirectory.groups')?.[1],'群')
 assert.equal(rows.find(row=>row[0]==='conversationDirectory.subtitle')?.[1],'一对一和群都在这里，按最近活动排列')
 assert.equal(rows.find(row=>row[0]==='conversationDirectory.groupSearch')?.[1],'群按名称和公告搜索')
 assert.equal(rows.find(row=>row[0]==='conversationDirectory.landingTitle')?.[1],'选择一段对话')
})
