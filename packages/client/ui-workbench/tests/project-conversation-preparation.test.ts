import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {BindingClient} from '../src/client/binding-client.ts'
import {createProjectRuntimeApi} from '../src/client/project-runtime-api.ts'
import {createHomeContextApi} from '../src/client/home-native-controller.ts'
import {PromptPreparation} from '../src/client/prompt-preparation.ts'

const module=await import('../src/client/project-conversation-preparation.ts')
test('项目和业务绑定全部确认前不开放新会话，未知绑定重试同一预约并保留旧输入',async()=>{
 assert.equal(typeof module.prepareProjectConversation,'function')
 const projectId=randomUUID(),calls:any[]=[],storage=new Map<string,string>(),journal={read:()=>storage.get('runtime')??null,write:(value:string)=>storage.set('runtime',value),clear:()=>storage.delete('runtime')}
 let lost=true,context:any=null,membership:any=null,current='old-session'
 const runtime=createProjectRuntimeApi(async(endpoint,input:any)=>{
  calls.push([endpoint,input]);if(endpoint.endsWith('/members'))return {rows:membership?[membership]:[]}
  if(endpoint.endsWith('/bind')){membership={sessionId:input.sessionId,projectId,version:1,memoryMode:'off',generation:1,title:'项目会话'};if(lost){lost=false;throw Error('lost receipt')}return membership}
  throw Error(endpoint)
 },journal)
 const home=createHomeContextApi(async(endpoint,input:any)=>{calls.push([endpoint,input]);if(endpoint==='work-context/read')return context;if(endpoint==='work-context/set')return context={sessionId:input.sessionId,scopeId:input.scopeId,roleId:null,version:1,locked:false};throw Error(endpoint)},{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)})
 const creation=runtime.reserveCreation(projectId,'项目会话','off'),conversation:any={id:randomUUID(),ownerId:'owner',title:'项目会话',scopeIds:['general'],version:1,status:'ready',sessionId:'new-session',requestedSessionId:'new-session',requestId:creation.requestId,createdAt:'2026-10-13T00:00:00Z'}
 const work=new BindingClient({current:()=>current,open:id=>{current=id},create:async()=>conversation,adopt:async id=>id,list:async()=>[],read:async()=>conversation,ensure:async()=>conversation,isNativeChild:()=>false,block:()=>{},catalog:async()=>({}) as any})
 const api:any={runtime,get:async()=>({project:{id:projectId,scope:'SOC',state:'running'}})},beforeOpen=()=>module.prepareProjectConversation!({api,home,creation,sessionId:conversation.sessionId,scope:'SOC'})
 await assert.rejects(work.create({requestId:creation.requestId,title:creation.title,beforeOpen}))
 assert.equal(current,'old-session','绑定回执丢失时原生输入仍留在旧会话');assert.ok(runtime.creation(projectId));assert.ok(runtime.pending(projectId))
 await work.create({requestId:creation.requestId,title:creation.title,beforeOpen})
 assert.equal(current,'new-session');assert.equal(context.scopeId,'SOC');assert.equal(membership.memoryMode,'off')
 const bindCalls=calls.filter(row=>row[0]==='project-runtime/bind');assert.equal(bindCalls.length,2);assert.equal(bindCalls[0][1].requestId,bindCalls[1][1].requestId)
 assert.ok(calls.findIndex(row=>row[0]==='work-context/set')<calls.findIndex(row=>row[0]==='project-runtime/bind'))
})


test('自然语言预约按原UUID保存完整Markdown与项目版本，刷新和未知回执不能改投说明',()=>{
 const projectId=randomUUID(),storage=new Map<string,string>(),journal={read:()=>storage.get('runtime')??null,write:(value:string)=>storage.set('runtime',value),clear:()=>storage.delete('runtime')}
 const body='# 核对发布\n\n- 保留 **原文** 与结尾换行\n',work={text:body,projectVersion:3,scope:'SOC'}
 const runtime=createProjectRuntimeApi(async()=>{throw Error('本例不得派发')},journal)
 const created=runtime.reserveCreation(projectId,'核对发布','off',work)
 assert.deepEqual(created.preparation,work)
 const restored=createProjectRuntimeApi(async()=>{throw Error('本例不得派发')},journal)
 assert.deepEqual(restored.creation(projectId),created)
 assert.equal(restored.reserveCreation(projectId,'核对发布','off',work).requestId,created.requestId)
 for(const drift of [{...work,text:body+'变更'},{...work,projectVersion:4},{...work,scope:'other'}])assert.throws(()=>restored.reserveCreation(projectId,'核对发布','off',drift))
 assert.deepEqual(restored.creation(projectId),created)
})

