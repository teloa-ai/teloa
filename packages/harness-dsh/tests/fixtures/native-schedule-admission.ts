import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {cp,mkdtemp,readFile,realpath,rm,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createRequire} from 'node:module'
import {spawnSync} from 'node:child_process'
import {setTimeout as delay} from 'node:timers/promises'
import {Context,Service} from '@deepseek-ai/cordis'
import {AgentRegistry,type Agent} from '@deepseek-ai/dsh-agent'
import type {UserMessage} from '@deepseek-ai/dsh-llm'
import {SessionId,type SessionStore} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {patchedCorePackages} from './native-final-session.ts'

export type Delivery={agent:Agent;message:UserMessage;occurrences:readonly {scheduleId:string;occurrenceAt:string}[]}
export type Admission=(request:Readonly<Delivery>,dispatch:()=>void)=>Promise<void>
export type ScheduleOptions={admitDelivery?:Admission;requireDeliveryAdmission?:boolean}
const require=createRequire(import.meta.url),dshRequire=createRequire(require.resolve('@deepseek-ai/dsh/package.json'))
const compat=fileURLToPath(new URL('../../compat/',import.meta.url)),name='dsh-schedule-0.2.0-rc.2-delivery-admission'
const sha=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex')
const installed=(name:string)=>dshRequire.resolve(name)
export function deferred<T=void>(){let resolve!:(value:T)=>void;let reject!:(error:unknown)=>void;const promise=new Promise<T>((done,fail)=>{resolve=done;reject=fail});return {promise,resolve,reject}}
export async function until(check:()=>boolean|Promise<boolean>){for(let i=0;i<500;i++){if(await check())return;await delay(2)}throw Error('计划内存验收等待超时。')}

/** 仅复制已核对 npm 包到自有 tmp；原始依赖不写入，不复制引擎实现到仓库。 */
export async function patchedSchedule(t:{after:(action:()=>unknown)=>void},patched=true){
 const source=dirname(dirname(installed('@deepseek-ai/dsh-schedule'))),metadata=JSON.parse(await readFile(join(source,'package.json'),'utf8'))
 assert.equal(metadata.version,'0.2.0-rc.2')
 const receipt=JSON.parse(await readFile(join(compat,name+'.json'),'utf8'))
 const patch=join(compat,name+'.patch');assert.equal(receipt.schema,'teloa.dsh-compat-patch/v1');assert.equal(metadata.name,receipt.package);assert.equal(metadata.version,receipt.version);assert.equal(sha(await readFile(patch)),receipt.patchSha256)
 for(const row of receipt.files)assert.equal(sha(await readFile(join(source,row.path))),row.beforeSha256)
 if(!patched)return import(pathToFileURL(join(source,'lib/index.js')).href)
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-native-schedule-'))),copy=join(root,'package')
 t.after(async()=>{for(const row of receipt.files)assert.equal(sha(await readFile(join(source,row.path))),row.beforeSha256);await rm(root,{recursive:true,force:true})})
 await cp(source,copy,{recursive:true,filter:path=>path!==join(source,'node_modules')});await symlink(dirname(dirname(source)),join(copy,'node_modules'),'dir')
 const applied=spawnSync('/usr/bin/patch',['--batch','--fuzz=0','--forward','-p1','-i',patch],{cwd:copy,encoding:'utf8'})
 assert.equal(applied.status,0,applied.stdout+applied.stderr)
 for(const row of receipt.files)assert.equal(sha(await readFile(join(copy,row.path))),row.afterSha256)
 return import(pathToFileURL(join(copy,'lib/index.js')).href)
}

