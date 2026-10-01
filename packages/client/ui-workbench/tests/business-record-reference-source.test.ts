import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync} from 'node:fs'
const source=new URL('../src/client/business-record-reference-source.ts',import.meta.url)
const reference={scope:'sales',type:'客户订单',id:'order/one',version:7,snapshotHash:'a'.repeat(64)}
async function load(){assert.ok(existsSync(source),'业务记录原生引用 source 尚未实现');return import('../src/client/business-record-reference-source.ts')}
test('原生记录chip完整固定身份；codec只序列化共享规范引用且不含记录正文',async()=>{
 const {businessRecordReferenceSource,businessRecordReferenceInsert}=await load()
 const chip=businessRecordReferenceInsert(reference,'客户订单'),src=businessRecordReferenceSource()
 const {encodeBusinessRecordReference}=await import('@teloa/contract')
 assert.equal(chip.source,src.name);assert.equal(chip.ref,encodeBusinessRecordReference(reference));assert.equal(chip.clipboardText,chip.ref);assert.equal(chip.label,'客户订单')
 assert.equal(await src.codec!.serialize(chip.ref,new AbortController().signal),chip.ref)
 assert.equal(src.codec!.clipboardText!(chip.ref),chip.ref)
 assert.deepEqual(await src.candidates({} as never,{} as never),[])
})
test('损坏/多条/非canonical引用和已取消序列化被拒绝，不降级为名称文本',async()=>{
 const {businessRecordReferenceSource,businessRecordReferenceInsert}=await load(),codec=businessRecordReferenceSource().codec!
 const chip=businessRecordReferenceInsert(reference,'客户订单')
 for(const ref of ['客户订单',chip.ref+' extra',chip.ref+chip.ref,chip.ref.replace('@7','@8').replace('aaaa','zzzz')])await assert.rejects(()=>codec.serialize(ref,new AbortController().signal))
 const abort=new AbortController();abort.abort();await assert.rejects(()=>codec.serialize(chip.ref,abort.signal))
 assert.throws(()=>businessRecordReferenceInsert(reference,''))
})
