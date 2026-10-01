import test from 'node:test'
import assert from 'node:assert/strict'
import {createImChannelsApi} from '../src/client/im-channels-api.ts'

const roleId='7a1c2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const groupId='0f9e8d7c-6b5a-4433-9211-0fedcba98765'
const summary=(extra:Record<string,unknown>={})=>({channelId:'telegram',kind:'telegram',label:'Telegram',enabled:false,credentialsSaved:true,status:{connected:false},bindings:0,groups:0,...extra})
const memory=()=>{const writes:string[]=[];let raw:string|null=null;return {writes,get raw(){return raw},journal:{read:()=>raw,write:(v:string)=>{writes.push(v);raw=v},clear:()=>{raw=null}}}}

test('save：payload 只含 requestId/channelId/kind/credentials，channelId=kind；凭据不写入 journal',async()=>{
 const store=memory(),sent:{endpoint:string;payload:Record<string,unknown>}[]=[]
 const api=createImChannelsApi(async(endpoint,payload)=>{sent.push({endpoint,payload:payload as Record<string,unknown>});return summary()},store.journal)
 const result=await api.save({kind:'telegram',credentials:{TELEGRAM_BOT_TOKEN:'123456:SECRET-VALUE'}})
 assert.equal(result.credentialsSaved,true)
 assert.equal(sent[0]!.endpoint,'im/channels/save')
 assert.deepEqual(Object.keys(sent[0]!.payload).sort(),['channelId','credentials','kind','requestId'])
 assert.equal(sent[0]!.payload.channelId,'telegram')
 assert.match(String(sent[0]!.payload.requestId),/^[0-9a-f-]{36}$/)
 assert.ok(store.writes.every(value=>!value.includes('SECRET-VALUE')),'journal 不得含凭据值')
 assert.equal(api.pending(),undefined)
})

test('读侧防回显：回包带 TELEGRAM_BOT_TOKEN 键即拒收；列表下钻数组',async()=>{
 const store=memory()
 const leak=createImChannelsApi(async()=>summary({TELEGRAM_BOT_TOKEN:'x'}),store.journal)
 await assert.rejects(leak.save({kind:'telegram',credentials:{TELEGRAM_BOT_TOKEN:'t'}}))
 await assert.rejects(createImChannelsApi(async()=>[summary(),{...summary(),SLACK_BOT_TOKEN:'x'}],store.journal).channels())
 await assert.rejects(createImChannelsApi(async()=>[{channelId:'telegram',imUserId:'u1',displayName:'小王',boundAt:'2026-09-26T00:00:00.000Z',target:{kind:'assistant'},apiKey:'k'}],store.journal).bindings())
 assert.deepEqual(await createImChannelsApi(async()=>[summary()],store.journal).channels(),[summary()])
})

test('enable：payload 只含 requestId/channelId，成功后清 journal',async()=>{
 const store=memory(),sent:Record<string,unknown>[]=[]
 const api=createImChannelsApi(async(_endpoint,payload)=>{sent.push(payload as Record<string,unknown>);return summary({enabled:true,status:{connected:true}})},store.journal)
 await api.enable('telegram')
 assert.deepEqual(Object.keys(sent[0]!).sort(),['channelId','requestId'])
 assert.equal(store.writes.length,1);assert.equal(store.raw,null)
})

test('可纠正错误（teloa/invalid-input）清 journal；非可纠正错误保留待核对，recover 重放同一 requestId',async()=>{
 const denied=memory()
 const api=createImChannelsApi(async()=>{throw Object.assign(Error('denied'),{rejected:true,code:'teloa/invalid-input'})},denied.journal)
 await assert.rejects(api.disable('telegram'),/denied/)
 assert.equal(denied.raw,null);assert.equal(api.pending(),undefined)

 const lost=memory(),sent:Record<string,unknown>[]=[]
 const first=createImChannelsApi(async(_endpoint,payload)=>{sent.push(payload as Record<string,unknown>);throw Error('offline')},lost.journal)
 await assert.rejects(first.enable('telegram'),/offline/)
 assert.ok(lost.raw);assert.ok(first.pending())
 await assert.rejects(first.disable('telegram'),/未完成/,'有待核对请求时不另发新请求')
 const second=createImChannelsApi(async(endpoint,payload)=>{assert.equal(endpoint,'im/channels/enable');sent.push(payload as Record<string,unknown>);return summary({enabled:true})},lost.journal)
 assert.ok(second.pending())
 await second.recover()
 assert.equal(sent[1]!.requestId,sent[0]!.requestId)
 assert.equal(lost.raw,null)
})

test('损坏的恢复记录给出 recoveryMessage，discard 后可继续',async()=>{
 const store=memory();store.journal.write('{broken')
 const api=createImChannelsApi(async()=>summary(),store.journal)
 assert.ok(api.recoveryMessage())
 await assert.rejects(api.enable('telegram'))
 assert.equal(api.discard(),true)
 assert.equal(api.recoveryMessage(),undefined)
 await api.enable('telegram')
})

test('配对、绑定与群绑定：payload 键集与回包校验',async()=>{
 const store=memory(),sent:{endpoint:string;payload:Record<string,unknown>}[]=[]
 const replies:Record<string,unknown>={
  'im/pairing/create':{code:'123456',expiresAt:'2026-09-26T00:10:00.000Z'},
  'im/bindings/change':{channelId:'telegram',imUserId:'u1',displayName:'小王',boundAt:'2026-09-26T00:00:00.000Z',target:{kind:'role',roleId}},
  'im/bindings/remove':{removed:true},
  'im/groups/bind':{channelId:'telegram',chatId:'-100',groupId,boundAt:'2026-09-26T00:00:00.000Z'},
  'im/groups/unbind':{removed:true},
  'im/channels/remove':{removed:true},
 }
 const api=createImChannelsApi(async(endpoint,payload)=>{sent.push({endpoint,payload:payload as Record<string,unknown>});return replies[endpoint]},store.journal)
 assert.deepEqual(await api.createPairing('telegram'),{code:'123456',expiresAt:'2026-09-26T00:10:00.000Z'})
 assert.equal((await api.changeTarget('telegram','u1',{kind:'role',roleId})).target.kind,'role')
 await api.removeBinding('telegram','u1')
 assert.equal((await api.bindGroup('telegram','-100',groupId)).groupId,groupId)
 await api.unbindGroup('telegram','-100')
 await api.remove('telegram')
 assert.deepEqual(sent.map(row=>[row.endpoint,Object.keys(row.payload).sort().join(',')]),[
  ['im/pairing/create','channelId,requestId'],
  ['im/bindings/change','channelId,imUserId,requestId,target'],
  ['im/bindings/remove','channelId,imUserId,requestId'],
  ['im/groups/bind','channelId,chatId,groupId,requestId'],
  ['im/groups/unbind','channelId,chatId,requestId'],
  ['im/channels/remove','channelId,requestId'],
 ])
 assert.equal(store.raw,null)
 const badCode=createImChannelsApi(async()=>({code:'12ab',expiresAt:'2026-09-26T00:10:00.000Z'}),memory().journal)
 await assert.rejects(badCode.createPairing('telegram'))
})
