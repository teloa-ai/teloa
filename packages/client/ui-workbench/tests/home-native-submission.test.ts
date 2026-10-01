import assert from 'node:assert/strict'
import test from 'node:test'
import {HomeSubmissionJournal,isDeterministicPromptRejection} from '../src/client/home-native-submission.ts'
const memory=()=>{const rows=new Map<string,string>();return {getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value)},removeItem:(key:string)=>{rows.delete(key)}}}
test('未知发送和刷新都禁止盲目重发，只有同requestId持久回执才解除',()=>{
 const storage=memory(),journal=new HomeSubmissionJournal(storage,'s')
 journal.observe(['r1'],[],false)
 assert.equal(journal.getSnapshot(),false)
 journal.observe([],[],true)
 assert.equal(journal.getSnapshot(),true)
 const restored=new HomeSubmissionJournal(storage,'s')
 assert.equal(restored.getSnapshot(),true)
 restored.observe([],['r2'],false)
 assert.equal(restored.getSnapshot(),true)
 restored.observe([],['r1'],false)
 assert.equal(restored.getSnapshot(),false)
})
test('官方已排队或持久消息回执及时解除，与另一会话完全隔离',()=>{
 const storage=memory(),left=new HomeSubmissionJournal(storage,'left'),right=new HomeSubmissionJournal(storage,'right')
 left.observe(['r1'],[],false);left.observe([],['r1'],false)
 assert.equal(left.getSnapshot(),false);assert.equal(right.getSnapshot(),false)
})

test('原生提交日志在已打开的两个标签页间对账，运行期存储故障不抛出事件链',()=>{
 const rows=new Map<string,string>(),storage={getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value)},removeItem:(key:string)=>{rows.delete(key)}}
 const a=new HomeSubmissionJournal(storage,'s'),b=new HomeSubmissionJournal(storage,'s')
 a.observe(['r'],[],false);b.observe([],[],false);assert.equal(b.getSnapshot(),true)
 b.observe([],['r'],false);a.observe([],[],false);assert.equal(a.getSnapshot(),false)
 const broken=new HomeSubmissionJournal({getItem:()=>null,setItem:()=>{throw Error('quota')},removeItem:()=>{throw Error('quota')}},'s')
 assert.doesNotThrow(()=>broken.observe(['r'],[],false))
})

test('贴密钥拒收（gateway/bad-request）是准入前的确定性拒收：不锁输入框，刷新后也不锁，同一会话可再发',()=>{
 assert.equal(isDeterministicPromptRejection('gateway/bad-request'),true)
 assert.equal(isDeterministicPromptRejection('session/model-unavailable'),true)
 assert.equal(isDeterministicPromptRejection('gateway/internal'),false)
 assert.equal(isDeterministicPromptRejection(undefined),false)
 const storage=memory(),journal=new HomeSubmissionJournal(storage,'s')
 journal.observe(['r1'],[],false)
 journal.observe([],[],false,isDeterministicPromptRejection('gateway/bad-request'))
 assert.equal(journal.getSnapshot(),false)
 assert.equal(storage.getItem('teloa.home-submission/s'),null)
 assert.equal(new HomeSubmissionJournal(storage,'s').getSnapshot(),false)
 journal.observe(['r2'],[],false);journal.observe([],['r2'],false)
 assert.equal(journal.getSnapshot(),false)
})
