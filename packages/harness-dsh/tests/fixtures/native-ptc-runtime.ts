import type {TestContext} from 'node:test'
import {Context} from '@deepseek-ai/cordis'
import {createRequire} from 'node:module'
import {mkdtemp,realpath,rm,mkdir} from 'node:fs/promises'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import NodeRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import PythonRuntime from '@deepseek-ai/dsh-experimental-ptc-runtime-python'

const require=createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json'))
/** 官方本机fs/subprocess/sandbox/策略和真实子进程；不替换沙箱或解释器。 */
export async function nativePtcRuntime(t:TestContext,language:'node'|'python',persistent=false){
 const base=fileURLToPath(new URL('../../../../.runtime/',import.meta.url));await mkdir(base,{recursive:true})
 const root=await realpath(await mkdtemp(join(base,'teloa-native-ptc-'))),ctx=new Context()
 t.after(async()=>{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true})})
 for(const name of ['session','session-projection','fs-local','subprocess-local','sandbox-local']){
  const plugin=await import(require.resolve('@deepseek-ai/dsh-'+name));await ctx.plugin(plugin.default,name==='fs-local'?{cwd:root}:{})
 }
 const policy=await import(require.resolve('@deepseek-ai/dsh-sandbox-policy'))
 await ctx.plugin(policy.default,{mode:'workspace-write',workspaceRoot:root})
 await ctx.plugin(language==='node'?NodeRuntime:PythonRuntime,language==='node'?{executionMode:persistent?'persistent-in-memory':'per-call',timeoutMs:10000,maxTimeoutMs:10000}:{maxWallMs:10000})
 return {ctx,root,runtime:ctx.ptcRuntime}
}
