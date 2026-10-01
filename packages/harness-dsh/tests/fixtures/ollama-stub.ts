import {createServer,type Server,type ServerResponse} from 'node:http'

/** 桩 Ollama（模型二期规格 §3 / §11）：只监听 127.0.0.1:0，覆盖 /api/* 与 /v1/* 固定路径，记录全部调用。 */
export type StubModel={name:string;size:number;digest:string;family?:string;parameterSize?:string;contextLength?:number;allocatedContext?:number|null;capabilities?:string[];thinking?:{values:(boolean|string)[];default:boolean|string}}
export type StubOptions={version?:string;/** 可在运行中切换：非空时 /v1/chat/completions 以该状态码返回错误（模拟本地模型服务故障）。 */chatFailure?:{status:number;error:string}|null;models?:StubModel[];pullChunks?:number;pullDelayMs?:number;pullError?:string|null;pulledDigest?:(name:string)=>string;running?:string[];chatReply?:string;reportUsage?:boolean;versionContentType?:string;hangVersionBody?:boolean;tagsPaddingBytes?:number;pullRawBytes?:number;loadError?:string;loadErrorStatus?:number;hangLoadBody?:boolean}
export type StubCall={method:string;path:string;body:unknown;host:string|undefined}
export async function startOllamaStub(options:StubOptions={}):Promise<{baseURL:string;port:number;calls:StubCall[];models:StubModel[];close:()=>Promise<void>;server:Server;lastPullResponse:()=>ServerResponse|null;setChatFailure:(failure:{status:number;error:string}|null)=>void}>{
 const models=[...(options.models??[])],calls:StubCall[]=[],version=options.version??'0.11.4'
 const running=new Set(options.running??[])
 let lastPull:ServerResponse|null=null,chatFailure=options.chatFailure??null
 const json=(res:ServerResponse,status:number,body:unknown)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body))}
 const server=createServer((req,res)=>{let raw='';req.on('data',c=>{raw+=c});req.on('end',()=>{
  const body=raw?JSON.parse(raw):undefined;calls.push({method:req.method!,path:req.url!,body,host:req.headers.host})
  if(req.url==='/api/version'){
   if(options.versionContentType){res.writeHead(200,{'Content-Type':options.versionContentType});return res.end('<html>not ollama</html>')}
   if(options.hangVersionBody){res.writeHead(200,{'Content-Type':'application/json'});res.write('{"version":"');return}
   return json(res,200,{version})
  }
  if(req.url==='/api/tags'&&options.tagsPaddingBytes)return json(res,200,{models:[],padding:'x'.repeat(options.tagsPaddingBytes)})
  if(req.url==='/api/tags')return json(res,200,{models:models.map(m=>({name:m.name,model:m.name,size:m.size,digest:m.digest.replace(/^sha256:/,''),modified_at:'2026-09-27T00:00:00Z',details:{family:m.family??'qwen3',parameter_size:m.parameterSize??'8B',quantization_level:'Q4_K_M'}}))})
  if(req.url==='/api/ps')return json(res,200,{models:[...running].map(name=>{const model=models.find(row=>row.name===name);return {name,digest:model?.digest.replace(/^sha256:/,''),...(model?.allocatedContext===null?{}:{context_length:model?.allocatedContext??4096})}})})
  if(req.url==='/api/chat'){
   if(options.hangLoadBody){res.writeHead(200,{'Content-Type':'application/json'});res.write('{');return}
   if(options.loadError)return json(res,options.loadErrorStatus??500,{error:options.loadError})
   const name=(body as {model:string}).model
   if(!models.some(row=>row.name===name))return json(res,404,{error:'model not found'})
   running.add(name);return json(res,200,{model:name,done:true,done_reason:'load',message:{role:'assistant',content:''}})
  }
  if(req.url==='/api/show'){const m=models.find(x=>x.name===(body as {model:string}).model);if(!m)return json(res,404,{error:'model not found'})
   return json(res,200,{details:{family:m.family??'qwen3'},model_info:{'general.architecture':'qwen3','qwen3.context_length':m.contextLength??40960},...(m.capabilities?{capabilities:m.capabilities}:{}),...(m.thinking?{thinking:m.thinking}:{})})}
  if(req.url==='/api/pull'){const name=(body as {model:string}).model;lastPull=res;res.writeHead(200,{'Content-Type':'application/x-ndjson'})
   if(options.pullError){res.end(JSON.stringify({error:options.pullError})+'\n');return}
   if(options.pullRawBytes){let sent=0;const raw=()=>{if(res.destroyed)return;res.write('x'.repeat(65_536));sent+=65_536;if(sent<options.pullRawBytes!)setImmediate(raw);else res.end('\n')};return void raw()}
   const chunks=options.pullChunks??4,total=4_000_000;let i=0
   const tick=()=>{if(res.destroyed)return;i++;res.write(JSON.stringify({status:'pulling abc',digest:'sha256:'+'a'.repeat(64),total,completed:Math.floor(total*i/chunks)})+'\n')
    if(i<chunks)return void setTimeout(tick,options.pullDelayMs??5)
    const digest=options.pulledDigest?.(name)??'sha256:'+'b'.repeat(64);if(!models.some(m=>m.name===name))models.push({name,size:total,digest})
    res.write(JSON.stringify({status:'verifying sha256 digest'})+'\n');res.end(JSON.stringify({status:'success'})+'\n')}
   return void setTimeout(tick,options.pullDelayMs??5)}
  if(req.method==='DELETE'&&req.url==='/api/delete'){const name=(body as {model:string}).model;const i=models.findIndex(m=>m.name===name);if(i<0)return json(res,404,{error:'model not found'});models.splice(i,1);running.delete(name);return json(res,200,{})}
  if(req.url==='/v1/models')return json(res,200,{object:'list',data:models.map(m=>({id:m.name,object:'model',owned_by:'library'}))})
  if(req.url==='/v1/chat/completions'){const reply=options.chatReply??'桩 Ollama 回复：你好。'
   if(chatFailure)return json(res,chatFailure.status,{error:{message:chatFailure.error,type:'server_error'}})
   // 完整宿主验收需要非零用量锚点；这是桩的确定性估计，不是真实 tokenizer。
   const promptTokens=Math.ceil(JSON.stringify((body as any).messages).length/4)+Math.ceil(JSON.stringify((body as any).tools??[]).length/4)
   const completionTokens=Math.ceil(reply.length/2)
   const usage=options.reportUsage?{prompt_tokens:promptTokens,completion_tokens:completionTokens,total_tokens:promptTokens+completionTokens}:undefined
   if((body as {stream?:boolean}).stream){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(`data: ${JSON.stringify({id:'c1',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:reply},finish_reason:null}]})}\n\n`);res.write(`data: ${JSON.stringify({id:'c1',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}],...(usage?{usage}:{})})}\n\n`);return res.end('data: [DONE]\n\n')}
   return json(res,200,{id:'c1',object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:reply},finish_reason:'stop'}],usage:usage??{prompt_tokens:1,completion_tokens:1,total_tokens:2}})}
  json(res,404,{error:'not found'})})})
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>r()))
 const port=(server.address() as {port:number}).port
 return {baseURL:`http://127.0.0.1:${port}`,port,calls,models,server,lastPullResponse:()=>lastPull,setChatFailure:failure=>{chatFailure=failure},close:()=>new Promise(r=>{server.closeAllConnections();server.close(()=>r())})}
}
