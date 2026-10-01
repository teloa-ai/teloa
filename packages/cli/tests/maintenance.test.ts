import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,mkdir,writeFile,symlink,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
const api=await import('../src/maintenance.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error}) as any
const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'teloa-backup-test-'))
 await mkdir(join(root,'dsh'))
 await writeFile(join(root,'database.dump'),'dump',{mode:0o600})
 await writeFile(join(root,'dsh/session'),'session',{mode:0o600})
 await writeFile(join(root,'installation.json'),JSON.stringify({workspaceRoot:'/temporary/workspace',port:3999}),{mode:0o600})
 const manifest={schema:'teloa.backup/v1',id:randomUUID(),createdAt:new Date().toISOString(),installId:randomUUID(),version:'0.2.0-alpha.3',dataVersion:1,files:[{path:'database.dump',sha256:hash('dump')},{path:'dsh/session',sha256:hash('session')},{path:'installation.json',sha256:hash(await readFile(join(root,'installation.json'),'utf8'))}],externalWorkspaceIncluded:false}
 await writeFile(join(root,'backup-manifest.json'),JSON.stringify(manifest),{mode:0o600})
 return {root,manifest}
}
test('备份校验读取所有摘要，坏摘要及未知数据版本拒绝',async()=>{
 assert.equal(typeof api.verifyBackup,'function')
 const {root,manifest}=await fixture()
 assert.deepEqual(await api.verifyBackup(root),manifest)
 await writeFile(join(root,'database.dump'),'tampered')
 await assert.rejects(api.verifyBackup(root),/摘要/)
 const other=await fixture();other.manifest.dataVersion=99
 await writeFile(join(other.root,'backup-manifest.json'),JSON.stringify(other.manifest))
 await assert.rejects(api.verifyBackup(other.root),/版本/)
})
test('拒绝备份路径穿越、软链接、未列入清单的文件与重复路径',async()=>{
 for(const path of ['../escape','/absolute','dsh/../escape','dsh\\escape']){
  const {root,manifest}=await fixture();manifest.files[0]!.path=path
  await writeFile(join(root,'backup-manifest.json'),JSON.stringify(manifest))
  await assert.rejects(api.verifyBackup(root),/路径/)
 }
 const extra=await fixture();await writeFile(join(extra.root,'unlisted'),'x');await assert.rejects(api.verifyBackup(extra.root),/清单/)
 const linked=await fixture();await symlink('/tmp',join(linked.root,'outside'));await assert.rejects(api.verifyBackup(linked.root),/链接/)
 const duplicate=await fixture();duplicate.manifest.files.push(duplicate.manifest.files[0]!)
 await writeFile(join(duplicate.root,'backup-manifest.json'),JSON.stringify(duplicate.manifest));await assert.rejects(api.verifyBackup(duplicate.root),/路径/)
})
test('维护只接受明确停止状态，不把 ready、unknown、失败或在跑工作视为空闲',()=>{
 assert.equal(typeof api.assertMaintenanceStopped,'function')
 for(const app of ['ready','starting','unknown','failed'])assert.throws(()=>api.assertMaintenanceStopped({app,activeWork:0},'stopped'),/停止/)
 assert.throws(()=>api.assertMaintenanceStopped({app:'stopped',activeWork:0},'failed'),/停止/)
 assert.doesNotThrow(()=>api.assertMaintenanceStopped({app:'stopped',activeWork:-1},'stopped'))
})
test('只省略 DSH 三处生成依赖链接，外部链接仍拒绝',async()=>{
 const root=await mkdtemp(join(tmpdir(),'teloa-generated-')),source=join(root,'dsh'),release=join(root,'release')
 await mkdir(release);await writeFile(join(release,'package.json'),'{}')
 for(const path of ['profiles/node_modules','profiles/teloa/node_modules','profiles/teloa/.dsh-module-fallback/node_modules']){
  await mkdir(join(source,path),{recursive:true});await symlink(release,join(source,path,'generated'))
 }
 await api.copyBackupData(source,join(root,'backup'),release,true)
 await symlink('/tmp',join(source,'external'))
 await assert.rejects(api.copyBackupData(source,join(root,'bad'),release,true),/外链/)
})
test('恢复之前验证原工作目录，不能用缺失路径或普通文件冒充',async()=>{
 assert.equal(typeof api.assertRestoreWorkspace,'function')
 const root=await mkdtemp(join(tmpdir(),'teloa-restore-workspace-'))
 await assert.rejects(api.assertRestoreWorkspace(join(root,'missing')),/工作目录/)
 await writeFile(join(root,'file'),'x');await assert.rejects(api.assertRestoreWorkspace(join(root,'file')),/工作目录/)
 await api.assertRestoreWorkspace(root)
})

