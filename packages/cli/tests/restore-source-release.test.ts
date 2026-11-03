import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,mkdir,writeFile,readFile,readdir,lstat,realpath,rm,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {main,parseArguments} from '../src/bin.ts'
import {backupFileRecords,copyBackupData} from '../src/maintenance.ts'

const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
async function fixture(t:{after:(fn:()=>Promise<void>)=>unknown}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-restore-old-source-')));t.after(()=>rm(root,{recursive:true,force:true}))
 const release=join(root,'frozen-old-release'),source=join(root,'old-dsh'),archive=join(root,'archive'),workspace=join(root,'workspace'),target=join(root,'new-home')
 await mkdir(release);await mkdir(workspace);await writeFile(join(release,'entry.js'),'old source')
 await writeFile(join(release,'release-manifest.json'),JSON.stringify({schema:'teloa.release/v1',version:'0.2.112',dshVersion:'0.2.1-rc.2',dataVersion:10,compatibleDataVersions:[10],files:[{path:'entry.js',sha256:hash('old source')}]}),{mode:0o600})
 const modules=join(source,'profiles/teloa/node_modules');await mkdir(join(modules,'@fixture/vendor/bin'),{recursive:true});await mkdir(join(modules,'.bin'))
 await writeFile(join(modules,'@fixture/vendor/package.json'),JSON.stringify({name:'@fixture/vendor',version:'1.0.0',bin:{vendor:'bin/cli.js'}}))
 await writeFile(join(modules,'@fixture/vendor/bin/cli.js'),'// isolated snapshot only',{mode:0o700});await symlink('../@fixture/vendor/bin/cli.js',join(modules,'.bin/vendor'))
 await copyBackupData(source,join(archive,'dsh'),release,true);await writeFile(join(archive,'database.dump'),'isolated dump');await writeFile(join(archive,'installation.json'),JSON.stringify({workspaceRoot:workspace,port:3296}),{mode:0o600})
 await writeFile(join(archive,'backup-manifest.json'),JSON.stringify({schema:'teloa.backup/v1',id:randomUUID(),installId:randomUUID(),createdAt:new Date().toISOString(),version:'0.2.112',dataVersion:10,files:await backupFileRecords(archive),externalWorkspaceIncluded:false}),{mode:0o600})
 return{root,release,archive,target,run:()=>main(['restore','--from',archive,'--home',target,'--source-release',release])}
}
test('normal restore 明确接受旧 source-release，仍要求新目标且不会触及 PG',async t=>{
 const f=await fixture(t)
 assert.deepEqual(parseArguments(['restore','--from',f.archive,'--home',f.target,'--source-release',f.release]),{command:'restore',options:{from:f.archive,home:f.target,'source-release':f.release}})
 await mkdir(f.target);await writeFile(join(f.target,'sentinel'),'preserve')
 // 真正经过 main 与旧版本/新链接清单校验，在数据库动作前由非空新目标保护明确停止。
 await assert.rejects(f.run(),/恢复目标已有数据/)
 assert.deepEqual(await readdir(f.target),['sentinel']);assert.equal(await readFile(join(f.target,'sentinel'),'utf8'),'preserve')
})
test('normal restore 的 source-release 仍拒绝版本、数据版本、坏摘要、外链及未验发行目录',async t=>{
 for(const variant of ['version','data-version','digest','release-file-link','unverified'] as const)await t.test(variant,async sub=>{
  const f=await fixture(sub),path=join(f.release,'release-manifest.json'),m=JSON.parse(await readFile(path,'utf8'))
  if(variant==='version'){m.version='0.2.113';await writeFile(path,JSON.stringify(m))}
  if(variant==='data-version'){m.dataVersion=12;await writeFile(path,JSON.stringify(m))}
  if(variant==='digest')await writeFile(join(f.release,'entry.js'),'changed')
  if(variant==='release-file-link'){const external=join(f.root,'external');await writeFile(external,'old source');await rm(join(f.release,'entry.js'));await symlink(external,join(f.release,'entry.js'))}
  if(variant==='unverified')await rm(path)
  await assert.rejects(f.run(),variant==='version'||variant==='data-version'?/完全匹配/:variant==='digest'?/摘要/:variant==='release-file-link'?/发行文件路径/:{code:'ENOENT'})
  await assert.rejects(lstat(f.target),{code:'ENOENT'})
 })
})
