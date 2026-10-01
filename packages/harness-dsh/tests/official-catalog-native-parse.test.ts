import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdir,mkdtemp,realpath,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import type {FileSystem} from '@deepseek-ai/dsh-fs'
import {SkillRegistry} from '@deepseek-ai/dsh-skill'
import {readMarketCatalogIndex} from '@teloa/contract'
import {createHash} from 'node:crypto'
import {officialCatalogFiles,officialCatalogIndex} from '../../backend/src/market/official-catalog-snapshot.ts'
import {inspectNativeSkillDirectory} from '../src/managed-skills-native.ts'

const hostRequire=createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const {LocalFileSystem}=await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-fs-local')).href) as {LocalFileSystem:new(ctx:Context,config:{cwd:string})=>FileSystem}

// 构建脚本只用正则检查 frontmatter；这里用官方文件解析器逐条解析全部目录工件，防止「能过 --check、装的时候才失败」。
test('官方目录全部工件都能被官方 Skill 解析器读出，名称与条目一致',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-catalog-parse-'))),ctx=new Context()
 t.after(async()=>{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true})})
 await ctx.plugin(SkillRegistry);await ctx.plugin(LocalFileSystem,{cwd:root})
 const index=readMarketCatalogIndex(officialCatalogIndex,text=>createHash('sha256').update(text).digest('hex'))
 for(const entry of index.entries){
  if(entry.kind!=='skill') continue
  const directory=join(root,entry.id,entry.skill.name)
  for(const file of entry.artifact.files){
   const target=join(directory,file.path);await mkdir(dirname(target),{recursive:true})
   await writeFile(target,Buffer.from(officialCatalogFiles[entry.id+'/'+entry.version+'/'+file.path]!,'base64'))
  }
  const native=await inspectNativeSkillDirectory(ctx,directory)
  assert.equal(native.name,entry.skill.name,entry.id)
  assert.ok(native.description.length>0&&native.modelInvocable&&native.userInvocable,entry.id)
 }
})
