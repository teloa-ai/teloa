import test from 'node:test'
import assert from 'node:assert/strict'
import {credentialKey} from '@deepseek-ai/dsh-credentials'
import {CredentialStoreLocked} from '../src/credentials/store-state.ts'
import {createOwnedSkillSecrets,createOwnedSkillRequest} from '../src/owned-skill-secrets.ts'
import type {SkillSecretCredentialPort} from '../src/skill-secrets.ts'

const identity={owner:'owner-A',installationId:'installation-A',bundleHash:'a'.repeat(64),contentHash:'b'.repeat(64),bodyHash:'c'.repeat(64),version:'1.0.0'}
const validRequest=()=>createOwnedSkillRequest(new AbortController().signal,peer,()=>peer)
const peer={}
const declaration=[{envVarName:'SKILL_API_KEY',label:{'zh-CN':'API 密钥',en:'API key'},required:true,target:'bearer',endpoints:[{origin:'https://api.example.com',pathPrefixes:['/v1/']}],methods:['GET']}]
function fixture(){
 let current:typeof identity|undefined={...identity},record:any,queued:(()=>void)|undefined,currentHook:(()=>void)|undefined,afterMutation:(()=>void)|undefined
 const events:unknown[]=[],credentials={readRecord:async()=>structuredClone(record),describeRecord:async()=>({configured:!!record,writable:true}),modifyRecord:async(_key:unknown,mutate:any)=>{queued?.();queued=undefined;record=await mutate(structuredClone(record));afterMutation?.();afterMutation=undefined},deleteRecord:async()=>{record=undefined}}
 const store=createOwnedSkillSecrets({owner:identity.owner,credentials:credentials as never,current:async()=>{const hook=currentHook;currentHook=undefined;hook?.();return current},audit:event=>events.push(event)})
 return {store,events,record:()=>record,change:(v:typeof identity|undefined)=>{current=v},duringWrite:(fn:()=>void)=>{queued=fn},afterCurrent:(fn:()=>void)=>{currentHook=fn},afterCommit:(fn:()=>void)=>{afterMutation=fn}}
}
async function authorize(f:ReturnType<typeof fixture>){const s=await f.store.describe('own-skill');assert(s?.owner);return f.store.authorize({skill:'own-skill',expectedInstallation:s.owner.installation,expectedBinding:s.binding,secrets:declaration,confirmed:true},validRequest())}

test('本人明确授权固定安装后，复用save/遮罩/readForUse/删除；公开回包与审计不含值',async()=>{
 const f=fixture(),initial=await f.store.describe('own-skill');assert.equal(initial?.owner.authorized,false)
 const granted=await authorize(f);assert(granted?.binding);assert.equal(granted.vars[0]?.configured,false)
 const saved=await f.store.save({skill:'own-skill',expectedBinding:granted.binding,values:{SKILL_API_KEY:'synthetic-owner-value-123'}},validRequest())
 assert.equal(saved?.vars[0]?.configured,true);assert.doesNotMatch(JSON.stringify([saved,f.events]),/synthetic-owner-value/)
 assert.deepEqual((await f.store.readForUse('own-skill')).values,{SKILL_API_KEY:'synthetic-owner-value-123'})
 const removed=await f.store.remove({skill:'own-skill',expectedInstallation:granted.owner.installation,expectedBinding:granted.binding,confirmed:true},validRequest());assert.equal(removed?.owner.authorized,true);assert.equal(removed.vars[0]?.configured,false)
})
test('没有可信当前非目录安装、缺明示确认及非法目标均不授予',async()=>{
 const f=fixture(),s=await f.store.describe('own-skill');assert(s)
 const input={skill:'own-skill',expectedInstallation:s.owner.installation,expectedBinding:null,secrets:declaration,confirmed:true}
 await assert.rejects(f.store.authorize({...input,confirmed:false},validRequest()))
 for(const origin of ['http://api.example.com','https://localhost','https://127.0.0.1','https://api.example.com:443','https://user:pass@api.example.com'])await assert.rejects(f.store.authorize({...input,secrets:[{...declaration[0],endpoints:[{origin,pathPrefixes:['/v1/']}]}]},validRequest()))
 await assert.rejects(f.store.authorize({...input,secrets:[{...declaration[0],envVarName:'TELOA_OWNER_SKILL_POLICY'}]},validRequest()))
 assert.equal(f.record(),undefined);f.change(undefined);assert.equal(await f.store.describe('own-skill'),undefined);await assert.rejects(f.store.authorize(input,validRequest()))
})
test('排队期间换owner/安装/版本则旧保存拒绝，不把旧值串给新代码',async()=>{
 for(const change of [{...identity,owner:'owner-B'},{...identity,installationId:'installation-B'},{...identity,bundleHash:'d'.repeat(64)}]){
  const f=fixture(),s=await authorize(f);assert(s?.binding);f.duringWrite(()=>f.change(change))
  await assert.rejects(f.store.save({skill:'own-skill',expectedBinding:s.binding,values:{SKILL_API_KEY:'synthetic-owner-value-123'}},validRequest()))
  if(change.owner!==identity.owner)await assert.rejects(f.store.resolve('own-skill'));else assert.equal(await f.store.resolve('own-skill'),undefined);assert.doesNotMatch(JSON.stringify(f.record()),/synthetic-owner-value/)
 }
})
test('撤销同时清授权和值；同安装再次授权也使旧页面nonce失效',async()=>{
 const f=fixture(),s=await authorize(f);assert(s?.binding)
 await f.store.save({skill:'own-skill',expectedBinding:s.binding,values:{SKILL_API_KEY:'synthetic-owner-value-123'}},validRequest())
 const revoked=await f.store.revoke({skill:'own-skill',expectedInstallation:s.owner.installation,expectedBinding:s.binding,confirmed:true},validRequest())
 assert.equal(revoked?.owner.authorized,false);assert.deepEqual(f.record().env,{});assert.equal(await f.store.resolve('own-skill'),undefined)
 const next=await authorize(f);assert(next?.binding);assert.notEqual(next.binding,s.binding)
 await assert.rejects(f.store.save({skill:'own-skill',expectedBinding:s.binding,values:{SKILL_API_KEY:'synthetic-owner-value-123'}},validRequest()))
 assert.equal(next.vars[0]?.configured,false)
})


