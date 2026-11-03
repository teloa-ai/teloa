import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,existsSync} from 'node:fs'
import {createRequire,registerHooks} from 'node:module'
import {pathToFileURL} from 'node:url'
import {createFailedTurnContinuation} from '../src/client/failed-turn-continuation.ts'
registerHooks({resolve(specifier,context,next){
 if(specifier.startsWith('.')&&specifier.endsWith('.js')&&context.parentURL?.includes('/ui-workbench/src/client/')){
  const source=new URL(specifier.slice(0,-3)+'.ts',context.parentURL);if(existsSync(source))return next(source.href,context)
 }
 return next(specifier,context)
}})
const require=createRequire(import.meta.url),React=require('react'),{renderToStaticMarkup}=require('react-dom/server'),ts=require('typescript')
const errors=await import('../src/client/i18n/errors.ts'),messages=await import('../src/client/i18n/messages.ts'),contract=await import('@teloa/contract')
const originalText='原问题\n中文与引用  原文保留',rpc='22222222-2222-4222-8222-222222222222',id='11111111-1111-4111-8111-111111111111'
const event=(seq,type,data)=>({type:'event',event:{seq,time:seq,type,data}})
const failed=()=>[event(0,'turn/start',{turn:1}),event(1,'step/start',{turn:1,step:1}),event(2,'user/message',{role:'user',id,source:{kind:'user',rpcId:rpc},content:[{type:'text',text:originalText}]}),event(3,'assistant/attempt',{turn:1,step:1,stream:[]}),event(4,'turn/end',{turn:1,reason:{kind:'error',error:{code:'NETWORK',message:'synthetic error'}}})]
function fixture(patch={}){
 const sent=[],entries=failed(),original=JSON.stringify(entries),facts={owner:'own-A',binding:{},current:true,ready:true,blocked:false,running:false,pending:false,unknown:false,editable:true,empty:true,entries,...patch}
 const port=createFailedTurnContinuation({read:()=>facts,subscribe:()=>()=>{},eligible:async()=>JSON.stringify(['own-A','same-SID','general',null,1]),send:(text,request)=>sent.push({text,request})})
 return {port,facts,sent,original}
}
function component(locale='en'){
 // 编译实际生产组件；React 与 SSR 真实，只有 i18n context/图标外壳是测试端口，不启动浏览器。
 const source=process.env.TELOA_RETRY_TEST_SOURCE?new URL(pathToFileURL(process.env.TELOA_RETRY_TEST_SOURCE)):new URL('../src/client/BudgetTurnErrorView.tsx',import.meta.url)
 const load=(file,modules)=>{const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText,exports={};new Function('require','exports','React',code)(name=>{assert(name in modules,'unexpected runtime dependency '+name);return modules[name]},exports,React);return exports}
 const copy=load(new URL('./draft-continuity-copy.ts',source),{})
 const modules={react:React,'@teloa/contract':contract,'./i18n/errors.js':errors,'./i18n/provider.js':{useI18n:()=>({locale,t:(key,params)=>messages.translateMessage(locale,key,params)})},'@deepseek-ai/dsh-client-ui-primitives':{StateDot:()=>React.createElement('span',{'aria-hidden':true})},'./BudgetTurnErrorView.module.css':{__esModule:true,default:new Proxy({},{get:(_,key)=>String(key)})},'./draft-continuity-copy.js':copy}
 return load(source,modules).BudgetTurnErrorView
}
const renderer=(entries=[],live=true)=>({subscribe:()=>()=>{},getSnapshot:()=>entries,isLive:entry=>live&&entries.includes(entry)})
const props=(f,entries=[],code='NETWORK',live=true)=>({renderer:renderer(entries,live),continuation:f.port,node:{data:{seq:4,turn:1,step:1,message:'PRIVATE_RAW_EXCEPTION_TOKEN',code}},t:()=>''})
const Native=({node})=>React.createElement('span',{'data-native-turn':true},'native '+node.data.code)
const entry=()=>({options:{key:'turn-error',priority:0},component:Native})
const render=(view,value)=>renderToStaticMarkup(React.createElement(view,value))

test('原生renderer缺失/卸载或不可借用时，真实错误和受安全gate保护的Retry仍可见',()=>{
 const view=component()
 for(const [entries,live]of [[[],true],[[entry()],false],[[{...entry(),inject:()=>({})}],true]]){
  const f=fixture(),html=render(view,props(f,entries,'NETWORK',live))
  assert.match(html,/role="status"/);assert.match(html,/This answer did not complete/);assert.match(html,/Retry answer/)
  assert.doesNotMatch(html,/PRIVATE_RAW_EXCEPTION_TOKEN/);assert.equal(f.sent.length,0,'渲染不自动发送')
 }
})
test('正常已加载的官方renderer继续拥有错误展示，不替换其props或错误语义',()=>{
 const view=component(),f=fixture(),html=render(view,props(f,[entry()]))
 assert.match(html,/data-native-turn="true"/);assert.match(html,/native NETWORK/);assert.match(html,/Retry answer/)
 assert.doesNotMatch(html,/This answer did not complete/);assert.equal(f.sent.length,0)
})
test('unknown、发送中、新草稿、切会话及缺owner仍不显示Retry，不被fallback绕过',()=>{
 const view=component()
 for(const patch of [{unknown:true},{pending:true},{empty:false},{current:false},{owner:null},{blocked:true},{running:true},{editable:false}]){
  const f=fixture(patch),html=render(view,props(f))
  assert.match(html,/This answer did not complete/);assert.doesNotMatch(html,/Retry answer/);assert.deepEqual(f.sent,[])
 }
})
test('额度错误保留具体原因和恢复下一步；未证实额度恢复不提供盲重试',()=>{
 for(const locale of ['zh-CN','zh-Hant','en'])for(const reason of ['tokens','rounds','concurrent','elapsed']){
  const f=fixture(),code='teloa/budget-exhausted/'+reason+'/owner',html=render(component(locale),props(f,[],code))
  assert.ok(html.includes(errors.localizeWorkError(locale,{code})));assert.doesNotMatch(html,/PRIVATE_RAW_EXCEPTION_TOKEN|Retry answer|重试回答|重試回答/);assert.deepEqual(f.sent,[])
 }
})
test('三语言fallback明确回答未完成，并保持真实的稳定错误说明而不泄露原异常',()=>{
 for(const [locale,label,retry]of [['zh-CN','本次回答未完成','重试回答'],['zh-Hant','本次回答未完成','重試回答'],['en','This answer did not complete','Retry answer']]){
  const f=fixture(),html=render(component(locale),props(f))
  assert.ok(html.includes(label));assert.ok(html.includes(retry));assert.ok(html.includes(errors.localizeWorkError(locale,{code:'NETWORK'})));assert.doesNotMatch(html,/PRIVATE_RAW_EXCEPTION_TOKEN/)
 }
})
test('显示后的显式动作仍复用实际continuation核对，仅一次精确原文提交；原失败不改',async()=>{
 const view=component(),f=fixture();assert.match(render(view,props(f)),/Retry answer/)
 await f.port.continue(4);assert.equal(f.sent.length,1);assert.equal(f.sent[0].text,originalText);assert.equal(f.sent[0].request.requestId,rpc)
 assert.equal(JSON.stringify(f.facts.entries),f.original);assert.doesNotMatch(render(view,props(f)),/Retry answer/)
 await assert.rejects(f.port.continue(4));assert.equal(f.sent.length,1)
})
