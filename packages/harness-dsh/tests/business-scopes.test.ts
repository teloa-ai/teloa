import test from 'node:test'
import assert from 'node:assert/strict'
import {createBusinessScopeHandler,readBusinessScopeLabels} from '../src/business-scopes.ts'
import type {BusinessScopeService} from '@teloa/backend'

const label={scope:'general',title:'通用工作',kind:'builtin' as const,loads:0,activeLoads:0,tasks:3,groups:1}
const domain={scope:'finance-ops',title:'财务风控工作',kind:'domain' as const,loads:2,activeLoads:1,tasks:0,groups:0}

test('业务范围目录只回登记过的标签，异常回包一律拒绝',async()=>{
 const calls:unknown[][]=[]
 const service={list:async(...args:unknown[])=>{calls.push(args);return [label,domain]}} as unknown as BusinessScopeService
 const handler=createBusinessScopeHandler('local:teloa-owner',async()=>service)
 assert.deepEqual(await handler('business-scopes/list',{}),{items:[label,domain]})
 assert.deepEqual(calls[0],['local:teloa-owner'])
 await assert.rejects(handler('business-scopes/rename',{}),{code:'teloa/not-found'})
 const bad=[
  {items:[{...label,kind:'unknown'}]},
  {items:[{...label,loads:-1}]},
  {items:[{...label,loads:1.5}]},
  {items:[{...label,activeLoads:2,loads:1}]},
  {items:[{...label,extra:'x'}]},
  {items:[{scope:label.scope,title:label.title,kind:label.kind,loads:0,activeLoads:0,tasks:0}]},
  {items:[{...label,scope:''}]},
  {items:[{...label,title:'x'.repeat(81)}]},
  {items:[{...label,sourceNoun:'告警源\n'}]},
  {items:[{...label,sourceNoun:'字'.repeat(13)}]},
  {items:[label,label]},
  {items:label},
  {items:[label],extra:'x'},
  {},
 ]
 for(const value of bad)assert.throws(()=>readBusinessScopeLabels(value),{code:'teloa/invalid-host-response'})
 assert.deepEqual(readBusinessScopeLabels({items:[{...label,sourceNoun:'告警源'}]}),{items:[{...label,sourceNoun:'告警源'}]})
 assert.deepEqual(readBusinessScopeLabels({items:[]}),{items:[]})
})
