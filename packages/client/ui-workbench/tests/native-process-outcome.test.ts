import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {verifiedProcessGroup} from '../src/client/native-process-outcome.ts'

const fixture=JSON.parse(readFileSync(new URL('./fixtures/native-process-write-failures.json',import.meta.url),'utf8'))
const results=fixture.events.filter((event:{type:string})=>event.type==='tool/result')
const calls=fixture.events.filter((event:{type:string})=>event.type==='tool/call')
const root=(index:number)=>({kind:'tool-result',callId:calls[index].data.callId,name:'write',call:{name:'write',argsRaw:calls[index].data.arguments},isError:results[index].data.message.isError,content:results[index].data.message.content,...(results[index].data.error?{error:results[index].data.error}:{}),subCalls:[] as unknown[]})
const group=()=>({key:'original-group',members:[{kind:'node',key:'original-node'}],data:{turn:1,closed:true,summary:{counts:[{kind:'write',count:1}],running:undefined,runningDetail:''}}})
const node=(value:unknown)=>({kind:'tool-call',data:{root:value}})

test('冻结原生两次失败write不因closed而获得成功类别，原节点与错误不改',()=>{
 for(const index of [0,1]){
  const original=group(),value=root(index),before=structuredClone(value)
  const adapted=verifiedProcessGroup(original,()=>node(value))
  assert.deepEqual(adapted.data.summary.counts,[{kind:'tools',count:1}])
  assert.deepEqual(original.data.summary.counts,[{kind:'write',count:1}])
  assert.strictEqual(adapted.members,original.members)
  assert.deepEqual(value,before)
 }
})

test('只有已配对明确成功结果保留写入完成；拒绝、缺回执、孤立和未知标记不保留',()=>{
 const success={...root(1),isError:false},original=group()
 assert.strictEqual(verifiedProcessGroup(original,()=>node(success)),original)
 for(const value of [{...root(1),content:[{type:'text',text:'Error: the user rejected tool write'}]},{phase:'start',callId:'pending',name:'write',subCalls:[]},{...success,call:null},{...success,isError:undefined},{...success,error:{code:'FAILED'}},undefined]){
  assert.deepEqual(verifiedProcessGroup(original,()=>node(value)).data.summary.counts,[{kind:'tools',count:1}])
 }
 assert.deepEqual(verifiedProcessGroup(original,()=>undefined).data.summary.counts,[{kind:'tools',count:1}])
})

test('父调用成功不能遮蔽失败或尚无回执的子调用',()=>{
 const parent={...root(1),isError:false,subCalls:[root(0)]},original=group()
 assert.deepEqual(verifiedProcessGroup(original,()=>node(parent)).data.summary.counts,[{kind:'tools',count:1}])
 parent.subCalls=[{phase:'start',callId:'pending',name:'write',subCalls:[]}] as unknown as typeof parent.subCalls
 assert.deepEqual(verifiedProcessGroup(original,()=>node(parent)).data.summary.counts,[{kind:'tools',count:1}])
})

test('活动组保留原生运行提示，纯分析组不伪造工具调用',()=>{
 const active=group();active.data.closed=false
 assert.strictEqual(verifiedProcessGroup(active,()=>node(root(0))),active)
 const thinking=group();thinking.data.summary.counts=[]
 assert.strictEqual(verifiedProcessGroup(thinking,()=>undefined),thinking)
})
