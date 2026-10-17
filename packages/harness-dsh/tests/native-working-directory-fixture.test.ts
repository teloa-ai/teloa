import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LocalFileSystem} from '@deepseek-ai/dsh-fs-local'
import {installNativeWorkingDirectory} from './fixtures/native-working-directory.ts'
import {createRuntime} from '../../../tests/native-auto-review-fixture.mjs'

test('目录夹具重用另一实际模块图的官方文件系统，不用 instanceof 覆盖既有服务',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-directory-fixture-'))),ctx=new Context()
 t.after(async()=>{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true})})
 await writeFile(join(root,'input.txt'),'official-provider')
 await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt)
 const other=await import(import.meta.resolve('@deepseek-ai/dsh-fs-local')+'?directory-fixture-independent-class') as typeof import('@deepseek-ai/dsh-fs-local')
 await ctx.plugin(other.LocalFileSystem,{cwd:root})
 assert.equal(ctx.get('fs') instanceof LocalFileSystem,false,'红例必须是另一真实官方类身份')
 await installNativeWorkingDirectory(ctx,root)
 const target=await ctx.fs.resolve('input.txt')
 assert.equal(await ctx.fs.readText(target),'official-provider')
 assert.equal(ctx.workingDirectory.defaultDirectory,root)
 await installNativeWorkingDirectory(ctx,root)
 assert.equal(await readFile(ctx.fs.processPath(target),'utf8'),'official-provider')
})

test('目录夹具保留官方受限文件系统及原目录服务，不将其降为本地文件系统',async t=>{
 const {ctx}=await createRuntime(t),before=ctx.fs.sandboxMode,directory=ctx.workingDirectory.defaultDirectory
 await installNativeWorkingDirectory(ctx)
 assert.equal(ctx.fs.sandboxMode,before)
 assert.equal(ctx.workingDirectory.defaultDirectory,directory)
 assert.equal(typeof ctx.fs.writeText,'function')
})

test('目录夹具拒绝不满足官方文件系统接口的旧空桩',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose());ctx.provide('fs',{} as never)
 await assert.rejects(installNativeWorkingDirectory(ctx),/既有 fs 不满足官方 FileSystem 接口/)
 assert.equal(ctx.get('workingDirectory'),undefined)
})
