import test from 'node:test'
import assert from 'node:assert/strict'
import {readdir,readFile} from 'node:fs/promises'
import {createGroupHandler,groupEndpoints} from '../src/groups.ts'
import type {GroupReactionSummary,GroupRoutingDecisionView} from '@teloa/contract'

const owner='local:owner'
const groupId='11111111-1111-4111-8111-111111111111'
const messageId='55555555-5555-4555-8555-555555555555'
const requestId='77777777-7777-4777-8777-777777777777'

const summary=(over:Partial<GroupReactionSummary>={}):GroupReactionSummary=>({messageId,emoji:'👍',count:1,mine:true,actors:[{actorKind:'self',actorId:'self'}],...over})
const view=(over:Partial<GroupRoutingDecisionView>={}):GroupRoutingDecisionView=>({messageId,kind:'routed',respond:[],hops:0,...over})

/** 十三个方法各记一次调用；既有十个的回包逐字照 `CollaborationService` 的形状。 */
function stand(){
 const calls:{name:string;owner:string;input:unknown}[]=[]
 const record=(name:string,value:unknown)=>async(actor:string,input:unknown)=>{calls.push({name,owner:actor,input});return value}
 const collaboration={
  list:record('list',{items:[]}),
  get:record('get',{group:{id:groupId}}),
  create:record('create',{group:{id:groupId}}),
  change:record('change',{group:{id:groupId}}),
  messages:record('messages',{items:[{id:messageId}]}),
  send:record('send',{message:{id:messageId}}),
  resources:record('resources',{items:[]}),
  resource:record('resource',{resource:null}),
  saveResource:record('saveResource',{resource:null}),
  withdrawResource:record('withdrawResource',{resource:null}),
 }
 const service={
  ...collaboration,
  reactions:record('reactions',{items:[summary()]}),
  toggleReaction:record('toggleReaction',{messageId,items:[summary()]}),
  routing:record('routing',{items:[view()]}),
 }
 return {calls,collaboration,service,handler:createGroupHandler(owner,async()=>service,()=>{})}
}

test('端点恰好三条进 groupEndpoints，GroupOperations 恰十三个方法',async()=>{
 assert.equal(groupEndpoints.length,13)
 assert.deepEqual(groupEndpoints.slice(10),['groups/reactions/list','groups/reactions/toggle','groups/routing/list'])
 // 服务对象按 GroupOperations 类型传进 createGroupHandler：这里再钉一次键数，少一个或多一个都判红。
 const {handler,calls,service}=stand()
 assert.equal(Object.keys(service).length,13)
 // 既有十个里，撤回原本是分发链末尾的兜底分支，本期改成显式分支，必须仍落到 withdrawResource。
 await handler('groups/resources/withdraw',{requestId,groupId,resourceId:messageId,expectedVersion:1})
 await handler('groups/reactions/list',{groupId,messageIds:[messageId]})
 await handler('groups/reactions/toggle',{requestId,groupId,messageId,emoji:'👍'})
 await handler('groups/routing/list',{groupId,messageIds:[messageId]})
 assert.deepEqual(calls.map(call=>call.name),['withdrawResource','reactions','toggleReaction','routing'])
 assert.ok(calls.every(call=>call.owner===owner))
 // 入参是解析器归一化之后的对象，不是浏览器原样交来的那一个。
 assert.deepEqual(calls[1]?.input,{groupId,messageIds:[messageId]})
})