test('非浏览器peer起始即拒；authorize/save/delete/revoke排队及异步身份核验期间租约失效不写不审计',async()=>{
 assert.throws(()=>createOwnedSkillRequest(new AbortController().signal,undefined,()=>undefined),{code:'teloa/forbidden'})
  for(const kind of ['authorize','save','remove','revoke'] as const)for(const phase of ['queued','after-current']){
  const f=fixture();if(kind!=='authorize')await authorize(f)
  const state=await f.store.describe('own-skill');assert(state)
  let currentPeer:unknown=peer
  const request=createOwnedSkillRequest(new AbortController().signal,peer,()=>currentPeer)
  const invalidate=()=>{currentPeer={}}
  f.duringWrite(()=>{if(phase==='queued')invalidate();else f.afterCurrent(invalidate)})
  const before=JSON.stringify(f.record()),audit=f.events.length
  const action=kind==='authorize'?f.store.authorize({skill:'own-skill',expectedInstallation:state.owner.installation,expectedBinding:state.binding,secrets:declaration,confirmed:true},request):kind==='save'?f.store.save({skill:'own-skill',expectedBinding:state.binding,values:{SKILL_API_KEY:'synthetic-owner-value-123'}},request):f.store[kind]({skill:'own-skill',expectedInstallation:state.owner.installation,expectedBinding:state.binding,confirmed:true},request)
  await assert.rejects(action,{code:'teloa/forbidden'})
  assert.equal(JSON.stringify(f.record()),before,kind+' '+phase);assert.equal(f.events.length,audit)
 }
})
test('signal在provider排队时取消不提交；逻辑提交后取消保留已接受回执而不回滚或重做',async()=>{
 const f=fixture(),state=await f.store.describe('own-skill');assert(state)
 const controller=new AbortController(),request=createOwnedSkillRequest(controller.signal,peer,()=>peer)
 f.duringWrite(()=>controller.abort())
 await assert.rejects(f.store.authorize({skill:'own-skill',expectedInstallation:state.owner.installation,expectedBinding:null,secrets:declaration,confirmed:true},request),{name:'AbortError'})
 assert.equal(f.record(),undefined)
 const committed=new AbortController();f.afterCommit(()=>committed.abort())
 const accepted=await f.store.authorize({skill:'own-skill',expectedInstallation:state.owner.installation,expectedBinding:null,secrets:declaration,confirmed:true},createOwnedSkillRequest(committed.signal,peer,()=>peer))
 assert.equal(accepted?.owner.authorized,true);assert.equal(f.events.length,1)
})
test('锁定describe不读取记录且状态是未知授权；读侧锁定沿用稳定storage-unavailable语义',async()=>{
 let reads=0
 const credentials={describeRecord:async()=>({configured:true,writable:false}),readRecord:async()=>{reads++;throw Error('should not read')},modifyRecord:async()=>{throw Error('not writable')},deleteRecord:async()=>{}}
 const store=createOwnedSkillSecrets({owner:identity.owner,credentials:credentials as never,current:async()=>identity,audit:()=>{}})
 const state=await store.describe('own-skill');assert.equal(state?.writable,false);assert.equal(state.owner.authorized,null);assert.equal(reads,0)
 const error=new CredentialStoreLocked('key-unavailable')
 const locked=createOwnedSkillSecrets({owner:identity.owner,credentials:{...credentials,readRecord:async()=>{throw error}} as never,current:async()=>identity,audit:()=>{}})
 await assert.rejects(locked.readForUse('own-skill'),{code:'teloa/storage-unavailable'})
})

