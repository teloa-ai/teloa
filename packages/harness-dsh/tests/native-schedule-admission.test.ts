import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import type {SessionStore} from '@deepseek-ai/dsh-session'
import {setImmediate as immediate} from 'node:timers/promises'
import {scheduleFixture,deferred,until,type Delivery,type Admission} from './fixtures/native-schedule-admission.ts'

const sampled=Date.parse('2033-05-18T12:00:00.000Z')
function clock(t:TestContext){t.mock.timers.enable({apis:['Date'],now:sampled});return (time:number)=>t.mock.timers.setTime(time)}
const one=(id='schedule-one')=>({id,kind:'at',title:'一次提醒',prompt:'真实计划输入',scheduledAt:new Date(sampled-1000).toISOString()})
const every=(id='schedule-every')=>({id,kind:'every',title:'周期提醒',prompt:'真实周期输入',everySeconds:60,scheduledAt:new Date(sampled-5000).toISOString()})
function zero(f:Awaited<ReturnType<typeof scheduleFixture>>){assert.equal(f.inbox().length,0);assert.equal(f.events().filter(event=>event.type==='agent/inbox/spliced').length,0);assert.equal(f.state.flushes,0)}

test('原始 npm 与 patched Free 无hook均保留真实 followup/flush/receipt',async t=>{
 clock(t)
 for(const patched of [false,true]){
  const f=await scheduleFixture(t,{},[one()],patched)
  await until(async()=>(await f.catalog())[0]?.status==='inactive')
  const [row]=await f.catalog();assert.equal(f.inbox().length,1);assert.equal(f.inbox()[0]?.source.kind,'schedule');assert.equal(f.state.flushes,1)
  assert.equal(row.lastDelivery.messageId,f.inbox()[0]!.id);assert.equal(row.deliveryHistory,undefined)
 }
})

test('required在初始due扫描前拒绝缺provider；安装唯一且require不能解除',async t=>{
 clock(t);const f=await scheduleFixture(t,{requireDeliveryAdmission:true},[one()]);await f.drain();zero(f)
 const [row]=await f.catalog();assert.equal(row.status,'active');assert.equal(row.lastDelivery,undefined)
 const provider:Admission=async(_,dispatch)=>dispatch()
 const scoped=Reflect.get(f.ctx.extend(),'schedule') as {installDeliveryAdmission:(fn:Admission)=>void;requireDeliveryAdmission:()=>void}
 f.service.installDeliveryAdmission(provider);scoped.installDeliveryAdmission(provider);scoped.requireDeliveryAdmission()
 assert.throws(()=>f.service.installDeliveryAdmission(async()=>{}),/already installed/)
 assert.throws(()=>f.service.installDeliveryAdmission(null),/invalid/)
 zero(f)
})

test('跨await零投递；同Session整批精确occurrences、一消息与同步once；管理FIFO继续',async t=>{
 clock(t);const entered=deferred<Delivery>(),hold=deferred(),records=[every('schedule-a'),every('schedule-b')]
 const f=await scheduleFixture(t,{requireDeliveryAdmission:true,admitDelivery:async(request,dispatch)=>{entered.resolve(request);await hold.promise;dispatch();assert.throws(dispatch,/scope is closed/)}},records)
 const request=await entered.promise;zero(f)
 assert.equal(request.agent,f.agent);assert.equal(request.message.source.kind,'schedule');assert.ok(Object.isFrozen(request));assert.ok(Object.isFrozen(request.message.content[0]));assert.ok(Object.isFrozen(request.occurrences))
 assert.deepEqual(request.occurrences,records.map(record=>({scheduleId:record.id,occurrenceAt:record.scheduledAt})))
 let updated=false;const updating=f.service.update({sessionId:f.agent.id,id:records[0]!.id,expected:records[0],prompt:'排队变更'}).then((result:unknown)=>{updated=true;return result})
 await immediate();assert.equal(updated,false);hold.resolve();await f.drain();const result=await updating
 assert.equal(result.code,'schedule_conflict');assert.equal(updated,true)
 assert.equal(f.inbox().length,1);assert.equal(f.inbox()[0]?.id,request.message.id);assert.equal(f.state.flushes,1)
 const rows=await f.catalog();assert.equal(rows.length,2);for(const row of rows){assert.equal(row.lastDelivery.messageId,request.message.id);assert.equal(row.scheduledAt,new Date(sampled+55000).toISOString())}
})

