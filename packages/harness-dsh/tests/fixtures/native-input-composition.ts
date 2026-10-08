import {createRequire} from 'node:module'
import {readFileSync,readdirSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'

/** 生效组合树中的一行（官方 applyEntryPatches 的输出形状）。 */
export type Row={id?:string;name?:string;disabled?:unknown;group?:boolean;config?:unknown;inject?:unknown}

const harnessRoot=fileURLToPath(new URL('../../',import.meta.url))
export const projectRoot=fileURLToPath(new URL('../../../../',import.meta.url))
const require=createRequire(join(harnessRoot,'package.json'))
const dshRequire=createRequire(createRequire(join(projectRoot,'package.json')).resolve('@deepseek-ai/dsh/package.json'))
const sdk=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href) as {
 PROFILE_TEMPLATES:{web:{bundles:string[]}}
 bundlePatchPaths:(directory:string,bundle:unknown)=>string[]
 loadOverlayPatches:(scope:string,path:string)=>unknown[]
}
const include=await import(pathToFileURL(createRequire(require.resolve('@deepseek-ai/dsh-app-boot')).resolve('@deepseek-ai/cordis-plugin-include')).href) as {
 applyEntryPatches:(rows:readonly unknown[],patches:readonly unknown[],warn:(message:string,...args:unknown[])=>void)=>Row[]
}
const profile=await import(pathToFileURL(join(projectRoot,'scripts/runtime/profile.mjs')).href) as {
 withTeloaProfileDefaults:(manifest:unknown)=>{dsh:{profile:{bundles:string[]}}}
}

/** 核心固定的 DSH 版本。 */
export const dshVersion=(JSON.parse(readFileSync(join(harnessRoot,'package.json'),'utf8')) as {engines:{dsh:string}}).engines.dsh
export const sessionControllerPackage='@deepseek-ai/dsh-api-session-controller'
export const officialManifestPath=require.resolve(sessionControllerPackage+'/package.json')

/** 官方补丁算法；任何未命中都视为组合错误。官方算法按引用插入行，这里先复制，避免后续补丁改到调用方手里的补丁。 */
export function applyPatches(rows:readonly unknown[],patches:readonly unknown[]):Row[]{
 return include.applyEntryPatches(rows,structuredClone(patches),(message,...args)=>{throw Error('补丁未命中：'+message+' '+args.map(String).join(' '))})
}

/** 社区版自身启动时的 bundle 顺序与官方补丁算法得到的生效组合（不含本人 profile 补丁）。 */
export function communityRows():Row[]{
 const bundles=profile.withTeloaProfileDefaults({dsh:{profile:{bundles:sdk.PROFILE_TEMPLATES.web.bundles}}}).dsh.profile.bundles
 const local:Record<string,string>={'@teloa/bundle':'packages/bundle','@teloa/im-gateway':'packages/im-gateway'}
 const patches:unknown[]=[]
 for(const name of bundles){
  const path=local[name]?join(projectRoot,local[name],'package.json'):dshRequire.resolve(name+'/package.json')
  const manifest=JSON.parse(readFileSync(path,'utf8')) as {dsh:{bundle:unknown}}
  patches.push(...sdk.bundlePatchPaths(dirname(path),manifest.dsh.bundle).flatMap(file=>sdk.loadOverlayPatches('dsh',file)))
 }
 return applyPatches([],patches)
}

/** 与宿主做法一致：由已应用的兼容补丁清单得到「包 → 能力名」。 */
export function compatibilityAPIs(version=dshVersion):Record<string,string[]>{
 const directory=join(harnessRoot,'compat'),result:Record<string,string[]>={}
 for(const file of readdirSync(directory).filter(name=>name.endsWith('.json')&&name.includes('-'+version+'-'))){
  const manifest=JSON.parse(readFileSync(join(directory,file),'utf8')) as {package:string;api:string[]}
  result[manifest.package]=[...manifest.api]
 }
 return result
}

export function findRow(rows:readonly Row[],id:string):Row|undefined{
 for(const row of rows){
  if(row.id===id)return row
  if(row.group&&Array.isArray(row.config)){const found=findRow(row.config as Row[],id);if(found)return found}
 }
 return undefined
}

export type ClientModules={graph:()=>{entries:Array<{id:string}>};clientPath:(id:string)=>string|undefined}

/** 用官方 dsh-client-modules 的真实发现逻辑扫描启用行，返回浏览器模块表（包名 → client 文件）。 */
export async function discoveredClientModules(rows:readonly Row[]):Promise<Map<string,string>>{
 const registry=await clientModuleRegistry(rows)
 return new Map(registry.graph().entries.map(entry=>[entry.id,registry.clientPath(entry.id)??'']))
}

/**
 * 官方 ClientModuleRegistry 服务（启动后 `ctx.get('clientModules')` 的同一实现），对启用行完成首次扫描。
 * Loader 只提供条目表；裸包名从官方 dsh 依赖树解析，与宿主一致。
 */
export async function clientModuleRegistry(rows:readonly Row[]):Promise<ClientModules>{
 const controllerRequire=createRequire(officialManifestPath),modulesPath=controllerRequire.resolve('@deepseek-ai/dsh-client-modules')
 const cordis=await import(pathToFileURL(createRequire(modulesPath).resolve('@deepseek-ai/cordis')).href) as {Context:new()=>{provide:(name:string,value:unknown)=>void;plugin:(plugin:unknown)=>Promise<unknown>;get:(name:string)=>unknown}}
 const {ClientModuleRegistry}=await import(pathToFileURL(modulesPath).href) as {ClientModuleRegistry:unknown}
 const baseUrl=pathToFileURL(createRequire(join(projectRoot,'package.json')).resolve('@deepseek-ai/dsh/package.json')).href
 const entries:unknown[]=[]
 const visit=(list:readonly Row[])=>{
  for(const row of list){
   if(row.disabled!==undefined&&row.disabled!==false)continue
   if(row.group&&Array.isArray(row.config)){visit(row.config as Row[]);continue}
   if(typeof row.name==='string')entries.push({options:{name:row.name},fiber:{},disabled:false,parent:{tree:{ctx:{baseUrl}}}})
  }
 }
 visit(rows)
 const ctx=new cordis.Context()
 ctx.provide('loader',{entries:()=>entries,internal:undefined})
 await ctx.plugin(ClientModuleRegistry)
 return ctx.get('clientModules') as ClientModules
}
