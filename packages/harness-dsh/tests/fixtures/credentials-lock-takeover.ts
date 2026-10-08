// 在独立进程中暂停旧接管协议的 unlink，确定性重现官方已持新锁后旧接管者仍删除它的窗口。
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {syncBuiltinESMExports} from 'node:module'
import {basename,dirname} from 'node:path'
import {withFileLock} from '@deepseek-ai/dsh-atomic-write'
import {clearStaleLock} from '../../src/credentials/store-state.ts'

const [filename]=process.argv.slice(2) as [string],lock=`${filename}.lock`,nativeRm=fs.rm
let pause!:()=>void,resume!:()=>void,enter!:()=>void,release!:()=>void,paused=false
const beforeRemove=new Promise<'paused'>(done=>{pause=()=>done('paused')})
const resumed=new Promise<void>(done=>{resume=done})
const entered=new Promise<void>(done=>{enter=done})
const released=new Promise<void>(done=>{release=done})
fs.rm=async(...args:Parameters<typeof fs.rm>)=>{
 const legacyGuard=(await fs.readdir(dirname(lock))).some(name=>name.startsWith(basename(lock)+'.takeover-')&&/\.takeover-\d+-\d+-[0-2]$/.test(name))
 if(args[0]===lock&&!paused&&legacyGuard){paused=true;pause();await resumed}
 return nativeRm(...args)
}
syncBuiltinESMExports()
const clearing=clearStaleLock(filename)
let holding:Promise<void>|undefined
try{
 const step=await Promise.race([beforeRemove,clearing.then(()=>'cleared' as const)])
 holding=withFileLock(filename,async()=>{enter();await released})
 await entered
 if(step==='paused'){resume();await clearing}else await clearStaleLock(filename)
 assert.equal(await fs.readFile(lock,'utf8').catch(()=>undefined),`${process.pid}\n`,'旧接管者不能删除官方正在持有的新锁')
 await assert.rejects(withFileLock(filename,async()=>assert.fail('临界区不得同时进入'),{waitMs:0}),/timed out/)
}finally{
 resume();release()
 await Promise.allSettled([clearing,holding])
 fs.rm=nativeRm;syncBuiltinESMExports()
}
