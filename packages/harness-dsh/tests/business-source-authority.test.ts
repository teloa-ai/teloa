import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {OAuthFlowManager,saveTokens,clearTokens} from '../src/managed-mcp-oauth.ts'
import {memorySlotStore} from '../src/managed-mcp-credentials.ts'
const module=await import('../src/business-source-authority.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {} as typeof import('../src/business-source-authority.ts');throw error})
test('来源快照使用生产连接协调器；派发前撤销零请求，已发出旧响应拒绝',async t=>{
 assert.equal(typeof module.BusinessSourceAuthorityController,'function')
 const root=await mkdtemp(join(tmpdir(),'business-authority-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const oauth=new OAuthFlowManager({runtimeRoot:root,slots:memorySlotStore()})
 let current={bindingId:'connection',bindingRevision:1,definitionHash:'a'.repeat(64),resourceScopeHash:'b'.repeat(64),connectionEpoch:'one',scopeSupport:'unsupported' as const},connected=true,requests=0
 const controller=new module.BusinessSourceAuthorityController({exclusive:oauth.exclusive.bind(oauth),read:async()=>{if(!connected)throw Error('disconnected');return current}})
 const authority=await controller.capture('source')
 assert.equal(authority.scopeSupport,'unsupported','只读声明不能变成资源范围保证')
 await oauth.exclusive('source',async()=>{connected=false})
 await assert.rejects(controller.dispatch(authority,()=>{requests++;return Promise.resolve('old')}));assert.equal(requests,0)
 connected=true;const fresh=await controller.capture('source')
 let release!:(value:string)=>void,started!:()=>void
 const dispatched=new Promise<void>(resolve=>{started=resolve})
 const result=controller.dispatch(fresh,()=>{requests++;started();return new Promise<string>(resolve=>{release=resolve})})
 await dispatched
 await oauth.exclusive('source',async()=>{current={...current,connectionEpoch:'two'}})
 release('old-account-data');await assert.rejects(result);assert.equal(requests,1)
})
test('OAuth 等价刷新保留授权世代；缩减scope或重新授权更换世代，撤销删除世代',async()=>{
 const slots=memorySlotStore()
 await saveTokens(slots,'source',{access_token:'synthetic-first',token_type:'Bearer',scope:'read:a read:b'},'client')
 const original=(await slots.read('source')).oauth_grant_id;assert.equal(typeof original,'string')
 await saveTokens(slots,'source',{access_token:'synthetic-refresh',token_type:'Bearer',scope:'read:b read:a'},'client',Date.now,true)
 assert.equal((await slots.read('source')).oauth_grant_id,original)
 await saveTokens(slots,'source',{access_token:'synthetic-less',token_type:'Bearer',scope:'read:a'},'client',Date.now,true)
 assert.notEqual((await slots.read('source')).oauth_grant_id,original)
 const narrowed=(await slots.read('source')).oauth_grant_id
 await saveTokens(slots,'source',{access_token:'synthetic-new-account',token_type:'Bearer',scope:'read:a'},'client')
 assert.notEqual((await slots.read('source')).oauth_grant_id,narrowed)
 await clearTokens(slots,'source');assert.equal((await slots.read('source')).oauth_grant_id,undefined)
})
test('换定义或缩减授权不接收旧快照；提交与撤销串行，不能伪造快照',async t=>{
 assert.equal(typeof module.BusinessSourceAuthorityController,'function')
 const root=await mkdtemp(join(tmpdir(),'business-authority-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const oauth=new OAuthFlowManager({runtimeRoot:root,slots:memorySlotStore()})
 let current={bindingId:'connection',bindingRevision:1,definitionHash:'a'.repeat(64),resourceScopeHash:'b'.repeat(64),connectionEpoch:'same-grant',scopeSupport:'enforced' as const}
 const controller=new module.BusinessSourceAuthorityController({exclusive:oauth.exclusive.bind(oauth),read:async()=>current}),original=await controller.capture('source')
 await assert.rejects(controller.dispatch({...original},async()=>1),'复制的JSON不能成为宿主来源授权')
 current={...current,bindingRevision:2};await assert.rejects(controller.dispatch(original,async()=>1))
 const fresh=await controller.capture('source');let release!:()=>void,started!:()=>void,revoked=false
 const committing=new Promise<void>(resolve=>{started=resolve})
 const commit=controller.commit(fresh,async()=>{started();await new Promise<void>(resolve=>{release=resolve});assert.equal(revoked,false);return 'saved'})
 await committing;const revoke=oauth.exclusive('source',async()=>{revoked=true;current={...current,bindingRevision:3}})
 release();assert.equal(await commit,'saved');await revoke;assert.equal(revoked,true)
})
