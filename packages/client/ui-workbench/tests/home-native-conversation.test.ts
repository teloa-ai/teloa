import {SlotCore} from '@deepseek-ai/dsh-client-ui-slots'
import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync} from 'node:fs'
import ts from 'typescript'
import {HomeNativeController} from '../src/client/home-native-controller.ts'

test('首页和会话常驻同一个官方 main 节点，外壳不重复声明官方头部',()=>{
 const source=readFileSync(new URL('../src/client/HomeNativeConversation.tsx',import.meta.url),'utf8')
 const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
 const react={createElement:(type:unknown,props:unknown,...children:unknown[])=>({type,props,children}),useEffect:()=>{},useSyncExternalStore:(_:unknown,get:()=>boolean)=>get()}
 const exports:any={};new Function('require','exports','React',js)((id:string)=>id==='react'?react:{default:new Proxy({},{get:(_,key)=>key})},exports,react)
 const native={type:'official-root',props:{},children:[]}
 for(const blank of [true,false]){
  const tree=exports.HomeNativeConversation({home:true,ready:true,overview:'overview',content:native,sessionId:'s',isHomeDraft:()=>true,accept:()=>{},acceptance:{subscribe:()=>()=>{},getSnapshot:()=>!blank},useSession:(select:any)=>select({blank,promptAttempted:!blank,openState:'open',pendingSubmissions:[]})})
  assert.equal(tree.children[1].children[0],native)
 }
 const frame=readFileSync(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8')
 assert.match(frame,/content:renderSlot\('main',\{\}, \{entryKey:'conversation'\}\)/)
 assert.doesNotMatch(source,/renderFactorySlot|renderSlot/)
})

test('首页不再拥有第二份文本框、发送处理或对话工作模式',()=>{
 const home=readFileSync(new URL('../src/client/WorkHome.tsx',import.meta.url),'utf8')
 assert.doesNotMatch(home,/<textarea|setGoal|HomeStartMode|modeSwitch|startPending/)
})


test('真实 DSH SlotCore 接受首页槽注册，官方头部声明仍只有原生拥有者',()=>{
 const core=new SlotCore(),register=core.register.bind(core) as (options:any,component:any)=>()=>void
 register({name:'root',children:{main:{kind:'keyed',scope:'root'},'teloa.conversation':{kind:'single',scope:'session-maybe'}}},()=>null)
 register({name:'main',key:'conversation',children:{'main.conversation':{kind:'single',scope:'session-maybe'}}},()=>null)
 register({name:'main.conversation',children:{'conversation.header':{kind:'single',scope:'session-maybe'}}},()=>null)
 const source=readFileSync(new URL('../src/client/index.ts',import.meta.url),'utf8'),ast=ts.createSourceFile('index.ts',source,ts.ScriptTarget.Latest,true)
 let options:ts.ObjectLiteralExpression|undefined
 const walk=(node:ts.Node)=>{if(ts.isCallExpression(node)&&node.expression.getText(ast)==='child.slots.register'&&node.arguments[0]&&ts.isObjectLiteralExpression(node.arguments[0])&&node.arguments[0].properties.some(prop=>ts.isPropertyAssignment(prop)&&prop.name.getText(ast)==='name'&&ts.isStringLiteral(prop.initializer)&&prop.initializer.text==='teloa.conversation'))options=node.arguments[0];ts.forEachChild(node,walk)}
 walk(ast);assert.ok(options)
 const compiled:any={};new Function('exports',ts.transpileModule('exports.options='+options!.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText)(compiled)
 assert.doesNotThrow(()=>register({...compiled.options,inject:undefined},()=>null))
})

test('空白会话激活和发送尝试均不离开首页，原生受理后才展开对话',()=>{
 const source=readFileSync(new URL('../src/client/HomeNativeConversation.tsx',import.meta.url),'utf8')
 const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
 const react={createElement:()=>null,useEffect:(effect:()=>void)=>effect(),useSyncExternalStore:(_:unknown,get:()=>boolean)=>get()},exports:any={}
 new Function('require','exports','React',js)((id:string)=>id==='react'?react:{default:{}},exports,react)
 const calls:string[]=[]
 for(const session of [{blank:true,promptAttempted:false,accepted:false},{blank:true,promptAttempted:true,accepted:false},{blank:false,promptAttempted:false,accepted:false},{blank:false,promptAttempted:true,accepted:true}])exports.HomeNativeConversation({home:true,ready:true,sessionId:'s',isHomeDraft:()=>true,accept:()=>{},acceptance:{subscribe:()=>()=>{},getSnapshot:()=>session.accepted},engaged:(id:string)=>calls.push(id),useSession:(select:any)=>select({...session,pendingSubmissions:[]})})
 assert.deepEqual(calls,['s'])
})

test('真实发送后返回首页，旧ready与回执不能抢在延迟准备前再次导航',async()=>{
 const source=readFileSync(new URL('../src/client/HomeNativeConversation.tsx',import.meta.url),'utf8')
 const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
 const effects:Array<()=>void>=[],react={createElement:(type:unknown,props:unknown,...children:unknown[])=>({type,props,children}),useEffect:(effect:()=>void)=>effects.push(effect),useSyncExternalStore:(_:unknown,get:()=>boolean)=>get()},exports:any={}
 new Function('require','exports','React',js)((id:string)=>id==='react'?react:{default:new Proxy({},{get:(_,key)=>key})},exports,react)
 const storage=new Map<string,string>();let ids=0,release:(()=>void)|undefined
 const controller=new HomeNativeController({storage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>{storage.set(key,value)},removeItem:key=>{storage.delete(key)}},identity:()=>`s-${++ids}`,isBlank:()=>true,create:async id=>{if(id==='s-2')await new Promise<void>(resolve=>{release=resolve});return id},adopt:async()=>{}})
 const navigation:string[]=[],render=(sessionId:string,accepted:boolean)=>exports.HomeNativeConversation({home:true,ready:true,sessionId,overview:'overview',content:'native',isHomeDraft:()=>controller.owns(sessionId),accept:()=>controller.accept(sessionId),acceptance:{subscribe:()=>()=>{},getSnapshot:()=>accepted},engaged:(id:string)=>navigation.push(id),useSession:(select:any)=>select({blank:!accepted,promptAttempted:accepted,pendingSubmissions:[]})})
 assert.equal(await controller.prepare(),'s-1')
 render('s-1',true);effects.splice(0).forEach(effect=>effect());assert.deepEqual(navigation,['s-1'])
 // 模拟子 effect 先于 Frame 的清理 effect：owner ready 与当前会话仍是旧值。
 const stale=render('s-1',true);effects.splice(0).forEach(effect=>effect())
 assert.deepEqual(navigation,['s-1']);assert.equal(stale.props['aria-busy'],true);assert.equal(stale.children[1].props.hidden,true)
 const preparing=controller.prepare();await Promise.resolve();await Promise.resolve()
 render('s-1',true);effects.splice(0).forEach(effect=>effect());assert.deepEqual(navigation,['s-1'])
 release!();assert.equal(await preparing,'s-2')
 const blank=render('s-2',false);effects.splice(0).forEach(effect=>effect())
 assert.equal(blank.props['aria-busy'],false);assert.equal(blank.children[2],'overview');assert.deepEqual(navigation,['s-1'])
})

test('待用会话从对话页发送也退役草稿身份，回首页不会把那次发送当成本页新提交',async()=>{
 const source=readFileSync(new URL('../src/client/HomeNativeConversation.tsx',import.meta.url),'utf8'),js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
 const react={createElement:()=>null,useEffect:(effect:()=>void)=>effect(),useSyncExternalStore:(_:unknown,get:()=>boolean)=>get()},exports:any={}
 new Function('require','exports','React',js)((id:string)=>id==='react'?react:{default:{}},exports,react)
 const storage=new Map<string,string>();let ids=0
 const controller=new HomeNativeController({storage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>{storage.set(key,value)},removeItem:key=>{storage.delete(key)}},identity:()=>`s-${++ids}`,isBlank:()=>true,create:async id=>id,adopt:async()=>{}}),navigation:string[]=[]
 const sessionId=await controller.prepare(),props={ready:true,sessionId,isHomeDraft:()=>controller.owns(sessionId),accept:()=>controller.accept(sessionId),acceptance:{subscribe:()=>()=>{},getSnapshot:()=>true},engaged:(id:string)=>navigation.push(id),useSession:(select:any)=>select({blank:false,promptAttempted:true,pendingSubmissions:[]})}
 exports.HomeNativeConversation({...props,home:false});assert.equal(controller.owns(sessionId),false)
 exports.HomeNativeConversation({...props,home:true});assert.deepEqual(navigation,[]);assert.equal(await controller.prepare(),'s-2')
})
