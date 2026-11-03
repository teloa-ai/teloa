import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import * as api from '../src/index.ts'

test('未知后续核验必须是本人新请求，正文与原处置/来源严格固定',()=>{
 const read=Reflect.get(api,'readTaskRunSourceFollowupCommand')
 assert.equal(typeof read,'function','缺少本人后续核验协议')
 const command={kind:'unknown-verification',requestId:randomUUID(),runId:randomUUID(),expectedTaskVersion:6,dispositionRequestId:randomUUID(),sourceUpdateId:randomUUID(),acknowledgeUnknown:true,instruction:'核对证据，不重做未知操作。'}
 assert.deepEqual(read(command),command)
 for(const changed of [{...command,acknowledgeUnknown:false},{...command,sessionId:'caller-session'},{...command,instruction:''},{...command,instruction:'x'.repeat(8001)},{...command,requestId:command.runId}])assert.throws(()=>read(changed))
 const {acknowledgeUnknown:_ack,dispositionRequestId:_disposition,...basis}=command,result={...basis,kind:'result-verification'}
 assert.deepEqual(read(result),result)
 assert.throws(()=>read({...result,acknowledgeUnknown:true}))
 assert.throws(()=>read({...result,dispositionRequestId:randomUUID()}))
})

test('失败续办使用独立kind与固定error证据，新reader仍读取旧kind',()=>{
 const command={kind:'error-recovery',requestId:randomUUID(),runId:randomUUID(),expectedTaskVersion:9,sourceUpdateId:randomUUID(),instruction:'按原固定来源完成尚未完成的核对，不重复旧动作。'}
 assert.deepEqual(api.readTaskRunSourceFollowupCommand(command),command)
 assert.throws(()=>api.readTaskRunSourceFollowupCommand({...command,acknowledgeUnknown:true}))
 const candidate={schema:'teloa.task-run-source-followup-candidate/v1',kind:command.kind,taskId:randomUUID(),expectedTaskVersion:9,runId:command.runId,sessionId:'original-session',originalNativeRequestId:randomUUID(),originalInputSha256:'a'.repeat(64),originalEvidenceSha256:'b'.repeat(64),sourceUpdateId:command.sourceUpdateId,sourceTaskVersion:8,sourceEventId:randomUUID(),reference:{scope:'SOC',type:'alert',id:'A1',version:3,snapshotHash:'c'.repeat(64)}}
 assert.equal(api.readTaskRunSourceFollowupCandidate(candidate).kind,'error-recovery')
 const binding={...candidate,schema:'teloa.task-run-source-followup/v1',requestId:command.requestId,taskVersion:9,originalRunId:command.runId,instruction:command.instruction,confirmedAt:'2026-11-02T00:00:00.000Z',notice:api.errorRecoveryNotice};delete (binding as Record<string,unknown>).expectedTaskVersion;delete (binding as Record<string,unknown>).runId
 assert.equal(api.readTaskRunSourceFollowup(binding).kind,'error-recovery')
 assert.throws(()=>api.readTaskRunSourceFollowup({...binding,notice:api.resultFollowupNotice}))
 assert.throws(()=>api.readTaskRunSourceFollowup({...binding,originalEvidenceSha256:null}))
})

test('停止后续办是独立新owner意图，固定停止时刻；普通error不接受停止字段',()=>{
 const command={kind:'stopped-continuation',requestId:randomUUID(),runId:randomUUID(),expectedTaskVersion:19,sourceUpdateId:randomUUID(),instruction:'核对剩余工作，不重启旧执行或重放旧输入。'}
 assert.deepEqual(api.readTaskRunSourceFollowupCommand(command),command)
 for(const invalid of [{...command,instruction:''},{...command,requestId:command.runId},{...command,start:true},{...command,originalStopRequestedAt:'2026-11-03T00:00:00.000Z'}])assert.throws(()=>api.readTaskRunSourceFollowupCommand(invalid))
 const candidate={schema:'teloa.task-run-source-followup-candidate/v1',kind:command.kind,taskId:randomUUID(),expectedTaskVersion:19,runId:command.runId,sessionId:'original-session',originalNativeRequestId:randomUUID(),originalInputSha256:'a'.repeat(64),originalEvidenceSha256:'b'.repeat(64),originalStopRequestedAt:'2026-11-03T00:00:00.000Z',sourceUpdateId:command.sourceUpdateId,sourceTaskVersion:14,sourceEventId:randomUUID(),reference:{scope:'SOC',type:'alert',id:'A1',version:4,snapshotHash:'c'.repeat(64)}}
 assert.deepEqual(api.readTaskRunSourceFollowupCandidate(candidate),candidate)
 for(const changed of [{...candidate,originalStopRequestedAt:undefined},{...candidate,originalStopRequestedAt:'invalid'},{...candidate,kind:'error-recovery'}])assert.throws(()=>api.readTaskRunSourceFollowupCandidate(changed))
 const {expectedTaskVersion:_version,runId:_run,...rest}=candidate,binding={...rest,schema:'teloa.task-run-source-followup/v1',requestId:command.requestId,taskVersion:19,originalRunId:command.runId,instruction:command.instruction,confirmedAt:'2026-11-03T00:00:01.000Z',notice:api.stoppedContinuationNotice}
 assert.deepEqual(api.readTaskRunSourceFollowup(binding),binding)
 assert.throws(()=>api.readTaskRunSourceFollowup({...binding,notice:api.errorRecoveryNotice}))
})
