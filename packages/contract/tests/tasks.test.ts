import test from 'node:test'
import assert from 'node:assert/strict'
import {taskDefinition} from '../src/tasks.ts'

const groupId='11111111-1111-4111-8111-111111111111'
const base={title:'核对上月工单','goal':'把逾期工单逐条核对完','scope':'SOC'}

test('任务定义缺少关联群与使用技能时回落成空关联与空列表',()=>{
  assert.deepEqual(taskDefinition(base),{title:'核对上月工单',goal:'把逾期工单逐条核对完',scope:'SOC',groupId:null,skills:[]})
  assert.deepEqual(taskDefinition({...base,groupId:null}).groupId,null)
})

test('关联协作群只接受群身份格式',()=>{
  assert.equal(taskDefinition({...base,groupId}).groupId,groupId)
  for(const value of ['','group-1','11111111-1111-4111-8111',' '+groupId,7,{}])assert.throws(()=>taskDefinition({...base,groupId:value}),/协作群/)
})

test('使用技能去空白、去重，并限定每项 1–80 字、最多 16 项',()=>{
  assert.deepEqual(taskDefinition({...base,skills:[' 证据核对 ','证据核对','工单归档']}).skills,['证据核对','工单归档'])
  assert.deepEqual(taskDefinition({...base,skills:[]}).skills,[])
  assert.deepEqual(taskDefinition({...base,skills:Array.from({length:16},(_,index)=>'技能'+index)}).skills.length,16)
  for(const value of [
    '证据核对',
    ['  '],
    [''],
    ['a'.repeat(81)],
    [7],
    [null],
    Array.from({length:17},(_,index)=>'技能'+index),
  ])assert.throws(()=>taskDefinition({...base,skills:value}),/使用技能/)
})

test('任务定义仍然拒绝白名单以外的字段',()=>{
  assert.throws(()=>taskDefinition({...base,ownerId:'forged'}),/未知字段/)
  assert.throws(()=>taskDefinition({...base,group:groupId}),/未知字段/)
})