test('完整Markdown在固定项目绑定后只进入原会话准备，恢复同意图不重复或覆盖现有草稿',async()=>{
 const projectId=randomUUID(),sessionId='project-native',text='  # 本轮核对\n\n- 保留 **完整 Markdown**\n\n结尾。\n',calls:string[]=[]
 let current='old-session',membership:any=null
 const runtime=createProjectRuntimeApi(async(endpoint,input:any)=>{calls.push(endpoint);if(endpoint==='project-runtime/members')return {rows:membership?[membership]:[]};if(endpoint==='project-runtime/bind')return membership={sessionId,projectId,version:1,memoryMode:input.memoryMode,generation:1,title:'本轮核对'};throw Error(endpoint)})
 const creation=runtime.reserveCreation(projectId,'本轮核对','off',{text,projectVersion:3,scope:'general'})
 const api:any={runtime,get:async()=>({project:{id:projectId,scope:'general',state:'running',version:3}})}
 const home:any={read:async()=>{calls.push('context/read');return null},set:async()=>{calls.push('context/set')}}
 const conversation:any={id:randomUUID(),ownerId:'owner',title:creation.title,scopeIds:['general'],version:1,status:'ready',sessionId,requestedSessionId:sessionId,requestId:creation.requestId,createdAt:'2026-10-17T00:00:00Z'}
 const work=new BindingClient({current:()=>current,open:id=>{calls.push('native/open');current=id},create:async()=>conversation,adopt:async id=>id,list:async()=>[],read:async()=>conversation,ensure:async()=>conversation,isNativeChild:()=>false,block:()=>{},catalog:async()=>({}) as any})
 await work.create({requestId:creation.requestId,title:creation.title,beforeOpen:()=>module.prepareProjectConversation({api,home,creation,sessionId,scope:'general'})})
 assert.equal(current,sessionId);assert.ok(calls.indexOf('project-runtime/bind')<calls.indexOf('native/open'))
 assert.deepEqual(runtime.creation(projectId)?.preparation,{text,projectVersion:3,scope:'general'},'准备原文之前预约不能清除')
 const preparation=new PromptPreparation(),args={api,preparation,creation,sessionId,scope:'general',scopeNames:{general:'通用工作'}}
 assert.equal(await module.offerProjectConversationWork(args),true)
 const [prepared]=preparation.getSnapshot();assert.ok(prepared)
 assert.deepEqual({sourceId:prepared.sourceId,sourceVersion:prepared.sourceVersion,sessionId:prepared.sessionId,text:prepared.text,status:prepared.status},{sourceId:'project:'+projectId,sourceVersion:3,sessionId,text:text.trim(),status:'pending'})
 let writes=0
 assert.throws(()=>preparation.insert(prepared.id,sessionId,{draft:'原生原草稿',attachmentIds:[],phase:'plain'} as any,false,{setDraft:()=>{writes++}}))
 assert.equal(writes,0,'不能覆盖原生已有草稿，更不能自动发送')
 preparation.dismiss(prepared.id)
 await module.offerProjectConversationWork(args)
 assert.equal(preparation.getSnapshot().length,1);assert.equal(preparation.getSnapshot()[0]?.status,'dismissed','恢复不复活本人已处理的准备')
 await assert.rejects(module.offerProjectConversationWork({...args,sessionId:'other-session'}))
 runtime.completeCreation(projectId,creation.requestId);assert.equal(runtime.creation(projectId),undefined)
})

test('项目版本或范围变更必须重新核对，离开后的读取不继续写绑定或准备原文',async()=>{
 const projectId=randomUUID(),runtime=createProjectRuntimeApi(async()=>{throw Error('不得写入')})
 const creation=runtime.reserveCreation(projectId,'核对','off',{text:'核对\n\n原文。',projectVersion:2,scope:'general'})
 let writes=0
 const home:any={read:async()=>null,set:async()=>{writes++}}
 for(const project of [{id:projectId,version:3,scope:'general',state:'running'},{id:projectId,version:2,scope:'SOC',state:'running'},{id:projectId,version:2,scope:'general',state:'archived'}]){
  await assert.rejects(module.prepareProjectConversation({api:{runtime,get:async()=>({project})} as any,home,creation,sessionId:'session',scope:'general'}))
 }
 assert.equal(writes,0)
 let current=true,release!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve}),api:any={runtime,get:async()=>({project:{id:projectId,version:2,scope:'general',state:'running'}})}
 const pending=module.prepareProjectConversation({api,home:{read:async()=>{await gate;return null},set:async()=>{writes++}} as any,creation,sessionId:'session',scope:'general',mayContinue:()=>current})
 await Promise.resolve();current=false;release();await assert.rejects(pending);assert.equal(writes,0)
 const preparation=new PromptPreparation();current=true
 const offered=module.offerProjectConversationWork({api:{get:async()=>{await gate;current=false;return await api.get()}} as any,preparation,creation,sessionId:'session',scope:'general',scopeNames:{general:'通用工作'},mayContinue:()=>current})
 assert.equal(await offered,false);assert.deepEqual(preparation.getSnapshot(),[]);assert.equal(runtime.creation(projectId)?.requestId,creation.requestId)
})
