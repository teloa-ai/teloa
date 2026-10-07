import test from 'node:test'
import assert from 'node:assert/strict'
import type {SessionEventLikeEntry} from '@deepseek-ai/dsh-api-session-controller/client'
import {collectConversationOverviewResources} from '../src/client/conversation-overview-resources.ts'

const event=(seq:number,type:string,data:unknown,time=1000+seq,sourceEventSeqs?:number[])=>({type:'event',event:{seq,type,data,time,...(sourceEventSeqs?{sourceEventSeqs}:{})}}) as unknown as SessionEventLikeEntry
const call=(seq:number,callId:string,name:string,args:unknown)=>event(seq,'tool/call',{turn:2,step:1,callId,name,arguments:JSON.stringify(args)})
const result=(seq:number,callId:string,isError=false,meta?:unknown,sourceEventSeqs?:number[])=>event(seq,'tool/result',{turn:2,step:1,message:{role:'tool',toolCallId:callId,content:[{type:'text',text:'实际工具结果'}],isError},...(meta===undefined?{}:{meta})},1000+seq,sourceEventSeqs)
const round={sessionId:'parent',turn:2,turns:[2],startSeq:10,startedAt:1010,userMessageId:'human-message',userMessageSeq:11,endSeq:30,endedAt:1030,status:'completed' as const}
const searchMeta={sources:[{url:'https://example.com/evidence',title:'真实来源',snippet:'来源摘要',publishedAt:'2026-10-07'}],truncated:false,answer:'工具返回的答案'}
const skillMeta=(name:string)=>({teloaResourceUse:{schema:'teloa.resource-use/v1',kind:'skill',providerId:'test-native-skills',name,toolName:'skill',state:'read'}})

test('只投影本次轮次内已成功读取或注入的技能，目录与失败请求不算使用',()=>{
 const entries=[call(2,'old','skill',{name:'旧技能'}),result(3,'old',false,skillMeta('旧技能')),event(10,'turn/start',{turn:2}),event(11,'user/message',{source:{kind:'skill-catalog',entries:[{name:'已安装未使用',description:'目录记录'}]},content:[]}),call(12,'failed','skill',{name:'读取失败'}),result(13,'failed',true,skillMeta('读取失败')),call(14,'pending','skill',{name:'尚未读取'}),call(15,'loaded','skill',{name:'实际读取'}),result(16,'loaded',false,skillMeta('实际读取'),[15]),event(17,'user/message',{source:{kind:'skill-invocation',name:'显式注入',form:'instructions'},content:[{type:'text',text:'已注入正文'}]}),call(31,'next','skill',{name:'下一轮'}),result(32,'next',false,skillMeta('下一轮'))]
 const groups=collectConversationOverviewResources({round,entries})
 assert.deepEqual(groups.map(group=>[group.kind,group.name]),[['skill','实际读取'],['skill','显式注入']])
 assert.deepEqual(groups[0]?.evidence.map(item=>[item.callId,item.seq,item.resultSeq,item.status]),[['loaded',15,16,'read']])
 assert.equal(groups[1]?.evidence[0]?.status,'injected')
 assert.equal(groups[1]?.evidence[0]?.executorId,'parent')
 assert.equal(groups[0]?.provider,'test-native-skills')
})

test('同一读取事件与注入事件去重，保留同一技能的独立调用证据',()=>{
 const first=call(12,'one','skill',{name:'report'}),done=result(13,'one',false,skillMeta('report'),[12]),injected=event(14,'user/message',{source:{kind:'skill-invocation',name:'report',form:'instructions'},content:[{type:'text',text:'技能正文'}]})
 const groups=collectConversationOverviewResources({round,entries:[first,done,first,done,injected,injected,call(15,'two','skill',{name:'report'}),result(16,'two',false,skillMeta('report'))]})
 assert.equal(groups.length,2,'缺少provider的注入不冒充已知读取provider')
 assert.deepEqual(groups[0]?.evidence.map(item=>[item.callId,item.status]),[['one','read'],['two','read']])
 assert.deepEqual(groups[1]?.evidence.map(item=>[item.callId,item.status]),[[undefined,'injected']])
 assert.equal(new Set(groups.flatMap(group=>group.evidence.map(item=>item.id))).size,3)
})

