import type {TestContext} from 'node:test'
import {readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {ApprovalService} from '@deepseek-ai/dsh-user-approval'
import {SandboxPolicyService} from '@deepseek-ai/dsh-sandbox-policy'
import {PermissionPresetService} from '@deepseek-ai/dsh-permission-presets'
import {WorkingDirectoryService} from '@deepseek-ai/dsh-working-directory'
import {official} from '../../../../tests/native-auto-review-fixture.mjs'
import {registerNativeAutoReviewGuard} from '../../src/native-auto-review-guard.ts'
import {registerTaskToolGuard} from '../../src/task-tool-guard.ts'
import {patchedNativePackage} from './native-patched-package.ts'
import type {nativeHotCausalityFixture} from './native-hot-causality.ts'
import type {GenerateOptions} from '@deepseek-ai/dsh-llm'

// 只供测试观察审核流，文本标记不参与产品准入或产生权限证明。
export const isReviewRequest=(request:GenerateOptions)=>request.system?.startsWith('REVIEW_POLICY\n')===true

/** 真实产品守卫和固定审核包引用同一私有副本，既不改依赖，也不绕过最终模型派发点。 */
export async function autoReviewCausalityFixture(t:TestContext){
 const pkg=await patchedNativePackage<typeof import('@deepseek-ai/dsh-experimental-auto-review')>(t,{packageName:'@deepseek-ai/dsh-experimental-auto-review',compatBasename:'dsh-experimental-auto-review-0.2.1-rc.2-request-owner'})
 const review=pathToFileURL(join(pkg.root,'lib/index.js')).href
 const copy=async(relative:string,name:string,replacements:Record<string,string>={})=>{
  const origin=new URL(relative,import.meta.url),require=createRequire(origin)
  const source=(await readFile(origin,'utf8')).replace(/from (['"])([^'"]+)\1/g,(original,_quote,specifier:string)=>{
   if(specifier.startsWith('node:'))return original
   const target=replacements[specifier]??(specifier.startsWith('.')?new URL(specifier,origin).href:pathToFileURL(require.resolve(specifier)).href)
   return 'from '+JSON.stringify(target)
  })
  const file=join(pkg.root,name);await writeFile(file,source);return pathToFileURL(file).href
 }
 const causality=await copy('../../src/native-work-causality.ts','native-work-causality.ts',{'@deepseek-ai/dsh-experimental-auto-review':review})
 const input=await copy('../../src/native-work-input.ts','native-work-input.ts',{'./native-work-causality.ts':causality})
 const kernel=await copy('./native-hot-causality.ts','native-hot-causality.ts',{'../../src/native-work-input.ts':input})
 const module=await import(kernel) as {nativeHotCausalityFixture:typeof nativeHotCausalityFixture}
 const f=await module.nativeHotCausalityFixture(t),{ctx,agent}=f
 await ctx.plugin(ApprovalService,{policy:'ask'})
 await ctx.plugin(SandboxPolicyService,{mode:'workspace-write'})
 ctx.provide('shell',{sandboxMode:'workspace-write'})
 await ctx.plugin(PermissionPresetService)
 await ctx.plugin((await official('dsh-fs-sandbox')).default,{})
 await ctx.plugin(WorkingDirectoryService,{defaultDirectory:process.cwd()})
 await ctx.plugin(pkg.namespace)
 ctx.permissionPresets.set(agent.session,'auto')
 agent.ctx.on('agent/request',async(_payload,next)=>({...await next(),maxTokens:64}))
 const read=async()=>({allowedTools:['hot_result']})
 registerTaskToolGuard(ctx,read);registerNativeAutoReviewGuard(ctx,read)
 return f
}
