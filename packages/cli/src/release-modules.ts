import {registerHooks} from 'node:module'
import {readFile,realpath} from 'node:fs/promises'
import {readFileSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
import {verifyRelease} from './releases.ts'
import {within} from './layout.ts'

const digest=(value:Buffer)=>createHash('sha256').update(value).digest('hex')
const denied=()=>Error('发行模块或其依赖归属无法核对，维护保持停止。')
type Binding={root:string;manifestSha256:string;files:Map<string,string>;packages:Map<string,string>}
const verified=new Map<string,Promise<Binding>>()
async function prepare(root:string):Promise<Binding>{
 const manifest=await verifyRelease(root),bytes=await readFile(join(root,'release-manifest.json')),files=new Map(manifest.files.map(row=>[pathToFileURL(join(root,row.path)).href,row.sha256])),packages=new Map<string,string>()
 for(const row of manifest.files){
  if(!/^packages\/[^/]+\/package\.json$/.test(row.path))continue
  const path=join(root,row.path),pkg=JSON.parse(await readFile(path,'utf8')) as {name?:unknown;version?:unknown;type?:unknown;exports?:unknown}
  if(typeof pkg.name!=='string'||!pkg.name.startsWith('@teloa/'))continue
  if(pkg.version!==manifest.version||pkg.type!=='module'||!pkg.exports||packages.has(pkg.name))throw denied()
  packages.set(pkg.name,pathToFileURL(path).href)
 }
 if(!packages.has('@teloa/contract'))throw denied()
 return {root,manifestSha256:digest(bytes),files,packages}
}
/** 只在已验发行自有模块的导入期间补齐包 self-exports 解析；不写链接、不替换 SDK 执行图。 */
export async function withReleaseModule<T>(releaseRoot:string,path:string,work:(module:unknown)=>Promise<T>):Promise<T>{
 const root=await realpath(releaseRoot)
 let preparing=verified.get(root);if(!preparing){preparing=prepare(root);verified.set(root,preparing)}
 const binding=await preparing,entry=pathToFileURL(join(root,path)).href
 const current=()=>{if(digest(readFileSync(join(root,'release-manifest.json')))!==binding.manifestSha256)throw denied()}
 if(!within(root,join(root,path))||!/^packages\/[^/]+\/lib\/.+\.js$/.test(path)||!binding.files.has(entry)||typeof registerHooks!=='function')throw denied()
 current()
 const hook=registerHooks({resolve(specifier,context,nextResolve){
  if(!context.parentURL||!binding.files.has(context.parentURL)||!specifier.startsWith('@teloa/'))return nextResolve(specifier,context)
  const name=specifier.split('/').slice(0,2).join('/'),anchor=binding.packages.get(name)
  if(!anchor)throw denied()
  current()
  // 以同一发行内该包自己的 package.json 为 self-reference 锚，沿 Node 官方 import exports 条件解析。
  const result=nextResolve(specifier,{...context,parentURL:anchor}),expected=binding.files.get(result.url)
  if(!result.url.startsWith('file:')||!expected||!within(dirname(fileURLToPath(anchor)),fileURLToPath(result.url))||digest(readFileSync(fileURLToPath(result.url)))!==expected)throw denied()
  return result
 }})
 try{if(digest(readFileSync(fileURLToPath(entry)))!==binding.files.get(entry))throw denied();const module:unknown=await import(entry);current();return await work(module)}finally{hook.deregister()}
}
