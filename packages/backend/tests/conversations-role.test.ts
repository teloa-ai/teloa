import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DigitalRole } from '@teloa/contract'
import { ConversationService, FileConversationRepository, type SessionHost } from '../src/work/conversations.ts'

const owner='local:teloa-owner'
const otherOwner='local:teloa-someone-else'

function role(id:string,fields:Partial<DigitalRole>={}):DigitalRole {
  return {
    id,ownerId:owner,name:'岗位',kind:'employee',scopes:['general'],
    duty:'职责说明',dataScope:'资料范围',executionScope:'执行范围',skills:[],knowledge:[],
    version:1,state:'active',createdAt:'2026-09-10T10:00:00.000Z',updatedAt:'2026-09-10T10:00:00.000Z',
    ...fields,
  }
}

async function fixture() {
  const path=join(await mkdtemp(join(tmpdir(),'teloa-bindings-role-')),'conversations.json')
  const calls:unknown[][]=[]
  const existing=new Set<string>()
  const host:SessionHost={
    async create(sessionId,workspaceId,agentPresetId,signal) {
      calls.push([sessionId,workspaceId,agentPresetId,signal])
      const id='host-'+sessionId;existing.add(id);return id
    },
    async inspect(sessionId) {if(!existing.has(sessionId))throw Error('不存在的原生会话')},
  }
  let counter=0
  const identity={id:()=>`identity-${++counter}`,now:()=>'2026-09-10T10:00:00.000Z'}
  const repository=new FileConversationRepository(path)
  const roles=new Map<string,DigitalRole>()
  const readRole=async(_owner:string,roleId:string)=>roles.get(roleId)
  const service=new ConversationService(repository,host,identity,readRole)
  return {path,calls,host,identity,repository,roles,readRole,service}
}

test('不带 roleId 时行为与今天逐字一致（host.create 第三参为 undefined）',async()=>{
  const f=await fixture()
  await f.service.create(owner,{requestId:randomUUID(),title:'新工作会话'})
  assert.deepEqual(f.calls.at(-1)?.slice(2,3),[undefined])
})

test('带 roleId 时把该岗位的 agentPresetId 传给 host.create',async()=>{
  const f=await fixture()
  const roleId=randomUUID()
  f.roles.set(roleId,role(roleId,{runtimeConfig:{agentPresetId:'teloa-standard'}}))
  await f.service.create(owner,{requestId:randomUUID(),title:'找它说话',roleId})
  assert.deepEqual(f.calls.at(-1)?.slice(2,3),['teloa-standard'])
})

test('岗位没有固定运行配置时仍传 undefined，不报错',async()=>{
  const f=await fixture()
  const roleId=randomUUID()
  f.roles.set(roleId,role(roleId))
  await assert.doesNotReject(()=>f.service.create(owner,{requestId:randomUUID(),title:'x',roleId}))
  assert.deepEqual(f.calls.at(-1)?.slice(2,3),[undefined])
})

test('已退休岗位判 forbidden，暂停岗位放行，非本人岗位判 forbidden，不存在岗位判 forbidden',async()=>{
  const f=await fixture()
  const retiredRole=randomUUID(),pausedRole=randomUUID(),otherOwnerRole=randomUUID(),missingRole=randomUUID()
  f.roles.set(retiredRole,role(retiredRole,{state:'retired'}))
  f.roles.set(pausedRole,role(pausedRole,{state:'paused'}))
  f.roles.set(otherOwnerRole,role(otherOwnerRole,{ownerId:otherOwner}))
  await assert.rejects(()=>f.service.create(owner,{requestId:randomUUID(),title:'x',roleId:retiredRole}),{code:'teloa/forbidden'})
  await assert.doesNotReject(()=>f.service.create(owner,{requestId:randomUUID(),title:'x',roleId:pausedRole}))
  await assert.rejects(()=>f.service.create(owner,{requestId:randomUUID(),title:'x',roleId:otherOwnerRole}),{code:'teloa/forbidden'})
  await assert.rejects(()=>f.service.create(owner,{requestId:randomUUID(),title:'x',roleId:missingRole}),{code:'teloa/forbidden'})
})

test('readRole 端口未接线却传了 roleId 判 dependency-unavailable（判不出来就拒），不传则照常',async()=>{
  const f=await fixture()
  const roleId=randomUUID()
  f.roles.set(roleId,role(roleId,{runtimeConfig:{agentPresetId:'teloa-standard'}}))
  const bare=new ConversationService(f.repository,f.host,f.identity)
  await assert.rejects(()=>bare.create(owner,{requestId:randomUUID(),title:'x',roleId}),{code:'teloa/dependency-unavailable'})
  await assert.doesNotReject(()=>bare.create(owner,{requestId:randomUUID(),title:'x'}))
})

