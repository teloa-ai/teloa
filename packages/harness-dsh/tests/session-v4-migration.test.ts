import test from 'node:test'
import assert from 'node:assert/strict'
import {createSessionFormatV3ToV4,restoreReleasedV4Artifact,RELEASED_V3_EVENT_TYPES} from '@deepseek-ai/dsh-session-format-v3-to-v4'
import type {SessionFormatEvent,SessionFormatHeader,SessionFormatMigrationContext} from '@deepseek-ai/dsh-session-format'
import type {SessionEvent} from '@deepseek-ai/dsh-session'
import {resourceHistoryPage} from '../src/resource-history.ts'
import {observeTaskRun} from '../src/task-run-observation.ts'

const sessionId='11111111-1111-4111-a111-111111111111'
const resourceId='22222222-2222-4222-a222-222222222222'
const requestId='33333333-3333-4333-a333-333333333333'
const sourceHeader:SessionFormatHeader={version:3,id:sessionId,createdAt:1000,isSeeded:false,delegationDepth:0,agentPreset:'teloa-standard'}

/** 直接调用官方相邻版本迁移器和目标版本校验器，不手工改写历史资料来源。 */
function migrate(events:SessionFormatEvent[]){
 const migration=createSessionFormatV3ToV4([]),header=migration.migrateHeader(sourceHeader)
 const stage=migration.createStage({sourceHeader,targetHeader:header,sourceInheritedEventCount:0,sourceKind:'decoded'})
 const output:SessionFormatEvent[]=[]
 const context:SessionFormatMigrationContext={emitEvent:event=>{output.push(event)},emitRun:run=>{output.push(...run.expand())}}
 for(const event of events)stage.transformEvent(event,context)
 const inheritedEventCount=stage.finish(context)
 const artifact=restoreReleasedV4Artifact({header,inheritedEventCount,events:output},RELEASED_V3_EVENT_TYPES)
 assert.equal(artifact.header.version,4)
 return artifact.events as readonly SessionEvent[]
}

test('官方 V3→V4 后保留任务请求身份、冻结资料标题和不透明扩展事件',()=>{
 const payload={schema:'teloa.resource-context/v1',snapshot:{ownerId:'owner',sessionId,messageId:'user-1',scopeIds:['general'],references:[{id:resourceId,version:1}]},contents:[{id:resourceId,version:1,title:'旧会话的资料标题',scopeIds:['general'],sourceId:'workbench',sourceVersion:'a'.repeat(64),text:'资料正文不能回传给目录'}]}
 const events:SessionFormatEvent[]=[
  {type:'turn/start',seq:0,time:1000,data:{turn:1}},
  {type:'user/message',surfaceOp:'append',seq:1,time:1001,data:{id:'user-1',role:'user',source:{kind:'user',rpcId:requestId},content:[{type:'text',text:`核对 [[teloa-resource:${resourceId}@1]]`}] }},
  {type:'user/message',surfaceOp:'append',seq:2,time:1002,data:{id:'context-1',role:'user',source:{kind:'plugin',plugin:'teloa.resources',form:'notice',summary:'本轮资料'},content:[{type:'text',text:'资料说明\n'+JSON.stringify(payload)}]}},
  {type:'teloa/legacy-evidence',ignorable:true,seq:3,time:1003,data:{version:1,note:'保留的业务记录'}},
  {type:'turn/end',seq:4,time:1004,data:{turn:1,reason:{kind:'completed'}}},
 ]
 const before=JSON.stringify(events),output=migrate(events)
 assert.equal(JSON.stringify(events),before,'迁移不得原地改写旧版本备份')
 const history=resourceHistoryPage('owner',sessionId,output)
 assert.equal(history.items[0]?.references[0]?.metadata?.title,'旧会话的资料标题')
 assert.equal(JSON.stringify(history).includes('资料正文不能回传给目录'),false)
 assert.deepEqual(observeTaskRun(output,requestId),{state:'ended',turn:1,messageSeq:1,endSeq:4,reason:'completed'})
 const opaque=output[3] as SessionFormatEvent|undefined
 assert.equal(opaque?.type,'plugin:teloa/legacy-evidence')
 assert.deepEqual(opaque?.data,{version:1,note:'保留的业务记录'})
})

test('V3 未完成轮次迁移后保持执行中，不伪造任务完成',()=>{
 const output=migrate([
  {type:'turn/start',seq:0,time:1000,data:{turn:1}},
  {type:'user/message',surfaceOp:'append',seq:1,time:1001,data:{id:'user-1',role:'user',source:{kind:'user',rpcId:requestId},content:[{type:'text',text:'尚未完成的交办'}]}},
 ])
 assert.deepEqual(observeTaskRun(output,requestId),{state:'active',turn:1,messageSeq:1})
})
