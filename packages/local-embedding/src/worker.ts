/**
 * 嵌入推理子进程（由宿主经 `ctx.subprocess.spawn` 以 `process.execPath` 启动，环境按 DSH 官方规则清洗）。
 * 协议：stdin/stdout 逐行 JSON，不开端口。加载完成先写 `{"ready":true}`；之后每行请求 `{id,kind,texts}`，
 * 响应 `{id,vectors,truncated}`（vectors 为全部向量按序拼接的小端 float32 的 base64）或 `{id,error:{category}}`。
 * 只加载宿主传入的已校验缓存路径与受管运行时目录；本文件及其依赖不引用任何网络能力（测试静态检查守住）。
 */
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {createInterface} from 'node:readline'
import {createTextTokenizer} from './tokenize.ts'
import {createSession,embedTexts,resolveRuntimeEntry,type OrtLike,type SessionLike,type WorkerConfig} from './inference.ts'

const write=(value:unknown)=>{process.stdout.write(JSON.stringify(value)+'\n')}
const config=JSON.parse(process.argv[2]??'null') as WorkerConfig
const ort=createRequire(import.meta.url)(resolveRuntimeEntry(config.runtimeDir)) as OrtLike&{InferenceSession:{create(path:string,options:object):Promise<SessionLike>}}
const tokenizer=createTextTokenizer(JSON.parse(readFileSync(config.tokenizerPath,'utf8')),JSON.parse(readFileSync(config.tokenizerConfigPath,'utf8')),{maxTokens:config.maxTokens,appendedTokenId:config.appendedTokenId})
const session=await createSession(ort,config)
write({ready:true})

for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){
 let id:unknown=null
 try{
  const request=JSON.parse(line) as {id?:unknown;kind?:unknown;texts?:unknown}
  id=request.id
  if(!Number.isSafeInteger(id)||(request.kind!=='query'&&request.kind!=='passage')||!Array.isArray(request.texts)||request.texts.some(text=>typeof text!=='string')){
   write({id:Number.isSafeInteger(id)?id:null,error:{category:'input'}})
   continue
  }
  const result=await embedTexts({ort,session,tokenizer,config},request.kind,request.texts as string[])
  const flat=new Float32Array(result.vectors.length*config.dimensions)
  result.vectors.forEach((vector,index)=>flat.set(vector,index*config.dimensions))
  write({id,vectors:Buffer.from(flat.buffer,flat.byteOffset,flat.byteLength).toString('base64'),truncated:result.truncated})
 }catch{
  // 不回传原文或底层错误消息（可能含资料片段）；宿主按类别处理并回收进程。
  write({id:Number.isSafeInteger(id)?id:null,error:{category:'inference'}})
 }
}
process.exit(0)
