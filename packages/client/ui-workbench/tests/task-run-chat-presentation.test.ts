import test from 'node:test'
import assert from 'node:assert/strict'
import {projectTaskRunChatNode,TaskRunChatPresentationDirectory,readTaskRunSelectedBinding,taskRunSessionTitle,watchTaskRunConversationTitles} from '../src/client/task-run-chat-presentation.ts'
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
test('同会话历史输入按各自可信请求投影，不能用当前目标改写旧轮或回显内部JSON',()=>{
 const current={...presentation,nativeRequestId:'request-three',goal:'本轮复核',userMessages:[{nativeRequestId:'request-one',goal:'首轮任务与原资料概览'},{nativeRequestId:'request-three',goal:'本轮复核'}]},before=JSON.stringify(node)
 assert.deepEqual(projectTaskRunChatNode(node,'run-session',current).data.content,[{type:'text',text:'首轮任务与原资料概览'},image,file])
 assert.equal(JSON.stringify(node),before)
 const other={...node,data:{...node.data,source:{kind:'user',rpcId:'unverified'}}}
 assert.equal(projectTaskRunChatNode(other,'run-session',current),other)
})
test('连接世代失效后迟到的原呈现不能覆盖当前会话，多个入口共用一次本人读口',async()=>{
 const pending:Array<(value:typeof presentation|null)=>void>=[]
 const directory=new TaskRunChatPresentationDirectory(()=>new Promise(resolve=>pending.push(resolve))),source=directory.forSession('run-session')
 const first=source.load();assert.equal(source.load(),first);assert.equal(pending.length,1)
 directory.invalidate();const second=source.load();assert.equal(pending.length,2)
 pending[0]!(presentation);await first;assert.equal(source.getSnapshot().status,'loading');assert.equal(source.getSnapshot().value,null)
 pending[1]!(null);await second;assert.deepEqual(source.getSnapshot(),{status:'ready',value:null})
})
test('最近工作共用可信标题缓存，失效后重新读取，离开后不继续读取或更新旧视图',async()=>{
 let reads=0,current={...presentation,title:'告警 A'}
 const directory=new TaskRunChatPresentationDirectory(async()=>{reads++;return current}),titles:ReadonlyMap<string,string>[]=[]
 const close=watchTaskRunConversationTitles(['run-session'],directory,value=>titles.push(value))
 await directory.forSession('run-session').load();assert.equal(reads,1);assert.equal(titles.at(-1)?.get('run-session'),'告警 A')
 current={...current,title:'告警 A 复核'};directory.invalidate();await directory.forSession('run-session').load()
 assert.equal(reads,2);assert.equal(titles.at(-1)?.get('run-session'),'告警 A 复核')
 close();const count=titles.length;directory.invalidate();await Promise.resolve();assert.equal(reads,2);assert.equal(titles.length,count)
})

test('标题只借用当前可信Run，明确再打开时重新核对，普通呈现读取仍复用缓存',async()=>{
 let reads=0,ordinary=0
 const directory=new TaskRunChatPresentationDirectory(async()=>{reads++;return presentation})
 await directory.forSession('run-session').load()
 assert.equal(await readTaskRunSelectedBinding(directory,'run-session',async()=>{ordinary++;throw Error('不可普通ensure')}),conversation)
 assert.equal(reads,2);assert.equal(ordinary,0)
 await directory.forSession('run-session').load();assert.equal(reads,2)
 assert.equal(taskRunSessionTitle('JSON前缀','run-session',presentation),'固定标题')
 assert.equal(taskRunSessionTitle('普通JSON','other',presentation),'普通JSON')
 assert.equal(taskRunSessionTitle('内部JSON','task-run-loading',null,{...conversation,sessionId:'task-run-loading'}),'固定标题')
 assert.equal(taskRunSessionTitle('内部JSON','task-run-loading',null),undefined,'运行呈现加载前不闪现内部输入标题')
 const ordinaryBinding={...conversation,sessionId:'task-run-loading'};delete ordinaryBinding.purpose
 assert.equal(taskRunSessionTitle('本人普通 JSON 讨论','task-run-loading',null,ordinaryBinding),'本人普通 JSON 讨论','本人普通绑定不因标识前缀被改成运行标题')
})
test('同Session进入第三轮后再开读取规范Run，历史投影与原预约不改写且并发开共享读口',async()=>{
 let current=presentation,reads=0
 const directory=new TaskRunChatPresentationDirectory(async()=>{reads++;return current}),source=directory.forSession('run-session'),before=JSON.stringify(conversation)
 await source.load()
 current={...presentation,runId:'third-run',taskVersion:6,nativeRequestId:'request-three',goal:'仅补齐本轮本地核验。'}
 const ordinary=async()=>{throw Error('不得降级普通ensure')}
 await Promise.all([readTaskRunSelectedBinding(directory,'run-session',ordinary),readTaskRunSelectedBinding(directory,'run-session',ordinary)])
 assert.equal(reads,2);assert.equal(source.getSnapshot().value?.runId,'third-run');assert.equal(JSON.stringify(conversation),before)
 const third={...node,data:{...node.data,source:{kind:'user',rpcId:'request-three'}}}
 assert.equal(projectTaskRunChatNode(node,'run-session',source.getSnapshot().value),node)
 const projected=projectTaskRunChatNode(third,'run-session',source.getSnapshot().value).data.content[0]
 assert.ok(projected&&'text'in projected);assert.equal(projected.text,current.goal)
 assert.deepEqual(projectTaskRunChatNode(node,'run-session',presentation).data.content,[{type:'text',text:presentation.goal},image,file])
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
