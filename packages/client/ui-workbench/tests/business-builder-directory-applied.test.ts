import test from 'node:test'
import assert from 'node:assert/strict'
import {pendingBuilderDrafts} from '../src/client/business-builder-flow.ts'

const stamp='2026-10-22T00:00:00.000Z'
const item=(requestId:string,draftId:string,status:'draft'|'applied')=>({
 binding:{requestId,kind:'builder' as const,title:'新业务',scope:'sales',sessionId:'session-'+requestId,createdAt:stamp,updatedAt:stamp},
 draft:{id:draftId,title:'新业务',scope:'sales',revision:1,status,updatedAt:stamp},
})

test('「继续搭建」目录只保留仍在编辑的草案，已应用/已采用的草案不再显示',()=>{
 const mixed={items:[item('r1','d1','applied'),item('r2','d2','draft')]}
 assert.deepEqual(pendingBuilderDrafts(mixed).map(row=>row.draft?.status),['draft'],'已应用草案不能继续显示为继续搭建')
 assert.equal(pendingBuilderDrafts({items:[item('r3','d3','applied')]}).length,0,'只有已应用草案时列表为空')
 assert.equal(pendingBuilderDrafts(null).length,0,'目录未加载时没有可显示草案')
})
