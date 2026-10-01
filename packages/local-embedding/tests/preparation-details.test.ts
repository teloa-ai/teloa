import assert from 'node:assert/strict'
import test from 'node:test'
import {retrievalPreparationDetails} from '../src/preparation-details.ts'
import {readRetrievalPreparationDetails} from '@teloa/contract'
test('固定准备详情严格读取，拒绝路径穿越、伪来源、重复文件与校验摘要缺失',()=>{
 const value=retrievalPreparationDetails('fp32','/models','/runtime')
 assert.deepEqual(readRetrievalPreparationDetails(value),value)
 for(const patch of [{path:'../model.onnx'},{source:'https://host/?token=x'},{bytes:Infinity},{sha256:'oops'},{shared:'yes'}]){
  assert.throws(()=>readRetrievalPreparationDetails({...value,files:[{...value.files[0],...patch}]}))
 }
 assert.throws(()=>readRetrievalPreparationDetails({...value,files:[value.files[0],value.files[0]]}))
})
test('确认卡列出两种下载来源：官方 huggingface.co 与国内镜像 hf-mirror.com，均来自固定 assets.json；来源表严格读取',()=>{
 const value=retrievalPreparationDetails('fp32','/models','/runtime')
 assert.deepEqual(value.downloadSources,[{id:'official',host:'huggingface.co'},{id:'hf-mirror',host:'hf-mirror.com'}])
 const {downloadSources:_omit,...legacy}=value
 assert.deepEqual(readRetrievalPreparationDetails(legacy),legacy,'不带来源表的旧详情仍可读（只能用官方来源）')
 for(const downloadSources of [[],[{id:'hf-mirror',host:'hf-mirror.com'}],[{id:'official',host:'huggingface.co'},{id:'evil',host:'evil.example'}],[{id:'official',host:'huggingface.co'},{id:'official',host:'huggingface.co'}],[{id:'official',host:'https://huggingface.co/?t=1'}],[{id:'official',host:'huggingface.co',url:'https://x'}],'official',undefined]){
  assert.throws(()=>readRetrievalPreparationDetails({...value,downloadSources}),JSON.stringify(downloadSources))
 }
})
