import test from 'node:test'
import assert from 'node:assert/strict'
import {markSubmissionFailure,submissionFailureDiagnostic,submissionFailureLog} from '../src/task-run-submission-diagnostic.ts'
import {taskRunHasPublicationEvidence} from '../src/task-run-publication.ts'
test('提交诊断仅固定phase/类别/合法码，不输出异常正文或恶意getter',()=>{
 const sensitive='https://private/?token=secret-value input body Authorization: bearer password'
 const error=Object.assign(new TypeError(sensitive),{code:'ECONNREFUSED '+sensitive})
 markSubmissionFailure(error,'native-input')
 assert.deepEqual(submissionFailureDiagnostic(error),{phase:'native-input',category:'TypeError',code:'teloa/execution-pending'})
 assert.ok(!JSON.stringify(submissionFailureDiagnostic(error)).includes('secret'))
 assert.deepEqual(submissionFailureDiagnostic(Object.defineProperty({},'name',{get(){throw Error(sensitive)}})),{phase:'submission',category:'OtherError',code:'teloa/execution-pending'})
 const contract=Object.assign(new Error(sensitive),{name:'WorkError',code:'teloa/forbidden'})
 assert.equal(submissionFailureDiagnostic(contract).code,'teloa/forbidden')
})
test('模型失败保留有界阶段和公开模块行列，cause正文/路径/凭据均不进入日志',()=>{
 const secret='Authorization: Bearer private-token https://private.invalid/?key=hidden input body'
 const cause=Object.assign(new TypeError(secret),{stack:'TypeError: '+secret+'\n    at factory (file:///private/work/node_modules/@deepseek-ai/dsh-llm/lib/index.js:2175:18)\n    at secret (/private/customer-file.ts:1:2)'})
 const error=Object.assign(new Error(secret,{cause}),{stack:'Error: '+secret+'\n    at prepare (file:///private/work/packages/harness-dsh/lib/local-models.js:364:9)\n    at resolve (file:///private/work/packages/harness-dsh/src/task-model-routing.ts:47:31)\n    at unknown (https://private.invalid/secret:1:2)'})
 markSubmissionFailure(error,'model','model-routing-resolve')
 const diagnostic=submissionFailureDiagnostic(error)
 assert.deepEqual(diagnostic,{phase:'model',category:'Error',code:'teloa/execution-pending',modelStage:'model-routing-resolve',frames:[{module:'packages/harness-dsh/lib/local-models.js',line:364,column:9},{module:'packages/harness-dsh/src/task-model-routing.ts',line:47,column:31}],causes:[{category:'TypeError',frames:[{module:'@deepseek-ai/dsh-llm/lib/index.js',line:2175,column:18}]}]})
 const log=submissionFailureLog('00000000-0000-4000-8000-000000000001',error)
 assert.ok(log.includes('model-routing-resolve')&&log.includes('local-models.js'))
 for(const value of ['private-token','hidden','input body','file://','/private/work','customer-file','private.invalid'])assert.equal(log.includes(value),false,value)
 Object.defineProperty(cause,'cause',{value:error})
 assert.equal(submissionFailureDiagnostic(error).causes?.length,1,'循环cause不扩张')
 const evil=Object.defineProperties(new Error(secret),{stack:{get(){throw Error(secret)}},cause:{get(){throw Error(secret)}}})
 markSubmissionFailure(evil,'model','model-routing-install')
 assert.deepEqual(submissionFailureDiagnostic(evil),{phase:'model',category:'Error',code:'teloa/execution-pending',modelStage:'model-routing-install'})
})
test('未发布反证保留已结束旧历史，拒绝目标输入/排队与结束后的任意新Loop活动',()=>{
 const old=[{type:'user/message',data:{source:{kind:'user',rpcId:'old'}}},{type:'turn/end',data:{turn:1}}] as never
 assert.equal(taskRunHasPublicationEvidence(old,'new'),false)
 for(const tail of [{type:'request/header',data:{}},{type:'turn/start',data:{turn:2}},{type:'user/message',data:{source:{kind:'user',rpcId:'new'}}},{type:'agent/inbox/spliced',data:{inserted:[{source:{kind:'user',rpcId:'new'}}]}}])assert.equal(taskRunHasPublicationEvidence([...old as unknown as [],tail] as never,'new'),true)
})
