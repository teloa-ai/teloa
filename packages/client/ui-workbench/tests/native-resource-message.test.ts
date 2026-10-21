import test from 'node:test'
import assert from 'node:assert/strict'
import type {ISessions,SessionEventLikeEntry} from '@deepseek-ai/dsh-api-session-controller/client'
import {encodeResourceReference,type ResourceHistoryPage} from '@teloa/contract'
import {createNativeResourceMessageApi} from '../src/client/native-resource-message.ts'

const id='original-session',messageId='original-message',at='2026-10-21T01:00:00.000Z',ref={id:'11111111-1111-4111-a111-111111111111',version:2}
const text='核对原资料\n'+encodeResourceReference(ref)
const event={type:'user/message',seq:12,time:Date.parse(at),data:{id:messageId,source:{kind:'user',rpcId:'original-request'},content:[{type:'text',text}]}}
const pointer={seq:12,messageId,turn:1,at,references:[ref]}
function fixture(options:{missing?:boolean;wrongMessage?:boolean;wrongSession?:boolean;changedReference?:boolean}={}){
 let entries:readonly SessionEventLikeEntry[]=[]
 const feed={getSnapshot:()=>({entries}),replace:(next:readonly SessionEventLikeEntry[],_hasMore:boolean)=>{entries=next}},calls:string[]=[];let released=0
 const binding={sessionId:options.wrongSession?'another-session':id,eventSource:feed,session:{sessionId:id,loadThrough:async(seq:number)=>{calls.push('loadThrough:'+seq);feed.replace([{type:'event',event:{...event,data:{...event.data,...(options.wrongMessage?{id:'other-message'}:{}),...(options.changedReference?{content:[{type:'text',text:'changed '+encodeResourceReference({...ref,version:3})}]}:{})}}} as never],false)}}}
 const owner={refresh:async()=>{calls.push('refresh')},list:{getSnapshot:()=>({byId:{[id]:{origin:'user'}}})},subagentAddress:()=>undefined,binding:()=>binding,using:async(target:string,_options:unknown,operation:(reference:unknown)=>Promise<unknown>)=>{calls.push('retain:'+target);try{return await operation({sessionId:id,ready:Promise.resolve(binding)})}finally{released++;calls.push('release')}}} as unknown as ISessions
 let active=owner
 const history=async(sessionId:string,beforeSeq:number|undefined):Promise<ResourceHistoryPage>=>{calls.push('history:'+sessionId+':'+beforeSeq);return {sessionId,items:options.missing?[]:beforeSeq===undefined?[{...pointer,seq:20,messageId:'newer-message'}]:[pointer],nextBeforeSeq:options.missing||beforeSeq!==undefined?null:20}}
 return {api:createNativeResourceMessageApi(()=>active,history),owner,feed,calls,released:()=>released,replaceConnection:()=>{active={} as ISessions}}
}

test('公开本人history指针→原生保留→精确消息与固定refs→释放，不选会话或执行',async()=>{
 const f=fixture(),value=await f.api.read({id,messageId},new AbortController().signal)
 assert.deepEqual(value,{sessionId:id,messageId,seq:12,at,text,references:[ref]})
 assert.deepEqual(f.calls,['refresh','history:original-session:undefined','history:original-session:20','retain:original-session','loadThrough:12','release']);assert.equal(f.released(),1)
})

test('无自有history指针时不以继承同messageId冒充，错误不当空态',async()=>{
 const f=fixture({missing:true});f.feed.replace([{type:'event',event} as never],false)
 await assert.rejects(f.api.read({id,messageId},new AbortController().signal),{code:'teloa/source-unavailable'})
 assert.equal(f.released(),0);assert.ok(!f.calls.some(call=>call.startsWith('retain:')))
})

test('原生目标、消息或固定引用不匹配均拒绝，所有已取得引用均释放',async()=>{
 for(const options of [{wrongMessage:true},{wrongSession:true},{changedReference:true}]){
  const f=fixture(options);await assert.rejects(f.api.read({id,messageId},new AbortController().signal),{code:'teloa/source-unavailable'});assert.equal(f.released(),1)
 }
})

test('连接切换或关闭后迟到的history结果不被采纳',async()=>{
 let resolve!:(page:ResourceHistoryPage)=>void
 const f=fixture(),pending=new Promise<ResourceHistoryPage>(done=>{resolve=done}),controller=new AbortController()
 let active=f.owner
 const api=createNativeResourceMessageApi(()=>active,()=>pending),reading=api.read({id,messageId},controller.signal)
 await Promise.resolve();await Promise.resolve();active={} as ISessions
 resolve({sessionId:id,items:[pointer],nextBeforeSeq:null})
 await assert.rejects(reading,{code:'teloa/source-unavailable'});assert.equal(f.released(),0)
 const g=fixture(),aborted=new AbortController();aborted.abort();await assert.rejects(g.api.read({id,messageId},aborted.signal),{name:'AbortError'});assert.deepEqual(g.calls,[])
})
