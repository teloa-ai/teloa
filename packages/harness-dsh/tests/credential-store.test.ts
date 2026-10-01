import test from 'node:test'
import assert from 'node:assert/strict'
import {renameSync,symlinkSync,writeFileSync} from 'node:fs'
import {chmod,link,mkdir,open,readdir,readFile,realpath,rename,rm,stat,symlink,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createCredentialStoreHandler,findPlaintextCopies} from '../src/credential-store.ts'
import {createTeloaWorkService} from '../src/teloa-work-service.ts'
import {tempHome} from './fixtures/credentials.ts'

test('清单只列历史副本（.credentials.yaml 与 mcp/credentials/*），排除在用文件，删除只按清单 id',async t=>{
 const base=await tempHome(t),runtime=join(base,'.runtime'),old=join(base,'.runtime-upgrade-backup-x','dsh')
 await mkdir(join(runtime,'dsh'),{recursive:true});await mkdir(old,{recursive:true});await mkdir(join(runtime,'backups','b','mcp','credentials'),{recursive:true})
 await writeFile(join(runtime,'dsh','.credentials.yaml'),'live');await writeFile(join(old,'.credentials.yaml'),'old')
 await writeFile(join(runtime,'backups','b','mcp','credentials','gh'),'{}');await writeFile(join(runtime,'note.txt'),'x')
 const live=await realpath(join(runtime,'dsh','.credentials.yaml'))
 const handle=createCredentialStoreHandler({status:()=>({tier:'keyring',fault:null}),runtimeRoot:runtime,exclude:path=>path===live})
 const status=await handle('credential-store/status',{}) as {tier:string;copies:{id:string;label:string}[]}
 assert.deepEqual(status.copies.map(copy=>copy.label).sort(),['.runtime-upgrade-backup-x/dsh/.credentials.yaml','.runtime/backups/b/mcp/credentials/gh'])
 await assert.rejects(handle('credential-store/plaintext-copies/delete',{ids:['../x']}),/格式/)
 const after=await handle('credential-store/plaintext-copies/delete',{ids:[status.copies[0]!.id]}) as {copies:unknown[]}
 assert.equal(after.copies.length,1);await stat(live)
 assert.equal((await findPlaintextCopies(runtime,()=>false)).length,2)
})

/** 源码与 npm 两种布局：运行目录与 DSH_HOME 同级（.runtime/{teloa,dsh}、instances/default/{runtime,dsh}）。 */
async function layout(t:Parameters<typeof tempHome>[0]){
 const base=await realpath(await tempHome(t)),parent=join(base,'.runtime'),runtime=join(parent,'teloa'),dshHome=join(parent,'dsh')
 await mkdir(join(runtime,'mcp','credentials'),{recursive:true});await mkdir(dshHome,{recursive:true})
 return {base,parent,runtime,dshHome}
}

test('清单纳入 DSH_HOME 的隔离副本、首启残留、原子写残留、同级备份目录与项目根的升级备份，在用文件与受管 MCP 在用目录除外',async t=>{
 const {base,parent,runtime,dshHome}=await layout(t),outside=await realpath(await tempHome(t))
 const quarantined=join(dshHome,'.credentials.yaml.quarantine-2026-09-26T00-00-00-000Z-a1b2c3'),leftover=join(dshHome,'.credentials.yaml'),temp=join(dshHome,'.credentials.yaml.0123456789ab.tmp')
 for(const path of [quarantined,leftover,temp])await writeFile(path,'x',{mode:0o600})
 await writeFile(join(runtime,'mcp','credentials','github'),'{}',{mode:0o600})
 await mkdir(join(parent,'backups','pre','dsh'),{recursive:true});await writeFile(join(parent,'backups','pre','dsh','.credentials.yaml'),'x')
 await mkdir(join(base,'.runtime-upgrade-backup-0.1.2','dsh'),{recursive:true});await writeFile(join(base,'.runtime-upgrade-backup-0.1.2','dsh','.credentials.yaml'),'x')
 await writeFile(join(dshHome,'.credentials.enc'),'x');await writeFile(join(dshHome,'.credentials.meta.json'),'{}');await writeFile(join(dshHome,'.env'),'X=1')
 const external=join(outside,'.credentials.yaml.quarantine-ext');await writeFile(external,'x',{mode:0o600})
 await symlink(join(outside,'target'),join(dshHome,'.credentials.yaml.quarantine-link'))
 const liveMcp=join(runtime,'mcp','credentials')
 const labels=async(live:string|undefined)=>(await findPlaintextCopies(runtime,path=>path===live||path.startsWith(liveMcp+'/'),{dshHome,files:[external,join(dshHome,'.credentials.yaml.quarantine-link')]})).map(copy=>copy.label).sort()
 const expected=[join(base,'.runtime-upgrade-backup-0.1.2','dsh','.credentials.yaml'),'backups/pre/dsh/.credentials.yaml','dsh/.credentials.yaml.0123456789ab.tmp','dsh/.credentials.yaml.quarantine-2026-09-26T00-00-00-000Z-a1b2c3']
 assert.deepEqual(await labels(leftover),[...expected,external].sort())
 assert.deepEqual(await labels(undefined),[...expected,external,'dsh/.credentials.yaml'].sort()) // 加密档读好后首启残留不再在用
 // 与运行目录不同级的 DSH_HOME（例如指到家目录）只扫它自己，不扩大到上一级；运行目录之外的副本标签用绝对路径
 const lone=join(outside,'home');await mkdir(lone);await writeFile(join(lone,'.credentials.yaml'),'x');await writeFile(join(outside,'.credentials.yaml'),'x')
 assert.deepEqual((await findPlaintextCopies(runtime,()=>false,{dshHome:lone})).map(copy=>copy.label).filter(label=>label.startsWith(outside)),[join(lone,'.credentials.yaml')])
})

