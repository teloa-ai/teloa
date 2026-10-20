import test from 'node:test'
import assert from 'node:assert/strict'
import type {SessionEvent} from '@deepseek-ai/dsh-session/types'
import {groupRoutingEmptyRetryRequestId,mayRetryEmptyGroupRouting,readGroupRoutingFailure} from '../src/group-routing-result.ts'

const request='11111111-1111-4111-8111-111111111111'
const events=(reason:unknown={kind:'completed'},content:unknown[]=[{type:'reasoning',text:'private reasoning'}])=>[
 {seq:0,type:'turn/start',data:{turn:0}},
 {seq:1,type:'user/message',surfaceOp:'append',data:{source:{kind:'user',rpcId:request}}},
 {seq:2,type:'assistant/message',surfaceOp:'append',data:{turn:0,message:{content}}},
 {seq:3,type:'turn/end',data:{turn:0,reason}},
] as SessionEvent[]

test('仅正常结束而无正文的轮次允许一次独立重试；错误、取消、有正文均不重放',()=>{
 assert.equal(mayRetryEmptyGroupRouting(events(),request,0),true)
 for(const reason of [{kind:'error',error:{code:'MISSING_CREDENTIAL',message:'PRIVATE'}},{kind:'error',error:{code:'SERVER',message:'PRIVATE'}},{kind:'cancel'}])assert.equal(mayRetryEmptyGroupRouting(events(reason),request,0),false)
 assert.equal(mayRetryEmptyGroupRouting(events({kind:'completed'},[{type:'text',text:'{}'}]),request,0),false)
 assert.equal(mayRetryEmptyGroupRouting(events(),request,1),false)
 const retry=groupRoutingEmptyRetryRequestId(request)
 assert.notEqual(retry,request)
 assert.equal(retry,groupRoutingEmptyRetryRequestId(request))
})

test('原生失败只投影固定诊断，不把认证和配置错误当作模型空答',()=>{
 assert.equal(readGroupRoutingFailure(events({kind:'error',error:{code:'MISSING_CREDENTIAL',message:'PRIVATE'}}),request,0),'credentials')
 assert.equal(readGroupRoutingFailure(events({kind:'error',error:{code:'UNKNOWN_MODEL',message:'PRIVATE'}}),request,0),'model')
 assert.equal(readGroupRoutingFailure(events({kind:'error',error:{code:'SERVER',message:'PRIVATE'}}),request,0),'request')
 assert.equal(readGroupRoutingFailure(events(),request,0),undefined)
})
