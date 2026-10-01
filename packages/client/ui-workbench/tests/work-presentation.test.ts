import test from 'node:test'
import assert from 'node:assert/strict'
import type { Conversation } from '@teloa/contract'
import { presentConversations, organizeConversations } from '../src/client/work-presentation.ts'

const row=(id:string,createdAt='2026-09-10T00:00:00Z'):Conversation=>({id:'work-'+id,sessionId:id,requestedSessionId:id,ownerId:'owner',title:'工作 '+id,scopeIds:['general'],version:1,status:'ready',createdAt})

test('最近工作以绑定身份关联真实标题，按活动时间排序且不修改原目录',()=>{
  const rows=[row('a'),row('b','2026-09-10T01:00:00Z')]
  const result=presentConversations(rows,[{id:'a',title:'资料核对',running:false,blank:false,updatedAt:Date.parse('2026-09-11T00:00:00Z')},{id:'unbound',title:'未绑定私人会话',running:true,blank:false,updatedAt:Date.parse('2026-09-12T00:00:00Z')}])
  assert.deepEqual(result.map(item=>[item.conversation.id,item.title]),[['work-a','资料核对'],['work-b','工作 b']])
  assert.deepEqual(rows.map(item=>item.id),['work-a','work-b'])
  assert.equal(result[0]?.conversation,rows[0])
})

test('搜索显示标题和原始身份，按实际运行状态筛选而非标题推断',()=>{
  const rows=[row('a'),row('b')],native=[{id:'a',title:'AppSec 核对',running:true,blank:false,updatedAt:1},{id:'b',title:'正在运行的说明',running:false,blank:false,updatedAt:2}]
  assert.deepEqual(presentConversations(rows,native,'  APPSEC  ').map(item=>item.conversation.id),['work-a'])
  assert.deepEqual(presentConversations(rows,native,'work-b').map(item=>item.title),['正在运行的说明'])
  assert.deepEqual(presentConversations(rows,native,'','running').map(item=>item.title),['AppSec 核对'])
  assert.deepEqual(presentConversations(rows,native,'不存在'),[])
})

test('创建未完成不能被原生运行状态覆盖；空标题和非法活动时间回退',()=>{
  const a={...row('a'),status:'pending' as const},b=row('b')
  const result=presentConversations([b,a],[{id:'a',title:'  ',running:true,blank:false,updatedAt:Number.NaN},{id:'b',running:false,blank:true,updatedAt:0}])
  assert.deepEqual(result.map(item=>[item.conversation.id,item.title,item.status,item.updatedAt]),[
    ['work-a','工作 a','pending',Date.parse(a.createdAt)],['work-b','工作 b','blank',Date.parse(b.createdAt)],
  ])
  assert.equal(presentConversations([a],[],'','running').length,0)
  assert.equal(presentConversations([b],[])[0]?.status,'unknown')
  assert.deepEqual(presentConversations([a,b],[{id:'b',running:false,blank:true,updatedAt:0}],'','blank').map(item=>item.conversation.id),['work-b'])
})

test('正文命中只补充已绑定且就绪的目录，标题与状态仍来自原生摘要',()=>{
  const rows=[row('a'),row('b'),{...row('pending'),status:'pending' as const}]
  const content=new Map([['a','正文中的河流样本'],['private','未绑定的私人正文'],['pending','未完成绑定']])
  const result=presentConversations(rows,[{id:'a',title:'研究记录',running:false,blank:false,updatedAt:3}], '河流','all',content)
  assert.deepEqual(result.map(item=>[item.conversation.sessionId,item.title,item.snippet]),[['a','研究记录','正文中的河流样本']])
  assert.equal(presentConversations(rows,[],'工作 b','all',content).some(item=>item.conversation.sessionId==='b'),true)
  assert.equal(presentConversations(rows,[],'','all',content).every(item=>item.snippet===undefined),true)
})


test('工作区筛选取原生归属，手动顺序不领养私人会话，目录被移除不退回全部',()=>{
 const rows=presentConversations([row('a'),row('b'),row('c'),row('loose')],[])
 const spaces=[{workspaceId:'one',title:'同名',path:'/one',sessionIds:['private','b','a']},{workspaceId:'two',title:'同名',path:'/two',sessionIds:['c']}]
 const ids=(result:typeof rows)=>result.map(item=>item.conversation.sessionId)
 assert.deepEqual(ids(organizeConversations(rows,spaces,{kind:'workspace',id:'one'},'manual')),['b','a'])
 assert.deepEqual(ids(organizeConversations(rows,spaces,{kind:'workspace',id:'one'},'recent')),['a','b'])
 assert.deepEqual(ids(organizeConversations(rows,spaces,{kind:'unassigned'},'recent')),['loose'])
 assert.deepEqual(ids(organizeConversations(rows,spaces,{kind:'workspace',id:'removed'},'manual')),[])
 assert.deepEqual(ids(rows),['a','b','c','loose'])
})
