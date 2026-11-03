import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,mkdir,writeFile,readFile,realpath,symlink,access,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {resolveLayout} from '../src/layout.ts'
import {startService} from '../src/service.ts'
import type {InstallState} from '../src/contracts.ts'

const execute=promisify(execFile)
for(const kind of ['directory','file'] as const){
 test(`服务通过${kind==='directory'?'发行目录':'入口文件'}符号链接启动时，Node argv 与实际模块使用同一物理入口`,async t=>{
  const root=await mkdtemp(join(tmpdir(),'teloa-entry-path-')),home=join(root,'安装 home')
  t.after(()=>rm(root,{recursive:true,force:true}))
  const layout=await resolveLayout({home,version:'0.2.0-alpha.3'}),physical=join(root,'program'),marker=join(root,'entry-observed.json')
  await mkdir(layout.workspaceRoot,{recursive:true})
  await mkdir(join(physical,'packages/cli/lib'),{recursive:true})
  await mkdir(join(physical,'scripts/runtime'),{recursive:true})
  await writeFile(join(physical,'package.json'),JSON.stringify({type:'module'}))
  await writeFile(join(physical,'scripts/runtime/profile.mjs'),'export const runtimeEnvironment=()=>process.env')
  const source=`import {writeFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){writeFileSync(${JSON.stringify(marker)},JSON.stringify({entry:process.argv[1],module:import.meta.url,home:process.argv[2]}));process.exitCode=1}`
  await writeFile(join(physical,'packages/cli/lib/service-entry.js'),source)
  await mkdir(dirname(layout.releaseRoot),{recursive:true})
  if(kind==='directory')await symlink(physical,layout.releaseRoot,'dir')
  else{
   await mkdir(join(layout.releaseRoot,'packages/cli/lib'),{recursive:true})
   await mkdir(join(layout.releaseRoot,'scripts/runtime'),{recursive:true})
   await writeFile(join(layout.releaseRoot,'package.json'),JSON.stringify({type:'module'}))
   await writeFile(join(layout.releaseRoot,'scripts/runtime/profile.mjs'),'export const runtimeEnvironment=()=>process.env')
   await symlink(join(physical,'packages/cli/lib/service-entry.js'),join(layout.releaseRoot,'packages/cli/lib/service-entry.js'))
  }
  // 故意没有发行清单和数据库配置：状态探测在任何数据库连接前退出。
  const state:InstallState={schema:'teloa.install/v1',id:randomUUID(),version:'0.2.0-alpha.3',layout,database:{kind:'existing',configFile:join(home,'missing-database.json')},phase:'stopped',port:65528}
  await assert.rejects(startService(state,{timeoutMs:3000}),/后台服务启动失败/)
  const observed=JSON.parse(await readFile(marker,'utf8'))
  assert.equal(observed.entry,await realpath(join(layout.releaseRoot,'packages/cli/lib/service-entry.js')))
  assert.equal(observed.home,layout.home)
  await assert.rejects(access(join(layout.instanceRoot,'control.json')),error=>(error as NodeJS.ErrnoException).code==='ENOENT')
 })
}

test('普通 import 官方 supervisor 模块不执行入口或启动后台服务',async t=>{
 const home=await mkdtemp(join(tmpdir(),'teloa-entry-import-'))
 t.after(()=>rm(home,{recursive:true,force:true}))
 const entry=new URL('../src/service-entry.ts',import.meta.url).href
 const result=await execute(process.execPath,['--input-type=module','-e',`const entry=await import(${JSON.stringify(entry)});if(typeof entry.runSupervisor!=='function')throw Error('missing entry');console.log('import-only')`,home],{timeout:10000})
 assert.equal(result.stdout.trim(),'import-only')
 assert.equal(result.stderr,'')
 await assert.rejects(access(join(home,'instances')),error=>(error as NodeJS.ErrnoException).code==='ENOENT')
})
