import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createChannelManager} from '../src/core/channel-manager.ts'
import {createChannelConfigStore} from '../src/core/channels-config.ts'
import {createBindingStore} from '../src/core/bindings.ts'
import {createAudit} from '../src/core/audit.ts'
import {createPairingService} from '../src/core/pairing.ts'
import {createImEndpointHandler} from '../src/server.ts'
import {fakeAdapter,fakeCredentials,silentLog,withTemp} from './im-fakes.ts'

const roleId='33333333-3333-4333-8333-333333333333'
const groupId='22222222-2222-4222-8222-222222222222'
let seq=0
const rid=()=>`00000000-0000-4000-8000-${String(seq+=1).padStart(12,'0')}`

function setup(root:string,lock:{held:boolean}={held:true},stub=false){
 const dir=join(root,'im-gateway')
 const fakes=fakeCredentials()
 const bindings=createBindingStore(dir,{perChannel:1})
 const audit=createAudit(dir)
 const manager=createChannelManager({
  credentials:fakes.credentials,config:createChannelConfigStore(dir),bindings,
  createAdapter:kind=>fakeAdapter(kind).adapter,onInbound:async()=>{},audit,
  installPackage:async()=>join(root,'sdk'),lock,log:silentLog,now:()=>'2026-09-26T00:00:00.000Z',
 })
 const removed:string[]=[]
 const handler=createImEndpointHandler({
  manager,bindings,audit,lock,stub,
  pairing:createPairingService({now:()=>Date.parse('2026-09-26T00:00:00Z'),random:()=>'123456'}),
  roles:async()=>[{id:roleId,name:'文员',version:1}],
  groups:async()=>[{id:groupId,name:'项目群'}],
  onBindingRemoved:(channelId,imUserId)=>removed.push(`${channelId}/${imUserId}`),
 })
 const call=(endpoint:string,payload:unknown)=>handler(endpoint,payload,new AbortController().signal)
 return {call,bindings,removed,dir}
}

const save=(call:ReturnType<typeof setup>['call'])=>call('im/channels/save',{requestId:rid(),channelId:'slack',kind:'slack',credentials:{SLACK_BOT_TOKEN:'xoxb-TEST-SECRET',SLACK_APP_TOKEN:'xapp-TEST-SECRET'}})

test('5. 错误映射：pairing 未启用 → conflict；已有 1 位绑定 → forbidden；未知 roleId → invalid-input；group 二次绑定 → conflict；未知渠道 enable → not-found',()=>withTemp(async root=>{
 const {call,bindings}=setup(root)
 await assert.rejects(call('im/channels/enable',{requestId:rid(),channelId:'feishu'}),{code:'teloa/not-found'})
 await save(call)
 await assert.rejects(call('im/pairing/create',{requestId:rid(),channelId:'slack'}),{code:'teloa/conflict'})
 await call('im/channels/enable',{requestId:rid(),channelId:'slack'})
 assert.deepEqual(await call('im/pairing/create',{requestId:rid(),channelId:'slack'}),{code:'123456',expiresAt:'2026-09-26T00:10:00.000Z'})
 await bindings.bind({channelId:'slack',imUserId:'U1',ownerId:'local:teloa-owner',displayName:'Max'})
 await assert.rejects(call('im/pairing/create',{requestId:rid(),channelId:'slack'}),{code:'teloa/forbidden'})
 await assert.rejects(call('im/bindings/change',{requestId:rid(),channelId:'slack',imUserId:'U1',target:{kind:'role',roleId:'44444444-4444-4444-8444-444444444444'}}),{code:'teloa/invalid-input'})
 assert.deepEqual(await call('im/bindings/change',{requestId:rid(),channelId:'slack',imUserId:'U1',target:{kind:'role',roleId}}),{channelId:'slack',imUserId:'U1',displayName:'Max',boundAt:(await bindings.list())[0]!.boundAt,target:{kind:'role',roleId}})
 await assert.rejects(call('im/groups/bind',{requestId:rid(),channelId:'slack',chatId:'C1',groupId:'55555555-5555-4555-8555-555555555555'}),{code:'teloa/invalid-input'},'groupId 不在 groups/list')
 await call('im/groups/bind',{requestId:rid(),channelId:'slack',chatId:'C1',groupId})
 await assert.rejects(call('im/groups/bind',{requestId:rid(),channelId:'slack',chatId:'C2',groupId}),{code:'teloa/conflict'})
 await assert.rejects(call('im/channels/save',{requestId:rid(),channelId:'slack',kind:'slack',credentials:{SLACK_BOT_TOKEN:'x'}}),{code:'teloa/invalid-input'},'契约白名单')
}))