test('工作区（用户项目文件，模型可写）不扫描：其中同名文件不当作 Teloa 的明文副本',async t=>{
 const {runtime,dshHome}=await layout(t),workspace=join(runtime,'workspace','repo')
 await mkdir(workspace,{recursive:true});await writeFile(join(workspace,'.credentials.yaml'),'x')
 await writeFile(join(dshHome,'.credentials.yaml.quarantine-a'),'x')
 assert.deepEqual((await findPlaintextCopies(runtime,()=>false,{dshHome,skip:[join(runtime,'workspace')]})).map(copy=>copy.label),['dsh/.credentials.yaml.quarantine-a'])
 const handle=createCredentialStoreHandler({status:()=>({tier:'keyring',fault:null}),runtimeRoot:runtime,exclude:()=>false,dshHome:()=>dshHome,skip:()=>[join(runtime,'workspace')]})
 assert.deepEqual((await handle('credential-store/status',{}) as {copies:{label:string}[]}).copies.map(copy=>copy.label),['dsh/.credentials.yaml.quarantine-a'])
})

test('其它 DSH_HOME 带存活的运行标记（宿主正在运行）：整目录跳过；标记对应进程已退出的照常列入；本安装的 DSH_HOME 不受影响',async t=>{
 const {parent,runtime,dshHome}=await layout(t)
 const {spawnSync}=await import('node:child_process')
 const dead=spawnSync(process.execPath,['-e','0']).pid!
 const running=join(parent,'acceptance-a','dsh'),stopped=join(parent,'acceptance-b','dsh')
 for(const dir of [running,stopped]){await mkdir(join(dir,'sub'),{recursive:true});await writeFile(join(dir,'.credentials.yaml'),'x');await writeFile(join(dir,'sub','.credentials.yaml'),'x')}
 await writeFile(join(running,'.credentials.host.pid'),process.ppid+'\n');await writeFile(join(stopped,'.credentials.host.pid'),dead+'\n')
 await writeFile(join(dshHome,'.credentials.host.pid'),process.pid+'\n');await writeFile(join(dshHome,'.credentials.yaml.quarantine-a'),'x')
 assert.deepEqual((await findPlaintextCopies(runtime,()=>false,{dshHome})).map(copy=>copy.label),['acceptance-b/dsh/.credentials.yaml','acceptance-b/dsh/sub/.credentials.yaml','dsh/.credentials.yaml.quarantine-a'])
})

test('npm 安装：升级前自动备份（<home>.backups）里的旧明文副本进清单',async t=>{
 const base=await realpath(await tempHome(t)),home=join(base,'.teloa'),runtime=join(home,'instances','default','runtime'),dshHome=join(home,'instances','default','dsh')
 await mkdir(runtime,{recursive:true});await mkdir(dshHome,{recursive:true})
 const backup=join(base,'.teloa.backups','before-0.2.0-x','dsh');await mkdir(backup,{recursive:true});await writeFile(join(backup,'.credentials.yaml'),'x')
 assert.deepEqual((await findPlaintextCopies(runtime,()=>false,{dshHome})).map(copy=>copy.label),[join(backup,'.credentials.yaml')])
})