/** 小型测试 KV 原语；存储域、计划调度、Session/Inbox 均使用真实官方实现。 */
function memoryBackend(){
 const units=new Map<string,{version:number;global:unknown;tables:Map<string,Map<string,unknown>>}>()
 return {async close(){},kv:{async open(descriptor:{name:string;version:number;tables:readonly string[]}){
  let medium=units.get(descriptor.name)
  if(!medium){medium={version:descriptor.version,global:null,tables:new Map()};units.set(descriptor.name,medium)}
  assert.equal(medium.version,descriptor.version);const saved=medium;let closed=false
  const current=()=>{assert.equal(closed,false)}
  return {async loadAll(){current();return {tables:Object.fromEntries(descriptor.tables.map(table=>[table,Object.fromEntries(saved.tables.get(table)??[])])),global:structuredClone(saved.global)}},async putRecord(table:string,key:string,value:unknown){current();if(!saved.tables.has(table))saved.tables.set(table,new Map());saved.tables.get(table)!.set(key,structuredClone(value))},async deleteRecord(table:string,key:string){current();saved.tables.get(table)?.delete(key)},async setGlobal(value:unknown){current();saved.global=structuredClone(value)},async close(){closed=true}}
 }}}
}

export type ScheduleFixtureComposition={
 sessionPackage?:{SessionStore:typeof SessionStore}
 beforeService?:(candidate:{ctx:Context;agent:Agent})=>void
}

export async function scheduleFixture(t:{after:(action:()=>unknown)=>void},options:ScheduleOptions={},records:unknown[]=[],patched=true,resolvedAgent?:Agent,composition:ScheduleFixtureComposition={}){
 const {sessionPackage,llmPackage,toolsPackage,loopPackage}=await patchedCorePackages(t),schedule=await patchedSchedule(t,patched),ctx=new Context(),publication=deferred(),published=deferred<Agent>()
 for(const plugin of [llmPackage.LlmRuntime,composition.sessionPackage?.SessionStore??sessionPackage.SessionStore,SessionProjectionRegistry,SystemPrompt,toolsPackage.ToolRuntime,AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(loopPackage.AgentLoop,{agents:[]})
 // 官方创建发布屏障防止 turn 启动；无需 LLM/模型请求，仍保留真实 Agent.followup/Inbox。
 ctx.on('agent/created',async({agent})=>{published.resolve(agent);await publication.promise})
 const creating=ctx.agents.create({sessionId:SessionId('schedule-real-agent'),agentOptions:{provider:'test',model:'test'}})
 const agent=await published.promise
 t.after(async()=>{const disposing=ctx.fiber.dispose();publication.resolve();await Promise.allSettled([creating,disposing])})
 const [{default:Storage},{DomainFacility}]=await Promise.all([import(pathToFileURL(installed('@deepseek-ai/dsh-storage')).href),import(pathToFileURL(installed('@deepseek-ai/dsh-storage-domain')).href)])
 await ctx.plugin(Storage)
 const storage=Reflect.get(ctx,'storage') as {backend:{register:(name:string,backend:unknown)=>()=>void};mount:(name:string,facility:unknown)=>()=>void}
 const backend=memoryBackend();ctx.effect(()=>storage.backend.register('schedule-admission-fixture',backend))
 const facility=new DomainFacility(ctx,{backend:'schedule-admission-fixture'})
 ctx.effect(()=>{const unmount=storage.mount('domain',facility);ctx.provide('storageDomain',facility);return async()=>{await facility.closeAll();unmount()}})
 const seed=await facility.open(schedule.scheduleDomain)
 for(const record of records)await seed.table('tasks').put((record as {id:string}).id,{record,sessionId:agent.id,status:'active',deliveryHistory:{records:[],earlierRecordsUnavailable:false}})
 await seed.close()
 ctx.provide('sessionController',{resolveAgent:async(id:string)=>{assert.equal(id,agent.id);return {agent:resolvedAgent??agent}}} as never)
 ctx.provide('sessionPersistence',{} as never)
 const state={flushes:0,flush:undefined as undefined|(()=>Promise<void>)}
 ctx.on('session/flush',async()=>{state.flushes++;await state.flush?.()},{global:true})
 composition.beforeService?.({ctx,agent})
 const service=new schedule.ScheduleService(ctx,{},options);await service[Service.init]()
 t.after(()=>assert.equal(service.runtime?.timer,undefined,'owned Schedule timer must be cleared after Context disposal'))
 return {ctx,agent,service,schedule,state,async catalog(){return service.catalog()},inbox(){return agent.inbox.nextTurn},events(){return agent.session.snapshotEvents()},async drain(){await service.runtime?.running}}
}
