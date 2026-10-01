// 随附依赖锁定的纯校验（不含安装、不引入 child_process）：宿主安装（managed-package-install.ts）与市场目录校验
// （scripts/市场目录校验.mjs → 市场仓 tools/validate.mjs）共用同一判据。
import {WorkError,isRecord} from '@teloa/contract'

export type ManagedPackageRecipe={package:string;version:string;integrity:string}

/** npm lockfile v3 外形（只声明核对所需字段）。 */
export type ManagedPackageLock={name:string;version:string;lockfileVersion:number;packages:Record<string,{name?:string;version?:string;integrity?:string;optional?:boolean;dependencies?:Record<string,string>}>}

/** 随附 lock 的每个包只能从 npm 官方源取；与目录构建的收录要求一致。 */
export const managedPackageRegistry='https://registry.npmjs.org/'
// 条目键只允许 node_modules/<包>[/node_modules/<包>]…，包名段不得为 . 或 ..，防止 npm 把包写出安装目录。
const lockKeyPat=/^node_modules\/(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*(?:\/node_modules\/(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*)*$/i
const sha512Pat=/^sha512-[A-Za-z0-9+/]{86}==$/

/**
 * 随附 lock 与配方声明逐项核对后才可用于安装：lockfile v3；根只依赖配方包且精确钉到配方版本；
 * 顶层条目版本与 integrity 等于配方；其余每个条目键合法、非 link、带 sha512 integrity，resolved 在 npm 官方源下。任何一处不符抛 teloa/forbidden。
 */
export function readManagedPackageLock(value:unknown,recipe:ManagedPackageRecipe):ManagedPackageLock{
 const missing=()=>new WorkError('teloa/forbidden','该安装包缺少完整的随附依赖锁定。')
 if(!isRecord(value)||value.lockfileVersion!==3||typeof value.name!=='string'||typeof value.version!=='string'||!isRecord(value.packages))throw missing()
 const packages=value.packages,root=packages[''],top=packages[`node_modules/${recipe.package}`]
 const dependencies=isRecord(root)&&isRecord(root.dependencies)?Object.entries(root.dependencies):[]
 if(dependencies.length!==1||dependencies[0]![0]!==recipe.package||dependencies[0]![1]!==recipe.version||!isRecord(top)||top.version!==recipe.version||top.integrity!==recipe.integrity){
  throw new WorkError('teloa/forbidden','该安装包的随附依赖锁定与配方声明不一致。')
 }
 for(const [key,entry] of Object.entries(packages)){
  if(key==='')continue
  if(!lockKeyPat.test(key)||!isRecord(entry)||entry.link!==undefined||typeof entry.version!=='string'||typeof entry.integrity!=='string'||!sha512Pat.test(entry.integrity))throw missing()
  if(typeof entry.resolved!=='string'||!entry.resolved.startsWith(managedPackageRegistry))throw new WorkError('teloa/forbidden','该安装包的随附依赖锁定含非 npm 官方源的下载地址。')
 }
 return value as ManagedPackageLock
}
