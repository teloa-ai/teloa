import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises'
import {join,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import {SkillRegistry} from '@deepseek-ai/dsh-skill'
import {convertGrokRecipe} from '@teloa/contract'
import {inspectNativeSkillDirectory} from '../src/managed-skills-native.ts'

test('recipe原技能和例行方法由真实DSH parser读取完整正文；检查不自动注册或执行',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-recipe-native-'))),ctx=new Context();t.after(async()=>{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true})})
 const hostRequire=createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json')),local=await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-fs-local')).href)
 await ctx.plugin(SkillRegistry);await ctx.plugin(local.LocalFileSystem,{cwd:root})
 const content='---\nname: original-method\ndescription: 作者说明\n---\n\n# 原完整正文\n按输入作答。',routine='按原例行步骤核对输入。'
 const pkg=await convertGrokRecipe(JSON.stringify({profile:{name:'原创员工',title:'原创模板',description:'核对文字。'},memory:[],skills:[{name:'原方法',description:'核对文字与证据。',content}],routines:[{slug:'review',name:'例行',description:'复核资料。',content:routine}],plugins:[]}))
 for(const resource of pkg.manifest.resources.filter(row=>row.kind==='skill')){
  const file=pkg.files.find(file=>file.path===resource.source.path)!;const path=join(root,file.path);await mkdir(dirname(path),{recursive:true});await writeFile(path,file.bytes)
  const observed=await inspectNativeSkillDirectory(ctx,dirname(path)),body=resource.id.startsWith('routine-method-')?routine:content
  assert.equal(observed.name,'assistant-method-'+createHash('sha256').update(pkg.report.sourceHash+':'+resource.id).digest('hex').slice(0,8));assert.ok(observed.description.startsWith(resource.title+' · '));assert.equal(observed.bodyHash,createHash('sha256').update(body.trim()).digest('hex'));assert.equal(observed.modelInvocable,true);assert.equal(observed.userInvocable,true)
 }
 assert.deepEqual(await ctx.skills.list({cwd:root}),[],'预览检查不得冒充安装或注册到运行目录')
})
