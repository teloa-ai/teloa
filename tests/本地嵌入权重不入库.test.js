import test from 'node:test'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'

// 端侧检索的模型权重只按 packages/local-embedding/runtime/assets.json 的固定摘要按需下载到忽略目录，永不入库。
const git=(...args)=>execFileSync('git',args,{cwd:new URL('..',import.meta.url),encoding:'utf8'})
const weightPattern=/\.(onnx|onnx_data|safetensors|partial)$/i

test('已跟踪文件里没有模型权重、外部数据或未完成下载',()=>{
 const tracked=git('ls-files','-z').split('\0').filter(Boolean)
 assert.deepEqual(tracked.filter(path=>weightPattern.test(path)),[])
 // 暂存区也不能有：防止 git add 之后、提交之前漏网
 const staged=git('diff','--cached','--name-only','-z').split('\0').filter(Boolean)
 assert.deepEqual(staged.filter(path=>weightPattern.test(path)),[])
})

test('.gitignore 覆盖扩展目录下的权重、外部数据、.partial 与缓存目录，且不误伤常量文件',()=>{
 const ignored=['packages/local-embedding/runtime/model.onnx','packages/local-embedding/runtime/model.onnx_data','packages/local-embedding/runtime/model_int8.onnx','packages/local-embedding/runtime/model.onnx.partial','packages/local-embedding/.cache/x','packages/local-embedding/tools/reference/venv/bin/python','packages/local-embedding/anything/model.safetensors','.runtime/local-embedding-acceptance/model.onnx']
 const kept=['packages/local-embedding/runtime/assets.json','packages/local-embedding/PROVENANCE.md','packages/local-embedding/tools/reference/requirements.lock','tests/fixtures/local-retrieval/tokenizer-golden.json']
 const check=path=>{try{git('check-ignore','-q','--no-index',path);return true}catch{return false}}
 for(const path of ignored)assert.equal(check(path),true,path+' 应被忽略')
 for(const path of kept)assert.equal(check(path),false,path+' 不应被忽略')
})

test('assets.json 只含 huggingface.co 固定 revision 地址，且没有镜像主机',()=>{
 const assets=JSON.parse(readFileSync(new URL('../packages/local-embedding/runtime/assets.json',import.meta.url),'utf8'))
 const files=[...assets.files,...(assets.evaluationOnly?.files??[])]
 assert.ok(files.length>=4)
 for(const file of files){
  assert.match(file.url,/^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\/[^?#]+$/,file.url)
  assert.match(file.sha256,/^[a-f0-9]{64}$/);assert.ok(Number.isSafeInteger(file.bytes)&&file.bytes>0)
 }
 assert.deepEqual(assets.allowedHosts,['huggingface.co'])
 assert.equal(assets.defaultVariant,'fp32')
})
