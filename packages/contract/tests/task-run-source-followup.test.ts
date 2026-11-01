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
