import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,lstat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createHash,randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {resolveLayout} from '../src/layout.ts'
import {prepareSubmissionMaintenanceInspector} from '../src/maintenance-submission.ts'

const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex')
test('停止日志从正式发行副本加载内部包；不修改原npm目录或安装状态',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-maintenance-module-')))
 t.after(()=>rm(root,{recursive:true,force:true}))
 const source=join(root,'npm'),layout=await resolveLayout({home:join(root,'home'),version:'0.2.13'})
 const files={
  'package.json':JSON.stringify({name:'@teloa/cli',version:'0.2.13',type:'module',dependencies:{}}),
  'packages/contract/package.json':JSON.stringify({name:'@teloa/contract',type:'module',exports:'./lib/index.js'}),
  'packages/contract/lib/index.js':'export const scope="fixture-module-resolution"',
  'packages/harness-dsh/package.json':JSON.stringify({name:'@teloa/harness-dsh',type:'module'}),
  'packages/harness-dsh/lib/stopped-task-run-inspection.js':'import {scope} from "@teloa/contract";export async function readStoppedSubmissionSnapshot(){return {scope}}',
 }
 for(const [path,body] of Object.entries(files)){await mkdir(dirname(join(source,path)),{recursive:true});await writeFile(join(source,path),body)}
 const manifest=JSON.stringify({schema:'teloa.release/v1',version:'0.2.13',dataVersion:3,compatibleDataVersions:[3],files:Object.entries(files).map(([path,body])=>({path,sha256:hash(body)}))})
 await writeFile(join(source,'release-manifest.json'),manifest)
 await assert.rejects(import(pathToFileURL(join(source,'packages/harness-dsh/lib/stopped-task-run-inspection.js')).href),/Cannot find package '@teloa\/contract'/)
 const inspect=await prepareSubmissionMaintenanceInspector(source,layout)
 assert.deepEqual(await inspect({dshHome:layout.dshHome,expectedCwd:layout.workspaceRoot,run:{sessionId:'fixture',agentPresetId:'fixture'}}),{scope:'fixture-module-resolution'})
 assert.equal(await readFile(join(source,'release-manifest.json'),'utf8'),manifest)
 await assert.rejects(lstat(join(source,'node_modules')),/ENOENT/)
 await assert.rejects(lstat(join(layout.instanceRoot,'state.json')),/ENOENT/)
 assert.equal(await realpath(join(layout.releaseRoot,'node_modules/@teloa/contract')),join(layout.releaseRoot,'packages/contract'))
})

const packagedRoot=process.env.TELOA_PACKAGED_CLI_ROOT
test('真实已安装npm包的停止日志模块：raw解析失败，正式stage后读取官方持久日志',{skip:!packagedRoot,timeout:180_000},async t=>{
 assert.ok(packagedRoot)
 const manifest=await readFile(join(packagedRoot,'release-manifest.json'))
 assert.match(process.env.TELOA_PACKAGED_CLI_MANIFEST_SHA256??'',/^[a-f0-9]{64}$/)
 assert.equal(hash(manifest),process.env.TELOA_PACKAGED_CLI_MANIFEST_SHA256)
 const release=JSON.parse(manifest.toString()) as {version:string;dataVersion:number}
 assert.equal(release.dataVersion,3)
 await assert.rejects(import(pathToFileURL(join(packagedRoot,'packages/harness-dsh/lib/stopped-task-run-inspection.js')).href),/Cannot find package '@teloa\/contract'/)
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-maintenance-packaged-')))
 t.after(()=>rm(root,{recursive:true,force:true}))
 const layout=await resolveLayout({home:join(root,'home'),workspace:join(root,'workspace'),version:release.version})
 const inspect=await prepareSubmissionMaintenanceInspector(packagedRoot,layout),require=createRequire(join(layout.releaseRoot,'package.json'))
 const {Context}=await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href),Jsonl=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href),{SessionId}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session')).href)
 const ctx=new Context(),sessionId='packaged-maintenance-'+randomUUID(),agentPresetId='teloa-standard'
 await ctx.plugin(Jsonl,{root:join(layout.dshHome,'sessions'),compression:'zstd'})
 try{const handle=await ctx.sessionPersistence.create({id:SessionId(sessionId),version:4,createdAt:Date.now(),cwd:layout.workspaceRoot,isSeeded:false,agentPreset:agentPresetId});await handle.flush();await handle.close()}finally{await ctx.fiber.dispose()}
 const snapshot=await inspect({dshHome:layout.dshHome,expectedCwd:layout.workspaceRoot,run:{sessionId,agentPresetId}})
 assert.equal(snapshot.logCut,-1);assert.equal(hash(await readFile(snapshot.path)),snapshot.fileSha256)
 assert.equal(hash(await readFile(join(packagedRoot,'release-manifest.json'))),hash(manifest))
 await assert.rejects(lstat(join(layout.instanceRoot,'state.json')),/ENOENT/)
})
