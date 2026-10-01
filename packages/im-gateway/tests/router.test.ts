import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {groupSendInput} from '@teloa/contract'
import {createBindingStore} from '../src/core/bindings.ts'
import {imRequestId} from '../src/core/request-id.ts'
import {createRouter} from '../src/core/router.ts'
import {withTemp} from './im-fakes.ts'
import {bindingOf,fakeSessionController,fakeWork,groupId,roleA} from './router-fakes.ts'

const source={channelId:'telegram',chatId:'100',messageId:'42'}

async function setup(dir:string,overrides:Parameters<typeof fakeWork>[0]={}){
 const bindings=createBindingStore(dir,{perChannel:1})
 await bindings.bind({channelId:'telegram',imUserId:'u1',displayName:'张三',ownerId:'local:teloa-owner'})
 const w=fakeWork(overrides),s=fakeSessionController()
 const marked:string[]=[]
 const router=createRouter({work:w.work,sessionController:s.controller,bindings,requestId:imRequestId,label:()=>'Telegram',markImSession:id=>marked.push(id)})
 return {bindings,router,marked,...w,...s}
}

test('ensureTargetSession（助理）：无会话 → conversations/create 只带 requestId+title，写回 assistantSessionId；再次调用读回复用',()=>withTemp(async dir=>{
 const {bindings,router,of,marked}=await setup(dir)
 const first=await router.ensureTargetSession((await bindings.find('telegram','u1'))!,source)
 assert.deepEqual(first,{sessionId:'s1',label:'助理'})
 const [create]=of('conversations/create')
 assert.deepEqual(Object.keys(create!.payload).sort(),['requestId','title'])
 assert.equal(create!.payload.requestId,imRequestId('telegram','100','42','conv'))
 assert.equal(create!.payload.title,'IM 私聊 · 张三')
 const bound=(await bindings.find('telegram','u1'))!
 assert.equal(bound.assistantSessionId,'s1')
 assert.deepEqual(await router.ensureTargetSession(bound,{...source,messageId:'43'}),{sessionId:'s1',label:'助理'})
 assert.equal(of('conversations/create').length,1)
 // 终审 I-3：IM 发起或复用的会话都向宿主登记，宿主据此拒绝该会话下载模型。
 assert.deepEqual(marked,['s1','s1'])
 assert.deepEqual(of('conversations/read').map(call=>call.payload),[{sessionId:'s1'}])
}))

test('ensureTargetSession（助理）：已存会话读不到（未就绪/已失效）→ 重建',()=>withTemp(async dir=>{
 const {router,of}=await setup(dir)
 const result=await router.ensureTargetSession(bindingOf({assistantSessionId:'gone'}),source)
 assert.equal(result.sessionId,'s1')
 assert.equal(of('conversations/create').length,1)
}))

test('M3. ensureTargetSession（同事）：不复用工作台已关联的会话，IM 绑定自建会话并写回 roleSessionIds；两个 IM 绑定各用各的',()=>withTemp(async dir=>{
 const {bindings,router,of,ready}=await setup(dir,{
  'object-conversations/list':()=>[{sessionId:'workbench',active:true,updatedAt:'2026-09-01T00:00:00.000Z'}],
 })
 ready.add('workbench')
 const first=await router.ensureTargetSession(bindingOf({target:{kind:'role',roleId:roleA.id}}),source)
 assert.deepEqual(first,{sessionId:'s1',label:'小王'})
 assert.equal(of('object-conversations/list').length,0)
 assert.deepEqual((await bindings.find('telegram','u1'))!.roleSessionIds,{[roleA.id]:'s1'})
 const other=await createBindingStore(dir,{perChannel:1}).bind({channelId:'slack',imUserId:'U2',displayName:'李四',ownerId:'local:teloa-owner'})
 const second=await router.ensureTargetSession({...other,target:{kind:'role',roleId:roleA.id}},{channelId:'slack',chatId:'D2',messageId:'1'})
 assert.equal(second.sessionId,'s2')
 assert.deepEqual((await bindings.find('slack','U2'))!.roleSessionIds,{[roleA.id]:'s2'})
 assert.deepEqual((await bindings.find('telegram','u1'))!.roleSessionIds,{[roleA.id]:'s1'})
}))

