import {realpath} from 'node:fs/promises'
import {dirname,basename,resolve,relative,isAbsolute} from 'node:path'
import {homedir} from 'node:os'
import {fileURLToPath} from 'node:url'
import type {Layout} from './contracts.ts'
export const programRoot=fileURLToPath(new URL('../../../',import.meta.url))
export const exactVersion=(value:string)=>/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)*)?$/.test(value)
export const within=(parent:string,child:string)=>{const path=relative(parent,child);return path===''||(path!=='..'&&!path.startsWith('../')&&!path.startsWith('..\\')&&!isAbsolute(path))}
export async function canonical(path:string):Promise<string>{
 let candidate=resolve(path);const tail:string[]=[]
 for(;;){try{return resolve(await realpath(candidate),...tail)}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  const parent=dirname(candidate);if(parent===candidate)throw Error('路径无法解析。');tail.unshift(basename(candidate));candidate=parent
 }
}
export async function resolveLayout(input:{home:string;version:string;workspace?:string}):Promise<Layout>{
 if(!exactVersion(input.version))throw Error('版本必须是确切的发行版本。')
 const home=await canonical(input.home),root=await canonical(programRoot)
 const ownRelease=dirname(root)===resolve(home,'releases')&&exactVersion(basename(root))
 if(home===dirname(home)||home===await canonical(homedir())||within(home,root)&&!ownRelease||within(root,home)&&!within(resolve(root,'.runtime'),home))throw Error('请为安装数据选择独立目录。')
 const releaseRoot=resolve(home,'releases',input.version),instanceRoot=resolve(home,'instances/default')
 const workspaceRoot=await canonical(input.workspace??resolve(home,'workspaces/default'))
 if(within(workspaceRoot,home)||within(workspaceRoot,root)||within(root,workspaceRoot)||within(home,workspaceRoot)&&!within(resolve(home,'workspaces'),workspaceRoot))throw Error('工作目录不能覆盖安装程序、凭据或运行数据。')
 return {home,releaseRoot,instanceRoot,dshHome:resolve(instanceRoot,'dsh'),runtimeRoot:resolve(instanceRoot,'runtime'),workspaceRoot}
}
