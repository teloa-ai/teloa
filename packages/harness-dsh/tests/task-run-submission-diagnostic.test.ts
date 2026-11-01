import test from 'node:test'
import assert from 'node:assert/strict'
import {markSubmissionFailure,submissionFailureDiagnostic} from '../src/task-run-submission-diagnostic.ts'
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
test('未发布反证保留已结束旧历史，拒绝目标输入/排队与结束后的任意新Loop活动',()=>{
 const old=[{type:'user/message',data:{source:{kind:'user',rpcId:'old'}}},{type:'turn/end',data:{turn:1}}] as never
 assert.equal(taskRunHasPublicationEvidence(old,'new'),false)
 for(const tail of [{type:'request/header',data:{}},{type:'turn/start',data:{turn:2}},{type:'user/message',data:{source:{kind:'user',rpcId:'new'}}},{type:'agent/inbox/spliced',data:{inserted:[{source:{kind:'user',rpcId:'new'}}]}}])assert.equal(taskRunHasPublicationEvidence([...old as unknown as [],tail] as never,'new'),true)
})
