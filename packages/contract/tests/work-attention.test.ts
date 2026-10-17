import test from 'node:test'
import assert from 'node:assert/strict'
import {readWorkAttentionPage,workAttentionPageLimit} from '../src/work-attention.ts'

const taskId='0b5b1a9e-3f7e-4d2a-9c1b-2f6d8e4a7c10',draftId='6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f'
const task={id:'task:'+taskId,kind:'error',reason:'task-blocked',title:'调查',scope:'general',occurredAt:'2026-10-01T00:00:00.000Z',source:{kind:'task',taskId,version:3},target:{kind:'task',taskId},basisHash:'a'.repeat(64)}
const draft={id:'page-create-draft:'+draftId,kind:'review',reason:'page-create-draft-pending',title:'草案',occurredAt:'2026-10-01T00:00:00.000Z',source:{kind:'page-create-draft',entity:'role',draftId,bodyHash:'b'.repeat(64)},target:{kind:'page-create-draft',draftId},basisHash:'c'.repeat(64)}
const page=(items:unknown[],extra:Record<string,unknown>={})=>({schema:'teloa.work-attention/v1',items,incomplete:[],...extra})
const rejects=(value:unknown)=>assert.throws(()=>readWorkAttentionPage(value),{code:'teloa/invalid-host-response'})

test('回读接受类型化来源、原对象目标与显式不完整来源',()=>{
 assert.equal(workAttentionPageLimit,50)
 const value=page([task,draft],{incomplete:[{source:'business-sync',scope:'SOC',reason:'unavailable'}],nextCursor:'abc'})
 assert.deepEqual(readWorkAttentionPage(value),value)
})

test('回读拒绝 URL 目标、错位目标、臆造草稿版本、重复待办与多余字段',()=>{
 rejects(page([{...task,target:{kind:'url',href:'https://example.com'}}]))
 rejects(page([{...task,target:{kind:'task',taskId:draftId}}]))
 rejects(page([{...task,target:{...task.target,href:'/x'}}]))
 rejects(page([{...draft,source:{...draft.source,revision:2}}]))
 rejects(page([task,task]))
 rejects(page([{...task,dueAt:'2026-10-02T00:00:00.000Z'}]))
 rejects(page([{...task,basisHash:'short'}]))
 rejects(page([task],{incomplete:[{source:'security',reason:'unavailable'}]}))
 rejects(page(Array.from({length:51},(_,n)=>({...task,id:'task:'+n}))))
})

test('来源和显示范围不能拼接错位，原对象类别不能冒充其它待办动作',()=>{
 rejects(page([{...draft,scope:'SOC'}]))
 rejects(page([{...draft,kind:'approval',reason:'business-change-review'}]))
 rejects(page([{...task,kind:'review',reason:'page-create-draft-pending'}]))
})
