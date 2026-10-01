import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readdir,readFile} from 'node:fs/promises'
import {createGroupAttachmentHandler,createGroupAttachmentUploadRoute,groupAttachmentEndpoints,toBackendBytePorts} from '../src/group-attachments.ts'
import {createAttachmentPorts} from '../src/attachments.ts'
import {WorkError,groupAttachmentUploadMaxBodyBytes,groupAttachmentUploadRoutePath} from '@teloa/contract'
import type {GroupAttachment} from '@teloa/contract'
import {isPendingRequestEndpoint} from '@teloa/backend'

const owner='local:owner',groupId=randomUUID()
const attachmentId='sha256:'+'a'.repeat(64)
const stamp='2026-09-21T00:00:00.000Z'

const file=(over:Partial<GroupAttachment>={}):GroupAttachment=>({
 attachmentId,ownerId:owner,version:1,kind:'file',mime:'text/markdown',bytes:3,sha256:'b'.repeat(64),
 name:'样本.md',width:null,height:null,uploadedInGroupId:groupId,state:'active',createdAt:stamp,withdrawnAt:null,...over,
})
const bytes={attachmentId,version:1 as const,mime:'text/markdown',bytes:3,sha256:'b'.repeat(64),name:'样本.md',dataBase64:'AAAA'}
const upload={requestId:randomUUID(),groupId,expectedVersion:1,mime:'text/markdown',name:'样本.md',dataBase64:'AAAA'}
const withdraw={requestId:randomUUID(),attachmentId}

function stand(results:{upload?:unknown;list?:unknown;read?:unknown;withdraw?:unknown}={}){
 const calls:{name:string;owner:string;input:unknown;signal:AbortSignal}[]=[]
 const record=(name:string,value:unknown)=>async(actor:string,input:unknown,signal:AbortSignal)=>{calls.push({name,owner:actor,input,signal});return value}
 const service={
  upload:record('upload',results.upload??file()),
  list:record('list',results.list??[file()]),
  read:record('read',results.read??bytes),
  withdraw:record('withdraw',results.withdraw??file({state:'withdrawn',withdrawnAt:stamp})),
 }
 return {calls,handle:createGroupAttachmentHandler(owner,async()=>service)}
}

test('群附件四端点固定宿主本人、逐条下传 signal，并按契约封装回包',async()=>{
 const {calls,handle}=stand(),signal=new AbortController().signal
 assert.deepEqual([...groupAttachmentEndpoints],['groups/attachments/upload','groups/attachments/list','groups/attachments/read','groups/attachments/withdraw'])
 assert.deepEqual(await handle('groups/attachments/upload',upload,signal),{attachment:file()})
 assert.deepEqual(await handle('groups/attachments/list',{groupId},signal),{items:[file()]})
 assert.deepEqual(await handle('groups/attachments/read',{attachmentId},signal),{bytes})
 assert.deepEqual(await handle('groups/attachments/withdraw',withdraw,signal),{attachment:file({state:'withdrawn',withdrawnAt:stamp})})
 assert.deepEqual(calls.map(call=>[call.name,call.owner]),[['upload',owner],['list',owner],['read',owner],['withdraw',owner]])
 assert.ok(calls.every(call=>call.signal===signal))
 // 服务收到的是解析器归一化之后的入参，不是浏览器原样交来的对象。
 assert.deepEqual(calls[0]?.input,upload)
 assert.notEqual(calls[0]?.input,upload)
})

test('不在四条里的端点即 not-found；服务未就绪显式失败；入参未过解析器前不得到达服务',async()=>{
 let opened=0
 const handle=createGroupAttachmentHandler(owner,async()=>{opened++;return undefined}),signal=new AbortController().signal
 await assert.rejects(handle('groups/attachments/purge',{},signal),{code:'teloa/not-found'})
 await assert.rejects(handle('groups/attachments/upload',{...upload,ownerId:'other'},signal),{code:'teloa/invalid-input'})
 await assert.rejects(handle('groups/attachments/list',{groupId,ownerId:'other'},signal),{code:'teloa/invalid-input'})
 // read 是本人级原件读口，混入 groupId 同样算未知字段。
 await assert.rejects(handle('groups/attachments/read',{attachmentId,groupId},signal),{code:'teloa/invalid-input'})
 await assert.rejects(handle('groups/attachments/withdraw',{...withdraw,groupId},signal),{code:'teloa/invalid-input'})
 assert.equal(opened,0)
 await assert.rejects(handle('groups/attachments/list',{groupId},signal),{code:'teloa/host-unavailable'})
 assert.equal(opened,1)
})