test('L3 im/channels/save 与 im/bindings/change 写审计：只记 action 与 channelId，不记凭据值、imUserId 与目标',()=>withTemp(async root=>{
 const {call,bindings,dir}=setup(root)
 await save(call)
 await bindings.bind({channelId:'slack',imUserId:'U1',ownerId:'local:teloa-owner',displayName:'Max'})
 await call('im/bindings/change',{requestId:rid(),channelId:'slack',imUserId:'U1',target:{kind:'role',roleId}})
 const raw=await readFile(join(dir,'im-audit.jsonl'),'utf8')
 const rows=raw.trim().split('\n').map(line=>JSON.parse(line) as Record<string,string>)
 assert.deepEqual(rows.map(row=>[row.action,row.channelId,row.chatId,row.imUserId,row.result]),[['channel-save','slack','','','ok'],['binding-change','slack','','','ok']])
 assert.ok(rows.every(row=>row.text===undefined&&row.targetId===undefined))
 assert.doesNotMatch(raw,/TEST-SECRET|U1|33333333/)
}))

test('6. im/channels/list 回包不含任何凭据字符串',()=>withTemp(async root=>{
 const {call}=setup(root)
 await save(call)
 await call('im/channels/enable',{requestId:rid(),channelId:'slack'})
 const list=await call('im/channels/list',{})
 assert.equal((list as unknown[]).length,1)
 assert.ok(!JSON.stringify(list).includes('TEST-SECRET'))
 assert.ok(!JSON.stringify(await save(call)).includes('TEST-SECRET'))
}))

test('bindings list/remove：摘要不含 ownerId；remove 通知审批模块、不存在 → not-found；groups list/unbind',()=>withTemp(async root=>{
 const {call,bindings,removed}=setup(root)
 await bindings.bind({channelId:'slack',imUserId:'U1',ownerId:'local:teloa-owner',displayName:'Max',assistantSessionId:'s1'})
 const list=await call('im/bindings/list',{}) as Record<string,unknown>[]
 assert.deepEqual(Object.keys(list[0]!).sort(),['boundAt','channelId','displayName','imUserId','target'])
 assert.deepEqual(await call('im/bindings/remove',{requestId:rid(),channelId:'slack',imUserId:'U1'}),{removed:true})
 assert.deepEqual(removed,['slack/U1'])
 await assert.rejects(call('im/bindings/remove',{requestId:rid(),channelId:'slack',imUserId:'U1'}),{code:'teloa/not-found'})
 await bindings.groups.bind({channelId:'slack',chatId:'C1',groupId})
 assert.equal((await call('im/groups/list',{}) as unknown[]).length,1)
 assert.deepEqual(await call('im/groups/unbind',{requestId:rid(),channelId:'slack',chatId:'C1'}),{removed:true})
 await assert.rejects(call('im/groups/unbind',{requestId:rid(),channelId:'slack',chatId:'C1'}),{code:'teloa/not-found'})
}))

test('L4 锁未持有：写端点 → conflict（确定性错误，宿主不留 pending）；list 仍可读并带 status.error',()=>withTemp(async root=>{
 const {call}=setup(root,{held:false})
 await assert.rejects(save(call),{code:'teloa/conflict'})
 await assert.rejects(call('im/pairing/create',{requestId:rid(),channelId:'slack'}),{code:'teloa/conflict'})
 assert.deepEqual(await call('im/channels/list',{}),[])
 await assert.rejects(call('im/channels/list',{extra:1}),{code:'teloa/invalid-input'})
}))

