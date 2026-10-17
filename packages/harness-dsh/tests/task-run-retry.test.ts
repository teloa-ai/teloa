import test from 'node:test'
import assert from 'node:assert/strict'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {SessionSeq,type SessionEvent} from '@deepseek-ai/dsh-session/types'
import {TaskRunService,workRequestChildId,type TaskRun} from '@teloa/backend'
import {WorkError,taskInput} from '@teloa/contract'
import {createTaskRunHandler} from '../src/task-runs.ts'
import type {TaskRunPorts} from '../src/task-run-driver.ts'
const owner='owner',parent={sessionId:'original-platform-session',requestId:'11111111-1111-4111-8111-111111111111',roleId:'22222222-2222-4222-8222-222222222222'},taskId='33333333-3333-4333-8333-333333333333',runId='44444444-4444-4444-8444-444444444444'
const failed:TaskRun={id:runId,taskId,roleId:parent.roleId,taskVersion:1,roleVersion:3,linkVersion:1,sessionId:'task-run-'+workRequestChildId(parent.requestId,'run',parent.roleId),nativeRequestId:runId,state:'ended',evidence:{state:'ended',turn:0,messageSeq:1,endSeq:2,reason:'error'},stopRequestedAt:null,allowedTools:['result'],skills:[],knowledge:[],memory:[],inputText:'fixed original input',createdAt:'2026-10-12T00:00:00.000Z'}
const events:SessionEvent[]=[{seq:SessionSeq(0),time:1,type:'turn/start',data:{turn:0}},{seq:SessionSeq(1),time:2,type:'user/message',surfaceOp:'append',data:createUserMessage({source:{kind:'user',rpcId:runId},content:[{type:'text',text:'fixed original input'}]})},{seq:SessionSeq(2),time:3,type:'turn/end',data:{turn:0,reason:{kind:'error',error:{code:'UNKNOWN',message:'Model error before output'}}}}]
function fixture(){
 let stored=structuredClone(failed),newRun:TaskRun|undefined,stopped=false,loseReply=false
 const calls:string[]=[],history:TaskRun[]=[stored],requests=new Map<string,TaskRun>()
 // 仅模拟数据库/原生IO边界；handler、派生幂等身份和证明读口使用真实实现。
 const service=Object.assign(Object.create(TaskRunService.prototype),{
  conversationParent:async(actor:string)=>{assert.equal(actor,owner);return parent},
  origin:async()=>({taskId,runId,source:{kind:'conversation-work',...parent,messageId:'original',messageSeq:7,title:'原交办',stopped}}),
  get:async()=>stored,list:async()=>history,
  retryTaskVersion:async(actor:string,run:TaskRun)=>{assert.equal(actor,owner);assert.equal(run.id,runId);calls.push('definition');return 3},
  preparationTarget:async(_actor:string,input:{taskId:string;expectedTaskVersion:number})=>{assert.equal(input.taskId,taskId);assert.equal(input.expectedTaskVersion,3);return {taskId,taskVersion:3,title:'原任务',roleId:parent.roleId,roleVersion:3}},
  request:async(_actor:string,input:{requestId:string})=>requests.get(input.requestId)??null,
  prepare:async(_actor:string,input:{requestId:string;sessionId:string})=>{calls.push('prepare');const value={...failed,id:'55555555-5555-4555-8555-555555555555',taskVersion:3,sessionId:input.sessionId,state:'prepared',evidence:null};history.push(value);newRun=value;requests.set(input.requestId,value);if(loseReply){loseReply=false;throw Error('committed reply lost')}return value},
 }) as TaskRunService
 const ports:TaskRunPorts={resolvePreset:async()=> 'standard',check:async()=>{},send:async()=>{calls.push('send')},stop:async()=>{},events:async()=>events,backgroundState:async()=>({outstanding:false,interrupted:false}),subagentState:async()=> 'none',flowState:async()=> 'none',stopState:async()=>({running:false,settledSeq:null}),goalObservation:async()=>undefined}
 const handler=createTaskRunHandler(owner,async()=>service,ports,undefined,{beforeCreate:sessionId=>{calls.push('invalidate:'+sessionId)},conversations:{runReservation:async()=>null,failRunReservation:async()=>false,createRun:async(_actor,payload,fixed)=>{const input=taskInput(payload,['requestId','title']);calls.push('create-session');return {id:'66666666-6666-4666-8666-666666666666',ownerId:owner,requestId:String(input.requestId),title:String(input.title),version:1,status:'ready',sessionId:fixed.sessionId,requestedSessionId:fixed.sessionId,scopeIds:['general'],purpose:'task-run',run:{taskId,taskVersion:3,roleId:parent.roleId,roleVersion:3,agentPresetId:'standard'},createdAt:failed.createdAt}}},links:{change:async(_actor,input)=>({kind:'task',objectId:taskId,objectVersion:3,sessionId:(input as {sessionId:string}).sessionId,conversationId:'66666666-6666-4666-8666-666666666666',version:1,active:true,updatedAt:failed.createdAt,scopeId:'general'})}},{listMany:async()=>new Map()},undefined,{listMany:async()=>new Map()})
 return {handler,ports,calls,history,set:(value:TaskRun)=>{stored=value;history[0]=value},stop:()=>{stopped=true},lose:()=>{loseReply=true},get retry(){return newRun}}
}
test('公共retry与source伪装不获得parentAuthority，原停止请求不能预约新会话',async()=>{
 const f=fixture(),signal=new AbortController().signal
 await assert.rejects(f.handler('task-runs/retry',{runId},signal),{code:'teloa/conflict'})
 await assert.rejects(f.handler('task-runs/retry',{runId,parentIdentity:parent},signal,parent),{code:'teloa/invalid-input'})
 await assert.rejects(f.handler('task-runs/retry',{runId},signal,{...parent,sessionId:'wrong-parent'}),{code:'teloa/conflict'})
 f.stop();await assert.rejects(f.handler('task-runs/retry',{runId},signal,parent),{code:'teloa/conflict'});assert.deepEqual(f.calls,[])
})
test('可信parent/零副作用失败派生同Task单次新Run；丢回包重放保留原失败不再次创建',async()=>{
 const f=fixture(),signal=new AbortController().signal;f.lose()
 await assert.rejects(f.handler('task-runs/retry',{runId},signal,parent),/reply lost/)
 const requestId=workRequestChildId(parent.requestId,'run-retry:'+runId,parent.roleId)
 const recovered=await f.handler('task-runs/retry',{runId},signal,parent)
 assert.equal((recovered as TaskRun).sessionId,'task-run-'+requestId);assert.equal((recovered as TaskRun).taskId,taskId);assert.equal((recovered as TaskRun).taskVersion,3)
 assert.equal(f.history.length,2);assert.deepEqual(f.history[0],failed)
 assert.deepEqual(f.calls.filter(call=>call.startsWith('invalidate:')),['invalidate:task-run-'+requestId],'新派生会话必须先经过与普通prepare相同的宿主保护')
 assert.equal(f.calls.filter(call=>call==='create-session').length,1);assert.equal(f.calls.filter(call=>call==='prepare').length,1);assert.equal(f.calls.includes('send'),false)
})
test('active/unknown/success/stop intent和子级未知不能新prepare；重试Run不能继续再重试',async()=>{
 const signal=new AbortController().signal
 for(const run of [{...failed,state:'active'},{...failed,evidence:null},{...failed,evidence:{state:'ended' as const,turn:0,messageSeq:1,endSeq:2,reason:'completed'}},{...failed,stopRequestedAt:failed.createdAt},{...failed,sessionId:'task-run-another-request'}]){
  const f=fixture();f.set(run);await assert.rejects(f.handler('task-runs/retry',{runId},signal,parent));assert.equal(f.calls.includes('prepare'),false);assert.equal(f.calls.includes('create-session'),false)
 }
 const unknown=fixture();unknown.ports.backgroundState=async()=>{throw Error('unknown')};await assert.rejects(unknown.handler('task-runs/retry',{runId},signal,parent));assert.equal(unknown.calls.includes('prepare'),false)
 const f=fixture();await f.handler('task-runs/retry',{runId},signal,parent);const retry={...f.retry!,state:'ended',evidence:failed.evidence};f.set(retry)
 await assert.rejects(f.handler('task-runs/retry',{runId:retry.id},signal,parent),{code:'teloa/conflict'});assert.equal(f.history.length,2)
})