test('删除走安全擦除：原位零覆写并落盘后删除；硬链接、不可写与删除前换成链接的一律拒绝且不改外部文件',async t=>{
 const {runtime,dshHome}=await layout(t),outside=await realpath(await tempHome(t)),value='sk-'+'x'.repeat(40)
 const plain=join(dshHome,'.credentials.yaml.quarantine-a'),shared=join(dshHome,'.credentials.yaml.quarantine-b'),locked=join(dshHome,'.credentials.yaml.quarantine-c'),swapped=join(dshHome,'.credentials.yaml.quarantine-d')
 for(const path of [plain,locked,swapped])await writeFile(path,value,{mode:0o600})
 const external=join(outside,'shared.txt');await writeFile(external,value,{mode:0o644});await link(external,shared)
 await chmod(locked,0o400)
 const handle=createCredentialStoreHandler({status:()=>({tier:'keyring',fault:null}),runtimeRoot:runtime,exclude:()=>false,dshHome:()=>dshHome})
 const listed=(await handle('credential-store/status',{}) as {copies:{id:string;label:string}[]}).copies
 assert.deepEqual(listed.map(copy=>copy.label),['dsh/.credentials.yaml.quarantine-a','dsh/.credentials.yaml.quarantine-b','dsh/.credentials.yaml.quarantine-c','dsh/.credentials.yaml.quarantine-d'])
 const probe=await open(plain,'r') // 保留句柄：删除后仍能读到同一 inode，核对确为零覆写
 t.after(()=>probe.close())
 // 列出之后被换成指向外部文件的符号链接：不跟随、不删除目标
 const victim=join(outside,'victim.txt');await writeFile(victim,'victim',{mode:0o600})
 await rename(swapped,swapped+'.moved');await symlink(victim,swapped)
 const after=await handle('credential-store/plaintext-copies/delete',{ids:listed.map(copy=>copy.id)}) as {copies:{label:string}[];refused:number}
 const zeroed=await probe.readFile()
 assert.equal(zeroed.length,value.length);assert.ok(zeroed.every(byte=>byte===0))
 await assert.rejects(stat(plain))
 assert.equal(after.refused,2)
 assert.deepEqual(after.copies.map(copy=>copy.label),['dsh/.credentials.yaml.quarantine-b','dsh/.credentials.yaml.quarantine-c','dsh/.credentials.yaml.quarantine-d.moved'])
 assert.equal(await readFile(external,'utf8'),value);assert.equal((await stat(external)).mode&0o777,0o644)
 assert.equal(await readFile(locked,'utf8'),value);assert.equal((await stat(locked)).mode&0o777,0o400)
 assert.equal(await readFile(victim,'utf8'),'victim')
 assert.ok((await readdir(dshHome)).includes('.credentials.yaml.quarantine-d'))
 assert.equal((await handle('credential-store/status',{}) as Record<string,unknown>).refused,undefined)
})

test('擦除前核对扫描时的 dev/ino 与所在目录真实路径（/tmp 复现）：清单之后中间目录换成链接、或文件被同名普通文件替换，一律拒绝且不动清单外文件',async t=>{
 const {runtime}=await layout(t),outside=await realpath(await tempHome(t)),dir=join(runtime,'backups','b','mcp','credentials'),victims=join(outside,'victims')
 await mkdir(dir,{recursive:true});await mkdir(victims,{recursive:true})
 await writeFile(join(dir,'gh'),'old-gh',{mode:0o600});await writeFile(join(dir,'gl'),'old-gl',{mode:0o600})
 await writeFile(join(victims,'gh'),'victim-gh',{mode:0o600})
 // 删除请求重新列清单时，趁扫描把中间目录换成指向清单外目录的链接（审查 M1 的探针手法）
 let attack:((path:string)=>void)|undefined
 const handle=createCredentialStoreHandler({status:()=>({tier:'keyring',fault:null}),runtimeRoot:runtime,exclude:path=>{attack?.(path);return false}})
 const listed=(await handle('credential-store/status',{}) as {copies:{id:string;label:string}[]}).copies
 assert.deepEqual(listed.map(copy=>copy.label).sort(),['teloa/backups/b/mcp/credentials/gh','teloa/backups/b/mcp/credentials/gl'])
 const gh=listed.find(copy=>copy.label.endsWith('/gh'))!
 attack=path=>{if(path===join(dir,'gh')){attack=undefined;renameSync(dir,dir+'.orig');symlinkSync(victims,dir)}}
 const after=await handle('credential-store/plaintext-copies/delete',{ids:[gh.id]}) as {refused:number}
 assert.equal(after.refused,1)
 assert.equal(await readFile(join(victims,'gh'),'utf8'),'victim-gh')
 assert.equal(await readFile(join(dir+'.orig','gh'),'utf8'),'old-gh')
 // 路径最后一段被同名普通文件替换（链接数为 1、不是链接）：inode 与扫描时不符，同样拒绝
 await rm(dir);renameSync(dir+'.orig',dir)
 const again=(await handle('credential-store/status',{}) as {copies:{id:string;label:string}[]}).copies.find(copy=>copy.label.endsWith('/gl'))!
 attack=path=>{if(path===join(dir,'gl')){attack=undefined;renameSync(join(dir,'gl'),join(dir,'gl.moved'));writeFileSync(join(dir,'gl'),'replacement',{mode:0o600})}}
 assert.equal((await handle('credential-store/plaintext-copies/delete',{ids:[again.id]}) as {refused:number}).refused,1)
 assert.equal(await readFile(join(dir,'gl'),'utf8'),'replacement')
})

