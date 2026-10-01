import test from 'node:test'
import assert from 'node:assert/strict'
import {randomBytes} from 'node:crypto'
import {readInstalledSkillBinding} from '@teloa/backend'
import type {MarketCatalogSkillSecret} from '@teloa/contract'
import {createManagedAvailabilitySync} from '../src/managed-skill-availability-sync.ts'
import {memoryCredentialPort} from '../src/managed-mcp-credentials.ts'
import {createSkillSecretStore,declaredSkillSecretsResolver,skillSecretBinding,skillSecretKey} from '../src/skill-secrets.ts'
import {createSkillSecretsApi} from '../../client/ui-workbench/src/client/skill-secrets-api.ts'

const declaration:MarketCatalogSkillSecret={envVarName:'REVIEW_API_KEY',label:{'zh-CN':'测试密钥',en:'Test key'},required:true,target:'header',name:'X-Key',endpoints:[{origin:'https://old.example.com',pathPrefixes:['/v1/']}],methods:['POST']}
const fakeValue=()=>randomBytes(24).toString('hex')
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done});return {promise,resolve}}

test('M-1：来源查询与胜出者核对共享维护队列，期间切到非目录/另一目录安装不能串绑',async()=>{
 for(const nextOrigin of [{kind:'github'},{kind:'catalog',entryId:'catalog.b'}]){
  let selected='a',selectionVersion=1,hold=true
  const entered=deferred(),release=deferred(),events:string[]=[]
  const sync=createManagedAvailabilitySync({deny:()=>events.push('deny'),read:async()=>selected,replace:()=>events.push('replaced')})
  const db={query:async(sql:string,args:unknown[])=>{
   if(sql.startsWith('select i.source'))return {rows:[{source:{kind:'atomic',contentId:selected}}]}
   assert.ok(sql.startsWith('select source'))
   if(hold){hold=false;entered.resolve();await release.promise}
   return {rows:[{source:args[1]==='a'?{kind:'catalog',entryId:'catalog.a'}:nextOrigin}]}
  }}
  const b={...declaration,endpoints:[{origin:'https://new.example.com',pathPrefixes:['/v2/']}]}
  const resolve=declaredSkillSecretsResolver({skillEntryIdsByName:()=>['catalog.a','catalog.b'],getSkillSecretsByEntry:id=>[id==='catalog.a'?declaration:b],getSkillSecretMetaByEntry:()=>({}),skillSecretGroupMembers:()=>[]},name=>readInstalledSkillBinding(db as never,'review-owner',name),async()=>{events.push(`winner:${selected}:${selectionVersion}`);return true},sync.stable)
  const reading=resolve('review-skill')
  await entered.promise
  const changing=sync.change(async()=>{selected='b';selectionVersion++;events.push('change')})
  await Promise.resolve();assert.equal(selected,'a','等待中的维护不能在绑定与胜出者之间提交')
  release.resolve()
  assert.deepEqual(await reading,{secrets:[declaration]})
  await changing
  assert.deepEqual(events,['winner:a:1','deny','change','replaced'])
  assert.deepEqual(await resolve('review-skill'),nextOrigin.kind==='catalog'?{secrets:[b]}:undefined)
 }
})