test('白名单外的 MIME 在宿主这一层就被拒，服务零调用',async()=>{
 const {calls,handle}=stand(),signal=new AbortController().signal
 for(const [mime,name] of [['image/svg+xml','图.svg'],['application/zip','包.zip'],['text/html','页.html']]){
  await assert.rejects(handle('groups/attachments/upload',{...upload,mime,name},signal),{code:'teloa/invalid-input'})
 }
 // GIF 走文件通道，仍在白名单里：这一条钉住「拒的是三类，不是顺手把 GIF 一起拒了」。
 await handle('groups/attachments/upload',{...upload,mime:'image/gif',name:'动画验收.gif'},signal)
 assert.deepEqual(calls.map(call=>call.name),['upload'])
})

test('回包逐层投影核对：形状不合契约或跨本人一律 invalid-host-response',async()=>{
 const signal=new AbortController().signal
 const reject=async(results:Parameters<typeof stand>[0],endpoint:string,payload:unknown)=>{
  await assert.rejects(stand(results).handle(endpoint,payload,signal),{code:'teloa/invalid-host-response'})
 }
 await reject({upload:{...file(),ownerId:'other'}},'groups/attachments/upload',upload)
 await reject({upload:{...file(),extra:1}},'groups/attachments/upload',upload)
 // kind='file' 不得带 width/height（编排者裁定 1：GIF 也走文件通道，没有像素事实）。
 await reject({upload:file({width:128,height:96})},'groups/attachments/upload',upload)
 // 反过来同样不许：伪造 kind='image' 却没有像素事实，判定器与 DDL 的 check 是同一条口径。
 await reject({upload:file({kind:'image'})},'groups/attachments/upload',upload)
 await reject({list:file()},'groups/attachments/list',{groupId})
 await reject({list:[file({ownerId:'other'})]},'groups/attachments/list',{groupId})
 await reject({read:{...bytes,dataBase64:'AAAAAA=='}},'groups/attachments/read',{attachmentId})
 await reject({withdraw:file({state:'withdrawn',withdrawnAt:null})},'groups/attachments/withdraw',withdraw)
})

test('后端 WorkError 原样透传：四端点各自的失败对象连实例都不换',async()=>{
 const signal=new AbortController().signal
 const failures=[
  ['groups/attachments/upload',upload,new WorkError('teloa/conflict','同一附件上传请求不能更换内容。')],
  ['groups/attachments/list',{groupId},new WorkError('teloa/version-conflict','群资料版本已变化。')],
  ['groups/attachments/read',{attachmentId},new WorkError('teloa/forbidden','附件不存在、已撤回或不属于当前本人。')],
  ['groups/attachments/withdraw',withdraw,new WorkError('teloa/storage-corrupt','附件记录已损坏。')],
 ] as const
 for(const [endpoint,payload,expected] of failures){
  const handle=createGroupAttachmentHandler(owner,async()=>({
   upload:async()=>{throw expected},list:async()=>{throw expected},read:async()=>{throw expected},withdraw:async()=>{throw expected},
  }))
  await assert.rejects(handle(endpoint,payload,signal),error=>error===expected)
 }
})

test('已取消的请求在解析之后、进服务之前就停住，服务零调用',async()=>{
 const {calls,handle}=stand(),controller=new AbortController()
 controller.abort()
 for(const [endpoint,payload] of [['groups/attachments/upload',upload],['groups/attachments/list',{groupId}],['groups/attachments/read',{attachmentId}],['groups/attachments/withdraw',withdraw]] as const){
  await assert.rejects(handle(endpoint,payload,controller.signal))
 }
 assert.deepEqual(calls,[])
 // 取消判在解析之后：不合法的入参仍按 invalid-input 作答，不被取消掩盖。
 await assert.rejects(handle('groups/attachments/list',{groupId,ownerId:'other'},controller.signal),{code:'teloa/invalid-input'})
})

/** 与 `@deepseek-ai/dsh-attachment` 的 AttachmentError 同形：按 `code` 路由，不按原型链。 */
class AttachmentError extends Error {
 readonly code:string
 constructor(message:string,code:string){super(message);this.name='AttachmentError';this.code=code}
}

