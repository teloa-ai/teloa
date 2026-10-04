import test from 'node:test'
import assert from 'node:assert/strict'
import {ResourceDatabaseEndpointPolicy} from '../src/capabilities/database-endpoint.ts'

const endpoint={hostname:'tenant-db.example',port:5432,database:'tenant_a',username:'tenant_a',tls:{ca:'trusted-ca'}} as const
test('未绑定宿主保留原连接策略；固定目标强制完整 TLS 且不能换绑',()=>{
 const policy=new ResourceDatabaseEndpointPolicy()
 assert.equal(policy.connectionOptions('postgresql://a:b@localhost/teloa'),undefined)
 policy.install(endpoint)
 assert.deepEqual(policy.connectionOptions('postgresql://tenant_a:password@tenant-db.example/tenant_a'),{
  connectionString:'postgresql://tenant_a:password@tenant-db.example/tenant_a',ssl:{rejectUnauthorized:true,ca:'trusted-ca'},
 })
 assert.throws(()=>policy.install(endpoint))
})
test('拒绝越租户、改变端口、回落本机、URL 覆盖和缺少凭据',()=>{
 const policy=new ResourceDatabaseEndpointPolicy();policy.install(endpoint)
 for(const value of [
  'postgresql://tenant_b:password@tenant-db.example/tenant_a',
  'postgresql://tenant_a:password@tenant-db.example/tenant_b',
  'postgresql://tenant_a:password@other.example/tenant_a',
  'postgresql://tenant_a:password@tenant-db.example:5433/tenant_a',
  'postgresql://tenant_a:password@localhost/teloa',
  'postgresql://tenant_a:password@tenant-db.example/tenant_a?sslmode=disable',
  'postgresql://tenant_a:password@tenant-db.example/tenant_a?host=other.example',
  'postgresql://tenant_a:password@tenant-db.example/tenant_a#fragment',
  'postgresql://tenant_a@tenant-db.example/tenant_a',
  'https://tenant_a:password@tenant-db.example/tenant_a',
  'invalid',
 ])assert.throws(()=>policy.connectionOptions(value),value)
})
test('固定配置不可变，外置明文与伪造的 TLS 配置不能装配',()=>{
 const mutable={...endpoint,tls:{ca:'trusted-ca'}}
 const policy=new ResourceDatabaseEndpointPolicy();policy.install(mutable)
 mutable.hostname='other.example';mutable.tls.ca='changed-ca'
 assert.deepEqual(policy.connectionOptions('postgresql://tenant_a:password@tenant-db.example/tenant_a')?.ssl,{rejectUnauthorized:true,ca:'trusted-ca'})
 for(const invalid of [
  {...endpoint,tls:false}, {...endpoint,port:0}, {...endpoint,database:'tenant_a/other'},
  {...endpoint,tls:{rejectUnauthorized:false}}, {...endpoint,hostname:'db/user'},
 ])assert.throws(()=>new ResourceDatabaseEndpointPolicy().install(invalid as typeof endpoint))
 const local=new ResourceDatabaseEndpointPolicy();local.install({...endpoint,hostname:'db',tls:false})
 assert.equal(local.connectionOptions('postgresql://tenant_a:password@db/tenant_a')?.ssl,false)
})
