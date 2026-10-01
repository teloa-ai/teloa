import {installManagedPackage,managedPackageAllowlist,managedPackageDir,managedPackageInstalled,managedPackageLock,type ManagedPackageRecipe} from '@teloa/harness-dsh/managed-package-install'
import recipeFromPackage from '../runtime/onnxruntime.json' with {type:'json'}

/** 运行时安装上限（关键决定 8）：tarball 含全平台二进制（解包约 300 MB），经 `timeoutMs` 参数传入，不改默认 180 秒。 */
export const runtimeInstallTimeoutMs=600_000

/** `runtime/onnxruntime.json` 必须与 `managedPackageAllowlist` 中的条目逐字段一致，多一个键也不行。 */
export function readRuntimeRecipe(value:unknown):ManagedPackageRecipe{
 const bad=()=>new Error('运行时配方与受管安装白名单不一致。')
 if(typeof value!=='object'||value===null||Array.isArray(value))throw bad()
 const row=value as Record<string,unknown>
 if(Object.keys(row).sort().join()!=='integrity,package,version')throw bad()
 const entry=managedPackageAllowlist.find(item=>item.package===row.package&&item.version===row.version&&item.integrity===row.integrity)
 if(!entry)throw bad()
 return {package:entry.package,version:entry.version,integrity:entry.integrity}
}

type Installer=typeof installManagedPackage
type InstalledCheck=typeof managedPackageInstalled
/**
 * 运行时阶段：`check` 只核对 root/packages 下的安装记录与全树摘要（启用时用，不执行 npm）；
 * `install` 经主干 `installManagedPackage` 按随附 lock 安装（`npm ci --ignore-scripts`、逐条 integrity、共用串行队列）。
 */
export function createRuntimeStage(root:string,deps:{install?:Installer;installed?:InstalledCheck;npmBin?:string;recipe?:unknown}={}){
 const recipe=readRuntimeRecipe(deps.recipe??recipeFromPackage)
 const lock=managedPackageLock(recipe)
 return {
  recipe,
  dir:managedPackageDir(root,recipe),
  check:()=>(deps.installed??managedPackageInstalled)(root,recipe,lock),
  install:()=>(deps.install??installManagedPackage)(root,recipe,deps.npmBin??'npm',lock,runtimeInstallTimeoutMs),
 }
}