test('拒绝及await期间许可撤销均零Inbox/flush/receipt/cursor',async t=>{
 clock(t)
 for(const held of [false,true]){
  const entered=deferred(),hold=deferred();let usable=true
  const f=await scheduleFixture(t,{requireDeliveryAdmission:true,admitDelivery:async(_,dispatch)=>{entered.resolve();if(held)await hold.promise;if(!held||!usable)throw Error('确定性许可拒绝');dispatch()}},[every()])
  await entered.promise;usable=false;hold.resolve();await f.drain();zero(f)
  const [row]=await f.catalog();assert.equal(row.scheduledAt,every().scheduledAt);assert.equal(row.lastDelivery,undefined);assert.equal(row.status,'active')
 }
})

test('dispose在admission await期间关闭dispatch且排空，无残留timer',async t=>{
 clock(t);const entered=deferred(),hold=deferred()
 const f=await scheduleFixture(t,{admitDelivery:async(_,dispatch)=>{entered.resolve();await hold.promise;dispatch()}},[one()])
 await entered.promise;const stopping=f.service.runtime.dispose();hold.resolve();await stopping;zero(f);assert.equal(f.service.runtime.timer,undefined)
})

test('await时钟回退令目标future：零写且保留官方未来timer义务',async t=>{
 const setTime=clock(t),entered=deferred(),hold=deferred()
 const f=await scheduleFixture(t,{admitDelivery:async(_,dispatch)=>{entered.resolve();await hold.promise;dispatch()}},[one()])
 await entered.promise;setTime(sampled-2000);hold.resolve();await f.drain();zero(f)
 const [row]=await f.catalog();assert.equal(row.scheduledAt,one().scheduledAt);assert.equal(row.lastDelivery,undefined);assert.ok(f.service.runtime.timer)
})

test('await跨周期新occurrence不能借旧grant，零Inbox与cursor变化',async t=>{
 const setTime=clock(t),entered=deferred<Delivery>(),hold=deferred()
 const f=await scheduleFixture(t,{admitDelivery:async(request,dispatch)=>{entered.resolve(request);await hold.promise;dispatch()}},[every()])
 const request=await entered.promise;assert.equal(request.occurrences[0]!.occurrenceAt,every().scheduledAt)
 setTime(sampled+60000);hold.resolve();await f.drain();zero(f)
 const [row]=await f.catalog();assert.equal(row.scheduledAt,every().scheduledAt);assert.equal(row.lastDelivery,undefined)
})

test('真实存储record改变拒旧descriptor；未dispatch及迟到callback不能入Inbox',async t=>{
 clock(t);const entered=deferred(),hold=deferred()
 const f=await scheduleFixture(t,{admitDelivery:async(_,dispatch)=>{entered.resolve();await hold.promise;dispatch()}},[one()])
 await entered.promise;const domain=await f.service.ready,current=domain.table('tasks').get(one().id)
 await domain.table('tasks').put(one().id,{...current,record:{...current.record,prompt:'实际存储变更'}})
 hold.resolve();await f.drain();zero(f);assert.equal((await f.catalog())[0].prompt,'实际存储变更')
 let late:(()=>void)|undefined
 const g=await scheduleFixture(t,{admitDelivery:async(_,dispatch)=>{late=dispatch}},[one('schedule-late')]);await g.drain();zero(g)
 assert.throws(()=>late!(),/scope is closed/);zero(g)
})

