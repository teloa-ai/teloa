import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {artifactContent,taskDefinition,type SavedArtifactVersion,type RoleDailyLog} from '@teloa/contract'
import type {CompletionVerifierInput,RoleDailyLogCompletionEvidence} from '@teloa/backend'
const {Client}:{Client:new()=>Omit<CompletionVerifierInput['db'],'release'>}=createRequire(import.meta.resolve('@teloa/backend'))('pg')
const id='11111111-1111-4111-8111-111111111111',artifactId='22222222-2222-4222-8222-222222222222',receiptId='33333333-3333-4333-8333-333333333333'
const sha=(text:string)=>createHash('sha256').update(text).digest('hex')
const content=artifactContent({title:'版本小结',sections:[{id:'summary',title:'来源',text:'原件v1的只读摘要'}],snapshotIds:[],note:'交付'})
const resource={id,version:1,title:'实际资料',sourceId:'policy',sourceVersion:sha('原件v1'),scopeIds:['general'],text:'原件v1'}
const artifact:SavedArtifactVersion={artifactId,ownerId:'owner',number:1,source:{kind:'task',id,scope:'general',version:'3 · 2026-10-09T00:00:00.000Z',title:'版本小结'},content,createdAt:'2026-10-09T00:00:00.000Z'}
const transaction:CompletionVerifierInput['db']=Object.assign(new Client(),{release(){throw Error('验证器只能通过所登记的真实读取端口访问事务。')}})
const at='2026-10-09T00:00:00.000Z'
const input:CompletionVerifierInput={ownerId:'owner',task:{...taskDefinition({title:'版本小结',goal:'核对真实资料',scope:'general'}),id,ownerId:'owner',version:3,contentVersion:1,state:'waiting',assigneeRoleId:id,assigneeRoleVersion:1,createdAt:at,updatedAt:at},run:{id,taskId:id,roleId:id,taskVersion:2,roleVersion:1,linkVersion:1,sessionId:'actual-session',nativeRequestId:receiptId,state:'ended',evidence:{state:'ended',turn:0,messageSeq:1,endSeq:3,reason:'completed'},stopRequestedAt:null,allowedTools:[],skills:[],knowledge:[resource],memory:[],inputText:'固定原执行输入',createdAt:at},policy:{kind:'verified',verifier:'material-version-summary',verifierVersion:1,authorizationVersion:1},candidate:{runId:id,terminalEventSeq:3,artifactIds:[artifactId],receiptIds:[receiptId]},lineage:{schema:'teloa.work-lineage/v1',ownerId:'owner',rootTaskId:id,definition:null,parentRunId:null,definitionControlId:null,roundControlId:id,controlGeneration:1,budgetAccountId:receiptId},db:transaction}
async function api(){const value=await import('../src/task-completion-verifiers.ts').catch(()=>null);assert.ok(value,'可信来源验证器尚未实现');return value}
test('资料版本小结核真实来源版本与正式成果摘要，伪已完成或文件存在不通过',async()=>{
 const {createTaskCompletionVerifiers}=await api()
 const receipt={id:receiptId,ownerId:'owner',runId:id,roleId:id,roleVersion:1,artifactId,artifactVersion:1,artifactHash:sha(JSON.stringify(content)),sources:[{resourceId:id,resourceVersion:1,sourceId:'policy',sourceVersion:resource.sourceVersion,contentHash:resource.sourceVersion}]}
 let current=structuredClone(receipt)
 const verifier=createTaskCompletionVerifiers({materialReceipts:async()=>[current],material:async()=>resource,artifact:async()=>artifact})['material-version-summary']
 assert.equal((await verifier(input)).verified,true)
 for(const patch of [{artifactHash:sha('别的成果')},{artifactVersion:2},{roleVersion:2},{sources:[{...receipt.sources[0],sourceVersion:sha('改版')}]}]){current={...receipt,...patch} as typeof receipt;assert.equal((await verifier(input)).verified,false)}
 const unavailable=createTaskCompletionVerifiers({artifact:async()=>artifact})['material-version-summary'];assert.equal((await unavailable(input)).verified,false)
})
test('系统小结只认真实employee daily-digest回执，不接分身habit或缺输出',async()=>{
 const {createTaskCompletionVerifiers}=await api()
 const verifier=createTaskCompletionVerifiers({digest:async()=>null})['system-digest']
 assert.equal((await verifier({...input,policy:{kind:'verified',verifier:'system-digest',verifierVersion:1,authorizationVersion:1}})).verified,false)
 const log:RoleDailyLog={id,ownerId:'owner',roleId:id,roleVersion:1,runId:id,kind:'daily-digest',state:'kept',day:'2026-10-09',title:'每日小结',markdown:'真实来源事实。',scopeIds:['general'],evidence:[],pruneHints:[],createdAt:at,discardedAt:null}
 const evidence:RoleDailyLogCompletionEvidence={identity:{taskId:id,runId:id,roleId:id,roleVersion:1,day:log.day,planId:id},log,receiptIds:[receiptId],contentHash:sha(log.markdown)}
 let current=structuredClone(evidence),saved=0
 const actual=createTaskCompletionVerifiers({digest:async()=>current,saveDigestArtifact:async()=>{saved++;return {id:artifactId,version:1}}})['system-digest'],candidate={...input,candidate:{runId:id,terminalEventSeq:3,artifactIds:[],receiptIds:[]}}
 assert.equal((await actual(candidate)).verified,true);assert.equal(saved,1)
 const patches:Array<Partial<RoleDailyLogCompletionEvidence>>=[{log:{...log,kind:'habit-digest',runId:null}},{log:{...log,roleId:artifactId}},{identity:{...evidence.identity,day:'2026-10-08'}},{identity:{...evidence.identity,roleId:artifactId}},{receiptIds:[]},{contentHash:sha('伪已完成')}]
 for(const patch of patches){current={...evidence,...patch};assert.equal((await actual(candidate)).verified,false)}
 assert.equal(saved,1)
})

test('服务端版本小结由实际读取固定来源生成，缺来源或错误保存摘要不结项',async()=>{
 const {createTaskCompletionVerifiers}=await api()
 let current=resource,wrong=false,saved=0
 const runInput:CompletionVerifierInput={...input,task:{...input.task,title:'资料版本小结'},candidate:{runId:id,terminalEventSeq:3,artifactIds:[],receiptIds:[]}}
 const verifier=createTaskCompletionVerifiers({material:async()=>current,saveMaterialSummaryArtifact:async(_input,delivery)=>{saved++;return {receiptId:delivery.requestId,artifact:{...artifact,content:wrong?content:delivery.content}}}})['material-version-summary']
 assert.equal((await verifier(runInput)).verified,true);assert.equal(saved,1)
 current={...resource,text:'已变化'};assert.equal((await verifier(runInput)).verified,false);assert.equal(saved,1)
 current=resource;wrong=true;assert.equal((await verifier(runInput)).verified,false)
 assert.equal((await verifier({...runInput,run:{...runInput.run,knowledge:[]}})).verified,false)
})
