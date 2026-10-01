import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {readFile,readdir,stat,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {credentialKey,credentialRef} from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider,{parseCredentialsDocument} from '@deepseek-ai/dsh-credentials-local'
import {createLaunchEnvironmentSnapshot} from '@deepseek-ai/dsh-launch-environment'
import TeloaCredentialProvider from '../src/credentials/provider.ts'
import {resolveStore,storePaths} from '../src/credentials/store-state.ts'
import {open,seal} from '../src/credentials/envelope.ts'
import {importBlockedMessage,importLegacyCredentials,runCredentialMaintenance} from '../src/credentials/maintenance.ts'
import {mcpCredentialKey} from '../src/managed-mcp-credentials.ts'
import {memoryKeyring,rand,tempHome} from './fixtures/credentials.ts'

async function encryptedHome(t:import('node:test').TestContext,value:string){
 const home=await tempHome(t),keyring=memoryKeyring(),keyDir=join(await tempHome(t),'k'),deps={keyring:keyring.port,env:{},keyDir}
 const state=await resolveStore(storePaths(home),'auto',deps)
 if(state.mode!=='encrypted')throw Error('setup')
 await writeFile(join(home,'.credentials.enc'),seal(state.key,state.meta.installId,JSON.stringify({version:1,refs:{DEEPSEEK_API_KEY:value},records:{}})),{mode:0o600})
 return {home,keyring,deps,state}
}
const hex16=()=>Array.from({length:16},()=>Math.floor(Math.random()*16).toString(16)).join('')

test('export-plaintext 写出官方可读的 0600 明文，并把 .enc 与 meta 改名留存',async t=>{
 const value=rand(30),{home,deps}=await encryptedHome(t,value)
 await runCredentialMaintenance('export-plaintext',{dshHome:home,...deps})
 assert.equal(parseCredentialsDocument(await readFile(join(home,'.credentials.yaml'),'utf8'),'x').refs.get('DEEPSEEK_API_KEY'),value)
 assert.equal((await stat(join(home,'.credentials.yaml'))).mode&0o777,0o600)
 const names=await readdir(home)
 assert.ok(names.some(name=>name.startsWith('.credentials.enc.bak-')));assert.ok(!names.includes('.credentials.enc'));assert.ok(!names.includes('.credentials.meta.json'))
})

test('导出后重新激活官方提供方，引用与两类记录均可实际读取并继续写入',async t=>{
 const value=rand(30),{home,deps}=await encryptedHome(t,value)
 const grantKey=mcpCredentialKey('acceptance'),modelKey=credentialKey('teloa-test','model')
 const grant={kind:'grant' as const,payload:{access_token:rand(32),refresh_token:rand(32)}}
 const model={kind:'api-key' as const,key:rand(32),env:{TELOA_TEST_TOKEN:rand(32)}}
 const source=new Context(),target=new Context()
 t.after(()=>target.fiber.dispose());t.after(()=>source.fiber.dispose())
 source.provide('launchEnvironment',createLaunchEnvironmentSnapshot([{source:'process',values:{}}]))
 target.provide('launchEnvironment',createLaunchEnvironmentSnapshot([{source:'process',values:{}}]))
 class Mounted extends TeloaCredentialProvider{constructor(ctx:Context,config:{dshHome?:string}){super(ctx,config,deps)}}
 await source.plugin(Mounted,{dshHome:home})
 await source.credentials.modifyRecord(grantKey,async()=>grant)
 await source.credentials.modifyRecord(modelKey,async()=>model)
 await source.fiber.dispose()
 await runCredentialMaintenance('export-plaintext',{dshHome:home,...deps})
 await target.plugin(LocalCredentialProvider,{dshHome:home,path:join(home,'.credentials.yaml'),watch:false})
 assert.deepEqual(await target.credentials.resolve(credentialRef('DEEPSEEK_API_KEY')),{value,source:'file'})
 assert.deepEqual(await target.credentials.readRecord(grantKey),grant)
 assert.deepEqual(await target.credentials.readRecord(modelKey),model)
 assert.equal((await target.credentials.listRecords()).length,2)
 const next=rand(30)
 await target.credentials.set(credentialRef('DEEPSEEK_API_KEY'),next)
 assert.equal(await target.credentials.resolve(credentialRef('DEEPSEEK_API_KEY')).then(item=>item?.value),next)
 assert.equal((await stat(join(home,'.credentials.yaml'))).mode&0o777,0o600)
})

test('rotate 换主密钥后仍可解、旧钥匙串账户删除；reset 改名留存',async t=>{
 const value=rand(30),{home,keyring,deps}=await encryptedHome(t,value)
 const before=[...keyring.items.keys()]
 await runCredentialMaintenance('rotate',{dshHome:home,...deps})
 const after=[...keyring.items.keys()]
 assert.equal(after.length,1);assert.notDeepEqual(after,before)
 const state=await resolveStore(storePaths(home),'auto',deps)
 assert.equal(state.mode,'encrypted')
 await runCredentialMaintenance('reset',{dshHome:home,...deps})
 assert.ok((await readdir(home)).some(name=>name.startsWith('.credentials.meta.json.bak-')))
})

test('file 档 rotate：生成新密钥文件、meta 指向新文件、旧文件删除、值不变',async t=>{
 const home=await tempHome(t),keyDir=join(await tempHome(t),'k'),deps={keyring:undefined,env:{},keyDir},value=rand(30)
 const state=await resolveStore(storePaths(home),'auto',deps)
 if(state.mode!=='encrypted'||state.meta.tier!=='file')throw Error('setup')
 await writeFile(join(home,'.credentials.enc'),seal(state.key,state.meta.installId,JSON.stringify({version:1,refs:{DEEPSEEK_API_KEY:value},records:{}})),{mode:0o600})
 await runCredentialMaintenance('rotate',{dshHome:home,...deps})
 const after=await resolveStore(storePaths(home),'auto',deps)
 assert.equal(after.mode,'encrypted');if(after.mode!=='encrypted')return
 assert.notEqual(after.meta.keyFile,state.meta.keyFile);await assert.rejects(stat(state.meta.keyFile!))
 assert.equal(JSON.parse(open(after.key,await readFile(join(home,'.credentials.enc'),'utf8')).plaintext).refs.DEEPSEEK_API_KEY,value)
})

test('宿主运行标记指向存活进程时拒绝；进程已退出则放行',async t=>{
 const value=rand(30),{home,deps}=await encryptedHome(t,value)
 const child=spawn(process.execPath,['-e','setTimeout(()=>{},30000)']);t.after(()=>child.kill())
 await writeFile(join(home,'.credentials.host.pid'),String(child.pid))
 await assert.rejects(runCredentialMaintenance('rotate',{dshHome:home,...deps}),/宿主仍在运行/)
 await assert.rejects(runCredentialMaintenance('reset',{dshHome:home,...deps}),/宿主仍在运行/)
 assert.ok((await readdir(home)).includes('.credentials.enc'))
 child.kill();await once(child,'exit')
 assert.equal(await runCredentialMaintenance('rotate',{dshHome:home,...deps}),'主密钥已轮换。')
})

test('首次初始化与轮换写钥匙串前先登记账户名（不含秘密）',async t=>{
 const value=rand(30),{home,keyring,deps,state}=await encryptedHome(t,value)
 if(state.mode!=='encrypted')throw Error('setup')
 const registry=join(home,'.credentials.keyring-accounts')
 assert.deepEqual((await readFile(registry,'utf8')).split('\n').filter(Boolean),[`${state.meta.installId}:${state.meta.keyId}`])
 assert.equal((await stat(registry)).mode&0o777,0o600)
 await runCredentialMaintenance('rotate',{dshHome:home,...deps})
 const lines=(await readFile(registry,'utf8')).split('\n').filter(Boolean)
 assert.equal(lines.length,2);assert.ok(keyring.items.has(lines[1]!))
 assert.ok(!(await readFile(registry,'utf8')).includes(value))
})

test('reset 按登记精确删除本安装的孤立钥匙串账户、清理全部级别的接管互斥文件，保留在用主密钥与别的安装',async t=>{
 const value=rand(30),{home,keyring,deps,state}=await encryptedHome(t,value)
 if(state.mode!=='encrypted')throw Error('setup')
 const live=`${state.meta.installId}:${state.meta.keyId}`,orphans=[`${state.meta.installId}:${hex16()}`,`${state.meta.installId}:${hex16()}`]
 const other=`00000000-0000-4000-8000-000000000000:${hex16()}`,unregistered=`${state.meta.installId}:${hex16()}`
 for(const account of [...orphans,other,unregistered])keyring.items.set(account,'x')
 await writeFile(join(home,'.credentials.keyring-accounts'),[...orphans,other].join('\n')+'\n',{flag:'a'})
 const guards=[0,1,2].map(level=>`.credentials.meta.json.lock.takeover-123-456-${level}`).concat('.credentials.enc.lock.takeover-7-8-0')
 for(const name of [...guards,'keep.json'])await writeFile(join(home,name),'1\n')
 await runCredentialMaintenance('reset',{dshHome:home,...deps})
 // 未登记的账户不碰（不枚举钥匙串）；别的安装的登记留在登记文件里
 assert.deepEqual([...keyring.items.keys()].sort(),[live,other,unregistered].sort())
 assert.deepEqual((await readFile(join(home,'.credentials.keyring-accounts'),'utf8')).split('\n').filter(Boolean),[live,other])
 const names=await readdir(home)
 for(const name of guards)assert.ok(!names.includes(name),name)
 assert.ok(names.includes('keep.json'));assert.ok(names.some(name=>name.startsWith('.credentials.enc.bak-')))
})

test('reset：首次探测失败后落到 file 档，探测时写进钥匙串的账户是孤立账户，reset 精确删除',async t=>{
 const home=await tempHome(t),keyring=memoryKeyring()
 // set 落地但读回失败（等同探测超时后写入仍然生效）
 const port={...keyring.port,get:async()=>undefined}
 const deps={keyring:port,env:{},keyDir:join(await tempHome(t),'k')}
 const state=await resolveStore(storePaths(home),'auto',deps)
 if(state.mode!=='encrypted'||state.meta.tier!=='file')throw Error('setup')
 assert.equal(keyring.items.size,1);keyring.items.set('unrelated','y')
 await runCredentialMaintenance('reset',{dshHome:home,...deps})
 assert.deepEqual([...keyring.items.keys()],['unrelated'])
 await assert.rejects(stat(join(home,'.credentials.keyring-accounts')))
})

test('导入旧备份的 .credentials.yaml：经提供方写入加密存储、同键覆盖，磁盘不落明文',async t=>{
 const value=rand(30),old=rand(30),{home,deps}=await encryptedHome(t,old)
 const yaml=JSON.stringify({version:1,refs:{DEEPSEEK_API_KEY:value,OTHER_API_KEY:rand(20)},records:{}})
 assert.deepEqual(await importLegacyCredentials(home,{yaml},deps),{imported:['dsh/.credentials.yaml'],failed:[]})
 const state=await resolveStore(storePaths(home),'auto',deps)
 if(state.mode!=='encrypted')throw Error('state')
 const doc=JSON.parse(open(state.key,await readFile(join(home,'.credentials.enc'),'utf8')).plaintext)
 assert.equal(doc.refs.DEEPSEEK_API_KEY,value);assert.ok(doc.refs.OTHER_API_KEY)
 const names=await readdir(home)
 assert.ok(!names.includes('.credentials.yaml'));assert.ok(!names.includes('.credentials.host.pid'))
 for(const name of names.filter(name=>!name.startsWith('.credentials.enc')))assert.ok(!(await readFile(join(home,name),'utf8').catch(()=>'')).includes(value),name)
})

test('导入旧备份的受管 MCP 凭据：走凭据槽写入 grant 记录，格式不对的记入 failed',async t=>{
 const token=rand(40),{home,deps}=await encryptedHome(t,rand(30))
 const result=await importLegacyCredentials(home,{mcp:{github:JSON.stringify({GITHUB_TOKEN:token,n:1}),broken:'not json'}},deps)
 assert.deepEqual(result,{imported:['runtime/mcp/credentials/github'],failed:['runtime/mcp/credentials/broken']})
 const state=await resolveStore(storePaths(home),'auto',deps)
 if(state.mode!=='encrypted')throw Error('state')
 const doc=JSON.parse(open(state.key,await readFile(join(home,'.credentials.enc'),'utf8')).plaintext)
 assert.deepEqual(doc.records[mcpCredentialKey('github')],{kind:'grant',payload:{GITHUB_TOKEN:token}})
})

test('导入时存储锁定：中止、不写任何凭据，并列出未导入项',async t=>{
 const value=rand(30),{home,deps}=await encryptedHome(t,rand(30))
 const before=await readFile(join(home,'.credentials.enc'),'utf8')
 await writeFile(join(home,'.credentials.meta.json'),'{}')
 await assert.rejects(importLegacyCredentials(home,{yaml:JSON.stringify({version:1,refs:{DEEPSEEK_API_KEY:value},records:{}}),mcp:{github:'{}'}},deps),(error:any)=>{
  assert.equal(error.message,importBlockedMessage)
  assert.deepEqual(error.pending,['dsh/.credentials.yaml','runtime/mcp/credentials/github'])
  return true
 })
 assert.equal(await readFile(join(home,'.credentials.enc'),'utf8'),before)
 assert.ok(!(await readdir(home)).includes('.credentials.yaml'))
})

test('导入到全新 DSH_HOME（真实恢复路径）：首次初始化加密档后写入，目录无明文',async t=>{
 const home=join(await tempHome(t),'dsh'),keyring=memoryKeyring(),deps={keyring:keyring.port,env:{},keyDir:join(await tempHome(t),'k')},value=rand(30),token=rand(40)
 const result=await importLegacyCredentials(home,{yaml:JSON.stringify({version:1,refs:{DEEPSEEK_API_KEY:value},records:{}}),mcp:{github:JSON.stringify({GITHUB_TOKEN:token})}},deps)
 assert.deepEqual(result,{imported:['dsh/.credentials.yaml','runtime/mcp/credentials/github'],failed:[]})
 const state=await resolveStore(storePaths(home),'auto',deps)
 if(state.mode!=='encrypted')throw Error('state')
 const doc=JSON.parse(open(state.key,await readFile(join(home,'.credentials.enc'),'utf8')).plaintext)
 assert.equal(doc.refs.DEEPSEEK_API_KEY,value);assert.equal(doc.records[mcpCredentialKey('github')].payload.GITHUB_TOKEN,token)
 for(const name of await readdir(home))if((await stat(join(home,name))).isFile())for(const secret of [value,token])assert.ok(!(await readFile(join(home,name),'utf8')).includes(secret),name)
})

test('导入时只能明文存放（没有钥匙串、密钥目录落在 DSH_HOME 内）：中止，目录无明文',async t=>{
 const home=join(await tempHome(t),'dsh'),value=rand(30)
 await assert.rejects(importLegacyCredentials(home,{yaml:JSON.stringify({version:1,refs:{DEEPSEEK_API_KEY:value},records:{}})},{keyring:undefined,env:{},keyDir:join(home,'k')}),(error:any)=>{
  assert.equal(error.message,importBlockedMessage);assert.deepEqual(error.pending,['dsh/.credentials.yaml']);return true
 })
 const names=await readdir(home)
 assert.ok(!names.includes('.credentials.yaml'))
 for(const name of names)if((await stat(join(home,name))).isFile())assert.ok(!(await readFile(join(home,name),'utf8')).includes(value),name)
})