function storeStub(behaviour:{throws?:unknown}={}){
 const seen:unknown[]=[]
 const guard=()=>{if(behaviour.throws)throw behaviour.throws}
 return {
  seen,
  store:{
   saveImage:async(input:{data:Uint8Array;mediaType:string;name?:string})=>{seen.push(['saveImage',input.mediaType,input.name]);guard();return {attachmentId,mediaType:'image/webp',bytes:input.data.length,width:128,height:96}},
   saveFile:async(input:{data:Uint8Array;name?:string})=>{seen.push(['saveFile',input.name]);guard();return {attachmentId,name:'样本.md',bytes:input.data.length}},
   readImage:async(ref:unknown,signal?:AbortSignal)=>{seen.push(['readImage',ref,signal]);guard();return {data:Uint8Array.from([1,2,3])}},
   readFileStream:async function*(ref:unknown,signal?:AbortSignal){seen.push(['readFileStream',ref,signal]);guard();yield Uint8Array.from([4,5,6])},
  },
 }
}

test('四方法端口折成后端三方法端口：按 kind 分流取字节，图片带归一化事实、文件带清洗叶名',async()=>{
 const stub=storeStub(),signal=new AbortController().signal,ports=toBackendBytePorts(createAttachmentPorts(stub.store),signal)
 assert.deepEqual(await ports.saveImage('AAAA','image/png','图.png'),{attachmentId,mediaType:'image/webp',bytes:3,width:128,height:96})
 assert.deepEqual(await ports.saveFile('AAAA','样本.md'),{attachmentId,name:'样本.md',bytes:3})
 assert.deepEqual([...await ports.readBytes({attachmentId,kind:'image',mime:'image/webp',bytes:3,name:'图.png',width:128,height:96})],[1,2,3])
 assert.deepEqual([...await ports.readBytes({attachmentId,kind:'file',mime:'text/markdown',bytes:3,name:'样本.md',width:null,height:null})],[4,5,6])
 assert.deepEqual(stub.seen,[
  ['saveImage','image/png','图.png'],
  ['saveFile','样本.md'],
  ['readImage',{attachmentId,mediaType:'image/webp',bytes:3,width:128,height:96},signal],
  ['readFileStream',{attachmentId,name:'样本.md',bytes:3},signal],
 ])
 // 像素事实缺了就是行坏了：不拿 0 去凑一个必定被附件仓拒绝的引用。
 assert.throws(()=>ports.readBytes({attachmentId,kind:'image',mime:'image/webp',bytes:3,name:'图.png',width:null,height:null}),{code:'teloa/storage-corrupt',message:'附件像素事实缺失。'})
})

test('附件仓写失败折成 dependency-unavailable：不带 details，文案里没有 DSH 码',async()=>{
 const stub=storeStub({throws:new AttachmentError('normalized image still carries metadata','ATTACHMENT_WRITE_FAILED')})
 const ports=toBackendBytePorts(createAttachmentPorts(stub.store))
 for(const call of [()=>ports.saveImage('AAAA','image/png','图.png'),()=>ports.saveFile('AAAA','样本.md')]){
  const error=await call().then(()=>undefined,(reason:unknown)=>reason)
  assert.equal((error as {code:string}).code,'teloa/dependency-unavailable')
  assert.equal((error as {message:string}).message,'附件存储当前不可用，请稍后再试。')
  assert.equal((error as {details?:unknown}).details,undefined)
  assert.doesNotMatch((error as {message:string}).message,/ATTACHMENT_|DSH/)
 }
})

test('endpointSet 守卫：四条端点必须同时进 endpointSet 与分发链，且全 src 只有一处清单',async()=>{
 const root=new URL('../src/',import.meta.url)
 const source=await readFile(new URL('index.ts',root),'utf8')
 const line=source.split('\n').find(row=>row.startsWith('const endpointSet=new Set('))
 assert.ok(line,'index.ts 里找不到 endpointSet 的声明行')
 assert.match(line,/\.\.\.groupAttachmentEndpoints/)
 // RPC 入口按 endpointSet 判 not-found：这一行没了，进不进 endpointSet 就不再有后果。
 assert.match(source,/if\(!endpointSet\.has\(endpoint\)\)/)
 assert.match(source,/\(groupAttachmentEndpoints as readonly string\[\]\)\.includes\(endpoint\)\?await groupAttachmentHandler\(endpoint,payload,signal\)/)
 // 端点字面量只许出现在 group-attachments.ts 的那一份清单里，避免有人另起一份绕过 endpointSet。
 for(const entry of await readdir(root,{withFileTypes:true})){
  if(!entry.isFile()||!entry.name.endsWith('.ts')||entry.name==='group-attachments.ts')continue
  const text=await readFile(new URL(entry.name,root),'utf8')
  for(const endpoint of groupAttachmentEndpoints)assert.doesNotMatch(text,new RegExp(`["'\`]${endpoint}["'\`]`),`${entry.name} 里不得出现 ${endpoint} 的字面量`)
 }
})

