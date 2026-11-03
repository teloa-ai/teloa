import test from 'node:test'
import assert from 'node:assert/strict'
import {readTaskRunMemorySelection} from '../src/task-runs.ts'

test('本次经验选择区分省略与空集合，并固定规范身份集合',()=>{
 const id='abcdefab-1234-4234-8234-123456789012',other='12345678-1234-4234-8234-123456789012'
 assert.equal(readTaskRunMemorySelection(undefined),undefined)
 assert.deepEqual(readTaskRunMemorySelection([]),[])
 assert.deepEqual(readTaskRunMemorySelection([id.toUpperCase(),other]),[other,id])
})
test('经验选择拒绝坏类型、重复身份与超限，不把非法选择变成自动或空集合',()=>{
 const id='abcdefab-1234-4234-8234-123456789012'
 for(const value of [null,false,'all',{},[null],['bad'],[id,id.toUpperCase()],Array(31).fill(id)])assert.throws(()=>readTaskRunMemorySelection(value),{code:'teloa/invalid-input'})
})
