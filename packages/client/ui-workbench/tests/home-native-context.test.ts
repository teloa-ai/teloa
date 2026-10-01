import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync} from 'node:fs'
import ts from 'typescript'
import {createHomeContextApi} from '../src/client/home-native-controller.ts'
import {homeNativeCopy} from '../src/client/home-native-copy.ts'

type Node={type:unknown;props:any;children:any[]}
const nodes=(node:any):Node[]=>node&&typeof node==='object'&&'props'in node?[node,...node.children.flatMap(nodes)]:[]
const text=(node:any):string=>typeof node==='string'?node:node?.children?.map(text).join('')??''
const tick=()=>new Promise(resolve=>setImmediate(resolve))
function mount(props:any){
 const source=readFileSync(new URL('../src/client/HomeComposerContext.tsx',import.meta.url),'utf8')
 const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
 const states:any[]=[],effects:(()=>void)[]=[];let cursor=0
 const react={
  createElement:(type:unknown,props:any,...children:any[])=>({type,props:props??{},children:children.flat(Infinity)}),
  useState:(initial:any)=>{const id=cursor++;if(!(id in states))states[id]=initial;return [states[id],(next:any)=>{states[id]=typeof next==='function'?next(states[id]):next}]},
  useSyncExternalStore:(_:any,get:any)=>get(),
  useRef:(value:any)=>{const id=cursor++;return states[id]??(states[id]={current:value})},
  useEffect:(effect:()=>void,deps:any[])=>{const id=cursor++;if(!states[id]||deps.some((item,index)=>item!==states[id][index])){states[id]=deps;effects.push(effect)}},
 }
 const modules:any={'react':react,'./home-native-copy.js':{homeNativeCopy},'./business-scope-context.js':{useBusinessScopes:()=>({general:'通用工作',SOC:'安全运营',AppSec:'应用安全'})},'./i18n/provider.js':{useI18n:()=>({locale:'zh-CN'})},'./i18n/errors.js':{localizeWorkError:(_:unknown,value:Error)=>value.message}}
 const exports:any={};new Function('require','exports','React',js)((id:string)=>modules[id]??{default:{}},exports,react)
 return ()=>{cursor=0;const view=exports.HomeComposerContext(props);for(const effect of effects.splice(0))effect();return view}
}
const storage=()=>{const rows=new Map<string,string>();return {getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value)},removeItem:(key:string)=>{rows.delete(key)}}}
function props(api:any,blocks:any[]){return {sessionId:'s',api,work:{subscribe:()=>()=>{},getSnapshot:()=>({sessionId:'s',status:'ready',conversation:{}})},isNativeChild:()=>false,isAssistantContext:async()=>true,roles:async()=>[{id:'r',name:'同事',scopes:['SOC'],version:1}],block:(...args:any[])=>blocks.push(args),useSession:(select:any)=>select({blank:true,promptAttempted:false,pendingSubmissions:[]}),useInput:(select:any)=>select({attachmentIds:[]})}}

test('业务工具栏在未知设置未回读时继续阻塞，按钮复用原请求后才解除',async()=>{
 const calls:any[]=[],blocks:any[]=[];let failures=1
 const api=createHomeContextApi(async(endpoint,payload:any)=>{calls.push([endpoint,payload]);if(endpoint.endsWith('/read'))return null;if(failures-->0)throw Error('lost');return {...payload,version:1,locked:false}},storage(),()=> 'request-1')
 await assert.rejects(api.set({sessionId:'s',scopeId:'SOC',roleId:null,expectedVersion:0}))
 const render=mount(props(api,blocks));render();await tick()
 const view=render()
 assert.equal(nodes(view).filter(node=>node.type==='select').every(node=>node.props.disabled),true)
 assert.equal(blocks.at(-1)[1],'业务上下文尚未核对，请重试后发送。')
 nodes(view).find(node=>node.type==='button'&&text(node)==='重试')!.props.onClick();await tick();render()
 assert.equal(blocks.at(-1)[1],undefined)
 assert.equal(calls.filter(([endpoint])=>endpoint.endsWith('/set'))[1][1].requestId,'request-1')
})

test('业务工具栏保留已有指定同事限制，但不提供常驻接手选择',async()=>{
 const api=createHomeContextApi(async()=>({sessionId:'s',scopeId:'SOC',roleId:'r',version:1,locked:false}),storage())
 const render=mount(props(api,[]));render();await tick();const view=render()
 const business=nodes(view).find(node=>node.type==='select'&&node.props['aria-label']==='业务')!
 assert.deepEqual(nodes(business).filter(node=>node.type==='option').map(node=>node.props.value),['general','SOC'])
 assert.equal(nodes(view).filter(node=>node.type==='select').length,1)
 assert.match(text(view),/指定员工 · 同事/)
 assert.doesNotMatch(text(view),/接手偏好/)
})

test('已发送会话的业务显示为固定上下文而非失效下拉框',async()=>{
 const api=createHomeContextApi(async()=>({sessionId:'s',scopeId:'SOC',roleId:null,version:1,locked:true}),storage())
 const render=mount(props(api,[]));render();await tick();const view=render()
 assert.equal(nodes(view).filter(node=>node.type==='select').length,0)
 assert.equal(text(nodes(view).find(node=>node.props['aria-label']==='业务')),'安全运营')
})


test('主助手上下文等绑定就绪再读，岗位/任务对象与原生子会话不调用主助手接口',async()=>{
 let reads=0,bound=false
 const api=createHomeContextApi(async()=>{reads++;return null},storage())
 const setup=props(api,[]);setup.work.getSnapshot=()=>({sessionId:'s',status:bound?'ready':'loading',conversation:{}})
 const render=mount(setup);render();await tick();assert.equal(reads,0)
 bound=true;render();await tick();render();assert.equal(reads,1)
 for(const override of [{isNativeChild:()=>true},{isAssistantContext:async()=>false},{work:{subscribe:()=>()=>{},getSnapshot:()=>({sessionId:'s',status:'ready',conversation:{purpose:'task-run'}})}}]){
  const before:number=reads;const renderExcluded=mount({...props(api,[]),...override});renderExcluded();await tick();assert.equal(renderExcluded(),null);assert.equal(reads,before)
 }
})
