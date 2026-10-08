import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync} from 'node:fs'
import ts from 'typescript'
import * as homeNative from '../src/client/home-native-controller.ts'
import {createInitialNativeSessionCoordinator,type InitialNativeSessionProvider} from '../src/client/initial-native-session.ts'
import {BindingClient} from '../src/client/binding-client.ts'
import {ConversationSearch} from '../src/client/conversation-search.ts'
import {presentConversations} from '../src/client/work-presentation.ts'
import {ConversationService,type StoredConversation} from '../../../backend/src/work/conversations.ts'

const source=readFileSync(new URL('../src/client/index.ts',import.meta.url),'utf8'),ast=ts.createSourceFile('index.ts',source,ts.ScriptTarget.Latest,true)
const owner='local:owner',draftKey='teloa.home-native-session/v1',uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i

/** 执行真实注册代码里的表达式，服务端使用真实会话校验和领养逻辑。 */
function wired<T>(find:(node:ts.Node)=>ts.Expression|undefined,ports:Record<string,unknown>,prelude=''):T{
 let found:ts.Expression|undefined
 const visit=(node:ts.Node)=>{found??=find(node);if(!found)ts.forEachChild(node,visit)}
 visit(ast);assert.ok(found)
 const js=ts.transpileModule(prelude+'const wired='+found.getText(ast)+';return wired',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
 const input={...ports,homeNativeAdoptionRequestId:(homeNative as any).homeNativeAdoptionRequestId}
 return new Function(...Object.keys(input),js)(...Object.values(input)) as T
}
const homePort=(name:'create'|'adopt',ports:Record<string,unknown>)=>wired<(id:string)=>Promise<any>>(node=>{
 if(!ts.isNewExpression(node)||node.expression.getText(ast)!=='HomeNativeController')return
 const options=node.arguments?.[0]
 if(options&&ts.isObjectLiteralExpression(options))for(const property of options.properties)if(ts.isPropertyAssignment(property)&&property.name.getText(ast)===name)return property.initializer
},ports)
const prepareHomeSession=(ports:Record<string,unknown>)=>wired<(signal:AbortSignal)=>Promise<string|undefined>>(node=>ts.isVariableDeclaration(node)&&node.name.getText(ast)==='prepareHomeSession'?node.initializer:undefined,ports,'let initialSessionPrepared=false;')
const searchScope=(ports:Record<string,unknown>)=>wired<()=>readonly string[]>(node=>ts.isNewExpression(node)&&node.expression.getText(ast)==='ConversationSearch'?node.arguments?.[1]:undefined,ports)

function fixture(sessionId:string,failure?:'lost'|'unavailable'){
 const saved=new Map<string,string>(),storage={getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>{saved.set(key,value)},removeItem:(key:string)=>{saved.delete(key)}}
 let rows:StoredConversation[]=[],counter=0
 const created:string[]=[],requests:any[]=[]
 const service=new ConversationService({read:async()=>rows,write:async value=>{rows=value}}, {create:async id=>{created.push(id);return id},inspect:async id=>{assert.equal(id,sessionId)}},{id:()=>`binding-${++counter}`,now:()=> '2026-10-07T12:00:00.000Z'})
 const sessions={list:{getSnapshot:()=>({byId:{[sessionId]:{title:'原来的工作'}}})},create:async({sessionId:id}:any)=>{created.push(id);return id}}
 const work=new BindingClient({list:async()=>service.list(owner,{})} as any)
 const ports={requireWorkContext:()=>({sessions}),brandString:(value:string)=>value,mainSession:{getSnapshot:()=>sessionId},management:{getSnapshot:()=>({workspaces:[]})},navigationStorage:storage,isConversation:(value:any)=>value?.sessionId===sessionId,work,call:async(endpoint:string,input:any)=>{
  assert.equal(endpoint,'conversations/adopt');requests.push(input)
  if(failure==='unavailable'){failure=undefined;throw Error('host unavailable')}
  const value=await service.adopt(owner,input)
  if(failure==='lost'){failure=undefined;throw Error('network response lost')}
  return value
 }}
 return {storage,ports,service,work,created,requests,rows:()=>rows}
}

/** 一次页面生命周期的首页入口；未注册初始提供方即社区版自身组合。 */
function homeEntry(f:ReturnType<typeof fixture>,sessionId:string,provider?:InitialNativeSessionProvider){
 const binding={sessionId},sessions={binding:()=>binding,using:async(_id:string,_options:unknown,operation:any)=>operation({ready:Promise.resolve(),binding})}
 const lifetime=new AbortController(),unexpected=()=>{throw Error('不应另建待用会话')}
 const initialSession=createInitialNativeSessionCoordinator(async()=>({current:{getSnapshot:()=>sessionId as any,subscribe:()=>()=>{}},sessions:()=>sessions as any,isBlank:async()=>true}),lifetime.signal)
 if(provider)initialSession.register(provider)
 const homeSession=new homeNative.HomeNativeController({storage:f.storage,identity:unexpected,isBlank:()=>true,create:homePort('create',f.ports),adopt:homePort('adopt',f.ports)})
 const enter=prepareHomeSession({initialSessionLifetime:lifetime,initialSession,homeSession,requireWorkContext:unexpected,requireActions:unexpected,brandString:(value:string)=>value})
 return {homeSession,enter:()=>enter(new AbortController().signal)}
}

test('设置返回冷恢复官方 session- 会话：恢复原会话，不创建会话或要求选择目录',async()=>{
 const id='session-12345678-1234-4234-8234-123456789012',f=fixture(id)
 f.storage.setItem(draftKey,id)
 const controller=new homeNative.HomeNativeController({storage:f.storage,identity:()=>{throw Error('不应换新草稿')},isBlank:()=>true,create:homePort('create',f.ports),adopt:homePort('adopt',f.ports)})
 assert.equal(await controller.prepare(),id)
 assert.equal(controller.owns(id),true);assert.deepEqual(f.created,[])
 assert.equal(f.rows().length,1);assert.match(f.requests[0].requestId,uuid)
})

test('冷恢复领养回包丢失：重试复用同一请求和原会话，不重建或重发任务',async()=>{
 const id='session-22345678-1234-4234-8234-123456789012',f=fixture(id,'lost')
 f.storage.setItem(draftKey,id)
 const controller=()=>new homeNative.HomeNativeController({storage:f.storage,identity:()=>{throw Error('不应换新草稿')},isBlank:()=>true,create:homePort('create',f.ports),adopt:homePort('adopt',f.ports)})
 await assert.rejects(controller().prepare(),/network response lost/)
 assert.equal(f.storage.getItem(draftKey),id)
 assert.equal(await controller().prepare(),id)
 assert.equal(f.requests.length,2);assert.equal(f.requests[0].requestId,f.requests[1].requestId)
 assert.equal(f.rows().length,1);assert.deepEqual(f.created,[])
})

test('旧版 UUID 待用会话保留原请求身份，冷恢复不改写已发放绑定',async()=>{
 const id='32345678-1234-4234-8234-123456789012',f=fixture(id)
 assert.equal(await homePort('create',f.ports)(id),id);assert.equal(f.requests.length,0)
 await homePort('adopt',f.ports)(id)
 assert.equal(f.requests[0].requestId,id);assert.equal(f.rows().length,1);assert.deepEqual(f.created,[])
})

test('社区版无初始提供方：首页认领 DSH 初始空白会话即以已持久化的请求编号领养，绑定同步行原地升级',async()=>{
 const id='session-42345678-1234-4234-8234-123456789012',f=fixture(id)
 const synced=await f.service.ensure(owner,{sessionId:id})
 assert.deepEqual(await f.service.list(owner,{}),[])
 const home=homeEntry(f,id)
 assert.equal(await home.enter(),id);assert.equal(home.homeSession.owns(id),true)
 const requestId=f.storage.getItem('teloa.home-native-adoption/'+id)
 assert.match(requestId??'',uuid);assert.deepEqual(f.requests.map(row=>row.requestId),[requestId])
 const listed=await f.service.list(owner,{})
 assert.deepEqual(listed.map(row=>[row.id,row.createdAt,row.requestId]),[[synced.id,synced.createdAt,requestId]])
 assert.equal((await f.service.ensure(owner,{sessionId:id})).id,synced.id)
 assert.equal(f.rows().length,1);assert.deepEqual(f.created,[])
})

test('领养后的首页会话发消息前仍按空白隐藏，发出首条消息后出现在对话目录与搜索中',async()=>{
 const id='session-52345678-1234-4234-8234-123456789012',f=fixture(id)
 assert.equal(await homeEntry(f,id).enter(),id)
 const rows=f.work.getDirectorySnapshot().rows
 assert.deepEqual(rows.map(row=>row.sessionId),[id])
 const native=(blank:boolean)=>[{id,title:'第一段工作',running:false,blank,updatedAt:Date.parse('2026-10-08T00:00:00Z')}]
 assert.equal(presentConversations(rows,native(true))[0]?.status,'blank')
 assert.equal(presentConversations(rows,native(false))[0]?.status,'idle')
 const search=new ConversationSearch(async()=>({items:[{sessionId:id,snippet:'第一段工作'},{sessionId:'session-not-adopted',snippet:'未接入'}],hasMore:false}),searchScope({work:f.work}))
 await search.run('第一段')
 assert.deepEqual(search.getSnapshot().items.map(item=>item.sessionId),[id])
})

test('刷新后重复认领同一空白会话只调用幂等领养，复用同一请求且不产生重复行',async()=>{
 const id='session-62345678-1234-4234-8234-123456789012',f=fixture(id)
 assert.equal(await homeEntry(f,id).enter(),id)
 const [first]=f.rows()
 assert.equal(await homeEntry(f,id).enter(),id)
 await f.service.ensure(owner,{sessionId:id})
 assert.equal(f.requests.length,2);assert.equal(f.requests[0].requestId,f.requests[1].requestId)
 assert.deepEqual(f.rows(),[first])
})

test('领养失败时首页不开放该会话，下一次进入首页以同一请求重试且只产生一行',async()=>{
 for(const [failure,id] of [['lost','session-72345671-1234-4234-8234-123456789012'],['unavailable','session-72345672-1234-4234-8234-123456789012']] as const){
  const f=fixture(id,failure),home=homeEntry(f,id)
  await assert.rejects(home.enter(),failure==='lost'?/network response lost/:/host unavailable/)
  assert.equal(home.homeSession.owns(id),false);assert.equal(f.storage.getItem(draftKey),null)
  assert.equal(await home.enter(),id);assert.equal(home.homeSession.owns(id),true)
  assert.equal(f.requests.length,2);assert.equal(f.requests[0].requestId,f.requests[1].requestId)
  assert.equal(f.rows().length,1);assert.equal(f.rows()[0]?.requestId,f.requests[0].requestId)
 }
})

test('显式初始提供方的原稿已领养时，认领仍走同一幂等领养，不改写原领养',async()=>{
 const id='session-82345678-1234-4234-8234-123456789012',f=fixture(id),draftRequest='92345678-1234-4234-8234-123456789012'
 const home=homeEntry(f,id,async request=>{const proof=await request.waitForCurrent();await f.service.adopt(owner,{sessionId:proof.sessionId,requestId:draftRequest,title:'已有原稿'});return proof.sessionId})
 assert.equal(await home.enter(),id);assert.equal(home.homeSession.owns(id),true)
 assert.equal(f.requests.length,1);assert.equal(f.rows().length,1);assert.equal(f.rows()[0]?.requestId,draftRequest)
})
