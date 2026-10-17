import test from 'node:test'
import assert from 'node:assert/strict'
import {SessionId,SessionSeq,type SessionEvent} from '@deepseek-ai/dsh-session'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {TeamId} from '@deepseek-ai/dsh-experimental-agent-team'
import type {TaskRunRuntimeLink} from '@teloa/backend'
import {taskRunTeamContinuations,taskRunTeamMessageKey} from '../src/task-run-team-records.ts'

const grant:Extract<TaskRunRuntimeLink,{kind:'team'}>={runId:'run',kind:'team',nativeId:'reservation',sessionId:'root',payload:{requestId:'request',reservationId:'reservation',name:'helper'}}
const row=(seq:number,type:string,data:unknown)=>({seq:SessionSeq(seq),time:Date.now(),type,data,surfaceOp:type==='user/message'?'append':'none'}) as SessionEvent
const member=row(0,'team/member',{teamId:TeamId('root'),member:{id:SessionId('child'),name:'helper',phase:'active'}})
/** alpha3 只产生 relay；direct 只存在于旧版持久历史，按原始事件数据构造，核对它不计为续接。 */
function message(sender='child',form:'relay'|'direct'='relay'){
 const relay=createUserMessage({source:{kind:'agent-message',form:'relay',senderSessionId:SessionId(sender)},content:[{type:'text',text:'不参与授权的正文'}]})
 return row(1,'user/message',form==='relay'?relay:{...relay,source:{...relay.source,form}})
}

test('新版直接 Inbox 仅将已获准 active 成员的 relay 消息计为续接',()=>{
 const relay=message(),events=[member,relay],key=taskRunTeamMessageKey(relay)
 assert.equal(typeof key,'string');assert.deepEqual([...taskRunTeamContinuations(events,[grant])],[key])
 for(const [history,grants] of [[events,[]],[[relay], [grant]],[[member,message('other')],[grant]],[[member,message('child','direct')],[grant]]] as const)assert.equal(taskRunTeamContinuations(history,grants).size,0)
})

test('不能用后续 roster 或相同正文补认未授权的历史递送',()=>{
 const relay=message(),later={...member,seq:SessionSeq(2)}
 assert.equal(taskRunTeamContinuations([relay,later],[grant]).size,0)
 const another=message();assert.notEqual(taskRunTeamMessageKey(relay),taskRunTeamMessageKey(another))
})

test('已接纳尚未claim的直接 Inbox relay也属于原Run续接，退役成员不再获准',()=>{
 const relay=message()
 assert.equal(relay.type,'user/message');if(relay.type!=='user/message')throw Error('fixture')
 const pending=row(1,'agent/inbox/spliced',{target:'next-step',index:0,deleteCount:0,inserted:[relay.data]})
 const key=taskRunTeamMessageKey(relay)
 assert.deepEqual([...taskRunTeamContinuations([member,pending],[grant])],[key])
 const retired=row(1,'team/member',{teamId:TeamId('root'),member:{id:SessionId('child'),name:'helper',phase:'failed'}})
 const late={...pending,seq:SessionSeq(2)}
 assert.equal(taskRunTeamContinuations([member,retired,late],[grant]).size,0)
})

test('历史未投递队列只生成核对清单，已投递消息和新 Inbox 不进入清单',async()=>{
 const {pendingLegacyTeamMessages}=await import('../src/task-run-team-records.ts')
 const queued=(id:string)=>row(2,'team/message/queued',{version:2,teamId:TeamId('root'),message:{id,senderId:SessionId('child'),senderName:'helper',targetId:SessionId('root'),content:[{type:'text',text:'不写入核对报告的正文'}]}})
 const history=[member,queued('pending'),queued('delivered'),row(3,'team/message/delivered',{version:2,teamId:TeamId('root'),messageId:'delivered'}),message()]
 assert.deepEqual(pendingLegacyTeamMessages(history),[{teamId:'root',messageId:'pending',senderId:'child',senderName:'helper',targetId:'root'}])
 assert.equal(JSON.stringify(pendingLegacyTeamMessages(history)).includes('正文'),false)
})
