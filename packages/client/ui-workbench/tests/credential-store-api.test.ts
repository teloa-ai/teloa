import test from 'node:test'
import assert from 'node:assert/strict'
import {createCredentialStoreApi} from '../lib/types/client/credential-store-api.js'

test('状态读取严格校验回包形状，删除只提交 ids',async()=>{
 const calls:unknown[]=[]
 const api=createCredentialStoreApi(async(endpoint,payload)=>{calls.push([endpoint,payload]);return {tier:'plaintext',fault:null,copies:[{id:'a'.repeat(32),label:'x/.credentials.yaml'}]}})
 assert.equal((await api.status()).tier,'plaintext')
 await api.deleteCopies(['a'.repeat(32)])
 assert.deepEqual(calls,[['credential-store/status',{}],['credential-store/plaintext-copies/delete',{ids:['a'.repeat(32)]}]])
 const bad=createCredentialStoreApi(async()=>({tier:'weird',fault:null,copies:[]}))
 await assert.rejects(bad.status(),/格式/)
})

test('删除回包带 refused（未安全删除的个数），必须是非负整数',async()=>{
 const ok=createCredentialStoreApi(async()=>({tier:'keyring',fault:null,copies:[],refused:2}))
 assert.equal((await ok.deleteCopies(['b'.repeat(32)])).refused,2)
 assert.equal((await ok.status()).refused,2)
 for(const refused of [-1,1.5,'2'])await assert.rejects(createCredentialStoreApi(async()=>({tier:'keyring',fault:null,copies:[],refused})).status(),/格式/)
 assert.equal('refused' in await createCredentialStoreApi(async()=>({tier:'keyring',fault:null,copies:[]})).status(),false)
})

test('清单项可带 shared（与其他路径共用内容，需手动处理），必须是布尔值',async()=>{
 const api=createCredentialStoreApi(async()=>({tier:'keyring',fault:null,copies:[{id:'a'.repeat(32),label:'x',shared:true},{id:'b'.repeat(32),label:'y',shared:false}]}))
 assert.deepEqual((await api.status()).copies,[{id:'a'.repeat(32),label:'x',shared:true},{id:'b'.repeat(32),label:'y',shared:false}])
 await assert.rejects(createCredentialStoreApi(async()=>({tier:'keyring',fault:null,copies:[{id:'a'.repeat(32),label:'x',shared:'yes'}]})).status(),/格式/)
 assert.deepEqual((await createCredentialStoreApi(async()=>({tier:'keyring',fault:null,copies:[{id:'a'.repeat(32),label:'x'}]})).status()).copies,[{id:'a'.repeat(32),label:'x',shared:false}])
})
