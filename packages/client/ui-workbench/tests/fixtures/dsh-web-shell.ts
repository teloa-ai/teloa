// 真实的刷新首页：官方 webserver 与 frontend-static 读取已安装的前端 dist，只替代浏览器认证。
// 官方包经核心固定的 @deepseek-ai/dsh 依赖树解析，与运行时同一份。
import {readFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {dirname,join} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'

type Cleanup={after:(fn:()=>unknown)=>void}
type Row={kind:string;[key:string]:unknown}
type Preference='light'|'dark'|'system'

const projectRoot=fileURLToPath(new URL('../../../../../',import.meta.url))
const dshRequire=createRequire(createRequire(join(projectRoot,'package.json')).resolve('@deepseek-ai/dsh/package.json'))
const load=async(name:string)=>import(pathToFileURL(dshRequire.resolve(name)).href)
const webServerPath=dshRequire.resolve('@deepseek-ai/dsh-host-webserver')
const {Context}=await import(pathToFileURL(createRequire(webServerPath).resolve('@deepseek-ai/cordis')).href)
const WebServer=(await load('@deepseek-ai/dsh-host-webserver')).default
const FrontendStatic=await load('@deepseek-ai/dsh-host-frontend-static')
const Theme=await load('@deepseek-ai/dsh-client-ui-theme')

/** 官方前端包的 dist 目录（dsh-web-app 按同一方式解析）。 */
export const distRoot=join(dirname(createRequire(dshRequire.resolve('@deepseek-ai/dsh-web-app')).resolve('@deepseek-ai/dsh-web-frontend/package.json')),'dist')
export const upstreamFile=(name:string)=>readFile(join(distRoot,name),'utf8')

/**
 * 起一套只含首页服务的组合。hostRows 模拟宿主或网关在 __DSH_BOOT__ 前后插入的行；
 * themePreference 给出时挂上官方主题插件的启动行（本人在设置里选的主题）。
 */
export async function serveIndex(t:Cleanup,{brand=true,hostRows=[],themePreference}:{brand?:boolean;hostRows?:Row[];themePreference?:()=>Preference}={}):Promise<{origin:string;ctx:any}>{
 const ctx=new Context()
 t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(WebServer,{host:'127.0.0.1',port:0})
 ctx.provide('connection',{authorizeIndex:()=>true})
 if(themePreference)await ctx.plugin({name:'theme-fixture',apply:(child:any)=>Theme.apply(child,{preference:{get:themePreference},fontSize:{get:()=>14}})})
 if(hostRows.length)await ctx.plugin({name:'host-rows',apply:(child:any)=>{child.on('webserver/index-inject',(table:Row[])=>{table.push(...hostRows)})}})
 if(brand)await ctx.plugin(await import('../../src/index.ts'))
 await ctx.plugin(FrontendStatic,{distIndex:join(distRoot,'index.html')})
 return {origin:`http://127.0.0.1:${ctx.get('webServer').port}`,ctx}
}
