import {Server} from '@modelcontextprotocol/sdk/server/index.js'
import {ListToolsRequestSchema,CallToolRequestSchema,type CallToolResult} from '@modelcontextprotocol/sdk/types.js'
import {setTimeout as pause} from 'node:timers/promises'
import {WorkError,readHardwarePrepare,readHardwareOperationId,type HardwareRequestPort} from '@teloa/contract'

/** 只有三项原助手操作；管理入口不注册到 MCP。 */
export function createXiaozhiServer(requests:HardwareRequestPort):Server{
 const server=new Server({name:'teloa-squirrel',version:'1.0.0'},{capabilities:{tools:{}}})
 const idSchema={type:'string',format:'uuid'}
 const tools=[
  {name:'teloa_request_prepare',description:'把用户本轮话语准备为 Teloa 原助手请求，不执行。返回 operationId 后调用 submit。回执未知应查询原操作，不重新准备。',inputSchema:{type:'object' as const,properties:{text:{type:'string',minLength:1,maxLength:8000}},required:['text'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false}},
  {name:'teloa_request_submit',description:'提交 prepare 返回的 operationId。相同操作不会重复执行。pending 表示仍在工作；needs_approval 请用户到 Teloa 原审批处理；unknown 只能 result 查询。',inputSchema:{type:'object' as const,properties:{operationId:idSchema},required:['operationId'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true}},
  {name:'teloa_request_result',description:'等待刚才原请求的结果，最多等候 8 秒，不会重做。省略 operationId 时先选该连接最近一项，等待期间保持原编号。按 speakableText 直接播报真实结果，不能把受理当完成。',inputSchema:{type:'object' as const,properties:{operationId:idSchema},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true}},
 ]
 let active=0
 const failure=(message:string):CallToolResult=>({isError:true,content:[{type:'text',text:message}]})
 const waitResult=async(id:string|undefined,signal:AbortSignal)=>{
  const deadline=performance.now()+8000
  signal.throwIfAborted()
  let value=await requests.result(id)
  const operationId=id??value.operationId
  while(true){
   signal.throwIfAborted()
   if(value.operationId!==operationId)throw new WorkError('teloa/forbidden','原请求不匹配。')
   if(!['pending','unknown'].includes(value.state)||performance.now()>=deadline)return value
   await pause(Math.min(250,Math.max(1,deadline-performance.now())),undefined,{signal})
   value=await requests.result(operationId)
  }
 }
 server.setRequestHandler(ListToolsRequestSchema,async()=>({tools}))
 server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
  if(active>=2)return failure('当前连接正忙，请查询原操作或稍后再试。')
  active++
  try{
   const args=request.params.arguments??{}
   const value=request.params.name==='teloa_request_prepare'?await requests.prepare(readHardwarePrepare(args).text)
    :request.params.name==='teloa_request_submit'?await requests.submit(readHardwareOperationId(args).operationId!,extra.signal)
    :request.params.name==='teloa_request_result'?await waitResult(readHardwareOperationId(args,true).operationId,extra.signal)
    :null
   if(!value)return failure('未提供此工具。')
   return {content:[{type:'text' as const,text:JSON.stringify(value)}],structuredContent:{...value}}
  }catch(error){
   const code=error instanceof WorkError?error.code:''
   return failure(code==='teloa/invalid-input'?'工具参数不正确。':code==='teloa/forbidden'?'当前连接无权执行或读取此操作。':code==='teloa/conflict'?'原操作尚待处理，请查询原操作。':'Teloa 暂时无法处理，请查询原操作。')
  }
  finally{active--}
 })
 return server
}
