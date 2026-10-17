import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdtemp,mkdir,writeFile,symlink,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'

test('固定 DSH Web 组合可发现新语音插件及其真实来源，不需另装旧会话助手',async t=>{
 const repository=fileURLToPath(new URL('../../../',import.meta.url))
 const anchor=createRequire(new URL('../../../package.json',import.meta.url)).resolve('@deepseek-ai/dsh/package.json')
 const native=createRequire(anchor)
 const boot=await import(pathToFileURL(native.resolve('@deepseek-ai/dsh-app-boot')).href)
 const home=await mkdtemp(join(tmpdir(),'teloa-voice-compose-'))
 t.after(()=>rm(home,{recursive:true,force:true}))
 const dir=join(home,'profiles','voice'),source=join(repository,'packages/bundle')
 await mkdir(join(dir,'node_modules/@teloa'),{recursive:true})
 await writeFile(join(dir,'package.json'),JSON.stringify({name:'voice-composition',private:true,dependencies:{'@teloa/bundle':'link:'+source},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','@teloa/bundle']}}}))
 await symlink(source,join(dir,'node_modules/@teloa/bundle'))
 const profile=boot.loadProfileDirectory('voice-test',dir,anchor)
 assert.equal(profile.layers.length,3);assert.deepEqual(profile.skippedBundles,[])
 const runtime=await boot.createRuntimeResolution({installAnchor:anchor,profile,home})
 const entry=runtime.entries.find((row:{name:string})=>row.name==='@teloa/realtime-voice')
 assert.ok(entry,'DSH 的实际模块解析图必须包含随附媒体插件')
 assert.equal(await realpath(entry.packageDir),await realpath(join(repository,'packages/realtime-voice')))
 assert.equal(runtime.entries.some((row:{name:string})=>row.name==='dsh-session-assistant'),false)
})
