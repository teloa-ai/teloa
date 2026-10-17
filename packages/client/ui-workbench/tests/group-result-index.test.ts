import test from 'node:test'
import assert from 'node:assert/strict'
import {groupSharedResults} from '../src/client/group-result-index.ts'
import type {GroupMessage} from '@teloa/contract'

const message=(id:string,groupId:string,version:number,createdAt:string,extra={}):GroupMessage=>({id,groupId,rootId:null,authorId:'self',text:'合成成果引用',mentions:[],references:[{kind:'artifact',id:'result',version}],createdAt,...extra})
test('群成果仅投影本群明确分享的固定版本，不纳入另一个群或输入资料',()=>{
 const rows=groupSharedResults('one',[message('m1','one',1,'2026-10-12T01:00:00Z'),message('private','two',9,'2026-10-12T02:00:00Z'),message('materials','one',4,'2026-10-12T03:00:00Z',{references:[{kind:'group-resource',id:'input',version:4}]})])
 assert.deepEqual(rows.map(row=>[row.reference.id,row.reference.version,row.message.id,row.historical]),[['result',1,'m1',false]])
})
test('同一成果按群内最新共享版本汇总，重复引用去重且旧版本仍锁定原消息',()=>{
 const one=message('m1','one',1,'2026-10-12T01:00:00Z'),two=message('m2','one',2,'2026-10-12T02:00:00Z'),again=message('m3','one',2,'2026-10-12T03:00:00Z')
 const before=structuredClone([one,two,again]),rows=groupSharedResults('one',[one,two,again,one])
 assert.deepEqual(rows.map(row=>[row.reference.version,row.message.id,row.historical]),[[2,'m3',false],[1,'m1',true]])
 assert.deepEqual([one,two,again],before,'投影不修改原消息和固定引用')
})
test('群成果按分享时间排列，话题结果保留根话题与真实员工来源',()=>{
 const rows=groupSharedResults('one',[message('early','one',1,'2026-10-12T01:00:00Z'),message('reply','one',1,'2026-10-12T04:00:00Z',{rootId:'root',authorId:'employee',runId:'run',taskId:'task',references:[{kind:'artifact',id:'another',version:1}]})])
 assert.deepEqual(rows.map(row=>[row.reference.id,row.message.id,row.message.rootId,row.message.authorId]),[['another','reply','root','employee'],['result','early',null,'self']])
 assert.deepEqual(groupSharedResults('unrelated',rows.map(row=>row.message)),[])
})
