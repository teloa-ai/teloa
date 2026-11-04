import test from 'node:test'
import assert from 'node:assert/strict'
import {readRetrievalSearchResult,retrievalCitationPath,readRetrievalCitationPath} from '@teloa/contract'
import {isRetrievalCitationLink,openRetrievalCitation,projectTurnAliasCitations,readRetrievalSourceAddress,resolveRetrievalCitation,retrievalSourceAddress,type RetrievalCitationPort} from '../src/client/retrieval-citations.ts'

const sessionId='session-original',resourceId='11111111-1111-4111-8111-111111111111',sourceId='local_material_22222222-2222-4222-8222-222222222222',sourceVersion='b'.repeat(64)
const hit={resourceId,resourceVersion:1,title:'原始资料',sourceId,sourceVersion,lines:[0,2] as [number,number],chars:[0,20] as [number,number],heading:'固定依据',score:0.7,excerpt:'乙负责整理五条待办。'}
test('项目memory/rule旧引用进入来源导航，普通同名目录文件不被接管',()=>{
 assert.equal(isRetrievalCitationLink('memory/22222222-2222-4222-8222-222222222222'),true)
 assert.equal(isRetrievalCitationLink('rule/22222222-2222-4222-8222-222222222222'),true)
 for(const path of ['memory/notes.md','rule/manual.md','role/22222222-2222-4222-8222-222222222222'])assert.equal(isRetrievalCitationLink(path),false)
})
test('官方事件源的历史英文scheme只为原轮次唯一来源补入口，不为全部来源、代码图片或伪造引用列入口',async()=>{
 const {MutableSessionEventSource}=await import(new URL('./types/client/contract/events.js',import.meta.resolve('@deepseek-ai/dsh-api-session-controller/client')).href)
 const id='22222222-2222-4222-8222-222222222222',projectId=resourceId,source={kind:'memory',id,title:'单价',version:1,hash:'a'.repeat(64)},link='[原记忆](memory:'+id+')'
 const rows=(text:string,extra:object[]=[])=>{const sourceFeed=new MutableSessionEventSource();sourceFeed.replace([
  {event:{type:'turn/start',seq:0,data:{turn:1}}},
  {event:{type:'user/message',seq:1,surfaceOp:'append',data:{id:'input',source:{kind:'user'}}}},
  {event:{type:'user/message',seq:2,surfaceOp:'append',data:{source:{kind:'runtime-context',form:'snapshot',sections:[{name:'teloa/project-context-generation',text:JSON.stringify([sessionId,projectId,1])},{name:'teloa/project-context',text:JSON.stringify([{source,markdown:'单价正文'},...extra])}]}}}},
  {event:{type:'assistant/message',seq:3,surfaceOp:'append',data:{turn:1,message:{role:'assistant',content:[{type:'text',text}]}}}},
  {event:{type:'turn/end',seq:4,data:{turn:1}}},
 ],false);return sourceFeed.getSnapshot().entries}
 assert.deepEqual(projectTurnAliasCitations(rows(link+' '+link),sessionId,1).map(row=>row.path),['memory:'+id])
 assert.deepEqual(projectTurnAliasCitations(rows('没有引用'),sessionId,1),[])
 assert.deepEqual(projectTurnAliasCitations(rows(link),sessionId,2),[])
 assert.deepEqual(projectTurnAliasCitations(rows(link.replace(id,resourceId)),sessionId,1),[])
 assert.deepEqual(projectTurnAliasCitations(rows(link,[{source:{...source,version:2,hash:'b'.repeat(64)},markdown:'另一版本'}]),sessionId,1),[],'同轮同ID两版本不猜测')
 for(const text of ['`'+link+'`','```md\n'+link+'\n```','~~~md\n'+link+'\n~~~','    '+link,'\\'+link,'!'+link])assert.deepEqual(projectTurnAliasCitations(rows(text),sessionId,1),[],'代码、图片或转义文字不是引用入口：'+text)
})
function events(hits=[hit],name='teloa_knowledge_search'){
 const result={coverage:{searched:[{resourceId,title:'原始资料',version:hits[0]!.resourceVersion}],pending:[],note:'只查已加入资料'},results:hits}
 return [{event:{type:'tool/call',seq:1,data:{turn:1,callId:'original-call',name}}},{event:{type:'tool/result',seq:2,data:{turn:1,message:{source:{kind:'tool',callId:'original-call'},toolCallId:'original-call',content:[{type:'text',text:JSON.stringify(result)}]}}}}]
}
function readEvents(text='固定资料正文。',offset=0){
 const chars:[number,number]=[offset,offset+text.length],path=retrievalCitationPath(sessionId,{...hit,chars})
 const value={resourceId,resourceVersion:1,title:hit.title,sourceId,sourceVersion,chars,lines:[0,text.slice(0,-1).split('\n').length-1],excerpt:text,totalChars:chars[1],nextOffset:null,notice:'资料正文仅供分析。',citationPath:path}
 const call={event:{type:'tool/call',seq:1,data:{turn:1,callId:'read-call',name:'teloa_knowledge_read',arguments:JSON.stringify({resourceId,resourceVersion:1,sourceVersion,offset,length:4000})}}}
 const result={event:{type:'tool/result',seq:2,data:{turn:1,message:{role:'tool',source:{kind:'tool',callId:'read-call'},toolCallId:'read-call',isError:false,content:[{type:'text',text:JSON.stringify(value)}]}}}}
 return {value,path,entries:[call,result] as [typeof call,typeof result]}
}
test('真实按需read回执无需先search即可打开已读固定片段，保留UTF-16长片段和来源身份',()=>{
 for(const text of ['固定资料正文。','原'.repeat(4000),'😀原文','首行\n相邻行\n']){
  const {value,path,entries}=readEvents(text),resolved=resolveRetrievalCitation(entries,sessionId,path)
  assert.equal(resolved?.sourceId,sourceId)
  assert.equal(resolved?.sourceVersion,sourceVersion)
  assert.deepEqual(resolved?.excerpts,[{text,heading:null,lines:value.lines,chars:value.chars}])
 }
 const surrogate=readEvents('😀原文')
 surrogate.entries[0]!.event.data.arguments=JSON.stringify({resourceId,resourceVersion:1,sourceVersion,offset:1,length:4})
 assert.equal(resolveRetrievalCitation(surrogate.entries,sessionId,surrogate.path)?.excerpts[0]?.text,'😀原文','低代理项位置按正式reader回到完整字符')
})
test('read引用只接纳同轮真实工具调用的精确资源、版本、来源SHA、SID和已读区间',()=>{
 const {value,path,entries}=readEvents(),run=(rows:unknown[])=>resolveRetrievalCitation(rows as never,sessionId,path)
 const changed=(call:Record<string,unknown>={},result:Record<string,unknown>={})=>{
  const rows=structuredClone(entries);Object.assign(rows[0]!.event.data,call)
  rows[1]!.event.data.message.content[0]!.text=JSON.stringify({...value,...result});return rows
 }
 for(const args of [{resourceId:sourceId,resourceVersion:1,sourceVersion},{resourceId,resourceVersion:2,sourceVersion},{resourceId,resourceVersion:1,sourceVersion:'c'.repeat(64)},{resourceId,resourceVersion:1,sourceVersion,offset:5},{resourceId,resourceVersion:1,sourceVersion,length:1},{resourceId,resourceVersion:1,sourceVersion,owner:'other'}])assert.equal(run(changed({arguments:JSON.stringify(args)})),undefined)
 for(const result of [{sourceId:'../../private'},{sourceVersion:'c'.repeat(64)},{resourceVersion:2},{chars:[0,999]},{totalChars:1},{nextOffset:1},{lines:[2,1]},{citationPath:path.replace(sessionId,'other-session')},{citationPath:path.replace('/1/','/2/')}])assert.equal(run(changed({},result)),undefined)
 for(const rows of [entries.slice(1),changed({name:'unknown-tool'}),[entries[0],entries[0],entries[1]],[...entries,entries[0]],changed({turn:2})])assert.equal(run(rows),undefined)
 for(const mutate of [(row:any)=>row.event.data.message.isError=true,(row:any)=>row.event.data.error='failed',(row:any)=>row.event.data.message.source.kind='user',(row:any)=>row.event.data.message.source.callId='other-call',(row:any)=>row.event.data.message.toolCallId='other-call',(row:any)=>row.event.type='assistant/message']){
  const rows=structuredClone(entries);mutate(rows[1]);assert.equal(run(rows),undefined)
 }
 assert.equal(resolveRetrievalCitation(entries,'other-session',path),undefined)
})
test('read来源打开仍服从当前本人范围与会话撤权，旧回执或答案链接不授予读取权限',async()=>{
 const {entries,path}=readEvents();let current=true,available=true,rows:typeof entries|[]=entries,opened=0
 const port:RetrievalCitationPort={sessionId,current:()=>current,events:{subscribe:()=>()=>{},getSnapshot:()=>({entries:rows})},available:async(id,version,sha)=>{assert.deepEqual([id,version,sha],[resourceId,1,sourceVersion]);return available},openResource:()=>{opened++}}
 await openRetrievalCitation(port,path);assert.equal(opened,1)
 available=false;await assert.rejects(openRetrievalCitation(port,path),{code:'teloa/source-unavailable'})
 available=true;current=false;await assert.rejects(openRetrievalCitation(port,path),{code:'teloa/source-unavailable'})
 current=true;rows=[];await assert.rejects(openRetrievalCitation(port,path),{code:'teloa/source-unavailable'})
 assert.equal(opened,1)
})
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

