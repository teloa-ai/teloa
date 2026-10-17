import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {groupTaskCreateInput,isGroupTaskSource,type GroupTaskSourceV1,type GroupTaskSourceV2} from '@teloa/contract'
import {selectGroupConversation,groupConversationThreadMessages,groupTopicMaxMessages,type GroupConversationRow} from '../src/work/group-topic.ts'
import {resolveGroupExecutionPolicy,groupRoutedExecution} from '../src/work/group-execution-policy.ts'
import {groupTaskSourceDigest} from '../src/work/group-task-source-digest.ts'

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const row=(n:number,rootId:number|null,at=n):GroupConversationRow=>({id:id(n),rootId:rootId===null?null:id(rootId),createdAt:at*1000})

test('两个主群根之间的预算追问：上一根话题里的员工回答进入当前主群消息的连续上下文',()=>{
 // 1 本人问预算（主群根）→ 2 员工在 1 的话题里答 680 元 → 3 本人在主群另起一句「还剩多少」。
 const rows=[row(1,null),row(2,1),row(3,null)]
 assert.deepEqual(selectGroupConversation(rows,{triggerId:id(3),replyToMessageId:null,mode:'main',visibleFrom:null}),[id(1),id(2),id(3)])
})

test('触发水位：触发之后才到达的消息不进入旧运行快照；话题与主群合并按身份去重',()=>{
 const rows=[row(1,null),row(2,1),row(3,1),row(4,null),row(5,1),row(3,1)]
 assert.deepEqual(selectGroupConversation(rows,{triggerId:id(3),replyToMessageId:null,mode:'thread',visibleFrom:null}),[id(1),id(2),id(3)])
})

test('话题回复先保留本话题最近 12 条，再用本群近期补足，总数不超过 20；触发与引用原消息是锚点',()=>{
 const thread=Array.from({length:16},(_,index)=>row(100+index,100)),main=Array.from({length:30},(_,index)=>row(200+index,null,90+index*0.01))
 // 引用一条很早的主群消息：即使不在近期窗口，也作为锚点保留。
 const anchor=row(1,null,1),rows=[anchor,...main,...thread]
 const picked=selectGroupConversation(rows,{triggerId:id(115),replyToMessageId:anchor.id,mode:'thread',visibleFrom:null})
 assert.equal(picked.length,groupTopicMaxMessages)
 assert.ok(picked.includes(id(115))&&picked.includes(anchor.id))
 const threadPicked=picked.filter(value=>thread.some(item=>item.id===value))
 assert.ok(threadPicked.length>=groupConversationThreadMessages,'本话题最近 12 条优先保留')
 assert.deepEqual(threadPicked.slice(-groupConversationThreadMessages),thread.slice(-groupConversationThreadMessages).map(item=>item.id))
 const times=picked.map(value=>rows.find(item=>item.id===value)!.createdAt)
 assert.deepEqual(times,[...times].sort((a,b)=>a-b),'按发送时间排序')
})

test('新成员不可见历史：入群前的消息与引用都不注入；触发消息不可见时没有上下文',()=>{
 const rows=[row(1,null),row(2,1),row(3,null),row(4,null)]
 assert.deepEqual(selectGroupConversation(rows,{triggerId:id(4),replyToMessageId:id(1),mode:'main',visibleFrom:3000}),[id(3),id(4)],'引用不可见历史不能绕过限制')
 assert.deepEqual(selectGroupConversation(rows,{triggerId:id(2),replyToMessageId:null,mode:'thread',visibleFrom:3000}),[])
})

test('交流回应恒为空工具集合；工作只保留原有效授权，不新增工具',()=>{
 assert.deepEqual(resolveGroupExecutionPolicy({executionMode:'reply',roleAllowedTools:['write-file'],argumentRules:[]}),{allowedTools:[],argumentRules:[]})
 const rule={name:'write-file',arguments:{}} as never
 assert.deepEqual(resolveGroupExecutionPolicy({executionMode:'reply',roleAllowedTools:['write-file','web'],argumentRules:[rule]}),{allowedTools:[],argumentRules:[]})
 assert.deepEqual(resolveGroupExecutionPolicy({executionMode:'work',roleAllowedTools:['web'],argumentRules:[rule]}),{allowedTools:['web'],argumentRules:[]})
 assert.deepEqual(groupRoutedExecution(2),{executionMode:'reply',routingAttemptVersion:2})
})

