import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync} from 'node:fs'
import ts from 'typescript'
import {readHomeWorkStatus,changeHomeWorkStatus} from '../src/client/home-work-status.ts'

const tick=()=>new Promise(resolve=>setImmediate(resolve))
const nodes=(node:any):any[]=>node&&typeof node==='object'&&node.props?[node,...node.children.flatMap(nodes)]:[]
const text=(node:any):string=>typeof node==='string'?node:node?.children?.map(text).join('')??''
function component(file:string,name:string,props:any){
 const source=readFileSync(new URL('../src/client/'+file,import.meta.url),'utf8'),js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
 const states:any[]=[],effects:Array<{id:number;effect:()=>void|(()=>void)}>=[],cleanups:any[]=[],timers=new Map<number,{callback:()=>void;delay:number}>();let cursor=0,timerId=0
 const react={
  createElement:(type:unknown,props:any,...children:any[])=>({type,props:props??{},children:children.flat(Infinity)}),
  useState:(initial:any)=>{const id=cursor++;if(!(id in states))states[id]=initial;return [states[id],(next:any)=>{states[id]=typeof next==='function'?next(states[id]):next}]},
  useSyncExternalStore:(_:unknown,get:()=>unknown)=>get(),
  useRef:(initial:unknown)=>{const id=cursor++;return states[id]??(states[id]={current:initial})},
  useEffect:(effect:()=>void,deps:any[])=>{const id=cursor++;if(!states[id]||deps.some((value,index)=>value!==states[id][index])){states[id]=deps;effects.push({id,effect})}},
 }
 const modules:any={react,'./HomeWorkRequestCard.js':{HomeWorkStatusCard:'shared-status-card'},'./home-work-status.js':{readHomeWorkStatus,changeHomeWorkStatus},'./business-scope-context.js':{useBusinessScopes:()=>({SOC:'安全运营'})},'./i18n/provider.js':{useI18n:()=>({locale:'zh-CN'})},'./i18n/errors.js':{localizeWorkError:(_:unknown,error:Error)=>error.message}}
 const exports:any={};new Function('require','exports','React','setTimeout','clearTimeout',js)((id:string)=>modules[id]??{default:{}},exports,react,(callback:()=>void,delay:number)=>{timers.set(++timerId,{callback,delay});return timerId},(id:number)=>timers.delete(id))
 return {
  render:()=>{cursor=0;const view=exports[name](props);for(const {id,effect} of effects.splice(0)){cleanups[id]?.();cleanups[id]=effect()}return view},
  timer:(delay:number)=>{for(const [id,timer] of [...timers])if(timer.delay===delay){timers.delete(id);timer.callback()}},
  unmount:()=>{for(const cleanup of cleanups)cleanup?.()},
 }
}
const status=(sessionId='s',state='waiting')=>({sessionId,requestId:'r',title:'交办核查',scope:'SOC',stoppedAt:null,members:[{roleId:'a',name:'Alex',scope:'SOC',status:state,task:{id:'task',title:'实际任务'},...(state==='received'?{result:'核查已完成'}:{})}]})

test('常驻交办dock等绑定就绪，原生事件发现请求，等待轮询接回结果而不需展开工具步骤',async()=>{
 let ready=false,activity=()=>{};let result:any[]=[],calls:any[]=[]
 const props={sessionId:'s',work:{subscribe:()=>()=>{},getSnapshot:()=>({sessionId:'s',status:ready?'ready':'loading'})},call:async(endpoint:string,payload:any)=>{calls.push([endpoint,payload]);return result},isAssistantContext:async()=>true,openTask:()=>{},subscribeActivity:(listener:()=>void)=>{activity=listener;return()=>{}}}
 const instance=component('HomeWorkRequestsDock.tsx','HomeWorkRequestsDock',props)
 assert.equal(instance.render(),null);await tick();assert.equal(calls.length,0)
 ready=true;instance.render();await tick();assert.equal(instance.render(),null)
 result=[status()];activity();instance.timer(200);await tick()
 let view=instance.render(),card=nodes(view).find(node=>node.type==='shared-status-card')
 assert.equal(view.props['aria-label'],'本会话交办');assert.ok(card);assert.equal(card.props.managed,true);assert.equal(card.props.initial.requestId,'r');assert.equal(nodes(view).some(node=>node.type==='details'),false)
 result=[status('s','received')];instance.timer(10000);await tick();view=instance.render();card=nodes(view).find(node=>node.type==='shared-status-card')
 assert.equal(card.props.initial.members[0].result,'核查已完成')
 assert.ok(calls.every(([endpoint,payload])=>endpoint==='work-requests/list'&&payload.sessionId==='s'))
 instance.unmount()
})

