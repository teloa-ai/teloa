import {createServer,type Server,type ServerResponse} from 'node:http'

/**
 * 远程备用桩：按 Anthropic Messages 协议（DSH 0.1.7-rc.1 官方 `llm-deepseek` 适配器的线协议）在 127.0.0.1:0 回复固定文本。
 * 只用于本地 HTTP 故障切换验收；不代表任何真实云端、不核对密钥内容。
 */
export type MessagesStubCall={method:string;path:string;body:unknown;headers:Record<string,string|string[]|undefined>}
/** 脚本化回复：按请求体决定回文本还是发起一次 tool_use；未提供时固定回复 reply。 */
export type MessagesStubTurn={text:string}|{toolUse:{name:string;input:Record<string,unknown>}}
export type MessagesStubOptions={reply?:string;failure?:{status:number;type:string;message:string}|null;script?:(body:{model?:string;messages?:{role:string;content:unknown}[];tools?:{name:string}[]})=>MessagesStubTurn}
export async function startAnthropicMessagesStub(options:MessagesStubOptions={}):Promise<{baseURL:string;port:number;calls:MessagesStubCall[];server:Server;setFailure:(failure:MessagesStubOptions['failure'])=>void;close:()=>Promise<void>}>{
 const calls:MessagesStubCall[]=[],reply=options.reply??'远程备用桩回复。'
 let failure=options.failure??null
 const json=(res:ServerResponse,status:number,body:unknown)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body))}
 const server=createServer((req,res)=>{let raw='';req.on('data',chunk=>{raw+=chunk});req.on('end',()=>{
  const body=raw?JSON.parse(raw):undefined
  calls.push({method:req.method!,path:req.url!,body,headers:{'x-api-key':req.headers['x-api-key'],'anthropic-version':req.headers['anthropic-version'],'x-deepseek-harness-compact':req.headers['x-deepseek-harness-compact']}})
  if(req.method!=='POST'||req.url!=='/v1/messages')return json(res,404,{type:'error',error:{type:'not_found_error',message:'not found'}})
  if(failure)return json(res,failure.status,{type:'error',error:{type:failure.type,message:failure.message}})
  const model=(body as {model?:string})?.model??'unknown'
  const turn:MessagesStubTurn=options.script?options.script((body??{}) as Parameters<NonNullable<MessagesStubOptions['script']>>[0]):{text:reply}
  const inputTokens=Math.ceil(raw.length/4),outputTokens=Math.ceil(JSON.stringify(turn).length/2)
  res.writeHead(200,{'Content-Type':'text/event-stream'})
  const event=(type:string,data:unknown)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...(data as object)})}\n\n`)
  event('message_start',{message:{id:'msg_stub',type:'message',role:'assistant',model,content:[],stop_reason:null,usage:{input_tokens:inputTokens,output_tokens:0}}})
  if('text' in turn){
   event('content_block_start',{index:0,content_block:{type:'text',text:''}})
   event('content_block_delta',{index:0,delta:{type:'text_delta',text:turn.text}})
   event('content_block_stop',{index:0})
   event('message_delta',{delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:outputTokens}})
  }else{
   event('content_block_start',{index:0,content_block:{type:'tool_use',id:'toolu_stub_'+calls.length,name:turn.toolUse.name,input:{}}})
   event('content_block_delta',{index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(turn.toolUse.input)}})
   event('content_block_stop',{index:0})
   event('message_delta',{delta:{stop_reason:'tool_use',stop_sequence:null},usage:{output_tokens:outputTokens}})
  }
  event('message_stop',{})
  res.end()
 })})
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',()=>done()))
 const port=(server.address() as {port:number}).port
 return {baseURL:`http://127.0.0.1:${port}`,port,calls,server,setFailure:next=>{failure=next??null},close:()=>new Promise(done=>{server.closeAllConnections();server.close(()=>done())})}
}
