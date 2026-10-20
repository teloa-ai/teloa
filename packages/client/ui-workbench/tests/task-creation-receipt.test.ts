import test from 'node:test'
import assert from 'node:assert/strict'
import {taskCreationEventSource,taskCreationWithoutDispatch,rememberTaskCreation,readTaskCreation} from '../src/client/task-creation-receipt.ts'

const user={type:'user/message',seq:1,data:{role:'user',source:{kind:'user'},content:[{type:'text',text:'请保存调查任务，不执行'}]}}
const turn=(extra:any[]=[],end=true)=>({entries:[{event:{type:'turn/start',seq:0,data:{turn:0}}},{event:user},...extra.map(event=>({event})),...(end?[{event:{type:'turn/end',seq:9,data:{turn:0,reason:{kind:'stop'}}}}]:[])]})
test('React 单独调用事件源方法时仍保留原生接收者，不导致会话插槽崩溃',()=>{
 const source={snapshot:turn(),listeners:new Set<()=>void>(),getSnapshot(){return this.snapshot},subscribe(listener:()=>void){this.listeners.add(listener);return()=>this.listeners.delete(listener)}}
 const {getSnapshot,subscribe}=taskCreationEventSource(source),listener=()=>{}
 assert.equal(getSnapshot(),source.snapshot)
 const off=subscribe(listener);assert.equal(source.listeners.has(listener),true);off();assert.equal(source.listeners.size,0)
})
test('建任务轮次结束却没有真实 dispatch 时给出提示，不采信助手的已保存声明',()=>{
 assert.equal(taskCreationWithoutDispatch(turn([{type:'assistant/message',seq:2,data:{turn:0,message:{content:[{type:'text',text:'已保存 task-1'}]}}}])),'请保存调查任务，不执行')
 assert.equal(taskCreationWithoutDispatch(turn([{type:'tool/call',seq:2,data:{turn:0,name:'teloa_work_directory'}}])),'请保存调查任务，不执行')
 assert.equal(taskCreationWithoutDispatch(turn([{type:'tool/call',seq:2,data:{turn:0,name:'teloa_work_dispatch'}}])),undefined)
 assert.equal(taskCreationWithoutDispatch(turn([],false)),undefined)
 assert.equal(taskCreationWithoutDispatch({entries:[...turn().entries,{event:{type:'turn/start',seq:10,data:{turn:1}}}]}),undefined)
})
test('创建入口按本人存储和会话隔离，刷新可恢复；损坏元数据不产生入口',()=>{
 const rows=new Map<string,string>(),storage={getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value)},removeItem:(key:string)=>{rows.delete(key)}}
 rememberTaskCreation(storage,'one','SOC')
 assert.deepEqual(readTaskCreation(storage,'one'),{scope:'SOC'})
 assert.equal(readTaskCreation(storage,'two'),undefined)
 assert.equal(readTaskCreation({...storage,getItem:()=>'{bad'},'one'),undefined)
})
