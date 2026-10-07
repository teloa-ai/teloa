import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {cp,mkdir,mkdtemp,readFile,readdir,realpath,rm,symlink} from 'node:fs/promises'
import {dirname,isAbsolute,join} from 'node:path'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'
import {fileURLToPath,pathToFileURL} from 'node:url'

type Cleanup={after:(action:()=>unknown)=>void}
export type NativePackagePatch=Readonly<{
 packageName:string
 compatBasename:string
 /** 可选组合的解析入口；仍对实际官方包逐文件核对来源。 */
 packageAnchor?:string
 /** 只将已复制的官方 peer 包接到同一私有 graph；不会写原 node_modules。 */
 overrides?:Readonly<Record<string,string>>
}>
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
const compat=fileURLToPath(new URL('../../compat/',import.meta.url))
const packageNamePattern=/^@deepseek-ai\/dsh-[a-z0-9-]+$/

/** 完整官方 npm 副本，精确 hash 与无 fuzz 差分；返回可供同图复用的 package root。 */
export async function patchedNativePackage<T>(t:Cleanup,spec:NativePackagePatch):Promise<{root:string;namespace:T}>{
 assert.match(spec.packageName,packageNamePattern);assert.match(spec.compatBasename,/^[a-z0-9.-]+$/)
 const source=dirname(await realpath(createRequire(spec.packageAnchor??import.meta.url).resolve(spec.packageName+'/package.json')))
 const receipt=JSON.parse(await readFile(join(compat,spec.compatBasename+'.json'),'utf8')) as {
  schema:string;package:string;version:string;upstreamCommit:string;patchSha256:string;files:Array<{path:string;beforeSha256:string;afterSha256:string}>
 }
 const metadata=JSON.parse(await readFile(join(source,'package.json'),'utf8')) as {name:string;version:string}
 assert.equal(receipt.schema,'teloa.dsh-compat-patch/v1')
 assert.equal(receipt.upstreamCommit,'5badb15009ae1756c3afe0ae0cef1faafc290ccc')
 assert.equal(receipt.package,spec.packageName);assert.equal(metadata.name,spec.packageName)
 assert.equal(metadata.version,'0.2.1-alpha.1');assert.equal(receipt.version,metadata.version)
 const patch=await readFile(join(compat,spec.compatBasename+'.patch'))
 assert.equal(hash(patch),receipt.patchSha256)
 for(const file of receipt.files){
  assert.ok(!isAbsolute(file.path)&&!file.path.split('/').includes('..'))
  assert.equal(hash(await readFile(join(source,file.path))),file.beforeSha256)
 }
 const temporary=await mkdtemp(join(tmpdir(),'teloa-native-package-'));t.after(()=>rm(temporary,{recursive:true,force:true}))
 const root=join(temporary,'package');await cp(source,root,{recursive:true,dereference:true})
 const applied=spawnSync('patch',['--batch','--fuzz=0','-p1'],{cwd:root,input:patch,encoding:'utf8'})
 assert.equal(applied.status,0,applied.error?.message||applied.stderr||applied.stdout)
 for(const file of receipt.files){
  assert.equal(hash(await readFile(join(root,file.path))),file.afterSha256)
  assert.equal(hash(await readFile(join(source,file.path))),file.beforeSha256)
 }
 const overrides=new Map<string,string>([[spec.packageName,root]])
 for(const [name,value] of Object.entries(spec.overrides??{})){
  assert.match(name,packageNamePattern);assert.ok(isAbsolute(value))
  const actual=await realpath(value),overrideMetadata=JSON.parse(await readFile(join(actual,'package.json'),'utf8')) as {name:string;version:string}
  assert.equal(overrideMetadata.name,name);assert.equal(overrideMetadata.version,'0.2.1-alpha.1')
  assert.ok(name!==spec.packageName,'本包只能引用本轮已验证副本')
  overrides.set(name,actual)
 }
 // scoped peer 必须是普通新目录，否则覆盖子 link 会透过 scope link 修改原依赖。
 const peers=dirname(dirname(source)),target=join(temporary,'node_modules');await mkdir(target)
 for(const entry of await readdir(peers,{withFileTypes:true})){
  if(entry.name==='.bin'||entry.name.startsWith('.'))continue
  if(entry.name.startsWith('@')){
   const scope=join(target,entry.name);await mkdir(scope)
   for(const child of await readdir(join(peers,entry.name),{withFileTypes:true})){
    const name=entry.name+'/'+child.name
    await symlink(overrides.get(name)??join(peers,entry.name,child.name),join(scope,child.name),'dir')
    overrides.delete(name)
   }
  }else await symlink(join(peers,entry.name),join(target,entry.name),'dir')
 }
 for(const [name,value] of overrides){
  const [scope,basename]=name.split('/');assert.ok(scope&&basename)
  await mkdir(join(target,scope),{recursive:true});await symlink(value,join(target,scope,basename),'dir')
 }
 const namespace=await import(pathToFileURL(join(root,'lib/index.js')).href) as T
 return {root,namespace}
}
