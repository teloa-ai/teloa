import test from 'node:test'
import assert from 'node:assert/strict'
import type { Conversation } from '@teloa/contract'
import { ConversationManagement, ForkRejectedError, managementAvailability, type ConversationManagementPort } from '../src/client/conversation-management.ts'

const row=(id:string):Conversation=>({id:'work-'+id,sessionId:id,requestedSessionId:id,ownerId:'owner',title:id,scopeIds:['general'],version:1,status:'ready',createdAt:'2026-09-11T00:00:00Z'})
function setup(){
  const rows=[row('a'),row('b')],calls:string[]=[],listeners=new Set<()=>void>()
  let archived:string[]=[],running=false
  const workspaces=[{workspaceId:'one',title:'项目',path:'/one',sessionIds:['a','private','b']}]
  const port:ConversationManagementPort={
    state:()=>({ready:true,baseline:true,archived,workspaces}),subscribe:fn=>{listeners.add(fn);return ()=>listeners.delete(fn)},
    summary:id=>id==='a'||id==='b'?{title:id,running}:undefined,
    rename:async(id,title)=>{calls.push('rename:'+id+':'+title)},
    archive:async id=>{calls.push('archive:'+id);archived=[...archived,id];listeners.forEach(fn=>fn())},
    fork:async id=>{calls.push('fork:'+id);return 'child'},
    copyHistory:async()=>[],
    releaseCopy:async()=>{throw Error('未设置确认记录')},
    resolveCopy:async()=>{throw Error('未设置恢复记录')},
    move:async(workspaceId,id,before)=>{calls.push('move:'+workspaceId+':'+id+':'+(before??'end'))},
    ensure:async id=>{calls.push('ensure:'+id);return row(id)},
    adopt:async(id,requestId,title)=>{calls.push('adopt:'+id);return {...row(id),requestId,title}},
  }
  const manager=new ConversationManagement(()=>rows),dispose=manager.attach(port)
  return {manager,port,calls,rows,workspaces,dispose,setRunning:(value:boolean)=>{running=value}}
}

test('管理仅接受本人已完成绑定的会话；空标题与运行中归档在调用前拒绝',async()=>{
  const s=setup()
  await assert.rejects(s.manager.rename('other','标题'),/工作目录/)
  await assert.rejects(s.manager.rename('a','  '),/名称/)
  s.rows[0]={...row('a'),status:'pending'}
  await assert.rejects(s.manager.rename('a','标题'),/绑定/)
  s.rows[0]=row('a');s.setRunning(true)
  await assert.rejects(s.manager.archive('a'),/运行/)
  assert.deepEqual(s.calls,[])
})

test('重命名锁定原身份；同会话并发拒绝，失败后可带原稿重试',async()=>{
  const s=setup();let fail!:(reason:Error)=>void
  s.port.rename=async(id,title)=>{s.calls.push(id+':'+title);await new Promise<void>((_,reject)=>{fail=reject})}
  const pending=s.manager.rename('a','  调查记录  ')
  assert.equal(s.manager.getSnapshot().pending.a,'rename')
  await assert.rejects(s.manager.rename('a','覆盖'),/正在/)
  fail(Error('断开连接'));await assert.rejects(pending,/断开连接/)
  assert.equal(s.manager.getSnapshot().pending.a,undefined)
  assert.deepEqual(s.calls,['a:调查记录'])
  s.port.rename=async(id,title)=>{s.calls.push(id+':'+title)}
  await s.manager.rename('a','调查记录')
  assert.deepEqual(s.calls,['a:调查记录','a:调查记录'])
})

test('原生副本已创建但绑定失败时重试同一副本，不再次 fork 或切换当前会话',async()=>{
  const s=setup();let fail=true
  s.port.ensure=async id=>{s.calls.push('ensure:'+id);if(fail)throw Error('工作绑定暂不可用');return row(id)}
  await assert.rejects(s.manager.fork('a'),/工作绑定暂不可用/)
  assert.equal(s.manager.getSnapshot().copies.a,'child')
  fail=false
  const result=await s.manager.fork('a')
  assert.equal(result.sessionId,'child')
  assert.deepEqual(s.calls,['fork:a','ensure:child','ensure:child'])
})

test('副本绑定身份不匹配不得宣告成功；原生 fork 结果不明不能自动重试创建',async()=>{
  const s=setup()
  s.port.ensure=async()=>row('wrong')
  await assert.rejects(s.manager.fork('a'),/不一致/)
  assert.equal(s.manager.getSnapshot().copies.a,'child')
  s.port.fork=async()=>{throw Error('请求超时')}
  await assert.rejects(s.manager.fork('b'),/结果未确认/)
  await assert.rejects(s.manager.fork('b'),/结果未确认/)
  assert.ok(s.manager.getSnapshot().uncertain.includes('b'))
})

