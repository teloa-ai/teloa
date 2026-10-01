import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,mkdir,symlink,realpath,writeFile,stat,copyFile} from 'node:fs/promises'
import {spawnSync} from 'node:child_process'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
const api=await import('../src/layout.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error}) as any
const stateApi=await import('../src/state.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error}) as any
const fresh=()=>mkdtemp(join(tmpdir(),'teloa-layout-'))

test('显式工作目录支持中文空格，不能覆盖安装数据或程序',async()=>{
 assert.equal(typeof api.resolveLayout,'function','缺少安装目录解析')
 const base=await realpath(await fresh()),home=join(base,'安装 数据'),workspace=join(base,'我的 文件')
 const layout=await api.resolveLayout({home,workspace,version:'0.2.0-alpha.3'})
 assert.equal(layout.workspaceRoot,workspace)
 assert.equal(layout.releaseRoot,join(home,'releases','0.2.0-alpha.3'))
 await assert.rejects(api.resolveLayout({home,workspace:home,version:'0.2.0-alpha.3'}),/工作目录/)
 await mkdir(home)
 await symlink(home,join(base,'shortcut'))
 await assert.rejects(api.resolveLayout({home,workspace:join(base,'shortcut'),version:'0.2.0-alpha.3'}),/工作目录/)
 await assert.rejects(api.resolveLayout({home,version:'../../escape'}),/版本/)
})
test('安装状态原子读写且不接受损坏状态，权限不暴露其他用户',async()=>{
 assert.equal(typeof stateApi.writeInstall,'function','缺少安装状态持久化')
 const home=join(await fresh(),'home')
 const layout=await api.resolveLayout({home,version:'0.2.0-alpha.3'})
 assert.equal(await stateApi.readInstall(layout),null)
 const state={schema:'teloa.install/v1',id:'01234567-89ab-4cde-8fab-0123456789ab',version:'0.2.0-alpha.3',layout,port:3100,database:{kind:'docker'},phase:'prepared'}
 await stateApi.writeInstall(state)
 assert.deepEqual(await stateApi.readInstall(layout),state)
 assert.equal((await stat(join(layout.instanceRoot,'state.json'))).mode&0o777,0o600)
 await writeFile(join(layout.instanceRoot,'state.json'),'{broken')
 await assert.rejects(stateApi.readInstall(layout),/安装状态/)
})
test('并发安装有明确冲突，抛错后释放本次互斥',async()=>{
 assert.equal(typeof stateApi.withInstallLock,'function','缺少安装互斥')
 const home=join(await fresh(),'home')
 await stateApi.withInstallLock(home,async()=>{
  await assert.rejects(stateApi.withInstallLock(home,async()=>{}),/正在/)
 })
 await assert.rejects(stateApi.withInstallLock(home,async()=>{throw Error('cancelled')}),/cancelled/)
 assert.equal(await stateApi.withInstallLock(home,async()=>42),42)
})
test('保存的发行副本能解析自己的安装 home',async()=>{
 const home=await realpath(await fresh()),directory=join(home,'releases/0.2.0-alpha.3/packages/cli/src')
 await mkdir(directory,{recursive:true})
 await copyFile(new URL('../src/layout.ts',import.meta.url),join(directory,'layout.ts'))
 const code="import {resolveLayout} from "+JSON.stringify(join(directory,'layout.ts'))+";await resolveLayout({home:"+JSON.stringify(home)+",version:'0.2.0-alpha.3'})"
 const result=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8'})
 assert.equal(result.status,0,result.stderr)
})
test('进程中断后的旧锁可重试，损坏配置不回显敏感内容',async()=>{
 const home=await fresh()
 await writeFile(join(home,'install.lock'),JSON.stringify({pid:2147483647,identity:'old'}),{mode:0o600})
 assert.equal(await stateApi.withInstallLock(home,async()=>42),42)
 await writeFile(join(home,'secret.json'),'{"password":"do-not-print" broken',{mode:0o600})
 await assert.rejects(stateApi.readPrivateJson(join(home,'secret.json')),error=>{assert.doesNotMatch(String(error),/do-not-print/);return true})
})