const v1:GroupTaskSourceV1={schema:'teloa.group-task-source/v1',taskId:id(1),ownerId:'owner',groupId:id(2),groupVersion:1,messageId:id(3),rootId:id(3),messageCreatedAt:'2026-10-14T00:00:00.000Z',messageText:'还剩多少？不要修改任何记录。',references:[],createdAssignee:{roleId:id(4),roleVersion:1},trigger:'routed',createdAt:'2026-10-14T00:00:01.000Z'}
const v2:GroupTaskSourceV2={...v1,schema:'teloa.group-task-source/v2',replyToMessageId:null,contextMode:'main',routingAttemptVersion:1,executionMode:'reply'}

test('群来源 v2：保留完整原文与 v1 字段；v1 摘要不受影响，v2 摘要覆盖新增字段',()=>{
 assert.equal(isGroupTaskSource(v1),true);assert.equal(isGroupTaskSource(v2),true)
 assert.equal(isGroupTaskSource({...v2,executionMode:'admin'}),false)
 assert.equal(isGroupTaskSource({...v2,trigger:'manual'}),false,'v2 只由路由派工写入')
 assert.equal(isGroupTaskSource({...v2,contextMode:'other'}),false)
 assert.equal(isGroupTaskSource({...v1,contextMode:'main'}),false,'v1 不接受新增键')
 // 历史 v1 行的 snapshot_digest 必须仍可核对：按上线前的固定字段序列重算，逐字相等。
 const legacy=createHash('sha256').update(JSON.stringify([v1.schema,v1.taskId,v1.ownerId,v1.groupId,v1.groupVersion,v1.messageId,v1.rootId,v1.messageCreatedAt,v1.messageText,[],[v1.createdAssignee!.roleId,v1.createdAssignee!.roleVersion],v1.createdAt])).digest('hex')
 assert.equal(groupTaskSourceDigest(v1),legacy)
 assert.notEqual(groupTaskSourceDigest(v2),groupTaskSourceDigest({...v2,executionMode:'work'}))
 assert.notEqual(groupTaskSourceDigest(v2),groupTaskSourceDigest(v1))
 assert.equal(v2.messageText.endsWith('不要修改任何记录。'),true,'尾部限制完整保留')
})

test('执行策略只随路由派工出现：手动建任务不能自选策略，策略与尝试世代必须成对',()=>{
 const base={requestId:id(5),groupId:id(2),messageId:id(3),expectedGroupVersion:1,goal:'回应',assignee:{roleId:id(4),expectedVersion:1}}
 assert.deepEqual(groupTaskCreateInput({...base,trigger:'routed',executionMode:'reply',routingAttemptVersion:2}),{...base,trigger:'routed',executionMode:'reply',routingAttemptVersion:2})
 assert.deepEqual(groupTaskCreateInput({...base,trigger:'manual'}),{...base,trigger:'manual'})
 for(const bad of [{trigger:'manual',executionMode:'work',routingAttemptVersion:1},{trigger:'routed',executionMode:'reply'},{trigger:'routed',routingAttemptVersion:1},{trigger:'routed',executionMode:'admin',routingAttemptVersion:1}])assert.throws(()=>groupTaskCreateInput({...base,...bad}),{code:'teloa/invalid-input'})
})

test('依赖交接：前序阶段的可信回帖晚于原触发也作为锚点进入后序阶段上下文，其余晚到消息仍被水位排除',()=>{
 const rows=[row(1,null),row(2,1),row(3,1),row(4,null)]
 assert.deepEqual(selectGroupConversation(rows,{triggerId:id(1),replyToMessageId:null,mode:'main',visibleFrom:null,handoffMessageIds:[id(3)]}),[id(1),id(3)])
 assert.deepEqual(selectGroupConversation(rows,{triggerId:id(1),replyToMessageId:null,mode:'main',visibleFrom:2500,handoffMessageIds:[id(3)]}),[],'触发消息不可见时整体不读')
})
