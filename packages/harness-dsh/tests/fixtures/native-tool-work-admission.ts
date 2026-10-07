import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {cp,mkdtemp,readFile,realpath,rm,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createRequire} from 'node:module'
import {spawnSync} from 'node:child_process'
import {Context} from '@deepseek-ai/cordis'
import {ToolCallId} from '@deepseek-ai/dsh-llm'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import type {ToolExecutionInput,ToolRunContext,ToolDefinition,Config} from '@deepseek-ai/dsh-tools'

export type WorkAdmissionRequest=Readonly<{kind:'create';input:ToolExecutionInput;exec:ToolRunContext}>|Readonly<{kind:'body'|'body-end';exec:ToolRunContext}>
export type WorkAdmission=(candidate:WorkAdmissionRequest)=>undefined
type Cleanup={after:(action:()=>unknown)=>void}
const require=createRequire(import.meta.url),source=dirname(dirname(require.resolve('@deepseek-ai/dsh-tools')))
const compat=fileURLToPath(new URL('../../compat/',import.meta.url)),basename='dsh-tools-0.2.1-alpha.1-work-admission'
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
export function deferred<T=void>(){let resolve!:(value:T)=>void;let reject!:(error:unknown)=>void;const promise=new Promise<T>((done,fail)=>{resolve=done;reject=fail});return {promise,resolve,reject}}

/** 真完整npm Tools副本、fuzz0及逐文件before/after，不写受管包。 */
export async function patchedTools(t:Cleanup,patched=true){
 const manifest=JSON.parse(await readFile(join(compat,basename+'.json'),'utf8')),metadata=JSON.parse(await readFile(join(source,'package.json'),'utf8')),patch=join(compat,basename+'.patch')
 assert.equal(manifest.schema,'teloa.dsh-compat-patch/v1');assert.equal(manifest.package,metadata.name);assert.equal(metadata.version,'0.2.1-alpha.1');assert.equal(manifest.version,metadata.version);assert.equal(manifest.upstreamCommit,'5badb15009ae1756c3afe0ae0cef1faafc290ccc');assert.equal(sha(await readFile(patch)),manifest.patchSha256)
 assert.deepEqual(manifest.files.map((row:{path:string})=>row.path),['lib/index.js','lib/types/index.d.ts'])
 for(const row of manifest.files)assert.equal(sha(await readFile(join(source,row.path))),row.beforeSha256)
 if(!patched)return {root:source,namespace:await import(pathToFileURL(join(source,'lib/index.js')).href)}
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-native-tools-work-'))),copy=join(root,'package')
 t.after(async()=>{for(const row of manifest.files)assert.equal(sha(await readFile(join(source,row.path))),row.beforeSha256);await rm(root,{recursive:true,force:true})})
 await cp(source,copy,{recursive:true,filter:path=>path!==join(source,'node_modules')});await symlink(dirname(dirname(source)),join(copy,'node_modules'),'dir')
 const applied=spawnSync('/usr/bin/patch',['--batch','--fuzz=0','--forward','-p1','-i',patch],{cwd:copy,encoding:'utf8'})
 assert.equal(applied.status,0,applied.stdout+applied.stderr)
 for(const row of manifest.files)assert.equal(sha(await readFile(join(copy,row.path))),row.afterSha256)
 return {root:copy,namespace:await import(pathToFileURL(join(copy,'lib/index.js')).href)}
}

/** 真Cordis ToolRuntime、官方pre/dispatch/post/finalize，没有AgentLoop或模型。 */
export async function toolWorkFixture(t:Cleanup,options:{patched?:boolean;config?:Config}={}){
 const pkg=await patchedTools(t,options.patched!==false),ctx=new Context()
 t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(SystemPrompt);await ctx.plugin(pkg.namespace.ToolRuntime,options.config)
 const tools=ctx.tools as typeof ctx.tools & {requireWorkAdmission():void;installWorkAdmission(policy:WorkAdmission):void}
 let bodies=0
 const register=(name='fixture',execute?:ToolDefinition['execute'])=>{
  const definition:ToolDefinition={name,description:'真实官方执行准入夹具',parameters:{type:'object',properties:{}},output:{schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok']},render:()=>[{type:'text',text:'完成'}]},async execute(args,exec){bodies++;return execute?await execute(args,exec):{ok:true}}}
  tools.register(definition);return definition
 }
 const input=(args:unknown={},name='fixture',signal=new AbortController().signal):ToolExecutionInput=>({callId:ToolCallId('work-call'),name,arguments:args,signal})
 return {ctx,tools,pkg,register,input,bodies:()=>bodies}
}
