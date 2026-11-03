import test from 'node:test'
import assert from 'node:assert/strict'
import {encodeEmployeeMention,parseEmployeeMentions,singleEmployeeMention} from '../src/employee-mention.ts'
const id='11111111-1111-4111-8111-111111111111'
test('员工reference规范编码、重复同人和损坏/多版本拒绝；名字不是身份',()=>{
 const ref={roleId:id,roleVersion:1},text=encodeEmployeeMention(ref)
 assert.deepEqual(parseEmployeeMentions('请 '+text+' 处理'),[ref]);assert.deepEqual(singleEmployeeMention(text+' '+text),ref)
 assert.equal(singleEmployeeMention('@同名员工'),undefined)
 for(const value of ['[teloa-employee:broken]','[teloa-employee:'+id+':01]','[teloa-employee:'+id+':2147483648]','[teloa-employee:'+id+':1'])assert.throws(()=>singleEmployeeMention(value))
 assert.throws(()=>singleEmployeeMention(text+' '+encodeEmployeeMention({roleId:id,roleVersion:2})))
})
