import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,mkdir,writeFile,readFile,readlink,symlink,rm,lstat,rename} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import * as api from '../src/maintenance.ts'

async function fixture(t:{after:(fn:()=>Promise<void>)=>unknown}){
 const root=await mkdtemp(join(tmpdir(),'teloa-package-bin-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const source=join(root,'home/instances/default/dsh'),release=join(root,'home/releases/0.2.116'),modules=join(source,'profiles/teloa/node_modules'),pkg=join(modules,'@anthropic-ai/sdk'),link=join(modules,'.bin/anthropic-ai-sdk')
 await mkdir(join(pkg,'bin'),{recursive:true});await mkdir(join(modules,'.bin'));await mkdir(release,{recursive:true})
 await writeFile(join(pkg,'package.json'),JSON.stringify({name:'@anthropic-ai/sdk',version:'0.93.0',bin:{'anthropic-ai-sdk':'bin/cli'}}))
 await writeFile(join(pkg,'bin/cli'),'#!/usr/bin/env node\n// isolated filesystem fixture\n',{mode:0o700})
 await symlink('../@anthropic-ai/sdk/bin/cli',link)
 return{root,source,release,modules,pkg,link}
}
test('正常 vendor 内部 bin 链接随包正文备份、清单绑定并可恢复到新 home',async t=>{
 const f=await fixture(t),archive=join(f.root,'archive'),restored=join(f.root,'restored-home/instances/default/dsh')
 await api.copyBackupData(f.source,join(archive,'dsh'),f.release,true)
 await writeFile(join(archive,'database.dump'),'isolated dump');await writeFile(join(archive,'installation.json'),'{}')
 const files=await api.backupFileRecords(archive),linkPath='dsh/profiles/teloa/node_modules/.bin/anthropic-ai-sdk'
 assert.equal(files.find(row=>row.path===linkPath)?.symlink,'../@anthropic-ai/sdk/bin/cli')
 await writeFile(join(archive,'backup-manifest.json'),JSON.stringify({schema:'teloa.backup/v1',id:randomUUID(),installId:randomUUID(),createdAt:new Date().toISOString(),version:'0.2.112',dataVersion:10,files,externalWorkspaceIncluded:false}),{mode:0o600})
 await api.verifyBackup(archive)
 await api.copyBackupData(join(archive,'dsh'),restored,f.release)
 const restoredLink=join(restored,'profiles/teloa/node_modules/.bin/anthropic-ai-sdk')
 assert.equal(await readlink(restoredLink),'../@anthropic-ai/sdk/bin/cli')
 assert.deepEqual(await readFile(restoredLink),await readFile(join(f.pkg,'bin/cli')))
 assert.equal((await lstat(join(restored,'profiles/teloa/node_modules/@anthropic-ai/sdk/bin/cli'))).mode&0o777,0o700)
 // 同一正文和目标也不能绕过清单对链接文本与类型的绑定。
 await rm(join(archive,linkPath));await symlink('../@anthropic-ai/sdk/./bin/cli',join(archive,linkPath))
 await assert.rejects(api.verifyBackup(archive))
 await rm(join(archive,linkPath));await writeFile(join(archive,linkPath),'../@anthropic-ai/sdk/bin/cli')
 await assert.rejects(api.verifyBackup(archive))
})
test('vendor bin 外部、悬空、路径逃逸、未声明和未捕获目标仍拒绝',async t=>{
 for(const kind of ['external','dangling','escape','undeclared','uncaptured','absolute','package-symlink','target-symlink'] as const)await t.test(kind,async sub=>{
  const f=await fixture(sub);await rm(f.link)
  let target='../@anthropic-ai/sdk/bin/cli'
  if(kind==='external'){const path=join(f.root,'external');await writeFile(path,'outside');target=path}
  if(kind==='dangling')await rm(join(f.pkg,'bin/cli'))
  if(kind==='escape')target='../../../../../../../../etc/passwd'
  if(kind==='undeclared')await writeFile(join(f.pkg,'package.json'),JSON.stringify({name:'@anthropic-ai/sdk',version:'0.93.0',bin:{other:'bin/cli'}}))
  if(kind==='uncaptured'){await writeFile(join(f.pkg,'session.lock'),'not copied');await writeFile(join(f.pkg,'package.json'),JSON.stringify({name:'@anthropic-ai/sdk',version:'0.93.0',bin:{'anthropic-ai-sdk':'session.lock'}}));target='../@anthropic-ai/sdk/session.lock'}
  if(kind==='absolute')target=join(f.pkg,'bin/cli')
  if(kind==='package-symlink'){const outside=join(f.root,'outside-package');await rename(f.pkg,outside);await symlink(outside,f.pkg)}
  if(kind==='target-symlink'){const outside=join(f.root,'outside-command');await writeFile(outside,'outside');await rm(join(f.pkg,'bin/cli'));await symlink(outside,join(f.pkg,'bin/cli'))}
  await symlink(target,f.link)
  await assert.rejects(api.copyBackupData(f.source,join(f.root,'backup'),f.release,true))
 })
})
test('归档中的命令链接不能借合法外形指向外部或悬空目标',async t=>{
 for(const kind of ['external','dangling','escape'] as const)await t.test(kind,async sub=>{
  const f=await fixture(sub),archive=join(f.root,'archive'),linkPath='dsh/profiles/teloa/node_modules/.bin/anthropic-ai-sdk'
  await api.copyBackupData(f.source,join(archive,'dsh'),f.release,true)
  await writeFile(join(archive,'database.dump'),'dump');await writeFile(join(archive,'installation.json'),'{}')
  const files=await api.backupFileRecords(archive)
  await writeFile(join(archive,'backup-manifest.json'),JSON.stringify({schema:'teloa.backup/v1',id:randomUUID(),installId:randomUUID(),createdAt:new Date().toISOString(),version:'0.2.112',dataVersion:10,files,externalWorkspaceIncluded:false}),{mode:0o600})
  await api.verifyBackup(archive)
  const target=kind==='external'?join(f.pkg,'bin/cli'):kind==='dangling'?'../@anthropic-ai/sdk/bin/missing':'../../../../../../../../../etc/passwd'
  await rm(join(archive,linkPath));await symlink(target,join(archive,linkPath))
  await assert.rejects(api.verifyBackup(archive))
 })
})
