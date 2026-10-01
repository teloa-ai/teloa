import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {existsSync,readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {createTextTokenizer} from '../src/tokenize.ts'
import {assetsCacheDir,type AssetsManifest} from '../src/assets.ts'
import assets from '../runtime/assets.json' with {type:'json'}

const repo=fileURLToPath(new URL('../../../',import.meta.url))
const golden=JSON.parse(readFileSync(repo+'tests/fixtures/local-retrieval/tokenizer-golden.json','utf8')) as {tokenizer:{sha256:string};method:{truncation:{maxLength:number};appendedTokenId:number};samples:{category:string;text:string;input_ids:number[];attention_mask:number[]}[]}

/**
 * tokenizer.json（11.4 MB）不入库：依次找环境变量、验收缓存（`.runtime/local-embedding-acceptance/dsh-home` 下的 fp32 缓存目录），
 * 且必须与固定 sha256 一致；都没有时明确跳过并说明原因（不下载）。
 */
function locate():{json:string;config:string}|string{
 const candidates=[process.env.TELOA_LOCAL_EMBEDDING_TOKENIZER_DIR,assetsCacheDir(assets as AssetsManifest,'fp32',(...segments)=>repo+'.runtime/local-embedding-acceptance/dsh-home/'+segments.join('/'))].filter((dir):dir is string=>typeof dir==='string'&&dir.length>0)
 for(const dir of candidates){
  const json=dir+'/tokenizer.json',config=dir+'/tokenizer_config.json'
  if(!existsSync(json)||!existsSync(config))continue
  if(createHash('sha256').update(readFileSync(json)).digest('hex')!==golden.tokenizer.sha256)return `跳过：${json} 与固定 sha256 不一致`
  return {json,config}
 }
 return '跳过：未找到已按固定 sha256 准备的 tokenizer.json（设置 TELOA_LOCAL_EMBEDDING_TOKENIZER_DIR 或准备验收缓存 .runtime/local-embedding-acceptance/dsh-home）；本测试不下载'
}
const found=locate()

test('分词黄金用例：200 条 input_ids 与 attention_mask 逐条与 HF tokenizers 完全一致，末位均为 151643（含 511/512/513 截断边界）',{skip:typeof found==='string'?found:false},()=>{
 const files=found as {json:string;config:string}
 const tokenizer=createTextTokenizer(JSON.parse(readFileSync(files.json,'utf8')),JSON.parse(readFileSync(files.config,'utf8')),{maxTokens:golden.method.truncation.maxLength,appendedTokenId:golden.method.appendedTokenId})
 assert.equal(golden.samples.length,200)
 for(const [index,sample] of golden.samples.entries()){
  const encoded=tokenizer.encode(sample.text)
  assert.deepEqual(encoded.ids,sample.input_ids,`#${index} ${sample.category}`)
  assert.deepEqual(encoded.ids.map(()=>1),sample.attention_mask,`#${index} ${sample.category}`)
  assert.equal(encoded.ids.at(-1),151643,`#${index} ${sample.category}`)
  assert.ok(encoded.ids.length<=512)
 }
 const boundaries=golden.samples.filter(sample=>/^truncation-(511|512|513)$/.test(sample.category))
 assert.equal(boundaries.length,3)
 assert.deepEqual(boundaries.map(sample=>tokenizer.encode(sample.text).truncated),[false,true,true])
})

test('截断：超过上限时保留前 maxTokens-1 个词元并补追加位，报告 truncated',()=>{
 const tokenizer=createTextTokenizer(tinyTokenizer,{},{maxTokens:4,appendedTokenId:9})
 assert.deepEqual(tokenizer.encode('a b c d e'),{ids:[1,2,3,9],truncated:true})
 assert.deepEqual(tokenizer.encode('a b'),{ids:[1,2,9],truncated:false})
 assert.deepEqual(tokenizer.encode(''),{ids:[9],truncated:false})
})

/** 最小 WordLevel 分词器：后处理器在末尾追加 id 9，用来验证截断为追加位预留一位。 */
const tinyTokenizer={version:'1.0',truncation:null,padding:null,added_tokens:[{id:9,content:'<eos>',single_word:false,lstrip:false,rstrip:false,normalized:false,special:true}],normalizer:null,pre_tokenizer:{type:'Whitespace'},
 post_processor:{type:'TemplateProcessing',single:[{Sequence:{id:'A',type_id:0}},{SpecialToken:{id:'<eos>',type_id:0}}],pair:[{Sequence:{id:'A',type_id:0}}],special_tokens:{'<eos>':{id:'<eos>',ids:[9],tokens:['<eos>']}}},
 decoder:null,model:{type:'WordLevel',vocab:{'<unk>':0,a:1,b:2,c:3,d:4,e:5,'<eos>':9},unk_token:'<unk>'}}