test('已受理后flush await中撤销继续完成官方receipt与cursor；后置provider失败亦不撤回',async t=>{
 clock(t);const dispatched=deferred(),holdAdmission=deferred(),flushed=deferred(),holdFlush=deferred();let usable=true
 const f=await scheduleFixture(t,{admitDelivery:async(_,dispatch)=>{assert.equal(usable,true);dispatch();dispatched.resolve();await holdAdmission.promise;throw Error('已受理后的许可撤销')}},[every()])
 await dispatched.promise;assert.equal(f.inbox().length,1);assert.equal((await f.catalog())[0].lastDelivery,undefined)
 f.state.flush=async()=>{flushed.resolve();await holdFlush.promise};holdAdmission.resolve();await flushed.promise;usable=false
 assert.equal(f.inbox().length,1);assert.equal((await f.catalog())[0].scheduledAt,every().scheduledAt)
 holdFlush.resolve();await f.drain()
 const [row]=await f.catalog();assert.equal(f.state.flushes,1);assert.equal(row.lastDelivery.messageId,f.inbox()[0]!.id);assert.equal(row.scheduledAt,new Date(sampled+55000).toISOString())
})


test('同id的另一真实Context Agent不能借该计划投递，exact对象核对零写',async t=>{
 clock(t);const other=await scheduleFixture(t),entered=deferred<Delivery>(),hold=deferred()
 const f=await scheduleFixture(t,{admitDelivery:async(request,dispatch)=>{entered.resolve(request);await hold.promise;dispatch()}},[one()],true,other.agent)
 const request=await entered.promise;assert.equal(request.agent,other.agent);assert.equal(request.agent.id,f.agent.id);assert.notEqual(request.agent,f.agent)
 hold.resolve();await f.drain();zero(f);zero(other);assert.equal((await f.catalog())[0].lastDelivery,undefined)
})


test('真实普通 observer 异常原版与差分均由官方隔离，receipt后扫描不重复',async t=>{
 clock(t)
 for(const patched of [false,true]){
  let sessionNotifications=0,inboxNotifications=0
  const f=await scheduleFixture(t,patched?{admitDelivery:async(_,dispatch)=>dispatch()}:{},[one()],patched,undefined,{beforeService:({ctx,agent})=>{
   ctx.on('session/event',()=>{sessionNotifications++;throw Error('test contained schedule session observer')},{global:true})
   agent.ctx.on('agent/inbox/inserted',()=>{inboxNotifications++;throw Error('test contained schedule inbox observer')})
  }})
  await f.drain();const [row]=await f.catalog()
  assert.equal(row.status,'inactive');assert.equal(f.inbox().length,1);assert.equal(row.lastDelivery.messageId,f.inbox()[0]!.id)
  assert.ok(sessionNotifications>=1);assert.equal(inboxNotifications,1);assert.equal(f.state.flushes,1)
  f.service.runtime.requestDrive();await f.drain()
  assert.equal(f.events().filter(event=>event.type==='agent/inbox/spliced').length,1);assert.equal(inboxNotifications,1);assert.equal(f.state.flushes,1)
 }
})

test('真实Inbox通知dispatch验证在append后抛错，精确新提交继续receipt且扫描不重复',async t=>{
 clock(t);let faults=0
 const f=await scheduleFixture(t,{admitDelivery:async(_,dispatch)=>dispatch()},[one()],true,undefined,{beforeService:({ctx})=>{
  ctx.on('internal/dispatch',(_mode,name)=>{if(name==='agent/inbox/inserted'){faults++;throw Error('test schedule dispatch after committed splice')}})
 }})
 await f.drain();const [row]=await f.catalog()
 assert.equal(f.inbox().length,1);assert.equal(f.events().filter(event=>event.type==='agent/inbox/spliced').length,1);assert.equal(faults,1)
 assert.equal(row.status,'inactive');assert.equal(row.lastDelivery.messageId,f.inbox()[0]!.id);assert.equal(f.state.flushes,1)
 f.service.runtime.requestDrive();await f.drain()
 assert.equal(f.inbox().length,1);assert.equal(f.events().filter(event=>event.type==='agent/inbox/spliced').length,1);assert.equal(faults,1);assert.equal(f.state.flushes,1)
})

