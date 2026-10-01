import test from 'node:test'
import assert from 'node:assert/strict'
import type {Pool} from 'pg'
import {PendingRequestService} from '../src/work/pending-requests.ts'

const requestId='11111111-1111-4111-8111-111111111111',owner='local:owner',now='2026-10-01T00:00:00.000Z'
test('旧市场上传待恢复行仍按本人可读取，新的上传不再进入通用登记',async()=>{
 const payload={requestId,kind:'atomic-skill',files:[{path:'SKILL.md',base64:'Iw=='}]}
 const row={request_id:requestId,endpoint:'market-content/import',request_spec:payload,created_at:now,updated_at:now,last_error_code:null}
 const queries:unknown[][]=[]
 const pool={query:async(sql:string,values:unknown[])=>{queries.push([sql,values]);return {rows:values[0]===owner?[row]:[]}},connect:async()=>{throw Error('不得登记上传正文')}} as unknown as Pool
 const service=new PendingRequestService(pool)
 assert.equal((await service.list(owner))[0]!.endpoint,'market-content/import')
 assert.deepEqual((await service.readForRecovery(owner,requestId)).payload,payload)
 await assert.rejects(service.readForRecovery('other',requestId),{code:'teloa/not-found'})
 await assert.rejects(service.reserve(owner,'market-content/import' as never,payload,now),{code:'teloa/invalid-input'})
 assert.ok(queries.every(([,values])=>(values as unknown[])[0]===owner||(values as unknown[])[0]==='other'))
})
