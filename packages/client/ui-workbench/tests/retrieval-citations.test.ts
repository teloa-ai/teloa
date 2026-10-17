import test from 'node:test'
import assert from 'node:assert/strict'
import {readRetrievalSearchResult,retrievalCitationPath,readRetrievalCitationPath} from '@teloa/contract'
import {isRetrievalCitationLink,openRetrievalCitation,readRetrievalSourceAddress,resolveRetrievalCitation,retrievalSourceAddress,type RetrievalCitationPort} from '../src/client/retrieval-citations.ts'

const sessionId='session-original',resourceId='11111111-1111-4111-8111-111111111111',sourceId='local_material_22222222-2222-4222-8222-222222222222',sourceVersion='b'.repeat(64)
const hit={resourceId,resourceVersion:1,title:'原始资料',sourceId,sourceVersion,lines:[0,2] as [number,number],chars:[0,20] as [number,number],heading:'固定依据',score:0.7,excerpt:'乙负责整理五条待办。'}
function events(hits=[hit],name='teloa_knowledge_search'){
 const result={coverage:{searched:[{resourceId,title:'原始资料',version:hits[0]!.resourceVersion}],pending:[],note:'只查已加入资料'},results:hits}
 return [{event:{type:'tool/call',seq:1,data:{turn:1,callId:'original-call',name}}},{event:{type:'tool/result',seq:2,data:{turn:1,message:{source:{kind:'tool',callId:'original-call'},toolCallId:'original-call',content:[{type:'text',text:JSON.stringify(result)}]}}}}]
}
test('新引用与历史sourceId只解析本会话真实检索回执，同一原件的多个片段可合并',()=>{
 const second={...hit,lines:[3,4] as [number,number],chars:[20,40] as [number,number],excerpt:'本周五前完成。'},entries=events([hit,second])
 for(const path of [retrievalCitationPath(sessionId,hit),sourceId]){
  const value=resolveRetrievalCitation(entries,sessionId,path) as any
  assert.equal(value?.resourceId,resourceId,'可打开固定来源，而不是把sourceId交给文件系统')
  assert.equal(value.resourceVersion,1);assert.equal(value.sourceVersion,sourceVersion);assert.equal(value.title,'原始资料')
  assert.deepEqual(value.excerpts.map((row:any)=>row.text),[hit.excerpt,second.excerpt])
 }
 assert.equal(resolveRetrievalCitation(entries,'other-session',retrievalCitationPath(sessionId,hit)),undefined)
 assert.equal(resolveRetrievalCitation(events([hit],'unknown-tool'),sessionId,sourceId),undefined)
 assert.equal(resolveRetrievalCitation(entries.slice(1),sessionId,sourceId),undefined)
 assert.equal(resolveRetrievalCitation([],sessionId,sourceId),undefined)
})
test('旧链接不同版本或身份有歧义时明确不可用；新引用不换当前版本',()=>{
 const later={...hit,resourceVersion:2,sourceVersion:'c'.repeat(64),excerpt:'新版职责不同。'},entries=[...events(),...events([later]).map(row=>({event:{...row.event,seq:row.event.seq+10,data:{...row.event.data,...('message'in row.event.data?{message:{...row.event.data.message,source:{kind:'tool',callId:'later-call'},toolCallId:'later-call'}}:{callId:'later-call'})}}}))]
 assert.equal(resolveRetrievalCitation(entries,sessionId,sourceId),undefined)
 const fixed=resolveRetrievalCitation(entries,sessionId,retrievalCitationPath(sessionId,hit)) as any
 assert.equal(fixed?.resourceVersion,1);assert.equal(fixed.excerpts[0].text,hit.excerpt)
 assert.equal(resolveRetrievalCitation(entries,sessionId,'../../private.txt'),undefined)
 const failed=events();(failed[1]!.event.data as any).message.isError=true
 assert.equal(resolveRetrievalCitation(failed,sessionId,sourceId),undefined)
 const wrongTurn=events();wrongTurn[1]!.event.data.turn=2
 assert.equal(resolveRetrievalCitation(wrongTurn,sessionId,sourceId),undefined)
})
test('引用地址严格绑定固定资料版本/hash/区间，旧检索结果保持兼容',()=>{
 const path=retrievalCitationPath(sessionId,hit)
 assert.deepEqual(readRetrievalCitationPath(path),{sessionId,resourceId,resourceVersion:1,sourceVersion,chars:hit.chars})
 for(const value of [path+'?path=/tmp/secret',path.replace('/1/','/01/'),path.replace('0-20','00-020'),path.replace('0-20','20-0'),'teloa-source/../'+resourceId+'/1/'+sourceVersion+'/0-20'])assert.equal(readRetrievalCitationPath(value),undefined)
 const result=JSON.parse((events()[1]!.event.data as any).message.content[0].text)
 assert.deepEqual(readRetrievalSearchResult(result).results[0],hit)
 assert.equal(readRetrievalSearchResult({...result,results:[{...hit,citationPath:path}]}).results[0]?.citationPath,path)
 assert.throws(()=>readRetrievalSearchResult({...result,results:[{...hit,citationPath:path.replace('/1/','/2/') }]}),{code:'teloa/invalid-input'})
 assert.deepEqual(readRetrievalSourceAddress(retrievalSourceAddress(sessionId,path)),{sessionId,path})
 assert.deepEqual(readRetrievalSourceAddress(retrievalSourceAddress(sessionId,sourceId)),{sessionId,path:sourceId})
 assert.equal(readRetrievalSourceAddress('dsh-resource://file/session/other/private.txt'),undefined)
 assert.equal(isRetrievalCitationLink('knowledge_notes.md'),false)
 assert.equal(isRetrievalCitationLink('local_material_notes.md'),false)
 assert.equal(isRetrievalCitationLink('teloa-source/../../secret'),true,'损坏的引用仍不能降级为文件路径')
})
test('来源撤回、当前会话改变或原回执撤下时拒绝打开；不降级为目录或文件读取',async()=>{
 let current=true,available=true,rows=events(),opened:string[]=[],resolveAvailable:((value:boolean)=>void)|undefined
 const port:RetrievalCitationPort={sessionId,events:{subscribe:()=>()=>{},getSnapshot:()=>({entries:rows})},current:()=>current,available:async()=>available,openResource:address=>opened.push(address)}
 await openRetrievalCitation(port,sourceId);assert.equal(opened.length,1)
 available=false;await assert.rejects(openRetrievalCitation(port,sourceId),{code:'teloa/source-unavailable'})
 available=true;port.available=()=>new Promise(resolve=>{resolveAvailable=resolve})
 const late=openRetrievalCitation(port,sourceId);current=false;resolveAvailable!(true);await assert.rejects(late,{code:'teloa/source-unavailable'})
 current=true;const removed=openRetrievalCitation(port,sourceId);rows=[];resolveAvailable!(true);await assert.rejects(removed,{code:'teloa/source-unavailable'})
 assert.equal(opened.length,1)
})
