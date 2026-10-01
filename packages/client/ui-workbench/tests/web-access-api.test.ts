import test from 'node:test'
import assert from 'node:assert/strict'
import {createWebAccessApi} from '../src/client/web-access-api.ts'
import {createWebAccessDraftStore,webAccessDrafts} from '../src/client/web-access-drafts.ts'
import {createTaskRunApi} from '../src/client/task-run-api.ts'
import {createRoleToolGrantApi} from '../src/client/role-tool-grant-api.ts'
import {isWebToolRule,selectedRoleToolGrantRules,roleToolGrantSelectionKey} from '../src/client/role-tool-grant-presentation.ts'

const requestId='c1234567-1234-4123-8123-123456789abc'
const request={requestId,expectedVersion:1,enabled:true,blocked:['example.com']}
const receipt={version:2,enabled:true,blocked:['example.com']}

test('回包核对：version 或 enabled/blocked 与请求不一致时拒绝并保留请求',async()=>{
 let raw:string|null=null;const journal={read:()=>raw,write:(v:string)=>{raw=v},clear:()=>{raw=null}}
 const wrongVersion=createWebAccessApi(async()=>({...receipt,version:3}),journal)
 await assert.rejects(wrongVersion.change(request),/不一致/);assert.ok(wrongVersion.pending())
 raw=null
 const wrongEnabled=createWebAccessApi(async()=>({...receipt,enabled:false}),journal)
 await assert.rejects(wrongEnabled.change(request),/不一致/);assert.ok(wrongEnabled.pending())
 raw=null
 const wrongBlocked=createWebAccessApi(async()=>({...receipt,blocked:['other.com']}),journal)
 await assert.rejects(wrongBlocked.change(request),/不一致/);assert.ok(wrongBlocked.pending())
})

test('四个可纠正码清空 journal，其余码保留待核对请求',async()=>{
 for(const code of ['teloa/invalid-input','teloa/forbidden','teloa/conflict','teloa/version-conflict']){
  let raw:string|null=null;const journal={read:()=>raw,write:(v:string)=>{raw=v},clear:()=>{raw=null}}
  const api=createWebAccessApi(async()=>{throw Object.assign(Error('denied'),{rejected:true,code})},journal)
  await assert.rejects(api.change(request),/denied/)
  assert.equal(raw,null,`code=${code} 应清空 journal`)
 }
 let raw:string|null=null;const journal={read:()=>raw,write:(v:string)=>{raw=v},clear:()=>{raw=null}}
 const api=createWebAccessApi(async()=>{throw Object.assign(Error('offline'),{rejected:true,code:'teloa/storage-corrupt'})},journal)
 await assert.rejects(api.change(request),/offline/)
 assert.ok(raw,'非可纠正码应保留 journal')
})

test('保存回包丢失后跨实例重放同一 requestId',async()=>{
 let raw:string|null=null;const journal={read:()=>raw,write:(v:string)=>{raw=v},clear:()=>{raw=null}},sent:unknown[]=[]
 const first=createWebAccessApi(async(_endpoint,payload)=>{sent.push(payload);throw Error('lost')},journal)
 await assert.rejects(first.change(request),/lost/);assert.ok(raw)
 const second=createWebAccessApi(async(_endpoint,payload)=>{sent.push(payload);return receipt},journal)
 await second.recover()
 assert.deepEqual(sent,[request,request])
 assert.equal(raw,null)
})

test('get 提交零字段入参，change 提交恰四键',async()=>{
 let getPayload:unknown,changePayload:unknown
 const journal={read:()=>null,write:(_v:string)=>{},clear:()=>{}}
 const api=createWebAccessApi(async(endpoint,payload)=>{
  if(endpoint==='web-access/get'){getPayload=payload;return receipt}
  changePayload=payload;return receipt
 },journal)
 await api.get()
 assert.deepEqual(Object.keys(getPayload as object),[])
 await api.change(request)
 assert.deepEqual(Object.keys(changePayload as Record<string,unknown>).sort(),['blocked','enabled','expectedVersion','requestId'])
})

// --- RunView.webAccess ---

const id='11111111-1111-4111-8111-111111111111',taskId='22222222-2222-4222-8222-222222222222',roleId='33333333-3333-4333-8333-333333333333'
const row={id,taskId,roleId,taskVersion:1,roleVersion:2,linkVersion:1,sessionId:'session',nativeRequestId:id,state:'ended',evidence:{state:'ended',turn:0,messageSeq:1,endSeq:2,reason:'completed'},allowedTools:[],memory:[],inputText:JSON.stringify({task:{id:taskId,version:1,title:'调查',goal:'核对证据',scope:'general'},role:{id:roleId,version:2,name:'调查岗',duty:'调查',dataScope:'只读',executionScope:'代拟'}}),createdAt:'2026-09-11T10:00:00.000Z'}
const entries=[{kind:'search',value:'台风路径',at:'2026-09-20T00:00:00.000Z'},{kind:'fetch',value:'https://example.com/a',at:'2026-09-20T00:00:01.000Z'},{kind:'search',value:'台风等级',at:'2026-09-20T00:00:02.000Z'}]

