import assert from 'node:assert/strict'
import test from 'node:test'
import type {WorkResource} from '@teloa/contract'
import {groupWorkResourceCandidates} from '../src/client/group-work-resources.ts'

test('群资料候选只取 active 且全部归属匹配；general 不扩大为跨业务读取',()=>{
 const resource=(id:string,scopeIds:string[],status:WorkResource['status']='active')=>({id,scopeIds,status}) as WorkResource
 const rows=[resource('general',['general']),resource('sales',['sales']),resource('mixed',['general','sales']),resource('withdrawn',['general'],'withdrawn')]
 assert.deepEqual(groupWorkResourceCandidates(rows,'general').map(row=>row.id),['general'])
 assert.deepEqual(groupWorkResourceCandidates(rows,'sales').map(row=>row.id),['sales'])
})
