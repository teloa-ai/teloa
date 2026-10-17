import test from 'node:test'
import assert from 'node:assert/strict'
import {projectTaskRunChatNode,TaskRunChatPresentationDirectory,readTaskRunSelectedBinding,taskRunSessionTitle} from '../src/client/task-run-chat-presentation.ts'
import type {Conversation} from '@teloa/contract'
const conversation:Conversation={id:'original',ownerId:'local:teloa-owner',title:'固定标题',sessionId:'run-session',requestedSessionId:'run-session',scopeIds:['general'],version:1,status:'ready',purpose:'task-run',createdAt:'2026-10-14T00:00:00.000Z'}
const presentation={conversation,scope:'general',sessionId:'run-session',runId:'run',taskId:'task',taskVersion:1,roleId:'role',roleVersion:1,nativeRequestId:'request-one',title:'固定标题',goal:'请核对证据。'}
const text={type:'text',text:'{"schema":"teloa.task-run-input/v2","skills":[{"content":"完整配置"}]}'}
const image={type:'image',attachment:{id:'original-image'}},file={type:'file',attachment:{id:'original-file'}}
const node={key:'user:7',kind:'user',data:{seq:7,time:100,source:{kind:'user',rpcId:'request-one'},content:[text,image,file]}}
test('只投影同一原 Run 的用户目标，附件和原节点字节保持',()=>{
 const before=JSON.stringify(node),projected=projectTaskRunChatNode(node,'run-session',presentation)
 assert.deepEqual(projected.data.content,[{type:'text',text:'请核对证据。'},image,file])
 assert.equal(projected.data.source,node.data.source);assert.equal(projected.data.content[1],image)
 assert.equal(JSON.stringify(node),before);assert.equal(node.data.content[0],text)
})
test('schema 字符串、普通消息、其他会话或 rpcId 都不能产生目标投影',()=>{
 assert.equal(projectTaskRunChatNode(node,'run-session',null),node)
 assert.equal(projectTaskRunChatNode(node,'other',presentation),node)
 for(const changed of [{...node,kind:'steering'},{...node,data:{...node.data,source:{kind:'user',rpcId:'other'}}},{...node,data:{...node.data,source:{kind:'runtime-context',rpcId:'request-one'}}}])assert.equal(projectTaskRunChatNode(changed,'run-session',presentation),changed)
})
test('连接世代失效后迟到的原呈现不能覆盖当前会话，多个入口共用一次本人读口',async()=>{
 const pending:Array<(value:typeof presentation|null)=>void>=[]
 const directory=new TaskRunChatPresentationDirectory(()=>new Promise(resolve=>pending.push(resolve))),source=directory.forSession('run-session')
 const first=source.load();assert.equal(source.load(),first);assert.equal(pending.length,1)
 directory.invalidate();const second=source.load();assert.equal(pending.length,2)
 pending[0]!(presentation);await first;assert.equal(source.getSnapshot().status,'loading');assert.equal(source.getSnapshot().value,null)
 pending[1]!(null);await second;assert.deepEqual(source.getSnapshot(),{status:'ready',value:null})
})

test('标题只借用当前可信Run，原预约在选择与多个呈现入口间只读一次',async()=>{
 let reads=0,ordinary=0
 const directory=new TaskRunChatPresentationDirectory(async()=>{reads++;return presentation})
 await directory.forSession('run-session').load()
 assert.equal(await readTaskRunSelectedBinding(directory,'run-session',async()=>{ordinary++;throw Error('不可普通ensure')}),conversation)
 assert.equal(reads,1);assert.equal(ordinary,0)
 assert.equal(taskRunSessionTitle('JSON前缀','run-session',presentation),'固定标题')
 assert.equal(taskRunSessionTitle('普通JSON','other',presentation),'普通JSON')
})
test('只读核对失败或连接世代改变，不能降级为普通ensure或使用旧预约',async()=>{
 let ordinary=0,resolve!:(value:typeof presentation)=>void
 const directory=new TaskRunChatPresentationDirectory(()=>new Promise(yes=>{resolve=yes}))
 const pending=readTaskRunSelectedBinding(directory,'run-session',async()=>{ordinary++;return conversation})
 directory.invalidate();resolve(presentation)
 await assert.rejects(pending);assert.equal(ordinary,0)
 const failure=new TaskRunChatPresentationDirectory(async()=>{throw Error('本人预约暂时不可读')})
 await assert.rejects(readTaskRunSelectedBinding(failure,'run-session',async()=>{ordinary++;return conversation}),/本人预约/)
 assert.equal(ordinary,0)
})
