import type {ImBinding} from '../src/core/bindings.ts'

export const roleA={id:'0f9e8d7c-6b5a-4433-9211-0fedcba98765',name:'小王',version:3,state:'active'}
export const groupId='1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d'

/** 假 teloaWork：按端点回桩数据并记录每次调用（端点 + payload）。 */
export function fakeWork(overrides:Record<string,(payload:Record<string,unknown>)=>unknown>={}){
 const calls:{endpoint:string;payload:Record<string,unknown>;signal?:AbortSignal}[]=[]
 let session=0
 const ready=new Set<string>()
 const handlers:Record<string,(payload:Record<string,unknown>)=>unknown>={
  'conversations/create':()=>{const sessionId=`s${++session}`;ready.add(sessionId);return {id:`c${session}`,sessionId,status:'ready'}},
  'conversations/read':payload=>{if(!ready.has(String(payload.sessionId)))throw Object.assign(new Error('not bound'),{code:'teloa/not-bound'});return {sessionId:payload.sessionId,status:'ready'}},
  'roles/list':()=>[roleA,{id:'9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d',name:'老李',version:1,state:'retired'}],
  'object-conversations/list':()=>[],
  'object-conversations/change':payload=>({...payload,version:1,active:true}),
  'groups/get':()=>({group:{id:groupId,version:7},members:[]}),
  // 真实回包是 GroupMessage 本身（CollaborationService.send）。
  'groups/messages/send':()=>({id:'m1',groupId,rootId:null,authorId:'self',text:'',references:[],createdAt:'2026-09-26T00:00:01.000Z'}),
  'tasks/list':()=>[{title:'写周报',state:'running'},{title:'整理发票',state:'waiting'}],
  'tasks/attention':()=>({items:[{task:{},attention:{kind:'review',reason:'task-waiting'}},{task:{},attention:null}]}),
  'security-actions/attention':()=>[{id:'x'}],
  ...overrides,
 }
 const work={
  async invoke(endpoint:string,payload:unknown,signal?:AbortSignal){
   calls.push({endpoint,payload:payload as Record<string,unknown>,...(signal?{signal}:{})})
   const handler=handlers[endpoint]
   if(!handler)throw new Error('未桩端点 '+endpoint)
   return handler(payload as Record<string,unknown>)
  },
 }
 return {work,calls,ready,of:(endpoint:string)=>calls.filter(call=>call.endpoint===endpoint)}
}

export function fakeSessionController(){
 const prompts:{request:{requestId:string;sessionId:string;mode:string;content:{type:string;text:string}[]};signal:AbortSignal}[]=[]
 const cancels:{sessionId:string}[]=[]
 const controller={
  async prompt(request:never,signal:AbortSignal){prompts.push({request,signal});return {accepted:true as const}},
  cancel(request:{sessionId:string}){cancels.push(request);return {accepted:true as const}},
 }
 return {controller:controller as never,prompts,cancels}
}

export const bindingOf=(patch:Partial<ImBinding>={}):ImBinding=>({channelId:'telegram',imUserId:'u1',ownerId:'local:teloa-owner',displayName:'张三',boundAt:'2026-09-26T00:00:00.000Z',target:{kind:'assistant'},...patch})
