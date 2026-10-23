import assert from 'node:assert/strict'
import test from 'node:test'
import {readCreateSentenceDraft,writeCreateSentenceDraft} from '../src/client/page-create-presentation.ts'

// BIZ-004：员工/团队「创建说明」在预备后未发送就关闭时，重开入口要恢复原说明并标明「已备好未发送」。
// 记录格式要兼容旧版纯文本草稿（升级后不能丢用户原稿），损坏值不影响下次输入。

test('旧的纯文本句稿按未预备状态读取，不能因升级丢原稿',()=>{
 assert.deepEqual(readCreateSentenceDraft('帮我建一名资料研究员'),{text:'帮我建一名资料研究员',prepared:false})
 assert.deepEqual(readCreateSentenceDraft(''),{text:'',prepared:false})
 assert.deepEqual(readCreateSentenceDraft(undefined),{text:'',prepared:false})
 assert.deepEqual(readCreateSentenceDraft(null),{text:'',prepared:false})
})

test('预备成功后保存的句稿记录能读回「已备好未发送」状态',()=>{
 const raw=writeCreateSentenceDraft({text:'帮我建一名资料研究员',prepared:true})
 assert.equal(typeof raw,'string')
 assert.deepEqual(readCreateSentenceDraft(raw),{text:'帮我建一名资料研究员',prepared:true})
})

test('未预备的句稿记录读回未预备状态',()=>{
 assert.deepEqual(readCreateSentenceDraft(writeCreateSentenceDraft({text:'草稿',prepared:false})),{text:'草稿',prepared:false})
})

test('空文本不写入存储，清除草稿后重开入口是空的',()=>{
 assert.equal(writeCreateSentenceDraft({text:'',prepared:false}),'')
 assert.equal(writeCreateSentenceDraft({text:'',prepared:true}),'')
 assert.deepEqual(readCreateSentenceDraft(''),{text:'',prepared:false})
})

test('损坏记录、未知结构和超长文本回落为空而不是抛错',()=>{
 for(const raw of ['{不是 JSON','{"schema":"oteloa.other/v1","text":"x","prepared":true}','{"schema":"teloa.create-sentence-draft/v1","text":1,"prepared":true}','{"schema":"teloa.create-sentence-draft/v1","text":"x","prepared":"yes"}','{"text":"x"}','x'.repeat(2001)]){
  assert.deepEqual(readCreateSentenceDraft(raw),{text:'',prepared:false},raw.slice(0,40))
 }
})
