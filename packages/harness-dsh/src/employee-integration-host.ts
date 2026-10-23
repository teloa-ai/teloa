import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import type {IncomingMessage,ServerResponse} from 'node:http'
import type {Context} from '@deepseek-ai/cordis'
import {credentialKey,type CredentialProvider} from '@deepseek-ai/dsh-credentials'
import {Server} from '@modelcontextprotocol/sdk/server/index.js'
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js'
import {EmployeeIntegrationService,EmployeeApiWorkService,EmployeeApiWebhooks,type EmployeeApiRuntime,type EmployeeIntegrationIdentity} from '@teloa/backend'
import {taskInput,WorkError,type DigitalRole} from '@teloa/contract'
import {EmployeeApiError,employeeApiId,employeeApiSchemas,type EmployeeApiPermission} from '../../sdk/contract.mjs'

type WebRoute={kind:'exact'|'prefix';path:string;handler:(req:IncomingMessage,res:ServerResponse)=>void|Promise<void>}
type WebServer={register:(route:WebRoute)=>()=>void}
type Pool=EmployeeIntegrationService['pool']
type Ports={owner:string;pool:()=>Promise<Pool>;employees:()=>Promise<DigitalRole[]>;scopes:()=>Promise<readonly string[]>;runtime:EmployeeApiRuntime;admit:<T>(run:()=>Promise<T>)=>Promise<T>;report:(code:string)=>void}
export const employeeIntegrationOwnerEndpoints=['employee-integrations/list','employee-integrations/create','employee-integrations/rotate','employee-integrations/revoke','employee-integrations/deliveries','employee-integrations/retry'] as const
const toolName={listEmployees:'teloa_list_employees',startWork:'teloa_start_work',getWork:'teloa_get_work',continueWork:'teloa_continue_work',cancelWork:'teloa_cancel_work',getResult:'teloa_get_result',listEvents:'teloa_list_work_events'} as const
const identitySchema={type:'string',format:'uuid'}
const mcpTools=[
 {id:'listEmployees',permission:'read',description:'List the employee explicitly granted to this integration. Does not grant employee tools.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
 {id:'startWork',permission:'execute',description:'Accept asynchronous employee work. Persist requestId before calling; retries use the same requestId and input. Returns work ID, not a completed result.',inputSchema:{...employeeApiSchemas.StartWork,properties:{...employeeApiSchemas.StartWork.properties,requestId:identitySchema},required:[...employeeApiSchemas.StartWork.required,'requestId']}},
 {id:'getWork',permission:'read',description:'Read current work state and version, including cancellation requested versus confirmed.',inputSchema:{type:'object',properties:{workId:identitySchema},required:['workId'],additionalProperties:false}},
 {id:'continueWork',permission:'execute',description:'Start a subsequent round under the same work ID after the current round ends. Requires current version and a stable requestId. Previous fixed result excerpt is included as context.',inputSchema:{...employeeApiSchemas.ContinueWork,properties:{...employeeApiSchemas.ContinueWork.properties,workId:identitySchema,requestId:identitySchema},required:['workId','requestId',...employeeApiSchemas.ContinueWork.required]}},
 {id:'cancelWork',permission:'cancel',description:'Request cancellation of this integration’s work; poll until cancelled. Does not approve tools or affect unrelated work.',inputSchema:{...employeeApiSchemas.CancelWork,properties:{...employeeApiSchemas.CancelWork.properties,workId:identitySchema,requestId:identitySchema},required:['workId','requestId','expectedVersion']}},
 {id:'getResult',permission:'read',description:'Read the immutable saved result version and checksum. Review state is distinct from execution success.',inputSchema:{type:'object',properties:{workId:identitySchema,version:{type:'integer',minimum:1}},required:['workId'],additionalProperties:false}},
 {id:'listEvents',permission:'read',description:'Read up to 100 persisted CloudEvents after a cursor. Save nextCursor to resume.',inputSchema:{type:'object',properties:{workId:identitySchema,after:{type:'integer',minimum:0}},required:['workId'],additionalProperties:false}},
] as const
function publicError(error:unknown):EmployeeApiError{
 if(error instanceof EmployeeApiError)return error
 if(error instanceof WorkError){
  if(error.code==='teloa/invalid-input')return new EmployeeApiError('invalid_request','Please check the request against the published schema.')
  if(error.code==='teloa/forbidden')return new EmployeeApiError('forbidden','The employee or work scope is not authorized.',403)
  if(['teloa/version-conflict','teloa/conflict'].includes(error.code))return new EmployeeApiError('conflict','Configuration changed; read the current state before retrying.',409)
 }
 return new EmployeeApiError('service_unavailable','The work service is unavailable. Retry the same idempotent request later.',503)
}
const json=(res:ServerResponse,status:number,value:unknown,requestId:string)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','x-request-id':requestId});res.end(JSON.stringify(value))}
async function body(req:IncomingMessage){
 if(req.headers['content-type']?.split(';')[0]?.trim().toLowerCase()!=='application/json')throw new EmployeeApiError('invalid_request','Content-Type must be application/json.',415)
 const chunks:Buffer[]=[];let length=0
 if(Number(req.headers['content-length'])>65536)throw new EmployeeApiError('request_too_large','Request body exceeds 64 KiB.',413)
 for await(const chunk of req){length+=chunk.length;if(length>65536)throw new EmployeeApiError('request_too_large','Request body exceeds 64 KiB.',413);chunks.push(Buffer.from(chunk))}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)))}catch{throw new EmployeeApiError('invalid_request','Request body must be valid UTF-8 JSON.')}
}
function integer(value:string|null,initial?:number){if(value===null)return initial;if(!/^(0|[1-9][0-9]{0,14})$/.test(value))throw new EmployeeApiError('invalid_request','Invalid integer parameter.');return Number(value)}