test('运行回包带上网记录时解析出三条，kind 只认两值',async()=>{
 const saved=(await createTaskRunApi(async()=>[{...row,webAccess:entries}]).list(taskId))[0]!
 assert.deepEqual(saved.webAccess,entries)
})

test('带第三个 kind 值时拒绝',async()=>{
 const invalid=[...entries,{kind:'download',value:'x',at:'2026-09-20T00:00:03.000Z'}]
 await assert.rejects(createTaskRunApi(async()=>[{...row,webAccess:invalid}]).list(taskId))
})

test('缺 webAccess 键时 RunView 上没有该键，不冒充空记录',async()=>{
 const saved=(await createTaskRunApi(async()=>[row]).list(taskId))[0]!
 assert.equal('webAccess' in saved,false)
})

test('webAccess 记录里多一个未知键时拒绝',async()=>{
 const invalid=[{...entries[0],extra:1}]
 await assert.rejects(createTaskRunApi(async()=>[{...row,webAccess:invalid}]).list(taskId))
})

// --- isWebToolRule ---

test('isWebToolRule 只认 web_search/web_fetch 的整工具授权',()=>{
 assert.equal(isWebToolRule({name:'web_search',allowed:[],anyArguments:true}),true)
 assert.equal(isWebToolRule({name:'web_fetch',allowed:[],anyArguments:true}),true)
 assert.equal(isWebToolRule({name:'subagent_task',allowed:[],anyArguments:true}),false)
 assert.equal(isWebToolRule({name:'web_fetch',allowed:[{url:'https://a'}]}),false)
})

// --- selectedRoleToolGrantRules 候选中同时有 subagent_task/web_search/web_fetch ---

test('候选里三条整工具授权只回传勾选的两条，形状与顺序稳定',()=>{
 const subagentRule={name:'subagent_task',allowed:[],anyArguments:true as const}
 const searchRule={name:'web_search',allowed:[],anyArguments:true as const}
 const fetchRule={name:'web_fetch',allowed:[],anyArguments:true as const}
 const rules=[subagentRule,searchRule,fetchRule]
 const selected=new Set([roleToolGrantSelectionKey(searchRule),roleToolGrantSelectionKey(fetchRule)])
 const result=selectedRoleToolGrantRules(rules,selected)
 assert.deepEqual(result,[{name:'web_search',allowed:[],anyArguments:true},{name:'web_fetch',allowed:[],anyArguments:true}])
})

// --- role-tool-grant-api.ts:41 的限额判据不误伤含 web 规则的候选 ---

test('候选含 web 两条与 subagent 一条并附限额时不抛',async()=>{
 const delegation={maxDepth:2,maxPerRun:8}
 const rules=[{name:'web_search',allowed:[],anyArguments:true as const},{name:'web_fetch',allowed:[],anyArguments:true as const},{name:'subagent_task',allowed:[],anyArguments:true as const}]
 const journal={read:()=>null,write:(_v:string)=>{},clear:()=>{}}
 const api=createRoleToolGrantApi(async()=>({roleVersion:3,rules,delegation}),journal)
 const result=await api.candidates(roleId)
 assert.deepEqual(result,{roleVersion:3,rules,delegation})
})

// --- 跨挂载草稿 ---

test('createWebAccessDraftStore 产出的草稿仓：write 通知 subscribe 一次，clear 后读不到',()=>{
 const store=createWebAccessDraftStore()
 let notified=0
 const off=store.subscribe(()=>{notified++})
 assert.equal(store.read(),undefined)
 store.write({enabled:true,blocked:['a.com'],input:'a.com'})
 assert.equal(notified,1)
 assert.deepEqual(store.getSnapshot(),{enabled:true,blocked:['a.com'],input:'a.com'})
 store.clear()
 assert.equal(store.read(),undefined)
 off()
})

test('全应用单例 webAccessDrafts：write 后另一处新挂载的读者仍读得到，clear 后读不到',()=>{
 webAccessDrafts.clear()
 webAccessDrafts.write({enabled:false,blocked:['b.com'],input:'b.com'})
 // 模拟设置壳把该节整段卸载再重挂：重新从模块单例取一次读方法，而非复用旧引用。
 const {read:remountedRead}=webAccessDrafts
 assert.deepEqual(remountedRead(),{enabled:false,blocked:['b.com'],input:'b.com'})
 webAccessDrafts.clear()
 assert.equal(webAccessDrafts.read(),undefined)
})