test('备份跳过凭据文件与受管 MCP 凭据目录',async()=>{
 const source=await mkdtemp(join(tmpdir(),'teloa-cred-backup-')),target=source+'-out'
 await mkdir(join(source,'mcp','credentials'),{recursive:true})
 for(const name of ['.credentials.yaml','.credentials.enc','.credentials.meta.json','.credentials.host.pid','.credentials.enc.bak-2026-09-26T00-00-00-000Z','.credentials.yaml.quarantine-2026-09-26T00-00-00-000Z-a1b2c3','.credentials.yaml.0123456789ab.tmp','.credentials.enc.lock','.credentials.keyring-accounts','keep.json'])await writeFile(join(source,name),'x',{mode:0o600})
 await writeFile(join(source,'mcp','credentials','gh'),'{}',{mode:0o600})
 await api.copyBackupData(source,target,source)
 const {readdir}=await import('node:fs/promises')
 assert.deepEqual((await readdir(target)).sort(),['keep.json','mcp'])
 assert.deepEqual(await readdir(join(target,'mcp')),[])
})

test('备份跳过 DSH 目录根下的 .env（可能含明文密钥），备份与恢复输出提示自行保存',async()=>{
 const source=await mkdtemp(join(tmpdir(),'teloa-env-backup-')),target=source+'-out'
 await mkdir(join(source,'profiles'),{recursive:true})
 await writeFile(join(source,'.env'),'DEEPSEEK_API_KEY=x',{mode:0o600});await writeFile(join(source,'profiles','.env'),'X=1',{mode:0o600});await writeFile(join(source,'keep.json'),'{}',{mode:0o600})
 await api.copyBackupData(source,target,source)
 const {readdir}=await import('node:fs/promises')
 assert.deepEqual((await readdir(target)).sort(),['keep.json','profiles'])
 assert.deepEqual(await readdir(join(target,'profiles')),['.env'])
 assert.match(api.dshEnvBackupNotice,/\.env/);assert.match(api.dshEnvBackupNotice,/自行/)
 assert.match(api.dshEnvRestoreNotice('/home/new/instances/default/dsh'),/\/home\/new\/instances\/default\/dsh\/\.env/)
 const bin=await readFile(new URL('../src/bin.ts',import.meta.url),'utf8')
 assert.match(bin,/dshEnvBackupNotice/);assert.match(bin,/dshEnvRestoreNotice\(restored\.layout\.dshHome\)/)
})

test('恢复旧备份：从清单读出两类旧明文凭据交给导入，不含其它文件',async()=>{
 const root=await mkdtemp(join(tmpdir(),'teloa-legacy-restore-'))
 await mkdir(join(root,'dsh'),{recursive:true});await mkdir(join(root,'runtime','mcp','credentials'),{recursive:true})
 await writeFile(join(root,'dsh','.credentials.yaml'),'version: 1\n');await writeFile(join(root,'runtime','mcp','credentials','github'),'{"T":"x"}')
 const files=['dsh/.credentials.yaml','runtime/mcp/credentials/github','runtime/mcp/credentials/gh.1.00000000-0000-4000-8000-000000000000.tmp','runtime/other.json'].map(path=>({path,sha256:'0'.repeat(64)}))
 files.push({path:'dsh/.credentials.yaml.0123456789ab.tmp',sha256:'0'.repeat(64)})
 assert.deepEqual(await api.readLegacyBackupCredentials(root,{files}),{yaml:'version: 1\n',mcp:{github:'{"T":"x"}'},dropped:['dsh/.credentials.yaml.0123456789ab.tmp','runtime/mcp/credentials/gh.1.00000000-0000-4000-8000-000000000000.tmp']})
 assert.deepEqual(await api.readLegacyBackupCredentials(root,{files:[{path:'runtime/other.json',sha256:'0'.repeat(64)}]}),{mcp:{},dropped:[]})
})

test('恢复时运行目录不放回旧数据库身份与旧的受管 MCP 明文凭据',()=>{
 const files=['runtime/a.json','runtime/database.json','runtime/postgres.env','runtime/mcp/credentials/github','runtime/mcp/credentials/x.1.00000000-0000-4000-8000-000000000000.tmp','runtime/mcp/connections.json','dsh/x'].map(path=>({path,sha256:'0'.repeat(64)}))
 assert.deepEqual(api.restorableRuntimeFiles({files}).map((row:{path:string})=>row.path),['runtime/a.json','runtime/mcp/connections.json'])
})