test('await前exact Session不能随Agent公开字段与Store解析一起替换后借旧grant',async t=>{
 clock(t);const other=await scheduleFixture(t),entered=deferred(),hold=deferred()
 const f=await scheduleFixture(t,{admitDelivery:async(_,dispatch)=>{entered.resolve();await hold.promise;dispatch()}},[one()])
 await entered.promise
 const session=f.agent.session,store=Reflect.get(f.ctx,'sessions') as unknown as SessionStore,get=store.get.bind(store),originalGet=store.get
 // 故障注入两个公开身份读取边界；Agent、Session、Inbox与提交路径仍为官方真实对象。
 Reflect.set(f.agent,'session',other.agent.session)
 store.get=(id)=>id===f.agent.id?other.agent.session:get(id)
 try{
  hold.resolve();await f.drain()
  assert.equal(session.snapshotEvents().filter(event=>event.type==='agent/inbox/spliced').length,0)
  zero(f);zero(other);assert.equal((await f.catalog())[0].lastDelivery,undefined)
 }finally{Reflect.set(f.agent,'session',session);store.get=originalGet}
})


test('提交前真实dispatch veto零写，旧的完整候选splice不能充当本次受理',async t=>{
 clock(t)
 const veto=await scheduleFixture(t,{admitDelivery:async(_,dispatch)=>dispatch()},[one()],true,undefined,{beforeService:({ctx})=>{
  ctx.on('internal/dispatch',(_mode,name,args)=>{if(name==='session/event'&&args[1]?.type==='agent/inbox/spliced')throw Error('test schedule pre-append veto')})
 }})
 await veto.drain();zero(veto);assert.equal((await veto.catalog())[0].lastDelivery,undefined)
 const old=await scheduleFixture(t,{admitDelivery:async(request,dispatch)=>{
  // 在本次同步提交窗口开始前写入完全相同的真实候选；下一次投递因官方重复ID校验被拒。
  request.agent.followup(request.message);dispatch()
 }},[one()])
 await old.drain();assert.equal(old.inbox().length,1);assert.equal(old.events().filter(event=>event.type==='agent/inbox/spliced').length,1)
 assert.equal(old.state.flushes,0);const [row]=await old.catalog();assert.equal(row.status,'active');assert.equal(row.lastDelivery,undefined)
})

test('真实新splice的相同message id与source不能代替完整候选payload',async t=>{
 clock(t);let faults=0,candidate:Delivery['message']|undefined
 const f=await scheduleFixture(t,{admitDelivery:async(request,dispatch)=>{
  candidate=request.message;const followup=request.agent.followup
  // 仅故障注入公开投递边界：仍由官方followup提交真实Session/Inbox，但消息正文被替换。
  request.agent.followup=(message)=>followup.call(request.agent,{...message,content:[{type:'text',text:'相同id与source的其他正文'}]})
  try{dispatch()}finally{request.agent.followup=followup}
 }},[one()],true,undefined,{beforeService:({ctx})=>{
  ctx.on('internal/dispatch',(_mode,name)=>{if(name==='agent/inbox/inserted'){faults++;throw Error('test changed candidate after committed splice')}})
 }})
 await f.drain();assert.equal(faults,1);assert.equal(f.inbox().length,1);assert.equal(f.events().filter(event=>event.type==='agent/inbox/spliced').length,1)
 assert.equal(f.inbox()[0]!.id,candidate!.id);assert.deepEqual(f.inbox()[0]!.source,candidate!.source);assert.notDeepEqual(f.inbox()[0],candidate)
 assert.equal(f.state.flushes,0);const [row]=await f.catalog();assert.equal(row.status,'active');assert.equal(row.lastDelivery,undefined)
})
