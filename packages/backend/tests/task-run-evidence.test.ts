import test from 'node:test'
import assert from 'node:assert/strict'
import {runEvidence} from '../src/work/task-run-evidence.ts'

test('终轮证据状态必须是字符串，不能把数组或对象归一化成成功依据',()=>{
 for(const state of [['ended'],['active'],{value:'ended'}])assert.throws(()=>runEvidence({state,turn:0,messageSeq:1,endSeq:2,reason:'completed'}),{code:'teloa/invalid-input'})
 assert.deepEqual(runEvidence({state:'ended',turn:0,messageSeq:1,endSeq:2,reason:'completed'}),{state:'ended',turn:0,messageSeq:1,endSeq:2,reason:'completed'})
})