test('搜索详情关联原查询与真实结构化结果，不从正文或工具名前缀猜来源',()=>{
 const entries=[call(12,'search','web_search',{queries:['原查询','第二查询','原查询']}),result(13,'search',false,searchMeta,[12]),call(14,'mcp','mcp__installed__search',{queries:['伪来源']}),result(15,'mcp',false,searchMeta),call(16,'plugin','plugin_search',{queries:['伪来源']}),result(17,'plugin',false,searchMeta)]
 const groups=collectConversationOverviewResources({round,entries})
 assert.equal(groups.length,1)
 assert.equal(groups[0]?.kind,'search')
 assert.deepEqual(groups[0]?.evidence[0]?.queries,['原查询','第二查询'])
 assert.deepEqual(groups[0]?.evidence[0]?.sources,[{url:'https://example.com/evidence',title:'真实来源',snippet:'来源摘要',publishedAt:'2026-10-07'}])
 assert.equal(groups[0]?.evidence[0]?.timestamp,1013)
 assert.equal(groups[0]?.evidence[0]?.answer,'工具返回的答案')
 assert.equal(groups[0]?.provider,undefined)
})

test('损坏、未完成和失败的搜索不能冒充实际结果，空结果仍保留查询及截断事实',()=>{
 const entries=[call(12,'bad','web_search',{queries:['损坏结果']}),result(13,'bad',false,{sources:[{title:'没有地址'}],truncated:false}),call(14,'failed','web_search',{queries:['失败']}),result(15,'failed',true,searchMeta),call(16,'pending','web_search',{queries:['等待']}),call(17,'empty','web_search',{queries:['没有结果']}),result(18,'empty',false,{sources:[],truncated:true},[17])]
 const groups=collectConversationOverviewResources({round,entries})
 assert.equal(groups.length,1)
 assert.deepEqual(groups[0]?.evidence[0]?.queries,['没有结果'])
 assert.deepEqual(groups[0]?.evidence[0]?.sources,[])
 assert.equal(groups[0]?.evidence[0]?.truncated,true)
})

test('只汇总明确关联本次父轮次的子会话，继承前缀不重复计数且调用身份隔离',()=>{
 const own=[call(12,'same','skill',{name:'parent-skill'}),result(13,'same',false,skillMeta('parent-skill'))]
 const childEntries=[call(0,'inherited','skill',{name:'ancestor-skill'}),result(1,'inherited',false,skillMeta('ancestor-skill')),call(2,'same','skill',{name:'child-skill'}),result(3,'same',false,skillMeta('child-skill'))]
 const child={sessionId:'child',executorId:'worker',executorName:'校对智能体',parentSessionId:'parent',parentTurn:2,parentStartSeq:10,inheritedEventCount:2,entries:childEntries}
 const unrelated={...child,sessionId:'other-child',parentTurn:1}
 const groups=collectConversationOverviewResources({round,entries:own,relatedSessions:[child,child,unrelated]})
 assert.deepEqual(groups.map(group=>group.name),['parent-skill','child-skill'])
 assert.equal(groups[1]?.evidence.length,1)
 assert.equal(groups[1]?.evidence[0]?.sessionId,'child')
 assert.equal(groups[1]?.evidence[0]?.executorId,'worker')
 assert.equal(groups[1]?.evidence[0]?.executorName,'校对智能体')
 assert.notEqual(groups[0]?.evidence[0]?.id,groups[1]?.evidence[0]?.id)
})

