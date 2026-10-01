import { createRequire } from 'node:module'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** npm 会安装 peers；核验范围必须与独立发行的运行依赖复制规则一致。 */
export function dshRuntimeDependencies(manifest) {
  return Object.keys({...manifest.dependencies,...manifest.peerDependencies,...manifest.optionalDependencies})
    .filter(name=>name.startsWith('@deepseek-ai/'))
    .map(name=>({name,optional:name in (manifest.optionalDependencies??{})||manifest.peerDependenciesMeta?.[name]?.optional===true}))
}

/** CLI 默认组合之外，可选提供方也是交付物；沿所有工作区的明确依赖作为真实安装图入口。 */
export function dshDependencyRoots() {
  const manifests=[resolve(projectRoot,'package.json')]
  const addDirectory=directory=>{
    for(const entry of readdirSync(directory,{withFileTypes:true})){
      if(!entry.isDirectory())continue
      const manifest=resolve(directory,entry.name,'package.json')
      if(existsSync(manifest))manifests.push(manifest)
    }
  }
  addDirectory(resolve(projectRoot,'packages'))
  addDirectory(resolve(projectRoot,'packages/client'))
  return manifests.flatMap(anchor=>{
    const manifest=JSON.parse(readFileSync(anchor,'utf8'))
    return Object.keys({...manifest.dependencies,...manifest.devDependencies}).filter(name=>name.startsWith('@deepseek-ai/')).map(name=>({name,anchor}))
  })
}

// 沿真实依赖图检查；pnpm store 中遗留但不再引用的版本不算当前宿主。
export function verifyDshPackages() {
  const baseline = JSON.parse(readFileSync(resolve(projectRoot,'config/dsh-package-versions.json'),'utf8'))
  const seen = new Set()
  const packages = []
  function visit(name, anchor) {
    const path = realpathSync(createRequire(anchor).resolve(name+'/package.json'))
    if (seen.has(path)) return
    seen.add(path)
    const localPath = relative(projectRoot,path)
    if (localPath.startsWith('..') || isAbsolute(localPath)) throw Error('宿主依赖位于 Teloa 项目之外：'+name)
    const manifest = JSON.parse(readFileSync(path,'utf8'))
    const expected = baseline.versions[name]
    if (!expected || manifest.version !== expected) throw Error('DSH 依赖版本不符：'+name+'，预期 '+expected+'，实际 '+manifest.version)
    packages.push({name,version:manifest.version,path})
    for (const dependency of dshRuntimeDependencies(manifest)) {
      try{visit(dependency.name,path)}catch(error){if(dependency.optional&&error.code==='MODULE_NOT_FOUND')continue;throw error}
    }
  }
  for(const {name,anchor} of dshDependencyRoots())visit(name,anchor)
  // 官方扩展即时启停（harness-dsh 的 bundled-extensions-apply.ts）调用 reconcileProfilePatches，它靠 dsh-app-boot 模块级的根 Include 表；
  // 安装图里出现第二份实例时 Teloa 拿到的是空表，热套用只能退回重启生效。
  if(packages.filter(row=>row.name==='@deepseek-ai/dsh-app-boot').length!==1)throw Error('@deepseek-ai/dsh-app-boot 在安装图里不是唯一一份实例，官方扩展即时启停需要与宿主共用同一份。')
  return packages
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log('DSH 依赖核对通过：'+verifyDshPackages().length+' 个包，均来自独立 Teloa 安装并符合固定基线。') }
  catch (error) { console.error(error.message);process.exitCode=1 }
}