test('切换会话立即移除旧交办，丢失的旧读取回包不能显示在新会话；错误保留入口可重读',async()=>{
 let selected='s',late:((value:unknown)=>void)|undefined,mode='first',activity=()=>{}
 const props={sessionId:'s',work:{subscribe:()=>()=>{},getSnapshot:()=>({sessionId:selected,status:'ready'})},call:async()=>{if(mode==='late')return new Promise(resolve=>{late=resolve});if(mode==='fail')throw Error('读取暂不可用');return [status(selected)]},isAssistantContext:async()=>true,openTask:()=>{},subscribeActivity:(listener:()=>void)=>{activity=listener;return()=>{}}}
 const instance=component('HomeWorkRequestsDock.tsx','HomeWorkRequestsDock',props)
 instance.render();await tick();assert.ok(instance.render())
 mode='late';activity();instance.timer(200);await tick()
 selected='other';props.sessionId='other';mode='first';assert.equal(instance.render(),null);await tick()
 late!([status()]);await tick();let view=instance.render()
 assert.ok(nodes(view).filter(node=>node.type==='shared-status-card').every(node=>node.props.initial.sessionId==='other'))
 mode='fail';activity();instance.timer(200);await tick();view=instance.render()
 assert.match(text(view),/读取暂不可用/);assert.ok(nodes(view).find(node=>node.type==='shared-status-card'))
 mode='first';nodes(view).find(node=>node.type==='button')!.props.onClick();instance.render();await tick();assert.doesNotMatch(text(instance.render()),/读取暂不可用/)
 instance.unmount()
})

test('交办dock等待可信身份核对，岗位/任务/受管运行/子会话不读主助手请求也不显示误报',async()=>{
 for(const reason of ['role','task','task-run','subagent']){
  let resolve!:(value:boolean)=>void,calls=0
  const props={sessionId:reason,work:{subscribe:()=>()=>{},getSnapshot:()=>({sessionId:reason,status:'ready'})},isAssistantContext:()=>new Promise<boolean>(done=>{resolve=done}),call:async()=>{calls++;throw Error('此会话不能改用本人主会话交办上下文')},openTask:()=>{},subscribeActivity:()=>()=>{}}
  const instance=component('HomeWorkRequestsDock.tsx','HomeWorkRequestsDock',props)
  assert.equal(instance.render(),null);await tick();assert.equal(calls,0)
  resolve(false);await tick();assert.equal(instance.render(),null);assert.equal(calls,0);instance.unmount()
 }
})

test('手动续办回执让dock恢复轮询，并拒绝覆盖它的在途旧list回包',async()=>{
 let activity=()=>{},mode='failed',late!:(value:unknown)=>void,calls=0
 const props={sessionId:'s',work:{subscribe:()=>()=>{},getSnapshot:()=>({sessionId:'s',status:'ready'})},isAssistantContext:async()=>true,call:async()=>{calls++;if(mode==='late')return new Promise(resolve=>{late=resolve});return [status('s',mode)]},openTask:()=>{},subscribeActivity:(listener:()=>void)=>{activity=listener;return()=>{}}}
 const instance=component('HomeWorkRequestsDock.tsx','HomeWorkRequestsDock',props)
 instance.render();await tick();let view=instance.render(),card=nodes(view).find(node=>node.type==='shared-status-card')
 mode='late';activity();instance.timer(200);await tick()
 card.props.onChange(readHomeWorkStatus(status('s','waiting'),'s'))
 late([status('s','failed')]);await tick();mode='waiting';view=instance.render();assert.equal(nodes(view).find(node=>node.type==='shared-status-card').props.initial.members[0].status,'waiting')
 await tick();instance.render();mode='received';const before=calls;instance.timer(10000);await tick()
 assert.equal(calls,before+1);assert.equal(nodes(instance.render()).find(node=>node.type==='shared-status-card').props.initial.members[0].result,'核查已完成')
 instance.unmount()
})

test('复用的进度卡接受同一请求的新快照并显示真实结果及友好业务名',()=>{
 const props={initial:readHomeWorkStatus(status(),'s'),call:async()=>status(),openTask:()=>{},managed:true}
 const instance=component('HomeWorkRequestCard.tsx','HomeWorkStatusCard',props)
 instance.render();assert.match(text(instance.render()),/等待中/)
 props.initial=readHomeWorkStatus(status('s','received'),'s');instance.render()
 const view=instance.render();assert.match(text(view),/安全运营/);assert.match(text(view),/核查已完成/);assert.match(text(view),/已收到/)
 instance.unmount()
})
