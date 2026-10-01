import assert from 'node:assert/strict'
import test from 'node:test'
import {evidenceKinds,isEvidenceEntry,readEvidenceEntry} from '../src/evidence.ts'

test('三种依据类型固定，叙述是 text、外部产出是 log 或 command',()=>{
 assert.deepEqual([...evidenceKinds],['text','log','command'])
})

test('最小合法条目只有 kind、title、body',()=>{
 const entry={kind:'text',title:'判断依据',body:'**已确认**外联域名。'}
 assert.equal(isEvidenceEntry(entry),true)
 assert.deepEqual(readEvidenceEntry(entry),entry)
})

test('source 与 observedAt 可选，observedAt 必须是规范 ISO 串',()=>{
 const entry={kind:'log' as const,title:'进程执行记录',body:'pid=811 exec /bin/sh',source:'edr-01',observedAt:'2026-09-15T02:00:00.000Z'}
 assert.deepEqual(readEvidenceEntry(entry),entry)
 assert.equal(isEvidenceEntry({...entry,observedAt:'2026-09-15 02:00'}),false)
 assert.equal(isEvidenceEntry({...entry,observedAt:'2026-09-15T02:00:00Z'}),false)
})

test('未知字段、未知 kind、空标题、超长正文一律拒绝',()=>{
 const base={kind:'command',title:'命令',body:'isolate --host prod-03'}
 assert.equal(isEvidenceEntry({...base,extra:1}),false)
 assert.equal(isEvidenceEntry({...base,kind:'html'}),false)
 assert.equal(isEvidenceEntry({...base,title:'  '}),false)
 assert.equal(isEvidenceEntry({...base,body:'x'.repeat(200001)}),false)
 assert.equal(isEvidenceEntry({...base,source:''}),false)
 assert.equal(isEvidenceEntry({...base,source:'r'.repeat(256)}),true)
 assert.equal(isEvidenceEntry({...base,source:'r'.repeat(257)}),false)
 assert.equal(isEvidenceEntry(null),false)
 assert.throws(()=>readEvidenceEntry({...base,kind:'html'}),{code:'teloa/invalid-input'})
})