test('副本结果未知不向上层拼接底层异常正文',async()=>{
 const s=setup();s.port.fork=async()=>{throw Error('服务端私有诊断')}
 await assert.rejects(s.manager.fork('a'),error=>{
   assert.ok(error instanceof Error)
   assert.match(error.message,/结果未确认/)
   assert.doesNotMatch(error.message,/私有诊断/)
   return true
 })
})

test('归档只跟随 DSH 权威集合，重复归档拒绝，断开后不允许管理',async()=>{
  const s=setup()
  assert.deepEqual(s.manager.getSnapshot().archived,[])
  await s.manager.archive('a')
  assert.deepEqual(s.manager.getSnapshot().archived,['a'])
  await assert.rejects(s.manager.rename('a','改历史'),/归档/)
  s.dispose()
  await assert.rejects(s.manager.archive('b'),/连接/)
  assert.deepEqual(s.calls,['archive:a'])
})

test('曾经同步完成不等于当前连接健康；断线保留归档基线但不允许操作',()=>{
 const healthy={phase:'ready',state:'idle',error:null}
 assert.deepEqual(managementAvailability('connected','ready',healthy),{baseline:true,ready:true})
 assert.deepEqual(managementAvailability('disconnected','ready',healthy),{baseline:true,ready:false})
 assert.deepEqual(managementAvailability('connected','ready',{...healthy,state:'error',error:Error('断开')}),{baseline:true,ready:false})
 assert.deepEqual(managementAvailability('connected','ready',{...healthy,phase:'pending'}),{baseline:false,ready:false})
})

test('宿主明确拒绝或空会话不进入结果未知，完成回复后允许新请求',async()=>{
 const s=setup();s.port.summary=()=>({running:false,blank:true})
 await assert.rejects(s.manager.fork('a'),/暂时不能/)
 assert.deepEqual(s.calls,[])
 s.port.summary=()=>({running:false,blank:false})
 s.port.fork=async()=>{throw new ForkRejectedError('还没有完成回复')}
 await assert.rejects(s.manager.fork('a'),/还没有完成/)
 assert.deepEqual(s.manager.getSnapshot().uncertain,[])
 s.port.fork=async()=>'child'
 assert.equal((await s.manager.fork('a')).sessionId,'child')
})


test('会话排序保存到所属原生工作区，不以最近更新时间计算锚点',async()=>{
 const s=setup()
 await s.manager.move('b','one','up',['a','b'])
 assert.deepEqual(s.calls,['move:one:b:a'])
 s.calls.length=0
 await s.manager.move('a','one','down',['a','b'])
 assert.deepEqual(s.calls,['move:one:a:end'])
 assert.deepEqual(s.workspaces[0]!.sessionIds,['a','private','b'])
})

test('排序前复核目录顺序和所属工作区，归档与未绑定会话不得排序',async()=>{
 const s=setup()
 await assert.rejects(s.manager.move('a','missing','down',['a','b']),/工作区/)
 await assert.rejects(s.manager.move('a','one','down',['b','a']),/顺序.*变化/)
 await assert.rejects(s.manager.move('private','one','up',['a','b']),/工作目录/)
 await s.manager.archive('b');s.calls.length=0
 await assert.rejects(s.manager.move('b','one','up',['a','b']),/归档/)
 await assert.rejects(s.manager.move('a','one','down',['a','b']),/顺序.*变化/)
 assert.deepEqual(s.calls,[])
})

test('排序请求期间不允许第二次移动；失败清除忙态后可按最新目录重试',async()=>{
 const s=setup();let reject!:(error:Error)=>void
 s.port.move=async()=>new Promise<void>((_,fail)=>{reject=fail})
 const pending=s.manager.move('a','one','down',['a','b'])
 assert.equal(s.manager.getSnapshot().pending.a,'move')
 await assert.rejects(s.manager.move('b','one','up',['a','b']),/正在/)
 reject(Error('网络错误'));await assert.rejects(pending,/网络错误/)
 assert.deepEqual(s.manager.getSnapshot().pending,{})
 s.port.move=async(workspaceId,id,before)=>{s.calls.push(workspaceId+':'+id+':'+before)}
 await s.manager.move('b','one','up',['a','b'])
 assert.deepEqual(s.calls,['one:b:a'])
})


