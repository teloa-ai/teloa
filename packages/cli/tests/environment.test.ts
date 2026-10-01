import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,access} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {main} from '../src/bin.ts'
const api=await import('../src/environment.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error}) as any

test('npm 范围严格匹配稳定的 11.12.1 及后续 11.x',()=>{
 assert.equal(typeof api.npmCheck,'function','缺少 npm 版本检查')
 for(const version of ['11.12.1','11.12.2','11.20.0'])assert.equal(api.npmCheck(version).ok,true,version)
 for(const version of ['10.9.3','11.12.0','12.0.0','11.12.1-beta.1','','garbage']){
  const check=api.npmCheck(version);assert.equal(check.ok,false,version);assert.match(check.remedy,/11\.12\.1/)
 }
})
test('沙箱不可用或仅部分强制执行不会被显示为通过，原始错误不泄露',async()=>{
 assert.equal(typeof api.collectEnvironment,'function','缺少环境自检')
 for(const outcome of ['full','partial','unavailable']){
  const checks=await api.collectEnvironment({releaseRoot:'/unused',workspace:'/tmp'},{nodeVersion:'24.15.0',platform:'linux',run:async()=>({code:0,stdout:'11.12.1\n',stderr:''}),sandbox:async()=>{
   if(outcome==='unavailable')throw Error('token=private-secret')
   return {backend:'landlock-run',enforcement:outcome}
  }})
  const sandbox=checks.find((check:any)=>check.name==='终端沙箱')
  assert.equal(sandbox.ok,outcome==='full');assert.doesNotMatch(JSON.stringify(checks),/private-secret/)
  if(outcome!=='full')assert.match(sandbox.remedy,/bubblewrap|Landlock/)
 }
})
test('npm 不在 PATH 时返回可操作失败，不吞掉其余检查',async()=>{
 assert.equal(typeof api.collectEnvironment,'function','缺少环境自检')
 const checks=await api.collectEnvironment({releaseRoot:'/unused',workspace:'/tmp'},{nodeVersion:'24.15.0',platform:'linux',run:async()=>{throw Error('private output')},sandbox:async()=>({backend:'bwrap',enforcement:'full'})})
 assert.equal(checks.find((check:any)=>check.name==='npm').ok,false)
 assert.equal(checks.find((check:any)=>check.name==='终端沙箱').ok,true)
 assert.doesNotMatch(JSON.stringify(checks),/private output/)
})
test('发行依赖缺失不会误导用户调整 Linux 内核或沙箱',async()=>{
 const checks=await api.collectEnvironment({releaseRoot:'/teloa-doctor-nonexistent-release'},{nodeVersion:'24.15.0',platform:'linux',run:async()=>({code:0,stdout:'11.12.1',stderr:''})})
 const sandbox=checks.find((check:any)=>check.name==='终端沙箱')
 assert.equal(sandbox.ok,false);assert.match(sandbox.message,/发行依赖/);assert.doesNotMatch(sandbox.remedy,/bubblewrap|Landlock/)
})
test('首次 up 前 doctor 返回结构化诊断且不创建安装目录',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'teloa-doctor-')),home=join(directory,'uninitialized'),output:string[]=[]
 const log=console.log,previous=process.exitCode
 console.log=(value:unknown)=>output.push(String(value))
 try{
  await assert.doesNotReject(main(['doctor','--home',home,'--json']))
  const result=JSON.parse(output.join(''));assert.equal(result.status.app,'not-installed')
  assert.ok(result.checks.some((check:any)=>check.name==='npm'))
  assert.ok(result.checks.some((check:any)=>check.name==='终端沙箱'))
  await assert.rejects(access(home),{code:'ENOENT'})
 }finally{console.log=log;process.exitCode=previous}
})
