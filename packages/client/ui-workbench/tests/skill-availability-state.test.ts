import test from 'node:test'
import assert from 'node:assert/strict'
import {reduceAvailabilityView} from '../src/client/skill-availability-state.ts'
import type {SkillAvailabilityPreview} from '../src/client/skill-availability-api.ts'

const a='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',b='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const value=(installationId=a,version=1,availability:'enabled'|'disabled'='enabled')=>({installationId,ownerId:'owner',availability,version,updatedAt:'2026-09-12T00:00:00.000Z'})
test('可用状态请求按安装与generation隔离，A→B→A迟到不能写入',()=>{
 let state=reduceAvailabilityView(undefined,{type:'select',installationId:a,generation:1})
 state=reduceAvailabilityView(state,{type:'select',installationId:b,generation:2})
 state=reduceAvailabilityView(state,{type:'select',installationId:a,generation:3})
 const current=state
 assert.deepEqual(reduceAvailabilityView(state,{type:'loaded',generation:1,value:value()}),current)
 assert.deepEqual(reduceAvailabilityView(state,{type:'error',generation:2,error:'旧错误'}),current)
 state=reduceAvailabilityView(state,{type:'loaded',generation:3,value:value()})
 assert.equal(state.current?.installationId,a)
})
test('当前可用状态版本单调，错误保留事实，同版本冲突拒绝',()=>{
 let state=reduceAvailabilityView(undefined,{type:'select',installationId:a,generation:1})
 state=reduceAvailabilityView(state,{type:'loaded',generation:1,value:value(a,3,'disabled')})
 state=reduceAvailabilityView(state,{type:'loaded',generation:1,value:value(a,2)})
 assert.equal(state.current?.availability,'disabled')
 state=reduceAvailabilityView(state,{type:'loaded',generation:1,value:value(a,3)})
 assert.match(state.error,/同版本/)
 assert.equal(state.current?.availability,'disabled')
 state=reduceAvailabilityView(state,{type:'error',generation:1,error:'刷新失败'})
 assert.equal(state.current?.version,3)
})
test('新读取或动作更换立即使旧预览失效，读取失败保留原状态',()=>{
 let state=reduceAvailabilityView(undefined,{type:'select',installationId:a,generation:1})
 state=reduceAvailabilityView(state,{type:'loaded',generation:1,value:value()})
 state=reduceAvailabilityView(state,{type:'select',installationId:a,generation:2})
 assert.equal(state.current?.version,1)
 assert.equal(state.preview,undefined)
 state=reduceAvailabilityView(state,{type:'error',generation:2,error:'失败'})
 assert.equal(state.current?.availability,'enabled')
})
test('预览绑定当次动作，状态已反转或新状态读回不能沿用旧确认',()=>{
 let state=reduceAvailabilityView(undefined,{type:'select',installationId:a,generation:1})
 const preview={availability:value(a,2,'disabled')} as SkillAvailabilityPreview
 state=reduceAvailabilityView(state,{type:'preview',generation:1,value:preview,action:'disable'})
 assert.equal(state.preview,undefined);assert.match(state.error,/变化/)
 state=reduceAvailabilityView(state,{type:'preview',generation:1,value:preview,action:'enable'})
 assert.equal(state.action,'enable')
 state=reduceAvailabilityView(state,{type:'loaded',generation:1,value:value(a,3)})
 assert.equal(state.preview,undefined)
})
