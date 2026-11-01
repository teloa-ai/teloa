import test from 'node:test'
import assert from 'node:assert/strict'
import {execFileSync,spawnSync} from 'node:child_process'
import {mkdtemp,mkdir,writeFile,readFile,lstat,open,symlink,rm,realpath,chmod} from 'node:fs/promises'
import {tmpdir,release} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {copyBackupData} from '../src/maintenance.ts'
const cli=fileURLToPath(new URL('..',import.meta.url)),helper=join(cli,'libexec/maintenance-process')
const supported=process.platform==='darwin'&&process.arch==='arm64'&&release().split('.')[0]==='25'
const hash=(v:Buffer)=>createHash('sha256').update(v).digest('hex')
test('备份大文件严格CoW：字节与0600不变，拒绝链接和既有目标，独立修改互不影响',{skip:!supported},async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-backup-clone-')));t.after(()=>rm(root,{recursive:true,force:true}))
 const source=join(root,'source'),target=join(root,'target');await mkdir(source,{mode:0o700});await mkdir(target,{mode:0o700})
 const body=Buffer.alloc(1024*1024,0x51),file=join(source,'fixture.bin');await writeFile(file,body,{mode:0o640});const before=await lstat(file)
 let result=spawnSync(helper,['clone-backup',source,target,'fixture.bin'],{encoding:'utf8'});assert.equal(result.status,0,result.stderr)
 assert.equal(JSON.parse(result.stdout).method,'fclonefileat');assert.equal(hash(await readFile(join(target,'fixture.bin'))),hash(body));assert.equal((await lstat(join(target,'fixture.bin'))).mode&0o777,0o600)
 const after=await lstat(file);for(const key of ['ino','dev','size','mtimeMs','ctimeMs','mode'] as const)assert.equal(after[key],before[key])
 const clone=await open(join(target,'fixture.bin'),'r+');await clone.write(Buffer.from([0x22]),0,1,0);await clone.close();assert.equal((await readFile(file))[0],0x51)
 const original=await open(file,'r+');await original.write(Buffer.from([0x33]),0,1,1);await original.close();assert.equal((await readFile(join(target,'fixture.bin')))[1],0x51)
 assert.notEqual(spawnSync(helper,['clone-backup',source,target,'fixture.bin']).status,0)
 await symlink('fixture.bin',join(source,'link.bin'));assert.notEqual(spawnSync(helper,['clone-backup',source,target,'link.bin']).status,0)
 await symlink(target,join(root,'target-link'));assert.notEqual(spawnSync(helper,['clone-backup',source,join(root,'target-link'),'fixture.bin']).status,0)
 assert.notEqual(spawnSync(helper,['clone-backup',source,target,'../fixture.bin']).status,0)
 await mkdir(join(target,'nested'),{mode:0o700});await symlink(source,join(source,'nested'));assert.notEqual(spawnSync(helper,['clone-backup',source,target,'nested/fixture.bin']).status,0)
})
test('官方备份复制>=16MiB走可信helper，普通小文件与原模式保持',{skip:!supported},async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-backup-copy-')));t.after(()=>rm(root,{recursive:true,force:true}))
 const source=join(root,'source'),target=join(root,'target');await mkdir(source,{mode:0o700})
 const body=Buffer.alloc(16*1024*1024,0x71);await writeFile(join(source,'large.bin'),body,{mode:0o644});await writeFile(join(source,'small.txt'),'small',{mode:0o644})
 await copyBackupData(source,target,fileURLToPath(new URL('../../../',import.meta.url)))
 // 私有目标校验失败不能普通复制回退；此断言在原copyFile实现上应失败。
 const rejected=join(root,'unsafe-target');await mkdir(rejected,{mode:0o755});await chmod(rejected,0o755)
 await assert.rejects(copyBackupData(source,rejected,fileURLToPath(new URL('../../../',import.meta.url))),/共享块备份失败/)
 await assert.rejects(lstat(join(rejected,'large.bin')),/ENOENT/)
 await symlink(source,join(root,'source-link'));await assert.rejects(copyBackupData(join(root,'source-link'),join(root,'root-link-target'),fileURLToPath(new URL('../../../',import.meta.url))),/根目录不能是符号链接/)
 assert.equal(hash(await readFile(join(target,'large.bin'))),hash(body));assert.equal(await readFile(join(target,'small.txt'),'utf8'),'small')
 for(const name of ['large.bin','small.txt'])assert.equal((await lstat(join(target,name))).mode&0o777,0o600)
})

test('跨设备前置拒绝分支：仅注入目标st_dev，不执行跨卷普通复制',{skip:!supported},async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-clone-device-')));t.after(()=>rm(root,{recursive:true,force:true}))
 const source=join(root,'source'),target=join(root,'cross-device-target'),binary=join(root,'cross-device-helper');await mkdir(source,{mode:0o700});await mkdir(target,{mode:0o700});await writeFile(join(source,'fixture.bin'),'same-user-source',{mode:0o600})
 execFileSync('xcrun',['clang','-std=c11','-O2','-Wall','-Wextra','-Werror','-DTELOA_OS_MAJOR=25','-DTELOA_BUILD_ARCH="arm64"',join(cli,'tests/fixtures/maintenance-backup-cross-device.c'),'-o',binary],{stdio:'pipe'})
 const result=spawnSync(binary,['clone-backup',source,target,'fixture.bin'],{encoding:'utf8'});assert.equal(result.status,1);assert.match(result.stderr,/backup clone refused/);await assert.rejects(lstat(join(target,'fixture.bin')),/ENOENT/)
})
