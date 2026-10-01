import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {waitForExit,writeRestartMarker} from '../scripts/验收进程.mjs'

for(const code of [0,7])test('子进程已退出后仍正确结算：'+code,{timeout:3000},async()=>{
 const child=spawn(process.execPath,['-e','process.exit('+code+')'])
 await once(child,'exit')
 if(code===0)await waitForExit(child)
 else await assert.rejects(waitForExit(child),/退出码 7/)
})
test('提前订阅的 spawn 失败会拒绝，不泄露未处理事件',{timeout:3000},async()=>{
 await assert.rejects(waitForExit(spawn('/nonexistent/teloa-acceptance-test')),/ENOENT/)
})
test('并行重启宿主各自原子保存带来源的代次',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'teloa-marker-test-'))
 try{
  const a={origin:'http://127.0.0.1:41001',profile:'a',launcher:1,pid:2,generation:1}
  const b={origin:'http://127.0.0.1:41002',profile:'b',launcher:3,pid:4,generation:1}
  await Promise.all([writeRestartMarker(directory,a),writeRestartMarker(directory,b)])
  await writeRestartMarker(directory,{...a,pid:5,generation:2})
  assert.deepEqual(JSON.parse(await readFile(join(directory,'重启验收代次-41001.json'),'utf8')),{...a,pid:5,generation:2})
  assert.deepEqual(JSON.parse(await readFile(join(directory,'重启验收代次-41002.json'),'utf8')),b)
 }finally{await rm(directory,{recursive:true,force:true})}
})
