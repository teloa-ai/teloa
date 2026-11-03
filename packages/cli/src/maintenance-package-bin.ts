import {createHash} from 'node:crypto'
import {lstat,readFile,readlink,realpath} from 'node:fs/promises'
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path'

const digest=(body:Buffer)=>createHash('sha256').update(body).digest('hex')
const refuse=()=>Error('扩展命令含不能安全备份的外链或未捕获目标。')
const file=async(path:string)=>{const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||await realpath(path)!==path)throw refuse();return readFile(path)}
export interface PackageBinLink{
 path:string;target:string;targetPath:string;packagePath:string;targetSha256:string;packageSha256:string
 identity:{dev:number;ino:number;mtimeMs:number;ctimeMs:number}
}
/** 只读核验：仅接受本 profile 内实体包声明的相对命令入口，不执行或读取外部目标。 */
export async function inspectPackageBinLink(source:string,path:string):Promise<PackageBinLink|undefined>{
 const rel=relative(source,path).split(sep).join('/'),match=/^(profiles\/(?:[^/]+\/(?:\.dsh-module-fallback\/)?)?node_modules)\/\.bin\/([a-zA-Z0-9_.-]+)$/.exec(rel)
 if(!match)return undefined
 source=await realpath(source);path=join(source,rel)
 const before=await lstat(path);if(!before.isSymbolicLink())return undefined
 const target=await readlink(path)
 if(isAbsolute(target)||target.includes('\\')||target.includes('\0'))throw refuse()
 const modules=join(source,match[1]!),resolved=resolve(dirname(path),target),local=relative(modules,resolved).split(sep).join('/'),parts=local.split('/')
 const name=parts[0]?.startsWith('@')?parts.slice(0,2).join('/'):parts[0]
 if(!name||!/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(name)||parts.some(p=>!p||p==='.'||p==='..')||local.startsWith('.')||local.split('/').at(-1)==='session.lock')throw refuse()
 const packageRoot=join(modules,name),packagePath=join(packageRoot,'package.json')
 // 每层都必须是同一快照内的实体目录，不能借包目录或目标祖先的链接逃逸。
 for(let directory=dirname(resolved);;directory=dirname(directory)){
  const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(directory)!==directory)throw refuse()
  if(directory===modules)break
  if(directory===dirname(directory)||!directory.startsWith(modules+sep))throw refuse()
 }
 const body=await file(packagePath),manifest=JSON.parse(body.toString('utf8')) as {name?:string;bin?:string|Record<string,string>}
 const declared=typeof manifest.bin==='string'&&match[2]===name.split('/').at(-1)?manifest.bin:typeof manifest.bin==='object'&&manifest.bin!==null?manifest.bin[match[2]!]:undefined
 if(manifest.name!==name||typeof declared!=='string'||isAbsolute(declared)||resolve(packageRoot,declared)!==resolved)throw refuse()
 const targetBody=await file(resolved),after=await lstat(path)
 if(!after.isSymbolicLink()||before.dev!==after.dev||before.ino!==after.ino||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||await readlink(path)!==target)throw refuse()
 return{path:rel,target,targetPath:relative(source,resolved).split(sep).join('/'),packagePath:relative(source,packagePath).split(sep).join('/'),targetSha256:digest(targetBody),packageSha256:digest(body),identity:{dev:before.dev,ino:before.ino,mtimeMs:before.mtimeMs,ctimeMs:before.ctimeMs}}
}
