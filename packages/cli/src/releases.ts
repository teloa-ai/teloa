import {createHash,randomUUID} from 'node:crypto'
import {copyFile,mkdir,readFile,readdir,lstat,realpath,readlink,symlink,rename,chmod,rm} from 'node:fs/promises'
import {dirname,join,resolve,relative,isAbsolute} from 'node:path'
import type {Layout,ReleaseManifest} from './contracts.ts'
import {within,exactVersion} from './layout.ts'
import {privateDirectory,writePrivateJson} from './state.ts'

const digest=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex')
const safePath=(path:unknown):path is string=>typeof path==='string'&&path.length>0&&!isAbsolute(path)&&!path.includes('\\')&&!path.includes('\0')&&!path.split('/').some(part=>!part||part==='.'||part==='..')
export async function verifyRelease(root:string):Promise<ReleaseManifest>{
 const manifest=JSON.parse(await readFile(join(root,'release-manifest.json'),'utf8'))
 if(manifest?.schema!=='teloa.release/v1'||!exactVersion(manifest.version)||!Array.isArray(manifest.files)||!Number.isInteger(manifest.dataVersion)||!Array.isArray(manifest.compatibleDataVersions))throw Error('发行清单无效。')
 const names=new Set<string>()
 for(const row of manifest.files){
  if(!safePath(row.path)||!(/^[a-f0-9]{64}$/).test(row.sha256)||names.has(row.path)||row.path.split('/').includes('node_modules'))throw Error('发行清单路径无效。')
  names.add(row.path)
 }
 for(const row of manifest.files){
  const path=join(root,row.path),info=await lstat(path)
  if(!info.isFile()||info.isSymbolicLink()||!within(await realpath(root),await realpath(path)))throw Error('发行文件路径不属于当前版本。')
  if(digest(await readFile(path))!==row.sha256)throw Error('发行文件摘要不一致：'+row.path)
 }
 return manifest
}
async function locateInstalledPackage(name:string,anchor:string):Promise<string>{
 if(!/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/.test(name))throw Error('依赖名称无效。')
 let directory=anchor
 for(;;){
  const candidate=join(directory,'node_modules',name,'package.json')
  try{return dirname(await realpath(candidate))}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  const parent=dirname(directory);if(parent===directory)throw Object.assign(Error('缺少已安装依赖：'+name),{code:'MODULE_NOT_FOUND'});directory=parent
 }
}
export async function findInstalledPackage(name:string,anchor:string,expectedName=name):Promise<string>{
 const directory=await locateInstalledPackage(name,anchor)
 const value=JSON.parse(await readFile(join(directory,'package.json'),'utf8'))
 if(value.name!==expectedName)throw Error('依赖身份不一致：'+name)
 return directory
}
async function link(target:string,path:string){
 await mkdir(dirname(path),{recursive:true})
 try{await symlink(relative(dirname(path),target),path,'dir')}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;if(await realpath(path)!==await realpath(target))throw Error('发行依赖链接冲突。')}
}
async function copyPackageTree(source:string,target:string,root=source,targetRoot=target):Promise<void>{
 await mkdir(target,{recursive:true})
 for(const item of await readdir(source,{withFileTypes:true})){
  if(source===root&&item.name==='node_modules')continue
  const from=join(source,item.name),to=join(target,item.name)
  if(item.isDirectory())await copyPackageTree(from,to,root,targetRoot)
  else if(item.isFile()){await copyFile(from,to);await chmod(to,(await lstat(from)).mode&0o777)}
  else if(item.isSymbolicLink()){
   const actual=await realpath(from)
   if(!within(root,actual))throw Error('依赖资源链接越出包目录。')
   await symlink(relative(dirname(to),join(targetRoot,relative(root,actual))),to)
  }
 }
}
async function cloneDependencies(sourceRoot:string,destination:string):Promise<void>{
 const rootPackage=JSON.parse(await readFile(join(sourceRoot,'package.json'),'utf8'))
 const baseline=await readFile(join(sourceRoot,'config/dsh-package-versions.json'),'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return {versions:{}};throw error})
 const copied=new Map<string,string>(),referencedNames=new Set<string>(),versions:Array<{name:string;version:string;path:string}>=[]
 async function visit(name:string,anchor:string,spec=''):Promise<string>{
  referencedNames.add(name)
  const expectedName=spec.startsWith('npm:')?spec.slice(4,spec.lastIndexOf('@')):name
  const source=await findInstalledPackage(name,anchor,expectedName),known=copied.get(source)
  if(known)return known
  const pkg=JSON.parse(await readFile(join(source,'package.json'),'utf8'))
  if(name.startsWith('@deepseek-ai/')&&baseline.versions[name]!==pkg.version)throw Error('DSH 依赖版本不符：'+name)
  const modules=join(destination,'node_modules/.teloa-store',digest(source).slice(0,24),'node_modules'),target=join(modules,name)
  copied.set(source,target)
  await copyPackageTree(source,target)
  versions.push({name,version:pkg.version,path:relative(destination,target)})
  const dependencies={...pkg.dependencies,...pkg.peerDependencies,...pkg.optionalDependencies}
  for(const dependency of Object.keys(dependencies)){
   let child
   try{child=await visit(dependency,source,dependencies[dependency])}catch(error){
    const optional=dependency in (pkg.optionalDependencies??{})||pkg.peerDependenciesMeta?.[dependency]?.optional
    if(optional&&(error as NodeJS.ErrnoException).code==='MODULE_NOT_FOUND')continue
    throw error
   }
   // 与包同级保留依赖：Node 可以向上解析，原生共享库的相对 rpath 也能找到它们。
   await link(child,join(modules,dependency))
  }
  return target
 }
 for(const name of Object.keys(rootPackage.dependencies??{}))await link(await visit(name,sourceRoot,rootPackage.dependencies[name]),join(destination,'node_modules',name))
 // 共享原生加载器可能用自己的 require 加载调用方声明的平台包；保留源安装根的提升可见性。
 // 只链接已验证并复制、且从源根实际解析到的身份，不能把嵌套版本或私有包任意提升。
 for(const name of referencedNames){
  let source
  try{source=await locateInstalledPackage(name,sourceRoot)}catch(error){if((error as NodeJS.ErrnoException).code==='MODULE_NOT_FOUND')continue;throw error}
  const target=copied.get(source)
  if(target)await link(target,join(destination,'node_modules',name))
 }
 // 宿主与后续插件管理使用同一套随版本保存的 dsh/pnpm，不依赖系统全局工具。
 for(const [name,bin] of [['@deepseek-ai/dsh','dsh'],['pnpm','pnpm']]){
  if(!(name! in (rootPackage.dependencies??{})))continue
  const directory=await realpath(join(destination,'node_modules',name!)),pkg=JSON.parse(await readFile(join(directory,'package.json'),'utf8'))
  const entry=typeof pkg.bin==='string'?pkg.bin:pkg.bin?.[bin!]
  if(!safePath(entry))throw Error('依赖命令入口无效。')
  await mkdir(join(destination,'node_modules/.bin'),{recursive:true})
  await symlink(relative(join(destination,'node_modules/.bin'),join(directory,entry)),join(destination,'node_modules/.bin',bin!))
 }
 await writePrivateJson(join(destination,'runtime-dependencies.json'),versions)
}
export async function stageRelease(sourceRoot:string,layout:Layout):Promise<ReleaseManifest>{
 const manifest=await verifyRelease(sourceRoot)
 if(manifest.version!==layout.releaseRoot.split(/[\\/]/).at(-1))throw Error('发行版本与安装目标不符。')
 try{
  const existing=await verifyRelease(layout.releaseRoot)
  if(JSON.stringify(existing)!==JSON.stringify(manifest))throw Error('同版本的发行内容已变化；不能覆盖正在使用的版本。')
  return existing
 }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
 const parent=dirname(layout.releaseRoot)
 await privateDirectory(parent)
 const staging=join(parent,'.staging-'+randomUUID())
 await mkdir(staging,{mode:0o700})
 try{
  for(const row of manifest.files){
   const from=join(sourceRoot,row.path),to=join(staging,row.path)
   await mkdir(dirname(to),{recursive:true});await copyFile(from,to);await chmod(to,(await lstat(from)).mode&0o777)
  }
  await writePrivateJson(join(staging,'release-manifest.json'),manifest)
  await cloneDependencies(sourceRoot,staging)
  // 内部包保持原有 packages 布局，所有链接只指向此发行副本内部。
  for(const row of manifest.files.filter(row=>row.path.startsWith('packages/')&&row.path.endsWith('/package.json'))){
   const directory=dirname(join(staging,row.path)),pkg=JSON.parse(await readFile(join(directory,'package.json'),'utf8'))
   if(!/^@teloa\/[a-z0-9-]+$/.test(pkg.name))throw Error('内部发行包名称无效。')
   await link(directory,join(staging,'node_modules',pkg.name))
  }
  await verifyRelease(staging)
  await rename(staging,layout.releaseRoot)
  return manifest
 }catch(error){await rm(staging,{recursive:true,force:true});throw error}
}
