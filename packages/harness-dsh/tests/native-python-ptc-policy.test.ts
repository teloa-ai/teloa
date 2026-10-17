import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,realpath,rm,readFile,symlink,access} from 'node:fs/promises'
import {join,dirname} from 'node:path'
import {nativePtcRuntime} from './fixtures/native-ptc-runtime.ts'

for(const language of ['node','python'] as const)test('官方 '+language+' PTC真实允许工作区写入，拒绝越界与符号链接写入',{timeout:30000},async t=>{
 const {root,runtime}=await nativePtcRuntime(t,language)
 const outside=await realpath(await mkdtemp(join(dirname(root),'teloa-ptc-outside-')));t.after(()=>rm(outside,{recursive:true,force:true}))
 const inside=join(root,'inside.txt'),forbidden=join(outside,'forbidden.txt'),link=join(root,'outside-link')
 await symlink(outside,link,'dir')
 const write=(path:string)=>language==='node'?`const fs=await import('node:fs/promises');await fs.writeFile(${JSON.stringify(path)},'native-ptc');return 17`:`from pathlib import Path
Path(${JSON.stringify(path)}).write_text('native-ptc')
17`
 const run=(program:string,mode:'read-only'|'workspace-write'='workspace-write')=>runtime.run(runtime.resolve({program,bindings:[],cwd:root,sandboxPolicy:{mode,workspaceRoot:root}}))
 const allowed=await run(write(inside));assert.equal(allowed.error,undefined,JSON.stringify(allowed));assert.equal(await readFile(inside,'utf8'),'native-ptc')
 for(const target of [forbidden,join(link,'forbidden.txt')]){const denied=await run(write(target));assert.ok(denied.error,JSON.stringify(denied));await assert.rejects(access(forbidden))}
 const readOnly=await run(write(join(root,'readonly.txt')),'read-only');assert.ok(readOnly.error,JSON.stringify(readOnly));await assert.rejects(access(join(root,'readonly.txt')))
})