test('清单标出与其他路径共用内容的项（硬链接）：需手动处理，普通项不标',async t=>{
 const {runtime,dshHome}=await layout(t),outside=await realpath(await tempHome(t))
 const external=join(outside,'shared.txt');await writeFile(external,'x',{mode:0o600});await link(external,join(dshHome,'.credentials.yaml.quarantine-b'))
 await writeFile(join(dshHome,'.credentials.yaml.quarantine-a'),'x',{mode:0o600})
 const handle=createCredentialStoreHandler({status:()=>({tier:'keyring',fault:null}),runtimeRoot:runtime,exclude:()=>false,dshHome:()=>dshHome})
 const copies=(await handle('credential-store/status',{}) as {copies:{id:string;label:string;shared:boolean}[]}).copies
 assert.deepEqual(copies.map(({label,shared})=>({label,shared})),[{label:'dsh/.credentials.yaml.quarantine-a',shared:false},{label:'dsh/.credentials.yaml.quarantine-b',shared:true}])
 assert.deepEqual(Object.keys(copies[0]!).sort(),['id','label','shared'])
})

test('请求形状：状态只收空对象，删除只收 ids 且不超过 100 项；未知端点 not-found',async t=>{
 const {runtime}=await layout(t)
 const handle=createCredentialStoreHandler({status:()=>({tier:null,fault:'key-unavailable'}),runtimeRoot:runtime,exclude:()=>false})
 assert.deepEqual(await handle('credential-store/status',{}),{tier:null,fault:'key-unavailable',copies:[]})
 await assert.rejects(handle('credential-store/status',{x:1}),/格式/)
 for(const payload of [{},{ids:[]},{ids:['a'.repeat(32)],extra:1},{ids:Array.from({length:101},()=>'a'.repeat(32))},{ids:['A'.repeat(32)]},null,[]])await assert.rejects(handle('credential-store/plaintext-copies/delete',payload),/格式/)
 await assert.rejects(handle('credential-store/other',{}),(error:{code?:string})=>error.code==='teloa/not-found')
})

test('AI 与会话工具不能调用凭据存储端点：只经本人浏览器的 /teloa 连接分发，进程内调用口一律拒绝',async()=>{
 const calls:string[]=[]
 const work=createTeloaWorkService({owner:'local:teloa-owner',runtimeRoot:'/tmp/x',dispatch:async endpoint=>{calls.push(endpoint)},broadcast:{add:()=>()=>{}} as never,install:async()=>'',attachAllowed:()=>false})
 for(const endpoint of ['credential-store/status','credential-store/plaintext-copies/delete'])await assert.rejects(work.invoke(endpoint,{ids:['a'.repeat(32)]},new AbortController().signal),(error:{code?:string})=>error.code==='teloa/forbidden')
 assert.deepEqual(calls,[])
 const source=await readFile(new URL('../src/index.ts',import.meta.url),'utf8')
 // 处理器只在 /teloa 连接处理函数里调用一次，且不进入 endpointSet（dispatchTeloaEndpoint 与 teloaWork.invoke 都以它为前置门槛）
 assert.equal(source.split('credentialStoreHandler(').length-1,1)
 const rpc=source.indexOf("connection.rpc.handle('/teloa'"),call=source.indexOf('credentialStoreHandler('),dispatch=source.indexOf('const dispatchTeloaEndpoint=')
 assert.ok(rpc>0&&call>rpc&&call<source.indexOf('ctx.tools.register',rpc))
 assert.ok(!source.slice(dispatch,rpc).includes('credentialStore'))
 assert.ok(!/const endpointSet=new Set\([^\n]*credentialStore/.test(source))
 // 任何注册模型工具的源文件都不引用凭据存储端点
 const dir=new URL('../src/',import.meta.url)
 for(const name of await readdir(dir)){
  if(!name.endsWith('.ts'))continue
  const text=await readFile(new URL(name,dir),'utf8')
  if(text.includes('defineTool('))assert.ok(!text.includes('credential-store/'),name)
 }
})
