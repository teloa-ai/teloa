import test from 'node:test'
import assert from 'node:assert/strict'
import {businessDashboardShareSnapshotText} from '@teloa/contract'
import {dashboardShareFixture} from '../../../backend/tests/fixtures/business-dashboard-share.ts'
import {createDashboardShareApi,dashboardShareDigest} from '../src/client/dashboard-share-api.ts'

test('分享读取器核对真实服务快照、原目标与内容摘要，取消读取不返回可用数据',async()=>{
 const value=await dashboardShareFixture(),calls:unknown[]=[]
 const api=createDashboardShareApi(async(endpoint,payload,signal)=>{calls.push({endpoint,payload,signal});return structuredClone(value)})
 assert.deepEqual(await api(value.target),value)
 assert.deepEqual(calls,[{endpoint:'business-dashboards/share-snapshot',payload:{target:value.target},signal:undefined}])
 for(const patch of [{configurationVersion:3},{configurationHash:'d'.repeat(64)},{scope:'SOC'},{timeRange:'7d'}]){
  await assert.rejects(api({...value.target,...patch} as typeof value.target),{code:'teloa/invalid-host-response'})
 }
 const altered=structuredClone(value);altered.capturedAt='2026-10-21T13:00:00.000Z'
 await assert.rejects(createDashboardShareApi(async()=>altered)(value.target),{code:'teloa/invalid-host-response'})
 altered.snapshotHash=await dashboardShareDigest(businessDashboardShareSnapshotText(altered))
 assert.deepEqual(await createDashboardShareApi(async()=>altered)(value.target),altered)
 const controller=new AbortController();controller.abort()
 await assert.rejects(api(value.target,controller.signal),{name:'AbortError'})
})
