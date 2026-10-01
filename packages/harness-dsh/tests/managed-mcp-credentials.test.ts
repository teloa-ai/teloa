import test from 'node:test'
import assert from 'node:assert/strict'
import {link,mkdir,readFile,stat,symlink,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {credentialSlotStore,mcpCredentialKey,memoryCredentialPort,memorySlotStore,migrateLegacyMcpCredentials} from '../src/managed-mcp-credentials.ts'
import {CredentialStoreLocked} from '../src/credentials/store-state.ts'
import {Context} from '@deepseek-ai/cordis'
import {redactSecrets} from '@teloa/contract'
import {checkPromptSecrets} from '../src/prompt-secret-gate.ts'
import TeloaCredentialProvider from '../src/credentials/provider.ts'
import {memoryKeyring,rand,tempHome} from './fixtures/credentials.ts'

test('键段编码：大小写与下划线的 serverName 可逆映射到合法键',()=>{
 assert.equal(String(mcpCredentialKey('Git_Hub-1')),'teloa-managed-mcp/s4769745f4875622d31')
})

test('槽读改写：patch 只改给定槽，undefined 删除，replace 整体替换，remove 删除记录',async()=>{
 const port=memoryCredentialPort(),slots=credentialSlotStore(port)
 await slots.replace('gh',{bearer_gh:'b-1234567890'})
 await slots.patch('gh',{oauth_access_token:'a-1234567890',bearer_gh:undefined})
 assert.deepEqual(await slots.read('gh'),{oauth_access_token:'a-1234567890'})
 assert.equal((await port.readRecord(mcpCredentialKey('gh')))?.kind,'grant')
 await slots.remove('gh');assert.deepEqual(await slots.read('gh'),{})
})

test('旧文件迁移：锁内补写记录中缺的槽，读回确认后删除旧文件；非法文件名跳过',async t=>{
 const root=await tempHome(t),dir=join(root,'mcp','credentials')
 await mkdir(dir,{recursive:true,mode:0o700})
 await writeFile(join(dir,'gh'),JSON.stringify({bearer_gh:'b-1234567890',oauth_refresh_token:'r-1234567890'}),{mode:0o600})
 await writeFile(join(dir,'..bad'),'{}',{mode:0o600})
 const port=memoryCredentialPort(),slots=credentialSlotStore(port),locks:string[]=[]
 await slots.replace('gh',{bearer_gh:'newer-value-123'})
 const migrated=await migrateLegacyMcpCredentials(root,slots,async(name,task)=>{locks.push(name);return task()},{info:()=>{},warn:()=>{}})
 assert.deepEqual(migrated,['gh']);assert.deepEqual(locks,['gh'])
 assert.deepEqual(await slots.read('gh'),{bearer_gh:'newer-value-123',oauth_refresh_token:'r-1234567890'})
 await assert.rejects(stat(join(dir,'gh')))
 assert.equal(await readFile(join(dir,'..bad'),'utf8'),'{}')
})

test('迁移逐个 serverName 隔离：一个坏文件或锁定不挡其他，失败的旧文件保留',async t=>{
 const root=await tempHome(t),dir=join(root,'mcp','credentials'),warned:string[]=[]
 await mkdir(dir,{recursive:true,mode:0o700})
 await writeFile(join(dir,'aa'),'{not json',{mode:0o600})
 await writeFile(join(dir,'bb'),JSON.stringify({bearer_bb:'b-1234567890'}),{mode:0o600})
 const slots=memorySlotStore()
 const migrated=await migrateLegacyMcpCredentials(root,slots,async(_,task)=>task(),{info:()=>{},warn:(format,...args)=>{warned.push(String(args[0]))}})
 assert.deepEqual(migrated,['bb']);assert.deepEqual(warned,['aa'])
 assert.equal(await readFile(join(dir,'aa'),'utf8'),'{not json')
})

test('锁定时迁移不删旧文件，也不抛出',async t=>{
 const root=await tempHome(t),dir=join(root,'mcp','credentials')
 await mkdir(dir,{recursive:true,mode:0o700})
 await writeFile(join(dir,'gh'),JSON.stringify({bearer_gh:'b-1234567890'}),{mode:0o600})
 const lockedPort={readRecord:async()=>{throw new CredentialStoreLocked('key-unavailable')},describeRecord:async()=>({configured:false,writable:false}),modifyRecord:async()=>{throw new CredentialStoreLocked('key-unavailable')},deleteRecord:async()=>{throw new CredentialStoreLocked('key-unavailable')}}
 assert.deepEqual(await migrateLegacyMcpCredentials(root,credentialSlotStore(lockedPort),async(_,task)=>task(),{info:()=>{},warn:()=>{}}),[])
 await stat(join(dir,'gh'))
})

const noop={info:()=>{},warn:()=>{}}
const run=async(_:string,task:()=>Promise<unknown>)=>task()

test('启动清理：擦除中断留下的空文件与全 NUL 文件直接删除，一期 .tmp 明文擦除后删除，均不导入',async t=>{
 const root=await tempHome(t),dir=join(root,'mcp','credentials')
 await mkdir(dir,{recursive:true,mode:0o700})
 await writeFile(join(dir,'empty'),'',{mode:0o600})
 await writeFile(join(dir,'nul'),Buffer.alloc(24),{mode:0o600})
 const temp=`gh.123.${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}.tmp`
 await writeFile(join(dir,temp),JSON.stringify({bearer_gh:'b-1234567890'}),{mode:0o600})
 const slots=memorySlotStore()
 assert.deepEqual(await migrateLegacyMcpCredentials(root,slots,run as never,noop),[])
 for(const name of ['empty','nul',temp])await assert.rejects(stat(join(dir,name)),name)
 assert.deepEqual(await slots.read('gh'),{})
})

test('孤儿旧文件（没有对应连接）只擦除删除，不导入记录',async t=>{
 const root=await tempHome(t),dir=join(root,'mcp','credentials')
 await mkdir(dir,{recursive:true,mode:0o700})
 await writeFile(join(dir,'orphan'),JSON.stringify({oauth_refresh_token:'r-1234567890'}),{mode:0o600})
 const slots=memorySlotStore()
 assert.deepEqual(await migrateLegacyMcpCredentials(root,slots,run as never,noop,()=>false),[])
 await assert.rejects(stat(join(dir,'orphan')))
 assert.deepEqual(await slots.read('orphan'),{})
})

test('擦除前拒绝硬链接文件与符号链接目录：外部文件原样保留',async t=>{
 const root=await tempHome(t),dir=join(root,'mcp','credentials'),outside=join(root,'outside')
 await mkdir(dir,{recursive:true,mode:0o700});await mkdir(outside)
 const body=JSON.stringify({bearer_gh:'b-1234567890'})
 await writeFile(join(outside,'linked'),body,{mode:0o600})
 await link(join(outside,'linked'),join(dir,'gh'))
 const warned:string[]=[]
 assert.deepEqual(await migrateLegacyMcpCredentials(root,memorySlotStore(),run as never,{info:()=>{},warn:(_,...args)=>{warned.push(String(args[0]))}}),[])
 assert.equal(await readFile(join(outside,'linked'),'utf8'),body)
 assert.deepEqual(warned,['gh'])

 const root2=await tempHome(t)
 await mkdir(join(root2,'mcp'),{recursive:true})
 await writeFile(join(outside,'gh'),body,{mode:0o600})
 await symlink(outside,join(root2,'mcp','credentials'))
 assert.deepEqual(await migrateLegacyMcpCredentials(root2,memorySlotStore(),run as never,noop),[])
 assert.equal(await readFile(join(outside,'gh'),'utf8'),body)
})

test('读回逐值比对：补写的槽读回值不符时不删除旧文件',async t=>{
 const root=await tempHome(t),dir=join(root,'mcp','credentials')
 await mkdir(dir,{recursive:true,mode:0o700})
 await writeFile(join(dir,'gh'),JSON.stringify({bearer_gh:'b-1234567890'}),{mode:0o600})
 const inner=memorySlotStore()
 const skewed={...inner,read:async(name:string)=>{const slots=await inner.read(name);return Object.keys(slots).length?{...slots,bearer_gh:'other-value-123'}:slots}}
 assert.deepEqual(await migrateLegacyMcpCredentials(root,skewed,run as never,noop),[])
 await stat(join(dir,'gh'))
})

test('提供方其他故障（信封、锁超时、已停用）一律按锁定上抛，不透出内部键名',async()=>{
 const fail=async():Promise<never>=>{throw new Error('credentials is disposed: cannot modify teloa-managed-mcp/s6768')}
 const faults:string[]=[]
 const slots=credentialSlotStore({readRecord:fail,describeRecord:fail,modifyRecord:fail,deleteRecord:fail},name=>faults.push(name))
 for(const call of [()=>slots.read('gh'),()=>slots.patch('gh',{a:'b'}),()=>slots.replace('gh',{}),()=>slots.remove('gh'),()=>slots.assertWritable('gh')]){
  await assert.rejects(call(),(error:Error)=>error.name==='CredentialStoreLocked'&&!error.message.includes('teloa-managed-mcp'))
 }
 // 调试钩子只拿到错误类名，不带 message
 assert.deepEqual(faults,['Error','Error','Error','Error','Error'])
})

test('孤儿文件先确认是 JSON 对象才擦除；解析不了的按 format 保留；写到一半的擦除残留（前半 NUL）直接清除',async t=>{
 const root=await tempHome(t),dir=join(root,'mcp','credentials')
 await mkdir(dir,{recursive:true,mode:0o700})
 await writeFile(join(dir,'README'),'not credentials',{mode:0o600})
 const body=JSON.stringify({bearer_gh:'b-1234567890'})
 await writeFile(join(dir,'gh'),Buffer.concat([Buffer.alloc(8),Buffer.from(body.slice(8))]),{mode:0o600})
 const warned:string[]=[]
 assert.deepEqual(await migrateLegacyMcpCredentials(root,memorySlotStore(),run as never,{info:()=>{},warn:(_,...args)=>{warned.push(`${args[0]}:${args[1]}`)}},()=>false),[])
 assert.equal(await readFile(join(dir,'README'),'utf8'),'not credentials')
 assert.deepEqual(warned,['README:format'])
 await assert.rejects(stat(join(dir,'gh')))
})

test('覆盖面（规格 2026-09-27 §7.1）：header / basic 新槽值与 bearer_* 槽值在已存值集合（守卫、脱敏、贴密钥闸共用 secretValues）中出现情况相同',async t=>{
 const ctx=new Context()
 t.after(()=>ctx.fiber.dispose())
 const deps={keyring:memoryKeyring().port,env:{},keyDir:join(await tempHome(t),'k')}
 class Mounted extends TeloaCredentialProvider{constructor(c:Context,config:{dshHome?:string}){super(c,config,deps)}}
 await ctx.plugin(Mounted,{dshHome:await tempHome(t)})
 const provider=ctx.credentials as TeloaCredentialProvider
 const slots=credentialSlotStore(provider)
 // 长值（≥ 8）与短值（< 8）各一组：新槽与 bearer 槽要么同在、要么同不在
 for(const length of [24,5]){
  const values={bearer:rand(length),header:rand(length),user:rand(length),pass:rand(length)}
  await slots.replace('svc',{bearer_svc:values.bearer,'header_svc__x-api-key':values.header,basic_user_svc:values.user,basic_pass_svc:values.pass})
  const known=provider.secretValues(),has=(value:string)=>known.includes(value)
  assert.equal(has(values.bearer),length>=8,'对照组：bearer 槽长值在、短值不在')
  assert.equal(has(values.header),has(values.bearer),`header 槽（长度 ${length}）`)
  assert.equal(has(values.pass),has(values.bearer),`basic 密码槽（长度 ${length}）`)
  // 设计约束：basic 用户名（常为邮箱）不进已存值集合与贴密钥闸，仍随记录加密存储
  assert.equal(has(values.user),false,`basic 用户名槽（长度 ${length}）不进已存值`)
 }
})

test('审查修复 M-1：Basic 线上形态 base64(用户名:密码) 进已存值；3–4 字符用户名的 Basic 回显被脱敏、贴密钥闸拦下，用户名本身不拦',async t=>{
 const ctx=new Context()
 t.after(()=>ctx.fiber.dispose())
 const deps={keyring:memoryKeyring().port,env:{},keyDir:join(await tempHome(t),'k')}
 class Mounted extends TeloaCredentialProvider{constructor(c:Context,config:{dshHome?:string}){super(c,config,deps)}}
 await ctx.plugin(Mounted,{dshHome:await tempHome(t)})
 const provider=ctx.credentials as TeloaCredentialProvider
 const slots=credentialSlotStore(provider)
 for(const user of ['abc','abcd','alice@example.com']){
  const pass='atl-'+rand(26)
  await slots.replace('jira',{basic_user_jira:user,basic_pass_jira:pass})
  const b64=Buffer.from(`${user}:${pass}`,'utf8').toString('base64'),known=provider.secretValues()
  // 探针：远端把请求头回显进工具结果
  for(const echo of [`Authorization: Basic ${b64}`,`{"authorization":"Basic ${b64}"}`,`auth=Basic%20${encodeURIComponent(b64)}`,`Basic ${b64.replace(/=+$/,'')}`]){
   const redacted=redactSecrets(echo,known)
   assert.ok(!redacted.includes(b64.replace(/=+$/,'')),`${user}：${echo.slice(0,30)} 被遮掉`)
   assert.equal(checkPromptSecrets([echo],()=>known).ok,false,`${user}：贴密钥闸拦下 ${echo.slice(0,30)}`)
  }
  assert.ok(!redactSecrets(`用户名是 ${user}`,known).includes('[已隐藏]'),`${user}：用户名本身不遮`)
  if(user.length>=8)assert.equal(checkPromptSecrets([`我的账号 ${user}`],()=>known).ok,true,'用户名本身不拦')
 }
})
