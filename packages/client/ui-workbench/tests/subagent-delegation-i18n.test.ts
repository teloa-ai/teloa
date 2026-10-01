import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {SUBAGENT_DELEGATION_MESSAGE_ROWS} from '../src/client/i18n/locales/subagent-delegation.ts'

test('子任务拆分词表完整覆盖十种产品语言并接入主词典',async()=>{
 const keys=new Set<string>()
 for(const row of SUBAGENT_DELEGATION_MESSAGE_ROWS){
  assert.equal(row.length,11,row[0])
  assert.equal(keys.has(row[0]),false,row[0])
  keys.add(row[0])
  assert.equal(row.slice(1).every(value=>typeof value==='string'&&value.trim().length>0),true,row[0])
 }
 for(const key of ['subagent.grant.title','subagent.grant.description','subagent.run.title','subagent.run.item','subagent.run.state.started','subagent.run.started.notice','subagent.run.recovery.notice','subagent.run.recovery.action','subagent.limit.depthDenied','subagent.limit.runDenied'])assert.equal(keys.has(key),true,key)
 const core=await readFile(new URL('../src/client/i18n/locales/core-pages.ts',import.meta.url),'utf8')
 assert.match(core,/SUBAGENT_DELEGATION_MESSAGE_ROWS/)
})