test('ensureTargetSession（同事）：无可用会话 → create 带 roleId + object-conversations/change link（精确键、派生 requestId）',()=>withTemp(async dir=>{
 const {router,of}=await setup(dir)
 const result=await router.ensureTargetSession(bindingOf({target:{kind:'role',roleId:roleA.id}}),source)
 assert.deepEqual(result,{sessionId:'s1',label:'小王'})
 const [create]=of('conversations/create')
 assert.deepEqual(Object.keys(create!.payload).sort(),['requestId','roleId','title'])
 assert.equal(create!.payload.roleId,roleA.id)
 const [link]=of('object-conversations/change')
 assert.deepEqual(link!.payload,{requestId:imRequestId('telegram','100','42','link'),kind:'role',objectId:roleA.id,expectedObjectVersion:3,sessionId:'s1',expectedLinkVersion:0,action:'link'})
}))

test('newSession：清除后新建（同事目标不复用 object-conversations 旧会话）',()=>withTemp(async dir=>{
 const {bindings,router,of,ready}=await setup(dir,{'object-conversations/list':()=>[{sessionId:'old',active:true}]})
 ready.add('old')
 const binding=await bindings.change('telegram','u1',{target:{kind:'role',roleId:roleA.id},roleSessionIds:{[roleA.id]:'old'}})
 assert.equal(await router.newSession(binding,source),'s1')
 assert.equal(of('object-conversations/list').length,0)
 assert.deepEqual((await bindings.find('telegram','u1'))!.roleSessionIds,{[roleA.id]:'s1'})
}))

test('prompt：sessionController.prompt 收到 queue 模式、来源前缀与派生 requestId；同一消息重放 requestId 相同（H3）',()=>withTemp(async dir=>{
 const {router,prompts}=await setup(dir)
 await router.prompt('s1','帮我写周报',source)
 await router.prompt('s1','帮我写周报',source)
 assert.equal(prompts.length,2)
 const [a,b]=prompts
 assert.equal(a!.request.requestId,imRequestId('telegram','100','42','prompt'))
 assert.equal(a!.request.requestId,b!.request.requestId)
 assert.deepEqual({...a!.request,content:undefined},{requestId:a!.request.requestId,sessionId:'s1',mode:'queue',content:undefined})
 assert.equal(a!.request.content[0]!.text,'（来自 IM：Telegram）\n帮我写周报')
}))

test('stop：同步 cancel({sessionId})',()=>withTemp(async dir=>{
 const {router,cancels}=await setup(dir)
 assert.deepEqual(router.stop('s1'),{accepted:true})
 assert.deepEqual(cancels,[{sessionId:'s1'}])
}))

test('listRoles：roles/list 去掉已退役',()=>withTemp(async dir=>{
 const {router}=await setup(dir)
 assert.deepEqual(await router.listRoles(),[{id:roleA.id,name:'小王',version:3}])
}))

test('10. sendGroup：groups/messages/send 恰 5 键、groupSendInput 通过、mentions 去重且 ≤8；无任何 pending 登记调用（H3）',()=>withTemp(async dir=>{
 const {router,calls,of}=await setup(dir)
 const group={channelId:'telegram',chatId:'-100',groupId,boundAt:'2026-09-26T00:00:00.000Z'}
 const mentions=[{roleId:roleA.id,expectedVersion:3},{roleId:roleA.id,expectedVersion:3}]
 for(let i=0;i<9;i+=1)mentions.push({roleId:`0f9e8d7c-6b5a-4433-9211-0fedcba9870${i}`,expectedVersion:1})
 assert.deepEqual(await router.sendGroup(group,'@小王 做X',mentions,{channelId:'telegram',chatId:'-100',messageId:'7'}),{messageId:'m1',since:'2026-09-26T00:00:01.000Z'})
 assert.deepEqual(of('groups/get')[0]!.payload,{groupId})
 const [send]=of('groups/messages/send')
 assert.deepEqual(Object.keys(send!.payload),['requestId','groupId','expectedVersion','text','mentions'])
 assert.equal(send!.payload.requestId,imRequestId('telegram','-100','7','group'))
 assert.equal(send!.payload.expectedVersion,7)
 const parsed=groupSendInput(send!.payload)
 assert.equal(parsed.mentions!.length,8)
 assert.equal(new Set(parsed.mentions!.map(m=>m.roleId)).size,8)
 assert.ok(calls.every(call=>!call.endpoint.startsWith('requests/pending')))
}))

