import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {citedGroupMessageIds,groupMessageSourcesEndpoint,readGroupMessageSources} from '../src/group-message-sources.ts'

test('明确消息编号保留五个来源与顺序；裸 UUID、作者/任务编号和代码不自动成为引用',()=>{
 const ids=Array.from({length:5},randomUUID),other=randomUUID()
 const text=`本人原消息（消息编号 ${ids[0]}）\n追加（消息编号 ${ids[1]}）\n最新（消息编号 ${ids[2]}）\n原结果（消息编号 ${ids[3]} 与 ${ids[4]}）\n作者编号 ${other}\n任务ID ${other}\n${other}\n\`消息编号 ${other}\`\n\n\`\`\`text\n消息编号 ${other}\n\`\`\`\n\n    消息编号 ${other}`
 assert.deepEqual(citedGroupMessageIds(text),ids)
 assert.deepEqual(citedGroupMessageIds(`message IDs: ${ids[0]}, ${ids[1]}\n訊息編號：${ids[0]!.toUpperCase()}`),ids.slice(0,2))
 assert.equal(groupMessageSourcesEndpoint.writing,false)
})
test('规范 messageId 与外部明确标签后的纯 UUID 代码 token 可引用，代码整句与作者/任务字段不引用',()=>{
 const first=randomUUID(),second=randomUUID(),other=randomUUID()
 assert.deepEqual(citedGroupMessageIds(`messageId: ${first}\n消息编号 \`${second}\`\n\`messageId\`: \`${first.toUpperCase()}\``),[first,second])
 for(const text of [`authorId: \`${other}\`\ntaskId: \`${other}\``,`\`消息编号 ${other}\``,`\`messageId: ${other}\``,`messageId: \`消息编号 ${other}\``,`\`${other}\``])assert.deepEqual(citedGroupMessageIds(text),[])
})
test('反引号围栏 info 含反引号不作为开符；合法围栏与缩进代码仍不生成来源',()=>{
 const first=randomUUID(),second=randomUUID(),other=randomUUID()
 assert.deepEqual(citedGroupMessageIds(`\`\`\`json\`invalid\nmessageId: ${first}\n\`\`\``),[first])
 assert.deepEqual(citedGroupMessageIds(`~~~json\`valid\nmessageId: ${other}\n~~~\nmessageId: \`${second}\`\n    messageId: ${other}`),[second])
})
test('来源读契约保原消息，拒跨群、错误定位、重复项和缺 Run 却伪称可信来源',()=>{
 const groupId=randomUUID(),messageId=randomUUID(),runId=randomUUID(),id=randomUUID(),message={id,groupId,rootId:null,authorId:'self' as const,text:'原始资料',references:[],mentions:[],createdAt:'2026-10-20T00:00:00.000Z'},item={message,rootId:null,sha256:'a'.repeat(64)},value={schema:'teloa.group-message-sources/v1',groupId,messageId,runId,items:[item],unavailableCount:0}
 assert.deepEqual(readGroupMessageSources(value),value)
 for(const bad of [{...value,items:[item,item]},{...value,runId:null},{...value,items:[{...item,message:{...message,groupId:randomUUID()}}]},{...value,items:[{...item,rootId:randomUUID()}]},{...value,items:[{...item,sha256:'wrong'}]},{...value,unavailableCount:-1}])assert.throws(()=>readGroupMessageSources(bad),{code:'teloa/invalid-input'})
 assert.deepEqual(readGroupMessageSources({...value,runId:null,items:[],unavailableCount:5}).items,[])
})