test('待恢复目录白名单：withdraw 已入白名单；upload 受 100 KB 载荷上限所阻，两边都不许默默漂移',()=>{
 assert.equal(isPendingRequestEndpoint('groups/attachments/withdraw'),true)
 /*
  * 编排者裁定要求 upload 一并入白名单，但 pending-requests.ts 的 safePayload 有 maxRequestBytes=100_000：
  * upload 的载荷含至多 16 MiB（文件档）的 dataBase64，入白名单后所有超过约 73 KiB 的上传会在 reserve() 处
  * 被判 teloa/invalid-input「待恢复请求内容过大。」，等于把功能拦死；且目录会为每次上传再存一份
  * 至多 16 MiB 的 base64。上传现已改走 `/api` 下的专用流式路由、不经 /teloa，更不经待恢复目录；
  * 这条断言钉住当前状态不让它单边漂移。
  */
 assert.equal(isPendingRequestEndpoint('groups/attachments/upload'),false)
})

// ─── 上传专用路由（审查 M1）：先判长再加锁，边读边计数，不整包缓冲 ───────────────────────────────

/** 可观测的请求体：记下是否被读过、读了多少块，用来证明「拒绝发生在读体之前」「锁在读体之前」。 */
function body(text:string,chunk=4){
 const bytes=Buffer.from(text),state={pulls:0}
 let offset=0
 const stream=new ReadableStream<Uint8Array>({pull(controller){
  state.pulls++
  if(offset>=bytes.length){controller.close();return}
  controller.enqueue(bytes.subarray(offset,offset+chunk));offset+=chunk
 }},{highWaterMark:0})
 return {stream,state,length:bytes.length}
}
const post=(stream:ReadableStream<Uint8Array>,headers:Record<string,string>)=>new Request('http://127.0.0.1'+groupAttachmentUploadRoutePath,{method:'POST',headers,body:stream,duplex:'half'} as RequestInit)
const json={'content-type':'application/json'}

test('上传路由：精确路径、只收 POST、请求体流式交付',()=>{
 const route=createGroupAttachmentUploadRoute(async()=>({}))
 assert.equal(route.path,groupAttachmentUploadRoutePath)
 assert.deepEqual([...route.methods],['POST'])
 assert.equal(route.requestBody,'streaming')
})

test('上传路由：缺长度、长度超档、非 JSON 在读请求体之前就拒，处理器零调用',async()=>{
 let handled=0
 const route=createGroupAttachmentUploadRoute(async()=>{handled++;return {}})
 const cases:[Record<string,string>,number][]=[
  [{...json},411],
  [{...json,'content-length':'abc'},411],
  [{...json,'content-length':String(groupAttachmentUploadMaxBodyBytes+1)},413],
  [{'content-type':'text/plain','content-length':'10'},415],
 ]
 for(const [headers,status] of cases){
  const probe=body('{"a":1}')
  const response=await route.fetch(post(probe.stream,headers))
  assert.equal(response.status,status,JSON.stringify(headers))
  const result=await response.json() as {ok:boolean;error:{code:string}}
  assert.equal(result.ok,false);assert.equal(result.error.code,'teloa/invalid-input')
  assert.equal(probe.state.pulls,0,'拒绝发生在读请求体之前')
 }
 assert.equal(handled,0)
})

test('上传路由：实际字节多于声明长度即中止读取并拒，不读到底',async()=>{
 let handled=0
 const route=createGroupAttachmentUploadRoute(async()=>{handled++;return {}})
 const probe=body(JSON.stringify({x:'y'.repeat(400)}))
 const response=await route.fetch(post(probe.stream,{...json,'content-length':'16'}))
 assert.equal(response.status,400)
 assert.equal(((await response.json()) as {error:{code:string}}).error.code,'teloa/invalid-input')
 assert.ok(probe.state.pulls<=6,'超出声明长度后不再继续读：实际读了 '+probe.state.pulls+' 块')
 assert.equal(handled,0)
})