/** 对外 HTTP/MCP 与内部本人凭据管理分开；不复用 Cookie、startup token、IM 或模型工具权限。 */
export function createEmployeeIntegrationHost(ctx:Context,ports:Ports){
 let cached:Promise<{keys:EmployeeIntegrationService;work:EmployeeApiWorkService;hooks:EmployeeApiWebhooks}>|undefined
 const credentials=Reflect.get(ctx,'credentials') as CredentialProvider
 const services=()=>cached??=ports.pool().then(pool=>{
  const slot=(id:string)=>credentialKey('teloa-employee-api','i'+employeeApiId(id).replaceAll('-',''))
  const secrets={write:async(id:string,secret:string)=>{await credentials.modifyRecord(slot(id),async()=>({kind:'grant',payload:{signingSecret:secret}}))},read:async(id:string)=>{const record=await credentials.readRecord(slot(id));return record?.kind==='grant'&&record.payload&&typeof record.payload==='object'&&typeof Reflect.get(record.payload,'signingSecret')==='string'?Reflect.get(record.payload,'signingSecret') as string:undefined},remove:async(id:string)=>{await credentials.deleteRecord(slot(id))}}
  const keys=new EmployeeIntegrationService(pool,secrets)
  return {keys,work:new EmployeeApiWorkService(pool,keys,ports.runtime,ports.owner),hooks:new EmployeeApiWebhooks(pool,secrets,ports.owner)}
 }).catch(error=>{cached=undefined;throw error})
 const controller=new AbortController(),transports=new Set<StreamableHTTPServerTransport>()
 let closed=false,timer:ReturnType<typeof setTimeout>|undefined,inFlight:Promise<unknown>|undefined
 const schedule=()=>{if(closed)return;timer=setTimeout(()=>{inFlight=ports.admit(async()=>{const s=await services();await s.work.tick(controller.signal,error=>ports.report(publicError(error).code));await s.hooks.tick(controller.signal)}).catch(error=>{if(!closed)ports.report(publicError(error).code)}).finally(()=>{inFlight=undefined;schedule()})},2000);timer.unref?.()}
 schedule()
 const authenticate=async(req:IncomingMessage)=>{
  const authorization=req.headers.authorization
  if(typeof authorization!=='string'||!authorization.startsWith('Bearer '))throw new EmployeeApiError('unauthorized','An integration Bearer key is required.',401)
  const identity=await (await services()).keys.authenticate(authorization.slice(7))
  if(identity.ownerId!==ports.owner)throw new EmployeeApiError('unauthorized','Invalid integration key for this host.',401)
  return identity
 }
 const runMcp=async(identity:EmployeeIntegrationIdentity,name:string,args:unknown,signal:AbortSignal)=>{
  signal.throwIfAborted();const s=await services()
  if(name===toolName.listEmployees){taskInput(args,[]);return s.work.employees(identity)}
  if(name===toolName.startWork){const r=taskInput(args,['requestId','employeeId','input','title','permissionMode','model']);const {requestId,...input}=r;return s.work.command(identity,'start',employeeApiId(requestId),input,undefined,signal)}
  if(name===toolName.getWork){const r=taskInput(args,['workId']);return s.work.get(identity,employeeApiId(r.workId))}
  if(name===toolName.continueWork||name===toolName.cancelWork){const r=taskInput(args,name===toolName.continueWork?['workId','requestId','input','expectedVersion','permissionMode','model']:['workId','requestId','expectedVersion']),{workId,requestId,...input}=r;return s.work.command(identity,name===toolName.continueWork?'continue':'cancel',employeeApiId(requestId),input,employeeApiId(workId),signal)}
  if(name===toolName.getResult){const r=taskInput(args,['workId','version']);return s.work.result(identity,employeeApiId(r.workId),r.version as number|undefined)}
  if(name===toolName.listEvents){const r=taskInput(args,['workId','after']);return s.work.events(identity,employeeApiId(r.workId),r.after===undefined?0:r.after as number)}
  throw new EmployeeApiError('not_found','Unknown employee tool.',404)
 }
 const handle=async(req:IncomingMessage,res:ServerResponse,mcp=false)=>{
  const requestId=randomUUID(),abort=new AbortController()
  const cancel=()=>{if(!res.writableEnded)abort.abort()};req.once('aborted',cancel);res.once('close',cancel)
  req.setTimeout(15_000,()=>req.destroy())
  try{
   if(closed)throw new EmployeeApiError('service_unavailable','The service is stopping.',503)
   if(req.headers.origin){let allowed=false;try{allowed=new URL(req.headers.origin).host===req.headers.host}catch{}if(!allowed)throw new EmployeeApiError('forbidden','Cross-origin browser access is not allowed.',403)}
   const url=new URL(req.url??'/', 'http://127.0.0.1')
   if(!mcp&&req.method==='GET'&&url.pathname==='/api/v1/openapi.json'){json(res,200,JSON.parse(await readFile(new URL('../../sdk/openapi.json',import.meta.url),'utf8')),requestId);return}
   const identity=await authenticate(req),s=await services()
   if(mcp){
    res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');res.setHeader('x-request-id',requestId)
    if(url.search||req.method!=='POST'){json(res,405,{error:{code:'method_not_allowed',message:'Use stateless Streamable HTTP POST.',requestId}},requestId);return}
    const parsed=await body(req),server=new Server({name:'teloa-employees',version:'1.0.0'},{capabilities:{tools:{}}})
    server.setRequestHandler(ListToolsRequestSchema,async()=>{
     await s.keys.current(s.keys.pool,identity,'read')
     return {tools:mcpTools.filter(tool=>identity.permissions.includes(tool.permission as EmployeeApiPermission)).map(tool=>({name:toolName[tool.id],description:tool.description,inputSchema:tool.inputSchema as any,annotations:{readOnlyHint:tool.permission==='read',destructiveHint:tool.permission!=='read',idempotentHint:true,openWorldHint:tool.permission!=='read'}}))}
    })
    server.setRequestHandler(CallToolRequestSchema,async request=>{try{const value=await runMcp(identity,request.params.name,request.params.arguments??{},abort.signal);return {content:[{type:'text' as const,text:JSON.stringify(value)}]}}catch(error){const value=publicError(error);return {isError:true,content:[{type:'text' as const,text:JSON.stringify({error:{code:value.code,message:value.message,requestId}})}]}}})
    const transport=new StreamableHTTPServerTransport({enableJsonResponse:true});transports.add(transport)
    res.once('close',()=>{transports.delete(transport);void server.close().catch(()=>{})})
    // 固定SDK 1.30的Transport可选回调显式带undefined，与exactOptionalPropertyTypes声明不一致。
    await server.connect(transport as Parameters<Server['connect']>[0]);await transport.handleRequest(req,res,parsed);return
   }
   const match=/^\/api\/v1\/works\/([^/]+)(?:\/(inputs|cancel|result|events))?$/.exec(url.pathname)
   const readQuery=(allowed:string[])=>{if([...url.searchParams.keys()].some(key=>!allowed.includes(key))||allowed.some(key=>url.searchParams.getAll(key).length>1))throw new EmployeeApiError('invalid_request','Unknown or repeated query parameter.')}
   let value:unknown,status=200
   if(req.method==='GET'&&url.pathname==='/api/v1/employees'){readQuery([]);value=await s.work.employees(identity)}
   else if(req.method==='POST'&&url.pathname==='/api/v1/works'){readQuery([]);value=await s.work.command(identity,'start',employeeApiId(req.headers['idempotency-key']),await body(req),undefined,abort.signal);status=202}
   else if(match){
    const id=employeeApiId(match[1]),action=match[2]
    if(req.method==='GET'&&!action){readQuery([]);value=await s.work.get(identity,id)}
    else if(req.method==='GET'&&action==='result'){readQuery(['version']);value=await s.work.result(identity,id,integer(url.searchParams.get('version')))}
    else if(req.method==='GET'&&action==='events'){readQuery(['after']);value=await s.work.events(identity,id,integer(url.searchParams.get('after'),0))}
    else if(req.method==='POST'&&(action==='inputs'||action==='cancel')){readQuery([]);value=await s.work.command(identity,action==='inputs'?'continue':'cancel',employeeApiId(req.headers['idempotency-key']),await body(req),id,abort.signal);status=202}
    else throw new EmployeeApiError('not_found','Unknown employee API operation.',404)
   }else throw new EmployeeApiError('not_found','Unknown employee API operation.',404)
   json(res,status,value,requestId)
  }catch(error){if(!res.headersSent){const value=publicError(error);if(value.status===401)res.setHeader('www-authenticate','Bearer realm="Teloa employee integrations"');json(res,value.status,{error:{code:value.code,message:value.message,requestId}},requestId)}else res.end()}
  finally{req.off('aborted',cancel);if(!mcp)res.off('close',cancel)}
 }
 const web=Reflect.get(ctx,'webServer') as WebServer
 const guarded=(mcp:boolean)=>(req:IncomingMessage,res:ServerResponse)=>ports.admit(()=>handle(req,res,mcp)).catch(()=>{if(!res.headersSent)json(res,503,{error:{code:'service_unavailable',message:'The service is stopping.',requestId:randomUUID()}},randomUUID());else res.end()})
 const unregister=[web.register({kind:'prefix',path:'/api/v1',handler:guarded(false)}),web.register({kind:'exact',path:'/mcp',handler:guarded(true)})]
 return {
  async owner(endpoint:string,payload:unknown){
   try{
   const s=await services()
   if(endpoint==='employee-integrations/list'){taskInput(payload,[]);return {items:await s.keys.list(ports.owner),employees:(await ports.employees()).filter(role=>role.kind==='employee'&&role.state==='active'&&role.responsibility),scopes:await ports.scopes()}}
   if(endpoint==='employee-integrations/create')return await s.keys.create(ports.owner,payload)
   if(endpoint==='employee-integrations/rotate')return await s.keys.rotate(ports.owner,payload)
   if(endpoint==='employee-integrations/revoke')return await s.keys.revoke(ports.owner,payload)
   if(endpoint==='employee-integrations/deliveries'){const r=taskInput(payload,['id']);return {items:await s.hooks.list(ports.owner,employeeApiId(r.id))}}
   if(endpoint==='employee-integrations/retry'){const r=taskInput(payload,['eventId']);return s.hooks.retry(ports.owner,employeeApiId(r.eventId))}
   throw new WorkError('teloa/not-found','未提供此集成管理操作。')
   }catch(error){if(error instanceof EmployeeApiError)throw new WorkError(error.status===403||error.status===401?'teloa/forbidden':'teloa/invalid-input','请核对员工身份、版本和回调地址；远程回调使用HTTPS，本机回环可使用HTTP。');throw error}
  },
  async close(){closed=true;clearTimeout(timer);controller.abort();for(const remove of unregister)remove();await Promise.allSettled([...transports].map(transport=>transport.close()));await inFlight},
 }
}
