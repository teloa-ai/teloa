import test from 'node:test'
import assert from 'node:assert/strict'
import {businessObjectReference,encodeBusinessRecordReference,parseBusinessRecordReferences} from '../src/business-data.ts'

const reference={scope:'SOC',type:'alert',id:'evt-1842',version:1,snapshotHash:'a'.repeat(64)}

test('业务对象引用固定业务范围、对象身份、版本与快照摘要',()=>{
 assert.deepEqual(businessObjectReference(reference),reference)
 for(const value of [
  {...reference,scope:'general'},
  {...reference,type:''},
  {...reference,id:42},
  {...reference,id:'../secret'},
  {...reference,version:0},
  {...reference,snapshotHash:'bad'},
  {...reference,extra:true},
 ])assert.throws(()=>businessObjectReference(value),{code:'teloa/invalid-input'})
})

test('业务记录原生引用保留固定版本与摘要，且不能容忍歧义或伪造字段',()=>{
 const value={...reference,type:'客户/线索',id:'客户 甲/2026:09'}
 const marker=encodeBusinessRecordReference(value)
 assert.deepEqual(parseBusinessRecordReferences('请调查 '+marker+' 并给出依据'),[value])
 assert.deepEqual(parseBusinessRecordReferences('普通问题'),[])
 assert.equal(marker,encodeBusinessRecordReference(parseBusinessRecordReferences(marker)[0]!))
 for(const text of [
  marker+' '+marker,
  marker.replace('%2F','%2f'),
  marker.replace('|1|','|01|'),
  marker.replace(reference.snapshotHash,'b'.repeat(63)),
  marker.replace('%E5','%XX'),
  '[[teloa-business-record:missing]]',
 ])assert.throws(()=>parseBusinessRecordReferences(text),{code:'teloa/invalid-reference'})
})
