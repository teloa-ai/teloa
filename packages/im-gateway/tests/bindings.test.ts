import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createBindingStore} from '../src/core/bindings.ts'
import {createChannelConfigStore} from '../src/core/channels-config.ts'

async function withTemp(run:(dir:string)=>Promise<void>):Promise<void>{
 const root=await mkdtemp(join(tmpdir(),'teloa-im-bindings-'))
 try{await run(join(root,'im-gateway'))}finally{await rm(root,{recursive:true,force:true})}
}

const now=()=>new Date('2026-09-26T00:00:00Z')
const row=(imUserId='u1',channelId='telegram')=>({channelId,imUserId,ownerId:'local:teloa-owner',displayName:'Max'})

test('bind 写 im-bindings.json：boundAt 取时钟、target 默认 assistant；find／list 按渠道过滤',()=>withTemp(async dir=>{
 const store=createBindingStore(dir,{perChannel:1},now)
 const bound=await store.bind(row())
 assert.deepEqual(bound,{...row(),boundAt:'2026-09-26T00:00:00.000Z',target:{kind:'assistant'}})
 await store.bind(row('u9','slack'))
 assert.deepEqual(await store.find('telegram','u1'),bound)
 assert.equal(await store.find('telegram','u9'),undefined)
 assert.deepEqual((await store.list('slack')).map(b=>b.imUserId),['u9'])
 assert.equal((await store.list()).length,2)
 const disk=JSON.parse(await readFile(join(dir,'im-bindings.json'),'utf8')) as {bindings:unknown[]}
 assert.equal(disk.bindings.length,2)
}))

test('7. 同主键重复 → teloa/conflict；第二位用户（perChannel=1）→ teloa/forbidden；remove 不存在 → teloa/not-found',()=>withTemp(async dir=>{
 const store=createBindingStore(dir,{perChannel:1},now)
 await store.bind(row())
 await assert.rejects(store.bind(row()),{code:'teloa/conflict'})
 await assert.rejects(store.bind(row('u2')),{code:'teloa/forbidden'})
 await assert.rejects(store.remove('telegram','u2'),{code:'teloa/not-found'})
 await store.remove('telegram','u1')
 assert.deepEqual(await store.list(),[])
 await store.bind(row('u2'))
 assert.deepEqual((await store.list()).map(b=>b.imUserId),['u2'])
}))

test('change：改 target／会话 id；不存在 → teloa/not-found',()=>withTemp(async dir=>{
 const store=createBindingStore(dir,{perChannel:1},now)
 await store.bind(row())
 const changed=await store.change('telegram','u1',{target:{kind:'role',roleId:'r1'},roleSessionIds:{r1:'s1'}})
 assert.deepEqual(changed.target,{kind:'role',roleId:'r1'})
 assert.deepEqual((await store.find('telegram','u1'))!.roleSessionIds,{r1:'s1'})
 await store.change('telegram','u1',{assistantSessionId:'s0'})
 assert.equal((await store.find('telegram','u1'))!.assistantSessionId,'s0')
 await assert.rejects(store.change('telegram','nobody',{assistantSessionId:'x'}),{code:'teloa/not-found'})
}))

test('8. groups.bind：同 chat 重复或同 groupId 绑第二个 chat → teloa/conflict；unbind 后可重绑；byChat',()=>withTemp(async dir=>{
 const store=createBindingStore(dir,{perChannel:1},now)
 const g=await store.groups.bind({channelId:'slack',chatId:'C1',groupId:'g1'})
 assert.deepEqual(g,{channelId:'slack',chatId:'C1',groupId:'g1',boundAt:'2026-09-26T00:00:00.000Z'})
 await assert.rejects(store.groups.bind({channelId:'slack',chatId:'C1',groupId:'g2'}),{code:'teloa/conflict'})
 await assert.rejects(store.groups.bind({channelId:'slack',chatId:'C2',groupId:'g1'}),{code:'teloa/conflict'})
 await assert.rejects(store.groups.bind({channelId:'telegram',chatId:'-100',groupId:'g1'}),{code:'teloa/conflict'})
 assert.deepEqual(await store.groups.byChat('slack','C1'),g)
 assert.equal(await store.groups.byChat('slack','C2'),undefined)
 await assert.rejects(store.groups.unbind('slack','C9'),{code:'teloa/not-found'})
 await store.groups.unbind('slack','C1')
 assert.deepEqual(await store.groups.list(),[])
 await store.groups.bind({channelId:'slack',chatId:'C2',groupId:'g1'})
 assert.deepEqual((await store.groups.list('slack')).map(x=>x.chatId),['C2'])
 assert.deepEqual(await store.groups.list('telegram'),[])
}))

