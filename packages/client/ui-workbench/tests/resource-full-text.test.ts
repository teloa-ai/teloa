import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {promptFullTextMaxBytes,type SourceReference,type WorkResource} from '@teloa/contract'
import {oversizedResources} from '../src/client/resource-full-text.ts'
import {KNOWLEDGE_DIRECTORY_MESSAGE_ROWS} from '../src/client/i18n/locales/knowledge-directory.ts'

const resource=(id:string,sourceId:string,sourceVersion:string):WorkResource=>({id,ownerId:'owner',version:1,status:'active',title:id,sourceId,sourceVersion,scopeIds:['general'],createdAt:'2026-09-28T00:00:00.000Z',updatedAt:'2026-09-28T00:00:00.000Z'})
const source=(id:string,version:string,bytes:number):SourceReference=>({id,title:id,source:id,version,bytes})

test('按来源目录登记的字节数找出超过 256 KiB 的资料，只按同一来源版本匹配',()=>{
 assert.equal(promptFullTextMaxBytes,256*1024)
 const a='a'.repeat(64),b='b'.repeat(64)
 const rows=[resource('big','knowledge_1',a),resource('exact','knowledge_2',a),resource('stale','knowledge_3',b),resource('unknown','industry_x',a)]
 const sizes=oversizedResources(rows,[source('knowledge_1',a,300*1024),source('knowledge_2',a,256*1024),source('knowledge_3',a,400*1024)])
 assert.deepEqual([...sizes.entries()],[['big',300]])
})

test('岗位知识与任务知识选择器把超限资料置灰并说明原因，词条十语齐全',()=>{
 const row=KNOWLEDGE_DIRECTORY_MESSAGE_ROWS.find(item=>item[0]==='knowledge.fullTextTooLarge')
 assert.ok(row,'缺少超限提示词条')
 assert.equal(row.length,11)
 for(const text of row.slice(1))assert.match(text,/\{size\}/)
 assert.equal(row[1],'{size} KiB，超过 256 KiB，只能加入本地检索使用')
 for(const name of ['RoleKnowledge.tsx','TaskKnowledge.tsx']){
  const source=readFileSync(new URL(`../src/client/${name}`,import.meta.url),'utf8')
  assert.match(source,/oversizedResources\(/)
  assert.match(source,/t\('knowledge\.fullTextTooLarge'/)
 }
})
