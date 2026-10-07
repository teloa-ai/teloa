import {test} from 'node:test'
import assert from 'node:assert/strict'
import type {SessionEventLikeEntry} from '@deepseek-ai/dsh-api-session-controller/client'
import {conversationOverviewDeliveries} from '../src/client/conversation-overview-deliveries.ts'
const entry=(seq:number,type:string,data:unknown)=>({type:'event',event:{type,seq,time:seq,data}}) as SessionEventLikeEntry
test('only explicit deliveries within the workspace become results; repeated paths are current files, not invented versions',()=>{
 const events=[entry(1,'tool/call',{name:'write',arguments:'{"file_path":"draft.md"}'}),entry(2,'deliverables/presented',{turn:1,callId:'a',files:[{path:'/work/result.md'},{path:'../escape.md'},{path:'/other/no.md'}]}),entry(3,'deliverables/presented',{turn:2,callId:'b',files:[{path:'result.md'}]})]
 const rows=conversationOverviewDeliveries('s',events,'/work')
 assert.equal(rows.length,1);assert.equal(rows[0]!.path,'result.md');assert.equal(rows[0]!.seq,3);assert.equal(rows[0]!.version,undefined);assert.equal(rows[0]!.status,'unknown')
})
test('fork inherited and malformed declarations never become the current session results',()=>{
 const events=[entry(1,'deliverables/presented',{turn:1,callId:'a',files:[{path:'ancestor.md'}]}),entry(2,'session/end-seed',{inherited:true}),entry(3,'deliverables/presented',{turn:1,files:[{path:'missing-call.md'}]}),entry(4,'deliverables/presented',{turn:2,callId:'b',files:[{path:'mine.csv'}]})]
 assert.deepEqual(conversationOverviewDeliveries('child',events,'/work').map(row=>row.path),['mine.csv'])
})