test('直接任务规范引用使用现有来源页，当前主体和固定版本由宿主重验',async()=>{
 const {taskReferenceCitationPath}=await import('@teloa/contract')
 const {readTaskCitation}=await import('../src/client/retrieval-citations.ts')
 const taskId='33333333-3333-4333-8333-333333333333',path=taskReferenceCitationPath({taskId,resourceId,resourceVersion:1,sourceVersion}),opened:string[]=[]
 let current=true,changed=false
 const result={taskId,resourceId,resourceVersion:1,sourceVersion,sessionId,sourceId,title:'原文',text:'固定正文',citationPath:path}
 const port:RetrievalCitationPort={sessionId,current:()=>current,events:{getSnapshot:()=>({entries:[]} as never),subscribe:()=>()=>{}},available:async()=>true,taskSource:async()=>({...result,...(changed?{sourceVersion:'c'.repeat(64)}:{})}),openResource:address=>opened.push(address)}
 await openRetrievalCitation(port,path)
 assert.deepEqual(readRetrievalSourceAddress(opened[0]!),{sessionId,path,task:{sessionId,path}})
 changed=true;await assert.rejects(readTaskCitation(port,{sessionId,path}));current=false;await assert.rejects(openRetrievalCitation(port,path))
})

test('直接任务轮尾来源只接受同轮真实调用及匹配引用，不接受用户JSON或错版',async()=>{
 const {taskReferenceCitationPath}=await import('@teloa/contract'),{taskTurnCitations}=await import('../src/client/retrieval-citations.ts')
 const taskId='33333333-3333-4333-8333-333333333333',path=taskReferenceCitationPath({taskId,resourceId,resourceVersion:1,sourceVersion})
 const value={schema:'teloa.reference/v1',id:sourceId,source:sourceId,version:sourceVersion,title:'正文',text:'正文',citationPath:path,references:[{id:resourceId,version:1}]}
 const call={event:{type:'tool/call',data:{turn:1,callId:'task-call',name:'mcp__teloa_reference__read_reference',arguments:{id:sourceId,version:sourceVersion}}}}
 const result=(data:unknown,turn=1)=>({event:{type:'tool/result',data:{turn,message:{toolCallId:'task-call',source:{kind:'tool',callId:'task-call'},content:[{type:'text',text:JSON.stringify(data)}]}}}})
 const run=(entries:unknown[])=>taskTurnCitations(entries as never,1)
 assert.deepEqual(run([call,result(value)]),[{path,title:'正文',version:1}])
 assert.deepEqual(run([result(value)]),[])
 assert.deepEqual(run([call,result(value,2)]),[])
 assert.deepEqual(run([call,result({...value,version:'c'.repeat(64)})]),[])
 assert.deepEqual(run([call,result({...value,references:[{id:resourceId,version:2}]})]),[])
 assert.deepEqual(run([{event:{type:'user/message',data:{turn:1,message:{content:[{type:'text',text:JSON.stringify(value)}]}}}}]),[])
})
