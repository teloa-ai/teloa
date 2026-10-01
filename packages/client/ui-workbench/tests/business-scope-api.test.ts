import test from 'node:test'
import assert from 'node:assert/strict'
import {createBusinessScopeApi,readBusinessScopeLabel,readBusinessScopeList} from '../src/client/business-scope-api.ts'

const label={scope:'SOC',title:'安全运营',kind:'builtin',loads:2,activeLoads:1,tasks:5,groups:1}

test('业务范围标签严格读取：完整回包通过，多余键、未知 kind 与负数计数一律拒绝',()=>{
 assert.deepEqual(readBusinessScopeLabel({...label}),label)
 assert.throws(()=>readBusinessScopeLabel({...label,spaceId:'x'}),/格式不正确/)
 assert.throws(()=>readBusinessScopeLabel({...label,kind:'team'}),/格式不正确/)
 assert.throws(()=>readBusinessScopeLabel({...label,tasks:-1}),/格式不正确/)
 assert.throws(()=>readBusinessScopeLabel({...label,activeLoads:3}),/格式不正确/)
 assert.deepEqual(readBusinessScopeLabel({...label,sourceNoun:'告警源'}),{...label,sourceNoun:'告警源'})
 for(const sourceNoun of ['', ' 有空格', '字'.repeat(13), '告警\n源'])assert.throws(()=>readBusinessScopeLabel({...label,sourceNoun}),/格式不正确/)
 const {groups,...missing}=label
 assert.throws(()=>readBusinessScopeLabel(missing),/格式不正确/)
 assert.throws(()=>readBusinessScopeLabel({...label,scope:''}),/格式不正确/)
 // 标题上限与契约、宿主同为 80 字：读取器不能比它们松，否则宿主写不进的标题会被客户端当成合法回包。
 assert.equal(readBusinessScopeLabel({...label,title:'长'.repeat(80)}).title,'长'.repeat(80))
 assert.throws(()=>readBusinessScopeLabel({...label,title:'长'.repeat(81)}),/格式不正确/)
})

test('目录只接受 {items} 信封，重复标签判为不可信',()=>{
 assert.deepEqual(readBusinessScopeList({items:[label]}),[label])
 assert.deepEqual(readBusinessScopeList({items:[]}),[])
 assert.throws(()=>readBusinessScopeList({items:[label],total:1}),/目录格式不正确/)
 assert.throws(()=>readBusinessScopeList([label]),/目录格式不正确/)
 assert.throws(()=>readBusinessScopeList({items:[label,{...label,title:'安全'}]}),/标签重复/)
})

test('list 只读且原样投影宿主登记的标题与计数',async()=>{
 const sent:Array<[string,unknown]>=[]
 const api=createBusinessScopeApi(async(endpoint,payload)=>{sent.push([endpoint,payload]);return {items:[label,{...label,scope:'finance',title:'财务',kind:'domain'}]}})
 const rows=await api.list()
 assert.deepEqual(sent,[['business-scopes/list',{}]])
 assert.deepEqual(rows.map(row=>[row.scope,row.title,row.kind]),[['SOC','安全运营','builtin'],['finance','财务','domain']])
})
