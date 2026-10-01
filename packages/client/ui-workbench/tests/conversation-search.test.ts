import test from 'node:test'
import assert from 'node:assert/strict'
import { ConversationSearch,searchPhase,type ContentResult } from '../src/client/conversation-search.ts'
const deferred=()=>{let resolve!:(value:ContentResult)=>void,reject!:(error:Error)=>void;const promise=new Promise<ContentResult>((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}

test('查询只发布当前获准工作目录的正文摘要，保留结果截断信号',async()=>{
  let ids=['a','b'];const pending=deferred()
  const search=new ConversationSearch(async(query,signal)=>{assert.equal(query,'河流');assert.equal(signal.aborted,false);return pending.promise},()=>ids)
  const run=search.run(' 河流 ')
  assert.equal(search.getSnapshot().status,'loading')
  ids=['b']
  pending.resolve({items:[{sessionId:'a',snippet:'已离开目录'},{sessionId:'b',snippet:'河流样本'},{sessionId:'private',snippet:'私人内容'}],hasMore:true})
  await run
  assert.deepEqual(search.getSnapshot(),{query:'河流',status:'ready',items:[{sessionId:'b',snippet:'河流样本'}],hasMore:true})
})

test('迟到结果与失败不能覆盖新查询；清空后同一词的新请求也有独立身份',async()=>{
  const old=deferred(),next=deferred(),third=deferred();let count=0;const signals:AbortSignal[]=[]
  const search=new ConversationSearch((_query,signal)=>{signals.push(signal);return [old,next,third][count++]!.promise},()=>['a'])
  const one=search.run('old'),two=search.run('new')
  assert.equal(signals[0]?.aborted,true)
  next.resolve({items:[{sessionId:'a',snippet:'新的内容'}],hasMore:false});await two
  old.reject(Error('旧连接断开'));await one
  assert.equal(search.getSnapshot().query,'new');assert.equal(search.getSnapshot().items[0]?.snippet,'新的内容')
  const last=search.run('new');search.clear();third.resolve({items:[{sessionId:'a',snippet:'清空前的内容'}],hasMore:false});await last
  assert.equal(signals[2]?.aborted,true);assert.equal(search.getSnapshot().status,'idle');assert.deepEqual(search.getSnapshot().items,[])
})

test('失败清除旧正文并允许重试，空查询不访问宿主',async()=>{
  let count=0
  const search=new ConversationSearch(async()=>{count++;if(count===1)throw Error('内容索引不可用');return {items:[{sessionId:'a',snippet:'恢复后内容'}],hasMore:false}},()=>['a'])
  await search.run(' ');assert.equal(count,0)
  await search.run('内容');assert.equal(search.getSnapshot().status,'failed');assert.deepEqual(search.getSnapshot().items,[]);assert.match(search.getSnapshot().error!,/索引/)
  await search.run('内容');assert.equal(search.getSnapshot().status,'ready');assert.equal(search.getSnapshot().items[0]?.snippet,'恢复后内容')
})

test('连接或工作目录未就绪时正文尚未查明，旧完成状态不能冒充当前查询',()=>{
  const idle={query:'',status:'idle' as const,items:[],hasMore:false}
  assert.equal(searchPhase('河流',false,idle),'waiting')
  assert.equal(searchPhase('河流',true,idle),'loading')
  assert.equal(searchPhase('河流',false,{...idle,query:'河流',status:'ready'}),'waiting')
  assert.equal(searchPhase('新查询',true,{...idle,query:'旧查询',status:'ready'}),'loading')
  assert.equal(searchPhase('河流',true,{...idle,query:'河流',status:'ready'}),'ready')
  assert.equal(searchPhase(' ',false,idle),'idle')
})

test('清空后重新搜索同一词，旧成功不能覆盖新的结果',async()=>{
  const first=deferred(),second=deferred();let calls=0
  const search=new ConversationSearch(()=>[first,second][calls++]!.promise,()=>['a'])
  const old=search.run('相同词');search.clear();const current=search.run('相同词')
  second.resolve({items:[{sessionId:'a',snippet:'当前结果'}],hasMore:false});await current
  first.resolve({items:[{sessionId:'a',snippet:'过期结果'}],hasMore:true});await old
  assert.equal(search.getSnapshot().items[0]?.snippet,'当前结果');assert.equal(search.getSnapshot().hasMore,false)
})