test('验收桩：未开启 stub 时任何带 channelId/kind=stub 的请求一律 invalid-input；开启后可保存、列出与按渠道过滤',()=>withTemp(async root=>{
 const off=setup(root)
 const saveStub=(call:ReturnType<typeof setup>['call'])=>call('im/channels/save',{requestId:rid(),channelId:'stub',kind:'stub',credentials:{STUB_TOKEN:'stub-secret-9f3a'}})
 await assert.rejects(saveStub(off.call),{code:'teloa/invalid-input'})
 await assert.rejects(off.call('im/channels/enable',{requestId:rid(),channelId:'stub'}),{code:'teloa/invalid-input'})
 await assert.rejects(off.call('im/bindings/list',{channelId:'stub'}),{code:'teloa/invalid-input'})
 assert.deepEqual(await off.call('im/channels/list',{}),[])
 const on=setup(join(root,'on'),{held:true},true)
 const saved=await saveStub(on.call) as {kind:string;label:string;credentialsSaved:boolean}
 assert.equal(saved.kind,'stub')
 assert.equal(saved.label,'验收桩')
 assert.equal(saved.credentialsSaved,true)
 assert.ok(!JSON.stringify(await on.call('im/channels/list',{})).includes('stub-secret'))
 assert.deepEqual(await on.call('im/bindings/list',{channelId:'stub'}),[])
}))

test('Lark 与飞书经端点并存：保存、启用、配对、群绑定各按渠道；审计只记 action 与 channelId，回包与审计不含凭据值',()=>withTemp(async root=>{
 const {call,bindings,dir}=setup(root)
 await call('im/channels/save',{requestId:rid(),channelId:'feishu',kind:'feishu',credentials:{FEISHU_APP_ID:'cli_a1b2c3d4e5f60718',FEISHU_APP_SECRET:'TEST-SECRET-feishu'}})
 const saved=await call('im/channels/save',{requestId:rid(),channelId:'lark',kind:'lark',credentials:{LARK_APP_ID:'cli_0123456789abcdef',LARK_APP_SECRET:'TEST-SECRET-lark'}})
 await assert.rejects(call('im/channels/save',{requestId:rid(),channelId:'lark',kind:'lark',credentials:{LARK_APP_ID:'cli_0123456789abcdef',LARK_APP_SECRET:'x',LARK_DOMAIN:'https://evil.example'}}),{code:'teloa/invalid-input'})
 await call('im/channels/enable',{requestId:rid(),channelId:'feishu'})
 await call('im/channels/enable',{requestId:rid(),channelId:'lark'})
 const list=await call('im/channels/list',{}) as {channelId:string;label:string;enabled:boolean}[]
 assert.deepEqual(list.map(row=>[row.channelId,row.label,row.enabled]),[['feishu','飞书',true],['lark','Lark',true]])
 assert.deepEqual(await call('im/pairing/create',{requestId:rid(),channelId:'lark'}),{code:'123456',expiresAt:'2026-09-26T00:10:00.000Z'})
 await bindings.bind({channelId:'lark',imUserId:'ou_lark',ownerId:'local:teloa-owner',displayName:'Max'})
 await assert.rejects(call('im/pairing/create',{requestId:rid(),channelId:'lark'}),{code:'teloa/forbidden'})
 assert.deepEqual(await call('im/pairing/create',{requestId:rid(),channelId:'feishu'}),{code:'123456',expiresAt:'2026-09-26T00:10:00.000Z'},'Lark 的绑定不占飞书名额')
 await call('im/groups/bind',{requestId:rid(),channelId:'lark',chatId:'oc_lark',groupId})
 assert.deepEqual((await call('im/groups/list',{channelId:'lark'}) as {chatId:string}[]).map(row=>row.chatId),['oc_lark'])
 assert.deepEqual(await call('im/groups/list',{channelId:'feishu'}),[])
 const raw=await readFile(join(dir,'im-audit.jsonl'),'utf8')
 assert.match(raw,/"channelId":"lark"[^\n]*"action":"channel-save"/)
 assert.doesNotMatch(raw+JSON.stringify(list)+JSON.stringify(saved),/TEST-SECRET/)
}))