test('10. 文件权限：im-bindings.json 与 im-groups.json 0o600，目录 0o700',()=>withTemp(async dir=>{
 const store=createBindingStore(dir,{perChannel:1},now)
 await store.bind(row())
 await store.groups.bind({channelId:'slack',chatId:'C1',groupId:'g1'})
 assert.equal((await stat(join(dir,'im-bindings.json'))).mode&0o777,0o600)
 assert.equal((await stat(join(dir,'im-groups.json'))).mode&0o777,0o600)
 assert.equal((await stat(dir)).mode&0o777,0o700)
}))

test('新实例从磁盘读回；文件结构不符 → teloa/storage-corrupt，不静默当空',()=>withTemp(async dir=>{
 await createBindingStore(dir,{perChannel:1},now).bind(row())
 assert.equal((await createBindingStore(dir,{perChannel:1},now).list()).length,1)
 await writeFile(join(dir,'im-bindings.json'),JSON.stringify({bindings:[{channelId:'telegram'}]}))
 await assert.rejects(createBindingStore(dir,{perChannel:1},now).list(),{code:'teloa/storage-corrupt'})
 await writeFile(join(dir,'im-groups.json'),JSON.stringify({groups:'x'}))
 await assert.rejects(createBindingStore(dir,{perChannel:1},now).groups.list(),{code:'teloa/storage-corrupt'})
}))

test('渠道配置 channels.json：upsert 新增与覆盖、list、remove（不存在时无操作）；0o600；kind 不合法 → storage-corrupt',()=>withTemp(async dir=>{
 const store=createChannelConfigStore(dir)
 assert.deepEqual(await store.list(),[])
 await store.upsert({channelId:'telegram',kind:'telegram',enabled:true,createdAt:'2026-09-26T00:00:00.000Z'})
 await store.upsert({channelId:'slack',kind:'slack',enabled:true,createdAt:'2026-09-26T00:00:01.000Z'})
 await store.upsert({channelId:'telegram',kind:'telegram',enabled:false,createdAt:'2026-09-26T00:00:00.000Z'})
 assert.deepEqual(await store.list(),[
  {channelId:'telegram',kind:'telegram',enabled:false,createdAt:'2026-09-26T00:00:00.000Z'},
  {channelId:'slack',kind:'slack',enabled:true,createdAt:'2026-09-26T00:00:01.000Z'},
 ])
 await store.remove('slack')
 await store.remove('slack')
 assert.deepEqual((await store.list()).map(c=>c.channelId),['telegram'])
 assert.equal((await stat(join(dir,'channels.json'))).mode&0o777,0o600)
 await writeFile(join(dir,'channels.json'),JSON.stringify({channels:[{channelId:'x',kind:'wechat',enabled:true,createdAt:'t'}]}))
 await assert.rejects(createChannelConfigStore(dir).list(),{code:'teloa/storage-corrupt'})
}))

test('I1. bind 可存私聊 chatId 并从磁盘读回；旧记录缺 chatId 照常读；chatId 类型不符 → storage-corrupt',()=>withTemp(async dir=>{
 const store=createBindingStore(dir,{perChannel:2},now)
 await store.bind({...row(),chatId:'100'})
 assert.equal((await createBindingStore(dir,{perChannel:2},now).find('telegram','u1'))!.chatId,'100')
 await writeFile(join(dir,'im-bindings.json'),JSON.stringify({bindings:[{...row(),boundAt:'2026-09-26T00:00:00.000Z',target:{kind:'assistant'}}]}))
 assert.equal((await store.find('telegram','u1'))!.chatId,undefined)
 await writeFile(join(dir,'im-bindings.json'),JSON.stringify({bindings:[{...row(),boundAt:'2026-09-26T00:00:00.000Z',target:{kind:'assistant'},chatId:100}]}))
 await assert.rejects(store.find('telegram','u1'),{code:'teloa/storage-corrupt'})
}))
