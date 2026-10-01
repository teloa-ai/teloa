import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,mkdir,rm,realpath,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {ManagedSkillFiles} from '../src/managed-skill-files.ts'
const hash=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex')
const id='12345678-1234-4234-8234-123456789012'
function bundle(){const files=[{path:'SKILL.md',bytes:new TextEncoder().encode('正文')},{path:'references/a.txt',bytes:new TextEncoder().encode('附件')}].map(f=>({...f,hash:hash(f.bytes)}));return {ownerId:'owner',source:{kind:'atomic' as const,contentId:id,contentHash:'a'.repeat(64),resourceId:'test-skill',resourceVersion:'1.0.0'},entryPath:'SKILL.md' as const,files,bundleHash:hash(JSON.stringify(files.map(f=>[f.path,f.hash])))}}
const native={name:'test-skill',description:'说明',modelInvocable:true,userInvocable:true,bodyHash:hash('正文')}
test('受管完整文件树发布和重试核验，不覆盖改动附件或多余文件',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-skill-files-')));t.after(()=>rm(root,{recursive:true,force:true}));let invalidated=0
 const fs=new ManagedSkillFiles(join(root,'skills'),async directory=>{assert.equal(await readFile(join(directory,'SKILL.md'),'utf8'),'正文');return native},()=>{invalidated++})
 assert.deepEqual(await fs.inspect(bundle()),native);await fs.publish(id,bundle(),native);await fs.publish(id,bundle(),native);await fs.verify(id,bundle(),native)
 assert.equal(await readFile(join(root,'skills',id,'references/a.txt'),'utf8'),'附件');assert.ok(invalidated>=1)
 await writeFile(join(root,'skills',id,'references/a.txt'),'本人改动');await assert.rejects(fs.publish(id,bundle(),native),{code:'teloa/storage-corrupt'});assert.equal(await readFile(join(root,'skills',id,'references/a.txt'),'utf8'),'本人改动')
})
test('拒绝越界、符号链接、入口或摘要变化；不把空目录视为恢复成功',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-skill-files-')));t.after(()=>rm(root,{recursive:true,force:true}));const fs=new ManagedSkillFiles(join(root,'skills'),async()=>native,()=>{})
 const bad=bundle();bad.files[1]!.path='../outside';await assert.rejects(fs.inspect(bad),{code:'teloa/invalid-input'})
 const corrupt=bundle();corrupt.files[0]!.bytes=new TextEncoder().encode('改变');await assert.rejects(fs.inspect(corrupt),{code:'teloa/storage-corrupt'})
 await mkdir(join(root,'skills',id),{recursive:true});await assert.rejects(fs.publish(id,bundle(),native),{code:'teloa/storage-corrupt'})
 const next='22345678-1234-4234-8234-123456789012';await symlink(join(root,'skills',id),join(root,'skills',next));await assert.rejects(fs.publish(next,bundle(),native),{code:'teloa/storage-corrupt'})
 const linked=join(root,'linked');await symlink(join(root,'skills'),linked);await assert.rejects(new ManagedSkillFiles(linked,async()=>native,()=>{}).inspect(bundle()),{code:'teloa/storage-corrupt'})
})

test('文件已发布但通知失败后恢复同一目录，额外文件和嵌套链接不冒充完好安装',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-skill-files-')));t.after(()=>rm(root,{recursive:true,force:true}));let fail=true
 const fs=new ManagedSkillFiles(join(root,'skills'),async()=>native,()=>{if(fail){fail=false;throw Error('发布后通知故障')}})
 await assert.rejects(fs.publish(id,bundle(),native),/发布后通知故障/);assert.equal(await readFile(fs.path(id),'utf8'),'正文');await fs.publish(id,bundle(),native)
 await writeFile(join(root,'skills',id,'extra.txt'),'额外文件');await assert.rejects(fs.verify(id,bundle(),native),{code:'teloa/storage-corrupt'})
 await rm(join(root,'skills',id,'extra.txt'));await rm(join(root,'skills',id,'references/a.txt'));await writeFile(join(root,'outside.txt'),'附件');await symlink(join(root,'outside.txt'),join(root,'skills',id,'references/a.txt'));await assert.rejects(fs.verify(id,bundle(),native),{code:'teloa/storage-corrupt'})
})
test('发布前再核对原生正文和策略，解析故障不进入发现根',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-skill-files-')));t.after(()=>rm(root,{recursive:true,force:true}));const fs=new ManagedSkillFiles(join(root,'skills'),async()=>({...native,modelInvocable:false}),()=>{})
 await assert.rejects(fs.publish(id,bundle(),native),{code:'teloa/storage-corrupt'});await assert.rejects(readFile(fs.path(id)),{code:'ENOENT'})
})