function keyedFixture(){
 type Key=Parameters<SkillSecretCredentialPort['readRecord']>[0]
 type RecordValue=NonNullable<Awaited<ReturnType<SkillSecretCredentialPort['readRecord']>>>
 const records=new Map<Key,RecordValue>()
 const credentials:SkillSecretCredentialPort={
  readRecord:async key=>structuredClone(records.get(key)),
  describeRecord:async key=>({configured:records.has(key),writable:true}),
  modifyRecord:async(key,mutate)=>{const next=await mutate(structuredClone(records.get(key)));if(next!==undefined)records.set(key,structuredClone(next));return structuredClone(records.get(key))},
  deleteRecord:async key=>{records.delete(key)},
 }
 const store=(owner:string)=>createOwnedSkillSecrets({owner,credentials,current:async()=>({...identity,owner}),audit:()=>{}})
 return {records,store}
}
async function grantKeyed(store:ReturnType<ReturnType<typeof keyedFixture>['store']>,skill:string){
 const initial=await store.describe(skill);assert(initial)
 const granted=await store.authorize({skill,expectedInstallation:initial.owner.installation,expectedBinding:initial.binding,secrets:declaration,confirmed:true},validRequest())
 assert(granted?.binding);return granted
}
test('真实SDK拒绝原数字摘要；正常本人技能可描述、授权、保存、读取及撤回',async()=>{
 const digest='87a3794c2fa1048db01093076d06c0f769c1e99153f012b48ba9da56703e7d1e'
 assert.throws(()=>credentialKey('teloa-owned-skill',digest),TypeError)
 const expected=credentialKey('teloa-owned-skill','s-'+digest),f=keyedFixture(),store=f.store('local:teloa-owner'),skill='f17-owner-consent-probe'
 assert.equal((await store.describe(skill))?.owner.authorized,false)
 const granted=await grantKeyed(store,skill)
 await store.save({skill,expectedBinding:granted.binding,values:{SKILL_API_KEY:'synthetic-digit-owner-value'}},validRequest())
 assert.deepEqual([...f.records.keys()],[expected])
 assert.deepEqual((await store.readForUse(skill)).values,{SKILL_API_KEY:'synthetic-digit-owner-value'})
 const revoked=await store.revoke({skill,expectedInstallation:granted.owner.installation,expectedBinding:granted.binding,confirmed:true},validRequest())
 assert.equal(revoked?.owner.authorized,false);assert.equal(await store.resolve(skill),undefined)
 await assert.rejects(store.readForUse(skill),{code:'teloa/version-conflict'})
 const record=f.records.get(expected);assert(record?.kind==='api-key');assert.deepEqual(record.env,{})
})
test('原字母摘要地址逐字保留；共享存储的不同owner或skill不串读、保存或撤回',async()=>{
 const legacy=credentialKey('teloa-owned-skill','abb67f4bdd3f2c1a3dbf4387691974541415360152ef76d559b7939e7f97e0d5')
 const f=keyedFixture(),a=f.store('owner-A'),b=f.store('owner-B'),skill='own-skill',other='other-skill'
 const ga=await grantKeyed(a,skill)
 await a.save({skill,expectedBinding:ga.binding,values:{SKILL_API_KEY:'synthetic-legacy-owner-a'}},validRequest())
 assert.deepEqual([...f.records.keys()],[legacy])
 assert.deepEqual((await f.store('owner-A').readForUse(skill)).values,{SKILL_API_KEY:'synthetic-legacy-owner-a'})
 assert.equal((await b.describe(skill))?.owner.authorized,false);assert.equal(await b.resolve(skill),undefined)
 await assert.rejects(b.readForUse(skill),{code:'teloa/version-conflict'})
 const gb=await grantKeyed(b,skill),go=await grantKeyed(a,other)
 await b.save({skill,expectedBinding:gb.binding,values:{SKILL_API_KEY:'synthetic-other-owner-b'}},validRequest())
 await a.save({skill:other,expectedBinding:go.binding,values:{SKILL_API_KEY:'synthetic-other-skill-a'}},validRequest())
 assert.equal(f.records.size,3)
 const beforeOther=[...f.records].filter(([key])=>key!==legacy)
 await a.revoke({skill,expectedInstallation:ga.owner.installation,expectedBinding:ga.binding,confirmed:true},validRequest())
 assert.deepEqual([...f.records].filter(([key])=>key!==legacy),beforeOther)
 assert.deepEqual((await b.readForUse(skill)).values,{SKILL_API_KEY:'synthetic-other-owner-b'})
 assert.deepEqual((await a.readForUse(other)).values,{SKILL_API_KEY:'synthetic-other-skill-a'})
})