test('上传路由：合法请求把解析后的载荷交给上传端点，回包与 /teloa 同形；业务失败回 ok:false 原码',async()=>{
 const seen:{endpoint:string;payload:unknown}[]=[]
 const route=createGroupAttachmentUploadRoute(async(endpoint,payload)=>{seen.push({endpoint,payload});if((payload as {fail?:boolean}).fail)throw new WorkError('teloa/conflict','附件总量已达上限，请先撤回不再需要的附件。');return {attachment:{id:1}}})
 const ok=body(JSON.stringify({a:1}))
 const response=await route.fetch(post(ok.stream,{...json,'content-length':String(ok.length)}))
 assert.equal(response.status,200)
 assert.deepEqual(await response.json(),{ok:true,value:{attachment:{id:1}}})
 assert.deepEqual(seen,[{endpoint:'groups/attachments/upload',payload:{a:1}}])
 const bad=body(JSON.stringify({fail:true}))
 const failed=await route.fetch(post(bad.stream,{...json,'content-length':String(bad.length)}))
 assert.deepEqual(await failed.json(),{ok:false,error:{code:'teloa/conflict',message:'附件总量已达上限，请先撤回不再需要的附件。',details:{}}})
 const broken=body('{not json')
 const invalid=await route.fetch(post(broken.stream,{...json,'content-length':String(broken.length)}))
 assert.equal(invalid.status,400)
})

test('上传路由：非 WorkError 折成 host-unavailable 并交给日志，文案不带原因',async()=>{
 const reported:unknown[]=[]
 const route=createGroupAttachmentUploadRoute(async()=>{throw Error('磁盘满：/secret/path')},error=>reported.push(error))
 const probe=body('{}')
 const response=await route.fetch(post(probe.stream,{...json,'content-length':String(probe.length)}))
 const result=await response.json() as {ok:boolean;error:{code:string;message:string}}
 assert.equal(result.error.code,'teloa/host-unavailable')
 assert.doesNotMatch(result.error.message,/secret/)
 assert.equal(reported.length,1)
})

test('上传路由：同一本人的上传串行——后到的请求在前一个处理完之前一个字节都不读',async()=>{
 let releaseFirst!:()=>void
 const gate=new Promise<void>(done=>{releaseFirst=done})
 const order:string[]=[]
 const route=createGroupAttachmentUploadRoute(async(_endpoint,payload)=>{
  const name=(payload as {name:string}).name
  order.push('start '+name)
  if(name==='甲')await gate
  order.push('end '+name)
  return {}
 })
 const first=body(JSON.stringify({name:'甲'})),second=body(JSON.stringify({name:'乙'}))
 const a=route.fetch(post(first.stream,{...json,'content-length':String(first.length)}))
 await new Promise(done=>setTimeout(done,20))
 const b=route.fetch(post(second.stream,{...json,'content-length':String(second.length)}))
 await new Promise(done=>setTimeout(done,20))
 assert.deepEqual(order,['start 甲'])
 assert.equal(second.state.pulls,0,'前一个上传未结束时，后一个的请求体不得开始读取')
 releaseFirst()
 await Promise.all([a,b])
 assert.deepEqual(order,['start 甲','end 甲','start 乙','end 乙'])
})

test('上传路由：前一个请求失败也释放锁，后一个照常处理',async()=>{
 const route=createGroupAttachmentUploadRoute(async(_endpoint,payload)=>{if((payload as {n:number}).n===1)throw new WorkError('teloa/invalid-input','坏');return {n:(payload as {n:number}).n}})
 const one=body('{"n":1}'),two=body('{"n":2}')
 const [r1,r2]=await Promise.all([route.fetch(post(one.stream,{...json,'content-length':String(one.length)})),route.fetch(post(two.stream,{...json,'content-length':String(two.length)}))])
 assert.equal(((await r1.json()) as {ok:boolean}).ok,false)
 assert.deepEqual(await r2.json(),{ok:true,value:{n:2}})
})

test('装配：上传只经专用路由——宿主注册该 Fetch 路由，/teloa 通道对上传端点回 not-found',async()=>{
 const source=await readFile(new URL('../src/index.ts',import.meta.url),'utf8')
 assert.match(source,/connection\.fetch\.register\(createGroupAttachmentUploadRoute\(groupAttachmentHandler,/)
 assert.match(source,/if\(endpoint===groupAttachmentUploadEndpoint\)throw new WorkError\('teloa\/not-found'/)
})
