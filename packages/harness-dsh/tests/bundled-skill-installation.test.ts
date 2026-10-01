import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {mkdtemp,readFile,readdir,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import {SkillRegistry} from '@deepseek-ai/dsh-skill'
import type {FileSystem} from '@deepseek-ai/dsh-fs'
import {ManagedSkillFiles} from '../src/managed-skill-files.ts'
import {inspectNativeSkillDirectory} from '../src/managed-skills-native.ts'

const hostRequire=createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const {LocalFileSystem}=await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-fs-local')).href) as {
 LocalFileSystem:new(ctx:Context,config:{cwd:string})=>FileSystem
}
const root=fileURLToPath(new URL('../../../examples/industry/',import.meta.url))
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex')

test('发布的行业示例技能必须经过真实宿主解析和受管文件发布，任务引用固定同一版本',async t=>{
 const temporary=await realpath(await mkdtemp(join(tmpdir(),'teloa-bundled-skills-'))),ctx=new Context()
 t.after(async()=>{await ctx.fiber.dispose();await rm(temporary,{recursive:true,force:true})})
 await ctx.plugin(SkillRegistry);await ctx.plugin(LocalFileSystem,{cwd:temporary})
 const managed=new ManagedSkillFiles(join(temporary,'managed'),directory=>inspectNativeSkillDirectory(ctx,directory),()=>{})
 let installed=0
 for(const entry of await readdir(root,{withFileTypes:true})){
  if(!entry.isDirectory())continue
  const directory=join(root,entry.name),manifest=JSON.parse(await readFile(join(directory,'teloa.json'),'utf8'))
  const skills=manifest.resources.filter((resource:{kind:string})=>resource.kind==='skill')
  for(const resource of skills){
   if(resource.source.kind!=='local')continue
   const bytes=await readFile(join(directory,resource.source.path)),files=[{path:'SKILL.md',bytes,hash:sha(bytes)}]
   const bundle={ownerId:'bundled-example',source:{kind:'atomic' as const,contentId:randomUUID(),contentHash:sha(bytes),resourceId:resource.id,resourceVersion:resource.version},entryPath:'SKILL.md' as const,files,bundleHash:sha(JSON.stringify(files.map(file=>[file.path,file.hash])))}
   const native=await managed.inspect(bundle)
   assert.equal(native.name,resource.id,`${entry.name} 的显示名与安装标识应分开`)
   const installationId=randomUUID();await managed.publish(installationId,bundle,native);await managed.verify(installationId,bundle,native)
   assert.deepEqual(await readFile(managed.path(installationId)),bytes)
   installed++
  }
  for(const resource of manifest.resources.filter((resource:{kind:string;source:{kind:string}})=>resource.kind==='work-template'&&resource.source.kind==='local')){
   const definition=JSON.parse(await readFile(join(directory,resource.source.path),'utf8'))
   assert.equal(definition.version,resource.version)
   for(const reference of definition.skills??[]){
    const skill=skills.find((value:{id:string})=>value.id===reference.id)
    if(skill)assert.equal(reference.version,skill.version,`${entry.name}/${resource.id} 技能引用版本不一致`)
   }
  }
 }
 assert.ok(installed>=2,'示例市场必须实际覆盖两个技能安装')
})
