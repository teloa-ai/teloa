import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'

const root=new URL('../src/client/',import.meta.url)

test('市场、行业任务和岗位的可见列表使用 locale-aware formatter',async()=>{
 const names=['MarketResourceCatalog.tsx','IndustryTaskForm.tsx','TeamPage.tsx','IndustryTaskSourcePanel.tsx','TaskDetail.tsx']
 const sources=await Promise.all(names.map(name=>readFile(new URL(name,root),'utf8')))
 for(const [index,source] of sources.entries()){
  assert.doesNotMatch(source,/\.join\(['"]、['"]\)/,names[index])
  assert.match(source,/\blist\(/,names[index])
 }
 assert.doesNotMatch(sources[0]!,/>Skill:\s*\{/)
 assert.doesNotMatch(sources[2]!,/<dt>Skill<\/dt>/)
})