test('显式接入拒绝未知、归档及正在创建的会话，不自动绑定私人历史',async()=>{
 const s=setup();assert.deepEqual(s.calls,[])
 await assert.rejects(s.manager.adopt('private','Work conversation'),/同步/)
 s.port.summary=()=>({running:false,title:'历史'})
 const state=s.port.state;s.port.state=()=>({...state(),archived:['private']})
 await assert.rejects(s.manager.adopt('private','Work conversation'),/归档/)
 s.port.state=state;s.rows.push({...row('private'),status:'pending'})
 await assert.rejects(s.manager.adopt('private','Work conversation'),/恢复/)
 assert.deepEqual(s.calls,[])
})
test('显式接入固定原身份标题和请求，失败重试不复制或创建会话',async()=>{
 const s=setup(),requests:{id:string;requestId:string;title:string}[]=[]
 s.port.summary=()=>({running:false,title:'原会话'})
 s.port.adopt=async(id,requestId,title)=>{requests.push({id,requestId,title});if(requests.length===1)throw Error('断线');return {...row(id),requestId,title}}
 await assert.rejects(s.manager.adopt('private','Work conversation'),/断线/)
 s.port.summary=()=>({running:false,title:'更新名称'})
 const result=await s.manager.adopt('private','Work conversation')
 assert.equal(result.sessionId,'private');assert.deepEqual(requests[0],requests[1]);assert.equal(requests[0]!.title,'原会话');assert.deepEqual(s.calls,[])
})
test('接入期间拒绝同身份并发，错误返回不能宣告成功',async()=>{
 const s=setup();s.port.summary=()=>({running:false})
 let resolve!:(value:Conversation)=>void
 s.port.adopt=()=>new Promise(done=>{resolve=done})
 const pending=s.manager.adopt('private','Work conversation')
 await assert.rejects(s.manager.adopt('private','Work conversation'),/正在/)
 resolve(row('wrong'));await assert.rejects(pending,/身份/)
 assert.equal(s.manager.getSnapshot().pending.private,undefined)
})

test('无原生标题时使用界面传入的当前语言回退标题',async()=>{
 const s=setup(),titles:string[]=[]
 s.port.summary=()=>({running:false})
 s.port.adopt=async(id,requestId,title)=>{titles.push(title);return {...row(id),requestId,title}}
 await s.manager.adopt('private','Imported conversation')
 assert.deepEqual(titles,['Imported conversation'])
})

test('刷新副本记录恢复未知状态，禁止再次调用原生创建',async()=>{
 const s=setup();s.port.copyHistory=async()=>[{ownerId:'owner',requestId:'attempt',sourceSessionId:'a',state:'pending',createdAt:'2026-09-11T00:00:00Z'}]
 await s.manager.refreshCopyHistory()
 await assert.rejects(s.manager.fork('a'),/未确认/)
 assert.deepEqual(s.calls,[])
})
test('显式恢复固定原尝试与副本，错误来源不能写工作绑定',async()=>{
 const s=setup(),attempt={ownerId:'owner',requestId:'attempt',sourceSessionId:'a',state:'pending' as const,createdAt:'2026-09-11T00:00:00Z'}
 s.port.copyHistory=async()=>[attempt];await s.manager.refreshCopyHistory()
 s.port.resolveCopy=async()=>({...attempt,sourceSessionId:'b',state:'ready',childSessionId:'child'})
 await assert.rejects(s.manager.recoverCopy('a','attempt','child'),/身份/)
 assert.deepEqual(s.calls,[])
 s.port.resolveCopy=async()=>({...attempt,state:'ready',childSessionId:'child'})
 s.port.copyHistory=async()=>[{...attempt,state:'ready',childSessionId:'child'}]
 const result=await s.manager.recoverCopy('a','attempt','child')
 assert.equal(result.sessionId,'child');assert.deepEqual(s.calls,['ensure:child']);assert.deepEqual(s.manager.getSnapshot().uncertain,[])
})

test('确认独立新建只释放选中旧尝试，新未知请求的锁继续保留',async()=>{
 const s=setup(),old={ownerId:'owner',requestId:'old',sourceSessionId:'a',state:'pending' as const,createdAt:'2026-09-11T00:00:00Z'}
 s.port.copyHistory=async()=>[old];await s.manager.refreshCopyHistory()
 const released={...old,releasedAt:'2026-09-11T01:00:00Z'}
 s.port.releaseCopy=async()=>released
 s.port.copyHistory=async()=>[released,{...old,requestId:'new'}]
 await s.manager.releaseCopy('a','old')
 assert.deepEqual(s.manager.getSnapshot().uncertain,['a']);assert.deepEqual(s.calls,[])
 s.port.copyHistory=async()=>[released];await s.manager.refreshCopyHistory()
 assert.deepEqual(s.manager.getSnapshot().uncertain,[])
})
