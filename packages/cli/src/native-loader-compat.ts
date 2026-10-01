import {readFile,realpath,mkdir,symlink} from 'node:fs/promises'
import {join,dirname,relative,resolve} from 'node:path'
import {createRequire} from 'node:module'
import {within} from './layout.ts'
import {findInstalledPackage} from './releases.ts'

/** alpha.4 已复制平台包，但未保留共享原生加载器需要的提升可见性。 */
export async function prepareNativeLoader(releaseRoot:string):Promise<void>{
 const root=await realpath(releaseRoot),loaderName='node-addon-native-custom-loader'
 const rows=JSON.parse(await readFile(join(root,'runtime-dependencies.json'),'utf8'))
 if(!Array.isArray(rows))throw Error('运行依赖记录无效。')
 const pending=new Map<string,string>()
 async function internal(path:string){
  if(!within(root,resolve(path))||!within(root,await realpath(path)))throw Error('原生依赖路径越出发行目录。')
  return realpath(path)
 }
 for(const row of rows){
  if(!['node-addon-require-builtin','node-addon-internal-loader'].includes(row.name))continue
  if(typeof row.path!=='string')throw Error('原生依赖路径无效。')
  const wrapper=await internal(resolve(root,row.path)),pkg=JSON.parse(await readFile(join(wrapper,'package.json'),'utf8'))
  if(pkg.name!==row.name||pkg.version!==row.version)throw Error('原生依赖身份不一致。')
  const loader=await internal(await findInstalledPackage(loaderName,wrapper)),loaderPkg=JSON.parse(await readFile(join(loader,'package.json'),'utf8'))
  if(pkg.dependencies?.[loaderName]!==loaderPkg.version)throw Error('共享原生加载器版本不一致。')
  const require=createRequire(join(loader,'package.json'))
  for(const [name,version] of Object.entries(pkg.optionalDependencies??{})){
   if(!name.startsWith(pkg.name+'-'))continue
   let target:string
   try{target=await internal(await findInstalledPackage(name,wrapper))}catch(error){if((error as NodeJS.ErrnoException).code==='MODULE_NOT_FOUND')continue;throw error}
   if(JSON.parse(await readFile(join(target,'package.json'),'utf8')).version!==version)throw Error('原生平台依赖版本不一致。')
   try{
    const visible=await internal(dirname(require.resolve(name+'/package.json')))
    if(visible!==target)throw Error('共享原生加载器依赖冲突。')
    continue
   }catch(error){if((error as NodeJS.ErrnoException).code!=='MODULE_NOT_FOUND')throw error}
   const path=join(loader,'node_modules',name)
   if(pending.has(path)&&pending.get(path)!==target)throw Error('共享原生加载器依赖冲突。')
   pending.set(path,target)
  }
 }
 // 仅补齐声明中已有的平台包，不修改上游文件，不提升无关的嵌套依赖。
 for(const [path,target] of pending){
  await mkdir(dirname(path),{recursive:true})
  await internal(dirname(path))
  try{await symlink(relative(dirname(path),target),path,'dir')}catch(error){
   if((error as NodeJS.ErrnoException).code!=='EEXIST'||await realpath(path)!==target)throw error
  }
 }
}
