import test from 'node:test'
import assert from 'node:assert/strict'
import type {SessionEvent} from '@deepseek-ai/dsh-session/types'
import {SessionSeq} from '@deepseek-ai/dsh-session'
import {createAssistantMessage,createUserMessage} from '@deepseek-ai/dsh-llm'
import {readTaskRunGroupResult} from '../src/task-run-group-result.ts'

const assistant=(seq:number,turn:number,text:string,interrupted=false):SessionEvent=>({type:'assistant/message',seq:SessionSeq(seq),time:seq,surfaceOp:'append',data:{turn,step:1,message:createAssistantMessage({source:{provider:'test',model:'test'},content:[{type:'text',text}]}),stream:[],...(interrupted?{interrupted:true}:{})}} as SessionEvent)
const start=(seq:number,turn:number):SessionEvent=>({type:'turn/start',seq,time:seq,data:{turn}} as SessionEvent)
const request=(seq:number,id='request'):SessionEvent=>({type:'user/message',seq:SessionSeq(seq),time:seq,surfaceOp:'append',data:createUserMessage({source:{kind:'user',rpcId:id},content:[]})} as SessionEvent)
const end=(seq:number,turn:number):SessionEvent=>({type:'turn/end',seq,time:seq,data:{turn,reason:{kind:'completed'}}} as SessionEvent)

test('群内回传只使用同一已结束轮次的最终完整助手文本',()=>{
 const events=[start(0,1),request(1),assistant(2,1,'第一版'),assistant(3,1,'最终答复'),end(4,1),start(5,2),assistant(6,2,'下一轮')]
 assert.equal(readTaskRunGroupResult(events,'request'),'最终答复')
})

test('未结束、被中断、空白或轮次外的助手消息不能作为群内回传',()=>{
 assert.equal(readTaskRunGroupResult([start(0,1),request(1),assistant(2,1,'仍在生成')],'request'),undefined)
 assert.equal(readTaskRunGroupResult([start(0,1),request(1),assistant(2,1,'中断内容',true),end(3,1)],'request'),undefined)
 assert.equal(readTaskRunGroupResult([start(0,1),request(1),assistant(2,2,'错误轮次'),assistant(3,1,'   '),end(4,1)],'request'),undefined)
})

test('后台续轮交付使用最后受管轮次，不能误发初轮占位回复',()=>{
 const notice={type:'user/message',seq:SessionSeq(5),time:5,surfaceOp:'append',data:createUserMessage({source:{kind:'tool-jobs',form:'notice',summary:'done'},content:[]})} as SessionEvent
 const events=[start(0,0),request(1),assistant(2,0,'后台仍在执行'),end(3,0),start(4,1),notice,assistant(6,1,'后台完成后的结果'),end(7,1)]
 assert.equal(readTaskRunGroupResult(events,'request'),'后台完成后的结果')
})
