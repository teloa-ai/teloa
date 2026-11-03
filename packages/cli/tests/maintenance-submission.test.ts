import test from 'node:test'
import assert from 'node:assert/strict'
import {parseArguments} from '../src/bin.ts'

test('未知提交维护必须精确选择原Run并承认未知，不能泛用force或自动启动',()=>{
const run='10000000-0000-4000-8000-000000000001'
 assert.deepEqual(parseArguments(['resolve-submission','--run',run,'--acknowledge-unknown','--to','0.2.12']),{command:'resolve-submission',options:{run,'acknowledge-unknown':true,to:'0.2.12'}})
 assert.deepEqual(parseArguments(['resolve-submission','--run',run,'--acknowledge-unknown','--to','0.2.12','--source-release','/original-target','--finish']),{command:'resolve-submission',options:{run,'acknowledge-unknown':true,to:'0.2.12','source-release':'/original-target',finish:true}})
 for(const args of [['resolve-submission','--source-release','/original-target'],['resolve-submission','--run',run,'--to','0.2.12','--source-release','/original-target'],['up','--source-release','/original-target'],['resolve-submission','--run',run,'--acknowledge-unknown','--to','0.2.12','--source-release']])assert.throws(()=>parseArguments(args))
 for(const args of [['resolve-submission'],['resolve-submission','--run',run,'--to','0.2.12'],['resolve-submission','--run','all','--acknowledge-unknown','--to','0.2.12'],['resolve-submission','--run',run,'--acknowledge-unknown','--to','latest'],['resolve-submission','--force'],['resolve-submission','--run',run,'--acknowledge-unknown','--to','0.2.12','--start']])assert.throws(()=>parseArguments(args))
})

import * as maintenance from '../src/maintenance.ts'
import {mkdtemp,writeFile,mkdir,rm,realpath} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash,randomUUID} from 'node:crypto'

test('专用维护备份绑定同安装且普通restore验证器拒绝，不能伪装普通保护点',async t=>{
 const verify=Reflect.get(maintenance,'verifySubmissionMaintenanceBackup')
 assert.equal(typeof verify,'function','缺少同安装专用备份验证器')
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-maintenance-backup-')))
 t.after(()=>rm(root,{recursive:true,force:true}))
 const bindingSha256='a'.repeat(64),installId=randomUUID(),home=join(root,'original-home')
 await mkdir(join(root,'dsh'));await mkdir(join(root,'runtime'))
 const files={'database.dump':'original pending run','installation.json':JSON.stringify({workspaceRoot:'/original',port:3123}),'maintenance-receipt.json':JSON.stringify({bindingSha256})}
 for(const [name,body] of Object.entries(files))await writeFile(join(root,name),body,{mode:0o600})
 const manifest={schema:'teloa.maintenance-backup/v1',id:randomUUID(),createdAt:new Date().toISOString(),installId,home,bindingSha256,version:'0.2.10',dataVersion:2,externalWorkspaceIncluded:false,files:Object.entries(files).map(([path,body])=>({path,sha256:createHash('sha256').update(body).digest('hex')}))}
 await writeFile(join(root,'backup-manifest.json'),JSON.stringify(manifest),{mode:0o600})
 assert.deepEqual(await verify(root,{installId,home,bindingSha256}),manifest)
 await assert.rejects(maintenance.verifyBackup(root),/维护备份|清单无效/)
 for(const expected of [{installId:randomUUID(),home,bindingSha256},{installId,home:home+'-copy',bindingSha256},{installId,home,bindingSha256:'b'.repeat(64)}])await assert.rejects(verify(root,expected))
 await writeFile(join(root,'database.dump'),'changed')
 await assert.rejects(verify(root,{installId,home,bindingSha256}),/摘要/)
})

test('确定未发布维护与承认未知互斥，保留精确原Run和固定目标',()=>{
 const run='10000000-0000-4000-8000-000000000001'
 assert.deepEqual(parseArguments(['resolve-submission','--run',run,'--cancel-not-published','--to','0.2.98']),{command:'resolve-submission',options:{run,'cancel-not-published':true,to:'0.2.98'}})
 assert.throws(()=>parseArguments(['resolve-submission','--run',run,'--cancel-not-published','--acknowledge-unknown','--to','0.2.98']))
})
