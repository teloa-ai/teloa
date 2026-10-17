import test from 'node:test'
import assert from 'node:assert/strict'
import type {GroupMessage,GroupRoutingStatusView} from '@teloa/contract'
import {groupMessageOverlayIds,groupMessageStatusIds,mergeGroupMessageStatuses} from '../src/client/group-message-overlays.ts'

const own=(id:string,rootId:string|null=null):GroupMessage=>({id,groupId:'group',rootId,authorId:'self',text:id,references:[],mentions:[],createdAt:'2026-10-15T00:00:00.000Z'})
const status=(messageId:string,phase:GroupRoutingStatusView['phase']):GroupRoutingStatusView=>({messageId,phase,attemptVersion:1,recipients:[],hintCode:null,canRetry:false})

test('并列窗口优先最新与话题根，保留实际可见旧消息，过滤其他话题且不修改原目录',()=>{
 const main=Array.from({length:10},(_,index)=>own('main-'+index)),topic=[own('topic-0'),...Array.from({length:9},(_,index)=>own('topic-'+(index+1),'topic-0'))]
 const original=structuredClone(main)
 assert.deepEqual(groupMessageOverlayIds([...main,own('another-topic-reply','another-root')],topic,6,{main:['main-2','outside'],topic:['topic-2']}),['topic-9','topic-0','topic-2','main-9','main-2','main-8'])
 assert.deepEqual(main,original)
 assert.deepEqual(groupMessageOverlayIds(main,[],3),['main-9','main-8','main-7'])
 assert.deepEqual(groupMessageOverlayIds([own('shared-root')],[own('shared-root'),own('reply','shared-root')],3),['reply','shared-root'])
})

test('G-A04：主群直回同时属于大话题时仍保留主群最新与可见消息，去重后补足有界窗口',()=>{
 const root=own('root'),direct=Array.from({length:120},(_,index)=>({...own('direct-'+index,root.id),authorId:'role',taskId:'task',runId:'run',contextMode:'main' as const}))
 direct[119]!.text='完整正文🙂。'.repeat(2000)
 direct[119]!.references=[{kind:'attachment',id:'original-file',version:1},{kind:'artifact',id:'original-result',version:3}]
 const topic=[root,...direct,...Array.from({length:250},(_,index)=>own('topic-'+index,root.id))]
 const main=[...topic,own('other-topic-reply','other-root')],original=structuredClone(main)
 const ids=groupMessageOverlayIds(main,topic,200,{main:['direct-0'],topic:['topic-0']})
 assert.ok(ids.includes('direct-119'),'主群最新直回不能因同时出现在话题而被排除')
 assert.ok(ids.includes('direct-0'),'正在阅读的主群消息也必须刷新')
 assert.ok(ids.includes('topic-249'),'话题超过 200 条后仍读取最新回复')
 assert.ok(ids.includes('topic-0'));assert.ok(ids.includes('root'))
 assert.equal(ids.includes('other-topic-reply'),false)
 assert.equal(ids.length,200);assert.equal(new Set(ids).size,200)
 assert.deepEqual(main,original,'窗口只选择覆盖层身份，不裁剪正文、引用或原目录')
})

test('G-A04：两个流的窗口高度重叠时去重后补足名额，不丢主群可见身份',()=>{
 const root=own('root'),topic=[root,...Array.from({length:250},(_,index)=>({...own('shared-'+index,root.id),authorId:'role',taskId:'task',runId:'run',contextMode:'main' as const}))]
 const ids=groupMessageOverlayIds(topic,topic,200,{main:['shared-0'],topic:['shared-1']})
 assert.ok(ids.includes('shared-0'));assert.ok(ids.includes('shared-1'))
 assert.ok(ids.includes('shared-249'));assert.ok(ids.includes('root'))
 assert.equal(ids.length,200);assert.equal(new Set(ids).size,200)
})

test('状态独立选择本人窗口，保留进行中接收者和本群旧工作，忽略陌生身份与已完成旧消息',()=>{
 const main=['completed','old-work','mixed','linked','main-1','main-2'].map(id=>own(id)),topic=[own('root'),own('topic-1','root'),own('topic-2','root')]
 const mixed=status('mixed','awaiting-review');mixed.recipients=[{roleId:'role',name:'原员工',taskId:'task',runId:'run',phase:'running',resultMessageId:null,executionMode:'work'}]
 const employee={...own('employee'),authorId:'role',taskId:'task',runId:'run',contextMode:'main' as const}
 const ids=groupMessageStatusIds([...main,employee],topic,4,[status('completed','completed'),status('old-work','running'),mixed,status('outside','running')],['linked','other-group-source'])
 assert.deepEqual(ids,['topic-2','root','main-2','main-1','old-work','mixed','linked'])
})

test('状态合并保留未成功重读的缓存，替换已核对回执并排除离开原目录的身份',()=>{
 const previous=[status('active','running'),status('failed-read','running'),status('other-group','running')]
 const merged=mergeGroupMessageStatuses(previous,['active','failed-read'],['active'],[status('active','completed'),status('foreign','running')])
 assert.deepEqual(merged,[status('failed-read','running'),status('active','completed')])
})

test('没有路由唤醒的历史 received 不累积为在途工作，终态缓存随读取窗口退役',()=>{
 const main=Array.from({length:600},(_,index)=>own('history-'+index)),idle=main.map(message=>status(message.id,'received'))
 const ids=groupMessageStatusIds(main,[],200,idle)
 assert.equal(ids.length,200,'历史已收到不永久占用独立状态批次')
 assert.ok(!ids.includes('history-0'));assert.ok(ids.includes('history-599'))
 const completed=main.map(message=>status(message.id,'completed'))
 const merged=mergeGroupMessageStatuses(completed,ids,ids,ids.map(id=>status(id,'completed')))
 assert.equal(merged.length,200,'只有本轮窗口与真正活动工作状态保留缓存')
})

test('滚到历史本人消息时同步读取其状态，不能只刷新表情与路由',()=>{
 const main=Array.from({length:600},(_,index)=>own('history-'+index))
 const ids=groupMessageStatusIds(main,[],200,[],[],{main:['history-0']})
 assert.ok(ids.includes('history-0'));assert.ok(ids.includes('history-599'));assert.equal(ids.length,200)
})