test('不跨调用引用、不接收 transient 或无轮次输入',()=>{
 const entries=[call(12,'wrong','skill',{name:'错配'}),result(13,'wrong',false,skillMeta('错配'),[11]),{type:'tool/call',data:{name:'skill',arguments:'{"name":"临时事件"}'}} as unknown as SessionEventLikeEntry]
 assert.deepEqual(collectConversationOverviewResources({round,entries}),[])
 assert.deepEqual(collectConversationOverviewResources({round:undefined,entries:[call(12,'one','skill',{name:'没有轮次'}),result(13,'one',false,skillMeta('没有轮次'))]}),[])
})

test('MCP 和插件仅采用调用结果里宿主记录的稳定来源，工具名与来源必须相符',()=>{
 const source=(kind:string,providerId:string,name:string,toolName:string)=>({schema:'teloa.resource-use/v1',kind,providerId,name,toolName,state:'used'})
 const entries=[call(12,'mcp','normalized_opaque_42',{query:'材料'}),result(13,'mcp',false,{teloaResourceUse:source('mcp','figma-team','设计资料','normalized_opaque_42')},[12]),call(14,'plugin','registered_tool',{input:'执行'}),result(15,'plugin',false,{teloaResourceUse:source('plugin','@vendor/extension','文档扩展','registered_tool')},[14]),call(16,'wrong','claimed_tool',{}),result(17,'wrong',false,{teloaResourceUse:source('mcp','forged','错配来源','other_tool')})]
 const groups=collectConversationOverviewResources({round,entries})
 assert.deepEqual(groups.map(group=>[group.kind,group.name,group.provider]),[['mcp','设计资料','figma-team'],['plugin','文档扩展','@vendor/extension']])
 assert.deepEqual(groups.map(group=>group.evidence[0]?.callId),['mcp','plugin'])
})

test('宿主确认的技能 provider 与搜索 provider 保留在证据组，失败调用不写成已使用',()=>{
 const skill={schema:'teloa.resource-use/v1',kind:'skill',providerId:'managed-skills',name:'report',toolName:'skill',state:'read'}
 const web={schema:'teloa.resource-use/v1',kind:'web',providerId:'live-search-provider',name:'Web 搜索',toolName:'web_search',state:'used'}
 const entries=[call(12,'skill','skill',{name:'report'}),result(13,'skill',false,{teloaResourceUse:skill}),call(14,'web','web_search',{queries:['材料来源']}),result(15,'web',false,{...searchMeta,teloaResourceUse:web}),call(16,'failed','registered_tool',{}),result(17,'failed',true,{teloaResourceUse:{schema:'teloa.resource-use/v1',kind:'plugin',providerId:'plugin',name:'失败扩展',toolName:'registered_tool',state:'used'}})]
 const groups=collectConversationOverviewResources({round,entries})
 assert.deepEqual(groups.map(group=>[group.kind,group.name,group.provider]),[['skill','report','managed-skills'],['search','Web 搜索','live-search-provider']])
 assert.deepEqual(groups[1]?.evidence[0]?.queries,['材料来源'])
})

test('同一用户工作轮次的 goal 续轮子调用仍须保留执行者，旧父轮次不归并',()=>{
 const continued={...round,turns:[2,3]},child={sessionId:'continued-child',executorId:'continued-worker',parentSessionId:'parent',parentTurn:3,parentStartSeq:10,inheritedEventCount:0,entries:[call(1,'read','skill',{name:'continuation-skill'}),result(2,'read',false,skillMeta('continuation-skill'))]}
 const groups=collectConversationOverviewResources({round:continued,entries:[],relatedSessions:[child]})
 assert.deepEqual(groups.map(group=>group.name),['continuation-skill'])
 assert.equal(groups[0]?.evidence[0]?.executorId,'continued-worker')
})