test('M-2：页面指纹过期拒绝且不写；刷新后重新提交才确认新目标',async()=>{
 let current=[declaration]
 const port=memoryCredentialPort(),audit:unknown[]=[],api=createSkillSecretStore(port,async()=>current.length?{secrets:current}:undefined,event=>audit.push(event))
 const shown=await api.describe('review-skill'),value=fakeValue()
 await api.save({skill:'review-skill',expectedBinding:shown.binding,values:{REVIEW_API_KEY:value}})
 const before=await port.readRecord(skillSecretKey('review-skill'));audit.length=0
 const changes:Partial<MarketCatalogSkillSecret>[]=[
  {endpoints:[{origin:'https://new.example.com',pathPrefixes:['/v1/']}]},
  {endpoints:[{origin:'https://old.example.com',pathPrefixes:['/v2/']}]},
  {methods:['GET']},{target:'query'},{name:'Other-Key'},{required:false},
  {label:{'zh-CN':'另一用途',en:'Another purpose'}},{envVarName:'OTHER_API_KEY'},
 ]
 for(const change of changes){
  current=[{...declaration,...change}]
  await assert.rejects(api.save({skill:'review-skill',expectedBinding:shown.binding,values:{REVIEW_API_KEY:fakeValue()}}),{code:'teloa/version-conflict'})
  assert.deepEqual(await port.readRecord(skillSecretKey('review-skill')),before)
 }
 assert.deepEqual(audit,[],'被拒保存不得记成功审计')
 current=[{...declaration,endpoints:[{origin:'https://new.example.com',pathPrefixes:['/v1/']}]}]
 const refreshed=await api.describe('review-skill')
 assert.notEqual(refreshed.binding,shown.binding);assert.equal(refreshed.reconfirm,true)
 await api.save({skill:'review-skill',expectedBinding:refreshed.binding,values:{REVIEW_API_KEY:value}})
 assert.equal((await api.readForUse('review-skill')).stale,false)
 current=[]
 assert.deepEqual((await api.describe('review-skill')).binding,null)
 await assert.rejects(api.save({skill:'review-skill',expectedBinding:refreshed.binding,values:{REVIEW_API_KEY:value}}),{code:'teloa/version-conflict'})
})

test('客户端真实 API 与宿主契约贯通：旧页面被拒，重新查询后本人提交才保存',async()=>{
 let current=[declaration]
 const port=memoryCredentialPort(),store=createSkillSecretStore(port,async()=>current.length?{secrets:current}:undefined,()=>{})
 const api=createSkillSecretsApi((endpoint,payload)=>store.handle(endpoint,payload)),shown=await api.describe('review-skill'),value=fakeValue()
 current=[{...declaration,methods:['GET']}]
 await assert.rejects(api.save('review-skill',{REVIEW_API_KEY:value},shown.binding!),{code:'teloa/version-conflict'})
 assert.equal(await port.readRecord(skillSecretKey('review-skill')),undefined)
 const refreshed=await api.describe('review-skill')
 const saved=await api.save('review-skill',{REVIEW_API_KEY:value},refreshed.binding!)
 assert.equal(saved.vars[0]!.configured,true);assert.equal(saved.binding,refreshed.binding)
 assert.equal(JSON.stringify(saved).includes(value),false)
 assert.equal((await api.remove('review-skill')).vars[0]!.configured,false)
})

test('M-2：等待凭据修改期间声明变化，实际修改回调重新核对且不写入',async()=>{
 let current=[declaration]
 const port=memoryCredentialPort(),entered=deferred(),release=deferred(),events:unknown[]=[]
 const api=createSkillSecretStore({...port,modifyRecord:async(key,mutate)=>{entered.resolve();await release.promise;return port.modifyRecord(key,mutate)}},async()=>current.length?{secrets:current}:undefined,event=>events.push(event))
 const shown=await api.describe('review-skill')
 const saving=api.save({skill:'review-skill',expectedBinding:shown.binding,values:{REVIEW_API_KEY:fakeValue()}})
 const rejected=assert.rejects(saving,{code:'teloa/version-conflict'})
 await entered.promise;current=[{...declaration,methods:['GET']}];release.resolve();await rejected
 assert.equal(await port.readRecord(skillSecretKey('review-skill')),undefined);assert.deepEqual(events,[])
})

test('声明指纹严格必需、集合顺序不影响指纹',async()=>{
 const port=memoryCredentialPort(),api=createSkillSecretStore(port,async()=>({secrets:[declaration]}),()=>{})
 for(const expectedBinding of [undefined,null,'','x'.repeat(64),'a'.repeat(63),12])await assert.rejects(api.save({skill:'review-skill',expectedBinding,values:{REVIEW_API_KEY:fakeValue()}}),{code:'teloa/invalid-input'})
 const a:MarketCatalogSkillSecret={...declaration,methods:['GET','POST'],endpoints:[{origin:'https://old.example.com',pathPrefixes:['/v1/','/v2/']},{origin:'https://new.example.com',pathPrefixes:['/v3/']}]}
 const b={...a,methods:[...a.methods].reverse(),endpoints:[...a.endpoints].reverse().map(ep=>({...ep,pathPrefixes:[...ep.pathPrefixes].reverse()}))}
 assert.equal(skillSecretBinding([a]),skillSecretBinding([b]))
 assert.equal(await port.readRecord(skillSecretKey('review-skill')),undefined)
})
