import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,stat,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {runInNewContext} from 'node:vm'
import {prepareContainerSecret,writeContainerDatabase} from '../scripts/容器配置.mjs'
import {stripCredentialEnv} from '../scripts/runtime/credential-env.mjs'
import {detectMarketRemoteExclusion} from '../packages/harness-dsh/src/market-remote.ts'

test('容器首次生成随机口令，重启不轮换，数据库配置指向内部服务',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'teloa-container-config-'))
  t.after(()=>rm(dir,{recursive:true,force:true}))
  const secret=join(dir,'secret'),config=join(dir,'database.json')
  await prepareContainerSecret(secret)
  const password=await readFile(secret,'utf8')
  assert.match(password,/^[a-f0-9]{64}$/)
  await prepareContainerSecret(secret)
  assert.equal(await readFile(secret,'utf8'),password)
  await writeContainerDatabase(secret,config)
  assert.equal(JSON.parse(await readFile(config,'utf8')).connectionString,'postgresql://teloa:'+password+'@db:5432/teloa')
  assert.equal((await stat(config)).mode&0o777,0o600)
})
test('损坏口令不被静默重置，避免与已有数据库脱节',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'teloa-container-config-'))
  t.after(()=>rm(dir,{recursive:true,force:true}))
  const secret=join(dir,'secret'),config=join(dir,'database.json')
  await writeFile(secret,'broken')
  await assert.rejects(prepareContainerSecret(secret),/口令/)
  await assert.rejects(writeContainerDatabase(secret,config),/口令/)
  assert.equal(await readFile(secret,'utf8'),'broken')
})

test('容器真实入口组装环境：在线市场默认开启，显式关闭、排除与凭据过滤保留',async()=>{
  const source=await readFile(new URL('../scripts/启动容器.mjs',import.meta.url),'utf8')
  // 执行入口的实际控制流；仅移除静态导入，所有进程、监听、数据库与文件副作用由内存桩接管。
  const body=source.replace(/^import .+\n/gm,'')
  const cases=[
    [{},'on',undefined],
    [{TELOA_MARKET_REMOTE:'off'},'off','env-off'],
    [{TELOA_MARKET_REMOTE:''},'','default-off'],
    [{TELOA_MARKET_REMOTE:'yes'},'yes','default-off'],
    [{CI:'true'},'on','ci'],
    [{TELOA_BROWSER_ACCEPTANCE:'1'},'on','acceptance'],
    [{NODE_ENV:'development'},'on','dev'],
  ]
  for(const [overrides,value,excluded] of cases){
    const launches=[],noop=()=>{},fakeProcess={argv:['node','launcher'],execPath:'/node',env:{TELOA_USAGE_STATS:'off',DEEPSEEK_API_KEY:'fixture-secret',TELOA_CREDENTIALS_KEYRING:'off',...overrides},on:noop}
    await runInNewContext('(async()=>{'+body+'})()',{
      process:fakeProcess,console:{log:noop,error:message=>{throw Error(message)}},
      mkdir:noop,prepareContainerSecret:noop,writeContainerDatabase:noop,
      waitForTeloaDatabase:noop,initializeTeloaDatabase:noop,startContainerProxy:()=>({stop:noop}),
      stripCredentialEnv,warnRemoved:noop,imCredentialFields:{},
      spawn:(executable,args,options)=>{launches.push({executable,args,options});return{once:noop,kill:noop}},
    })
    assert.equal(launches.length,1)
    const {executable,args,options:{env}}=launches[0]
    assert.equal(executable,'/node');assert.equal(args[0],'scripts/启动DSH.mjs')
    assert.equal(env.TELOA_MARKET_REMOTE,value)
    assert.equal(env.TELOA_USAGE_STATS,'off')
    assert.equal(env.DEEPSEEK_API_KEY,undefined)
    assert.equal(env.TELOA_CREDENTIALS_KEYRING,undefined)
    assert.equal(detectMarketRemoteExclusion(env),excluded)
  }
})
