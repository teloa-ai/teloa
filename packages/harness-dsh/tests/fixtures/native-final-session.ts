import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {cp,mkdtemp,readFile,realpath,rm,symlink} from 'node:fs/promises'
import {dirname,join} from 'node:path'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import type {Session,SessionEvent,SessionStore} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {LlmRuntime} from '@deepseek-ai/dsh-llm'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'

export type AppendAdmissionPolicy=(session:Session,event:Readonly<SessionEvent>)=>void
export type FinalSessionStore=SessionStore&{
 requireAppendAdmission:()=>void
 installAppendAdmission:(policy:AppendAdmissionPolicy)=>void
}
type Cleanup={after:(action:()=>unknown)=>void}
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
const compat=fileURLToPath(new URL('../../compat/',import.meta.url))

/** 只修改本测试创建的完整 npm 包副本；原包及 peer 依赖都保持只读。 */
export async function patchedSessionPackage(t:Cleanup){
 const source=dirname(await realpath(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-session/package.json')))
 const manifest=JSON.parse(await readFile(join(compat,'dsh-session-0.2.0-rc.2-append-admission.json'),'utf8')) as {
  schema:string;package:string;version:string;patchSha256:string;files:Array<{path:string;beforeSha256:string;afterSha256:string}>
 }
 const metadata=JSON.parse(await readFile(join(source,'package.json'),'utf8')) as {name:string;version:string}
 assert.equal(manifest.schema,'teloa.dsh-compat-patch/v1')
 assert.equal(metadata.name,manifest.package);assert.equal(metadata.version,manifest.version)
 const patch=await readFile(join(compat,'dsh-session-0.2.0-rc.2-append-admission.patch'))
 assert.equal(hash(patch),manifest.patchSha256)
 for(const file of manifest.files)assert.equal(hash(await readFile(join(source,file.path))),file.beforeSha256)
 const temporary=await mkdtemp(join(tmpdir(),'teloa-final-session-'))
 t.after(()=>rm(temporary,{recursive:true,force:true}))
 const copied=join(temporary,'session')
 await cp(source,copied,{recursive:true,dereference:true})
 // ESM resolves unchanged peer imports through this private temp link only.
 await symlink(dirname(dirname(source)),join(temporary,'node_modules'),'dir')
 const result=spawnSync('patch',['--batch','--fuzz=0','-p1'],{cwd:copied,input:patch,encoding:'utf8'})
 assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout)
 for(const file of manifest.files){
  assert.equal(hash(await readFile(join(copied,file.path))),file.afterSha256)
  assert.equal(hash(await readFile(join(source,file.path))),file.beforeSha256)
 }
 return await import(pathToFileURL(join(copied,'lib/index.js')).href) as typeof import('@deepseek-ai/dsh-session')&{
  SessionStore:new(ctx:Context)=>FinalSessionStore
 }
}

/** 真 patched SessionStore + 官方 AgentRegistry/AgentLoop/Inbox，同一 Context registry。 */
export async function patchedSessionFixture(t:Cleanup){
 const sessionPackage=await patchedSessionPackage(t)
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 for(const plugin of [LlmRuntime,sessionPackage.SessionStore,SessionProjectionRegistry,SystemPrompt,ToolRuntime,AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:sessionPackage.SessionId('final-a'),agentOptions:{provider:'test',model:'test'}})
 const {agent:other}=await ctx.agents.create({sessionId:sessionPackage.SessionId('final-b'),agentOptions:{provider:'test',model:'test'}})
 const sessions=Reflect.get(ctx,'sessions') as unknown as FinalSessionStore
 assert.equal(sessions.get(agent.id),agent.session);assert.equal(ctx.agents.get(agent.id),agent)
 assert.ok(agent.session instanceof sessionPackage.Session)
 return {ctx,agent,other,sessions,sessionPackage}
}