test('endpointSet 里这三条都在，且没有第四条本期新端点',async()=>{
 const root=new URL('../src/',import.meta.url)
 const source=await readFile(new URL('index.ts',root),'utf8')
 const line=source.split('\n').find(row=>row.startsWith('const endpointSet=new Set('))
 assert.ok(line,'index.ts 里找不到 endpointSet 的声明行')
 // 三条新端点经 groupEndpoints 整体进 endpointSet 与分发链，宿主里不再单列。
 assert.match(line,/\.\.\.groupEndpoints/)
 assert.match(source,/if\(!endpointSet\.has\(endpoint\)\)/)
 assert.match(source,/\(groupEndpoints as readonly string\[\]\)\.includes\(endpoint\)\?await groupHandler\(endpoint,payload\)/)
 // 端点字面量只许出现在 groups.ts 的那一份清单里，避免有人另起一份绕过 endpointSet 或多出第四条。
 let literals:string[]=[]
 for(const entry of await readdir(root,{withFileTypes:true})){
  if(!entry.isFile()||!entry.name.endsWith('.ts'))continue
  const text=await readFile(new URL(entry.name,root),'utf8')
  const found=[...new Set((text.match(/["'`]groups\/(reactions|routing)\/[a-z]+["'`]/g)??[]).map(item=>item.slice(1,-1)))]
  if(entry.name!=='groups.ts')assert.deepEqual(found,[],`${entry.name} 里不得出现本期新端点的字面量`)
  else literals=found.sort()
 }
 // groups.ts 里恰三条，没有第四条：多写一条就会在这里判红，而它不在 groupEndpoints 里就永远走不到。
 assert.deepEqual(literals,['groups/reactions/list','groups/reactions/toggle','groups/routing/list'])
})

test('未知端点仍走既有 not-found 分支，文案逐字',async()=>{
 const {handler,calls}=stand()
 await assert.rejects(handler('groups/reactions/unknown',{}),{code:'teloa/not-found',message:'未提供此群协作接口。'})
 await assert.rejects(handler('groups/routing/toggle',{}),{code:'teloa/not-found',message:'未提供此群协作接口。'})
 assert.deepEqual(calls,[])
})

test('未知键一律 invalid-input，owner 不从浏览器读',async()=>{
 let opened=0
 const handler=createGroupHandler(owner,async()=>{opened++;return undefined},()=>{})
 await assert.rejects(handler('groups/reactions/toggle',{requestId,groupId,messageId,emoji:'👍',ownerId:'别人'}),{code:'teloa/invalid-input'})
 await assert.rejects(handler('groups/reactions/list',{groupId,messageIds:[messageId],ownerId:'别人'}),{code:'teloa/invalid-input'})
 await assert.rejects(handler('groups/routing/list',{groupId,messageIds:[messageId],extra:1}),{code:'teloa/invalid-input'})
 // 白名单外的表情同样在宿主这一层就被拒。
 await assert.rejects(handler('groups/reactions/toggle',{requestId,groupId,messageId,emoji:'🐛'}),{code:'teloa/invalid-input'})
 assert.equal(opened,0)
 await assert.rejects(handler('groups/reactions/list',{groupId,messageIds:[messageId]}),{code:'teloa/host-unavailable'})
 assert.equal(opened,1)
})

test('回包形状逐字：toggle 恰两键、routing/list 每项恰四键',async()=>{
 const {handler}=stand()
 assert.deepEqual(Object.keys(await handler('groups/reactions/toggle',{requestId,groupId,messageId,emoji:'👍'}) as object).sort(),['items','messageId'])
 assert.deepEqual(Object.keys(await handler('groups/reactions/list',{groupId,messageIds:[messageId]}) as object),['items'])
 const routing=await handler('groups/routing/list',{groupId,messageIds:[messageId]}) as {items:GroupRoutingDecisionView[]}
 for(const item of routing.items)assert.deepEqual(Object.keys(item).sort(),['hops','kind','messageId','respond'])
})

test('十个既有群端点仍由 CollaborationService 服务，回包不变',async()=>{
 const {handler,collaboration}=stand()
 assert.deepEqual(await handler('groups/messages/list',{groupId}),await collaboration.messages(owner,{groupId}))
 assert.deepEqual(await handler('groups/list',{}),await collaboration.list(owner,{}))
 assert.deepEqual(await handler('groups/resources/list',{groupId}),await collaboration.resources(owner,{groupId}))
})

test('后端 WorkError 原样透传：三条新端点的失败对象连实例都不换',async()=>{
 const {service}=stand()
 const failures=[
  ['groups/reactions/list',{groupId,messageIds:[messageId]},'reactions'],
  ['groups/reactions/toggle',{requestId,groupId,messageId,emoji:'👍'},'toggleReaction'],
  ['groups/routing/list',{groupId,messageIds:[messageId]},'routing'],
 ] as const
 for(const [endpoint,payload,method] of failures){
  const expected=new Error('boom')
  const handler=createGroupHandler(owner,async()=>({...service,[method]:async()=>{throw expected}}),()=>{})
  await assert.rejects(handler(endpoint,payload),error=>error===expected)
 }
})