test('tasksSummary 前 10 条「[状态] 标题」；attentionSummary 计数并提示到工作台',()=>withTemp(async dir=>{
 const many=Array.from({length:12},(_,i)=>({title:`任务${i}`,state:'ready'}))
 const {router,of}=await setup(dir,{'tasks/list':()=>many})
 const tasks=(await router.tasksSummary()).split('\n')
 assert.equal(tasks.length,10)
 assert.equal(tasks[0],'[待开始] 任务0')
 const attention=await router.attentionSummary()
 assert.equal(of('tasks/attention').length,1)
 assert.equal(of('security-actions/attention').length,1)
 assert.match(attention,/任务 1 项/)
 assert.match(attention,/安全动作 1 项/)
 assert.match(attention,/请到工作台处理/)
}))

test('L3. 插件释放信号：deps.signal 中止后，在途与后续 invoke、prompt 都带已中止的信号',()=>withTemp(async dir=>{
 const bindings=createBindingStore(dir,{perChannel:1})
 const w=fakeWork(),s=fakeSessionController(),controller=new AbortController()
 const router=createRouter({work:w.work,sessionController:s.controller,bindings,requestId:imRequestId,label:()=>'Telegram',signal:controller.signal})
 await router.listRoles()
 assert.equal(w.calls[0]!.signal,controller.signal)
 controller.abort()
 await router.prompt('s1','hi',source)
 assert.equal(s.prompts[0]!.signal.aborted,true)
}))

test('L3. router.ts 不再用 as unknown as 绕过类型',async()=>{
 const text=await readFile(new URL('../src/core/router.ts',import.meta.url),'utf8')
 assert.doesNotMatch(text,/as unknown as/)
})

test('I2. groupRunSessions：tasks/list 取本协作群或未挂群（群内直接回应任务 groupId 为 null）且不早于触发消息的任务 → task-runs/list，只认 groupContext 来源为该触发消息的运行会话',()=>withTemp(async dir=>{
 const other='00000000-0000-4000-8000-000000000000'
 const run=(sessionId:string,messageId:string,group=groupId)=>({id:'r-'+sessionId,sessionId,groupContext:{groupId:group,source:{messageId}}})
 const {router,of}=await setup(dir,{
  'tasks/list':()=>[
   {id:'t-old',groupId,createdAt:'2026-09-25T00:00:00.000Z'},
   {id:'t-a',groupId,createdAt:'2026-09-26T00:00:02.000Z',assigneeRoleId:roleA.id},
   {id:'t-b',groupId,createdAt:'2026-09-26T00:00:03.000Z',assigneeRoleId:'9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d'},
   {id:'t-other',groupId:other,createdAt:'2026-09-26T00:00:04.000Z'},
   {id:'t-solo',groupId:null,createdAt:'2026-09-26T00:00:05.000Z',assigneeRoleId:roleA.id},
   {id:'t-c',groupId,createdAt:'2026-09-26T00:00:06.000Z',assigneeRoleId:null},
  ],
  'task-runs/list':payload=>({'t-solo':[run('run-solo','m1')],'t-a':[run('run-a','m1')],'t-b':[run('run-b','m1'),run('run-x','m2'),run('run-y','m1',other),{id:'bad'}],'t-c':[run('run-c','m1')]} as Record<string,unknown>)[String(payload.taskId)]??[],
 })
 // 同事名取自任务负责同事（已退役的「老李」也照名回发）；无负责同事时回「同事」。
 assert.deepEqual(await router.groupRunSessions({groupId,messageId:'m1',since:'2026-09-26T00:00:01.000Z'}),[{sessionId:'run-a',name:'小王'},{sessionId:'run-b',name:'老李'},{sessionId:'run-solo',name:'小王'},{sessionId:'run-c',name:'同事'}])
 assert.deepEqual(of('task-runs/list').map(call=>call.payload),[{taskId:'t-a'},{taskId:'t-b'},{taskId:'t-solo'},{taskId:'t-c'}])
 // 无命中不取同事名。
 const before=of('roles/list').length
 assert.deepEqual(await router.groupRunSessions({groupId,messageId:'m9',since:'2026-09-26T00:00:01.000Z'}),[])
 assert.equal(of('roles/list').length,before)
}))
