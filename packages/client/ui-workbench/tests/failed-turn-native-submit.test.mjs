import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {dirname,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import {webcrypto} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {latestRetryableRequest} from '../src/client/failed-turn-continuation.ts'
const require=createRequire(import.meta.url),root=dirname(require.resolve('@deepseek-ai/dsh-api-session-controller/package.json'))
// 真实固定SDK对象层；唯一替身为无网络Remote传输，不等于宿主/模型实测。
const {Session}=await import(pathToFileURL(join(root,'lib/types/client/sessions/session.js')).href)
test('固定SDK正常beginSubmission/prompt生成全新requestId且原文与queue不变，未重用旧RPC',async()=>{
 const calls=[],sid='11111111-1111-4111-8111-111111111111',oldRpc='22222222-2222-4222-8222-222222222222',text=' 原问题\n原文 '
 const session=new Session(sid,{session:{prompt:async(request)=>{calls.push(request);return {ok:true,value:{accepted:true}}}}})
 const submission=session.beginSubmission({text,attachments:[],mode:'queue'})
 assert.notEqual(submission.requestId,oldRpc)
 const result=await session.prompt([{type:'text',text}],'queue',undefined,submission.requestId)
 assert.equal(result.ok,true);assert.equal(calls.length,1);assert.equal(calls[0].sessionId,sid);assert.equal(calls[0].requestId,submission.requestId);assert.deepEqual(calls[0].content,[{type:'text',text}]);assert.equal(calls[0].mode,'queue')
})
const source=readFileSync(new URL('../src/client/index.ts',import.meta.url),'utf8'),start=source.indexOf('},send:text=>{',source.indexOf('const continuation=binding&&input?')),end=source.indexOf('\n        },\n      }):undefined',start)
assert(start>=0&&end>start)
const submitActualIntegration=new Function('input','text',source.slice(start+'},send:text=>{'.length,end))
test('实际index点击接线仅空同scope输入准确setDraft后normal queue/click submit，原稿或claim拒绝',()=>{
 const text='精确原文\n内部空白  保留',submissions=[];let state={phase:'plain',draft:'',attachmentIds:[],occurrences:[]}
 const input={state:{getSnapshot:()=>state},setDraft(value){state={...state,draft:value}},submit(...args){submissions.push({args,text:state.draft})}}
 submitActualIntegration(input,text);assert.deepEqual(submissions,[{args:['queue','click'],text}])
 for(const patch of [{draft:'本人新稿'},{claim:{}},{phase:'sending'},{attachmentIds:['file']},{occurrences:[{}]}]){state={phase:'plain',draft:'',attachmentIds:[],occurrences:[],...patch};assert.throws(()=>submitActualIntegration(input,text));assert.equal(submissions.length,1)}
 state={phase:'plain',draft:'',attachmentIds:[],occurrences:[]};input.setDraft=()=>{};assert.throws(()=>submitActualIntegration(input,text));assert.equal(submissions.length,1)
})

// 只在测试VM额外暴露包私有构造器；原bundle中的InputShell、Lexical与SubmitMachine代码不改。
// 不渲染的UI primitives为空，其他依赖为实际安装值；末端sink仅记录文本，不调用宿主/模型。
async function nativeInputShell(defaultSink){
 const packageRoot=dirname(require.resolve('@deepseek-ai/dsh-client-ui-conversation/package.json')),pkg=JSON.parse(readFileSync(join(packageRoot,'package.json'),'utf8'))
 assert.equal(pkg.version,'0.2.1-rc.2')
 const deps={'@deepseek-ai/dsh-client-ui-primitives':{}}
 for(const name of ['@deepseek-ai/dsh-client-store','@deepseek-ai/dsh-client-ui-slots','@deepseek-ai/cordis'])deps[name]=await import(pathToFileURL(require.resolve(name)).href)
 for(const name of ['react/jsx-runtime','react','react-dom'])deps[name]=require(name)
 let zodPath
 try{zodPath=require.resolve('zod')}catch{
  // pnpm未把SDK开发依赖提升到应用根；按该固定SDK声明的精确版本复用已装依赖，不下载。
  const workspace=fileURLToPath(new URL('../../../../',import.meta.url)),version=pkg.devDependencies.zod
  assert.match(version,/^\d+\.\d+\.\d+$/)
  zodPath=join(workspace,'node_modules/.pnpm','zod@'+version,'node_modules/zod/index.js')
 }
 deps.zod=await import(pathToFileURL(zodPath).href)
 const published=readFileSync(join(packageRoot,'lib/client.js'),'utf8'),anchor='exports.Config = Config;'
 assert.equal(published.split(anchor).length,2)
 const code=published.replace(anchor,'exports.__testSessionInputShell = SessionInputShell;\n'+anchor)
 let loaded
 vm.runInNewContext(code,{window:{__ModuleLoader__:{load:descriptor=>{assert.equal(descriptor.id,'@deepseek-ai/dsh-client-ui-conversation');loaded=descriptor.factory(name=>{assert.ok(name in deps,'unexpected import '+name);return deps[name]})}}},console,setTimeout,clearTimeout,setInterval,clearInterval,queueMicrotask,AbortController,crypto:webcrypto,TextEncoder,TextDecoder,performance})
 return new loaded.__testSessionInputShell({actx:{},defaultSink,commandAttachments:{serialize:async()=>[],release:()=>{},unsupportedNotice:()=>''}})
}
async function sinkText(send){
 let done
 const completed=new Promise(resolve=>{done=resolve}),calls=[]
 const input=await nativeInputShell(async(text,attachments,mode)=>{calls.push({text,attachments:[...attachments],mode});done();return {kind:'success'}})
 try{send(input);await Promise.race([completed,new Promise((_,reject)=>setTimeout(()=>reject(Error('normal SessionInput sink not reached')),1000))]);return calls}finally{input.dispose()}
}
test('真实固定SessionInput.submit到默认sink保留可重提原文内部空白，实际index接线不绕过输入机',async()=>{
 const text='原问题\n中文引用  与内部空白保留',calls=await sinkText(input=>submitActualIntegration(input,text))
 assert.deepEqual(calls,[{text,attachments:[],mode:'queue'}])
})
test('真实默认sink会trim首尾，不能保真的历史原文不提供重试动作',async()=>{
 const text='  原问题\n中文引用  ',calls=await sinkText(input=>{input.setDraft(text);input.submit('queue','click')})
 assert.equal(calls[0].text,text.trim());assert.notEqual(calls[0].text,text)
 const event=(seq,type,data)=>({type:'event',event:{seq,time:seq,type,data}}),id='11111111-1111-4111-8111-111111111111',rpcId='22222222-2222-4222-8222-222222222222'
 const events=[event(0,'turn/start',{turn:1}),event(1,'step/start',{turn:1,step:1}),event(2,'user/message',{role:'user',id,source:{kind:'user',rpcId},content:[{type:'text',text}]}),event(3,'turn/end',{turn:1,reason:{kind:'error',error:{message:'synthetic'}}})]
 assert.equal(latestRetryableRequest(events),undefined)
})