test('同一 requestId 换岗位判冲突；未知键与非 uuid 判 invalid-input',async()=>{
  const f=await fixture()
  const roleA=randomUUID(),roleB=randomUUID(),requestId=randomUUID()
  f.roles.set(roleA,role(roleA))
  f.roles.set(roleB,role(roleB))
  await f.service.create(owner,{requestId,title:'x',roleId:roleA})
  await assert.rejects(()=>f.service.create(owner,{requestId,title:'x',roleId:roleB}),{code:'teloa/conflict'})
  await assert.rejects(()=>f.service.create(owner,{requestId:randomUUID(),title:'x',roleId:'不是uuid'}),{code:'teloa/invalid-input'})
  await assert.rejects(()=>f.service.create(owner,{requestId:randomUUID(),title:'x',presetId:'p'}),{code:'teloa/invalid-input'})
})

test('从无到有换岗位同样判冲突（H1 方向），两次都不带 roleId 不冲突（回归：老行缺键视为 undefined）',async()=>{
  const f=await fixture()
  const roleId=randomUUID(),requestNoToYes=randomUUID(),requestSame=randomUUID()
  f.roles.set(roleId,role(roleId))
  await f.service.create(owner,{requestId:requestNoToYes,title:'x'})
  await assert.rejects(()=>f.service.create(owner,{requestId:requestNoToYes,title:'x',roleId}),{code:'teloa/conflict'})
  // 老行没有 requestedRoleId 这个键时视为 undefined：重复同一个「不带 roleId」的请求不得判冲突。
  await f.service.create(owner,{requestId:requestSame,title:'x'})
  await assert.doesNotReject(()=>f.service.create(owner,{requestId:requestSame,title:'x'}))
})

test('从有到无换岗位判冲突（A→undefined 方向）',async()=>{
  const f=await fixture()
  const roleId=randomUUID(),requestId=randomUUID()
  f.roles.set(roleId,role(roleId))
  await f.service.create(owner,{requestId,title:'x',roleId})
  await assert.rejects(()=>f.service.create(owner,{requestId,title:'x'}),{code:'teloa/conflict'})
})

test('重启（新建服务实例读同一份存储文件）后同 requestId 换岗位仍判冲突',async()=>{
  const f=await fixture()
  const roleA=randomUUID(),roleB=randomUUID(),requestId=randomUUID()
  f.roles.set(roleA,role(roleA));f.roles.set(roleB,role(roleB))
  await f.service.create(owner,{requestId,title:'x',roleId:roleA})
  const restarted=new ConversationService(new FileConversationRepository(f.path),f.host,f.identity,f.readRole)
  await assert.rejects(()=>restarted.create(owner,{requestId,title:'x',roleId:roleB}),{code:'teloa/conflict'})
  // 同一份存储里换回原岗位则不冲突，证明比对确实来自落盘的 requestedRoleId，不是巧合拒绝一切。
  await assert.doesNotReject(()=>restarted.create(owner,{requestId,title:'x',roleId:roleA}))
})

test('普通会话回包零新键（行守卫未被放宽），requestedRoleId 不出现在回包里',async()=>{
  const f=await fixture()
  const roleId=randomUUID()
  f.roles.set(roleId,role(roleId,{runtimeConfig:{agentPresetId:'teloa-standard'}}))
  const row=await f.service.create(owner,{requestId:randomUUID(),title:'x',roleId})
  assert.equal((row as Record<string,unknown>).roleId,undefined)
  assert.equal((row as Record<string,unknown>).requestedRoleId,undefined)
  assert.equal((row as Record<string,unknown>).purpose,undefined)
  assert.equal((row as Record<string,unknown>).run,undefined)
  assert.deepEqual(Object.keys(row).sort(),['createdAt','id','ownerId','requestId','requestedSessionId','scopeIds','sessionId','status','title','version'])
})

test('内部岗位请求指纹按本人会话现读，冷重启保留；公共回包仍不暴露',async()=>{
  const f=await fixture(),roleId=randomUUID()
  f.roles.set(roleId,role(roleId))
  const linked=await f.service.create(owner,{requestId:randomUUID(),title:'岗位会话',roleId})
  const general=await f.service.create(owner,{requestId:randomUUID(),title:'普通会话'})
  assert.equal(await f.service.requestedRoleId(owner,linked.sessionId),roleId)
  assert.equal(await f.service.requestedRoleId(owner,general.sessionId),null)
  await assert.rejects(()=>f.service.requestedRoleId(otherOwner,linked.sessionId),{code:'teloa/forbidden'})
  const restarted=new ConversationService(new FileConversationRepository(f.path),f.host,f.identity,f.readRole)
  assert.equal(await restarted.requestedRoleId(owner,linked.sessionId),roleId)
  assert.equal('requestedRoleId' in await restarted.bySession(owner,linked.sessionId),false)
})