test('无成功来源的skill同名工具和旧事件不推断读取，真实插件shadow仍归属于其插件',()=>{
 const source={schema:'teloa.resource-use/v1',kind:'plugin',providerId:'actual-shadow',name:'实际插件',toolName:'skill',state:'used'}
 const entries=[call(12,'unknown','skill',{name:'不能确认读取'}),result(13,'unknown'),call(14,'shadow','skill',{name:'只是参数'}),result(15,'shadow',false,{teloaResourceUse:source})]
 const groups=collectConversationOverviewResources({round,entries})
 assert.deepEqual(groups.map(group=>[group.kind,group.name,group.provider]),[['plugin','实际插件','actual-shadow']])
})

test('PTC 来源数组必须逐项对应真实成功结算，父结果与子调用保留可追溯引用',()=>{
 const row={schema:'teloa.resource-use/v1',kind:'mcp',providerId:'actual-provider',name:'实际连接',toolName:'opaque_registered',state:'used',callId:'outer:ptc:1',rootCallId:'outer'}
 const nested={rootCallId:'outer',parentCallId:'outer',subCallId:'outer:ptc:1',name:'opaque_registered',arguments:{},isError:false,content:[{type:'text',text:'实际子调用结果'}]}
 const entries=[call(12,'outer','run_code',{code:'fixture'}),event(13,'tool/ptc-dispatch-start',nested),event(14,'tool/ptc-dispatch',nested),result(15,'outer',false,{teloaResourceUses:[row,row,{...row,callId:'不存在的子调用'},{...row,toolName:'另一个工具'}]},[12])]
 const groups=collectConversationOverviewResources({round,entries})
 assert.equal(groups.length,1)
 assert.equal(groups[0]?.evidence.length,1)
 assert.deepEqual(groups[0]?.evidence.map(item=>[item.callId,item.seq,item.resultSeq,item.timestamp]),[['outer:ptc:1',13,14,1014]])
 assert.equal(groups[0]?.provider,'actual-provider')
})

test('PTC独立来源snapshot须匹配本次真实成功结算，outer失败/取消后保留且与数组去重',()=>{
 const row={schema:'teloa.resource-use/v1' as const,kind:'mcp' as const,providerId:'actual-provider',name:'实际连接',toolName:'opaque_registered',state:'used' as const,callId:'outer:ptc:1',rootCallId:'outer'}
 const nested={rootCallId:'outer',parentCallId:'outer',subCallId:'outer:ptc:1',name:'opaque_registered',arguments:{},isError:false,content:[{type:'text',text:'实际子调用结果'}]}
 const snapshot={schema:'teloa.resource-use-snapshot/v1' as const,sessionId:'parent',parentCallSeq:12,startSeq:13,parentCallId:'outer',use:row}
 const entries=[call(12,'outer','run_code',{code:'fixture'}),event(13,'tool/ptc-dispatch-start',nested),event(14,'tool/ptc-dispatch',nested),result(15,'outer',true)]
 const groups=collectConversationOverviewResources({round,entries,resourceUseSnapshots:[snapshot,snapshot,{...snapshot,sessionId:'另一个会话'},{...snapshot,parentCallSeq:2},{...snapshot,startSeq:11},{...snapshot,use:{...row,callId:'不存在的子调用'}}]})
 assert.equal(groups.length,1)
 assert.deepEqual(groups[0]?.evidence.map(item=>[item.callId,item.seq,item.resultSeq]),[['outer:ptc:1',13,14]])
 assert.equal(collectConversationOverviewResources({round,entries:entries.filter(item=>item.event.seq!==14),resourceUseSnapshots:[snapshot]}).length,0)
 assert.equal(collectConversationOverviewResources({round,entries:[entries[0]!,entries[1]!,event(14,'tool/ptc-dispatch',{...nested,isError:true})],resourceUseSnapshots:[snapshot]}).length,0)
 const success=[entries[0]!,entries[1]!,entries[2]!,result(15,'outer',false,{teloaResourceUses:[row]})]
 assert.equal(collectConversationOverviewResources({round,entries:success,resourceUseSnapshots:[snapshot]}).at(0)?.evidence.length,1)
})
