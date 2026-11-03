import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {matchesFrozenDockerPort,matchesOrdinaryDatabaseConfig} from '../src/upgrade-database-binding.ts'
import type {InstallState} from '../src/contracts.ts'

const id='8ce37bc5-983d-4980-849a-0a40717a829c',password='a'.repeat(64),name='teloa-'+id
const config=(port:number)=>({connectionString:'postgresql://teloa:'+password+'@127.0.0.1:'+port+'/teloa'})
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
function evidence(running=true){return {installationId:id,environment:'POSTGRES_DB=teloa\nPOSTGRES_USER=teloa\nPOSTGRES_PASSWORD='+password+'\n',volume:{Name:name+'-data',Labels:{'ai.teloa.install':id}},container:{Name:'/'+name,Config:{Labels:{'ai.teloa.install':id},Env:['POSTGRES_DB=teloa','POSTGRES_USER=teloa','POSTGRES_PASSWORD='+password]},State:{Running:running},Mounts:[{Type:'volume',Name:name+'-data',Destination:'/var/lib/postgresql/data'}],HostConfig:{PortBindings:{'5432/tcp':[{HostIp:'127.0.0.1',HostPort:''}]}},NetworkSettings:{Ports:running?{'5432/tcp':[{HostIp:'127.0.0.1',HostPort:'34066'}]}:{}}}}}

test('旧v1冻结SHA仅端口变化可复现，running核当前映射；停止态无Ports仍能正常续办',()=>{
 const before=config(34065),frozen=hash(before),current=config(34066),bytes=JSON.stringify(current)
 assert.equal(matchesFrozenDockerPort(current,frozen,evidence()),true)
 assert.equal(matchesFrozenDockerPort(current,frozen,evidence(false)),true)
 assert.equal(JSON.stringify(current),bytes);assert.equal(hash(before),frozen)
 const maxPort=evidence(false);assert.equal(matchesFrozenDockerPort(current,hash(config(65535)),maxPort),true,'有限枚举包括最后一个合法端口，未探测任何网络')
})
test('异安装/容器/卷/挂载/本机凭据/运行映射不能借端口重绑定',()=>{
 for(const variant of ['owner','name','volume','mount','env','container-env','live-port','live-host','publish-host'] as const){
  const proof=evidence()
  if(variant==='owner')proof.container.Config.Labels['ai.teloa.install']='another-owner'
  if(variant==='name')proof.container.Name='/another-container'
  if(variant==='volume')proof.volume.Labels['ai.teloa.install']='another-owner'
  if(variant==='mount')proof.container.Mounts[0]!.Name='another-volume'
  if(variant==='env')proof.environment=proof.environment.replace(password,'b'.repeat(64))
  if(variant==='container-env')proof.container.Config.Env[2]='POSTGRES_PASSWORD='+'b'.repeat(64)
  if(variant==='live-port')proof.container.NetworkSettings.Ports['5432/tcp']![0]!.HostPort='34067'
  if(variant==='live-host')proof.container.NetworkSettings.Ports['5432/tcp']![0]!.HostIp='0.0.0.0'
  if(variant==='publish-host')proof.container.HostConfig.PortBindings['5432/tcp']![0]!.HostIp='0.0.0.0'
  assert.equal(matchesFrozenDockerPort(config(34066),hash(config(34065)),proof),false,variant)
 }
})
test('协议/host/用户名/密码/db/额外key与连接覆盖参数均不能走port-only分支',()=>{
 const frozen=hash(config(34065)),base=config(34066)
 for(const current of [
  {...base,connectionString:base.connectionString.replace('postgresql:','postgres:')},
  {...base,connectionString:base.connectionString.replace('127.0.0.1','localhost')},
  {...base,connectionString:base.connectionString.replace('//teloa:','//other:')},
  {...base,connectionString:base.connectionString.replace(password,'b'.repeat(64))},
  {...base,connectionString:base.connectionString.replace('/teloa','/other')},
  {...base,connectionString:base.connectionString+'?host=other'},
  {...base,extra:true},
 ]){
  assert.equal(matchesFrozenDockerPort(current,frozen,evidence(false)),false)
 }
 const rotated=evidence(false);rotated.environment=rotated.environment.replace(password,'b'.repeat(64));rotated.container.Config.Env[2]='POSTGRES_PASSWORD='+'b'.repeat(64)
 assert.equal(matchesFrozenDockerPort({connectionString:base.connectionString.replace(password,'b'.repeat(64))},frozen,rotated),false,'即使当前env与container同时改密码，也不能复现旧SHA')
})
test('existing数据库仍完整SHA，禁止用docker元数据或端口等价绕过',async()=>{
 const state={database:{kind:'existing'}} as InstallState
 assert.equal(await matchesOrdinaryDatabaseConfig(state,config(34065),hash(config(34065))),true)
 assert.equal(await matchesOrdinaryDatabaseConfig(state,config(34066),hash(config(34065))),false)
})
