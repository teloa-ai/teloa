import assert from 'node:assert/strict'
import type {TestContext} from 'node:test'

/** 只供显式真实资源验收使用；取消后等待操作退出，不用 Promise.race 遗留后台任务。 */
export class LiveAcceptanceScope{
 readonly signal:AbortSignal
 private readonly stop=new AbortController()
 private readonly pending=new Set<Promise<unknown>>()
 constructor(parent:AbortSignal){this.signal=AbortSignal.any([parent,this.stop.signal])}
 run<T>(timeoutMs:number,operation:(signal:AbortSignal)=>Promise<T>,signals:readonly AbortSignal[]=[]):Promise<T>{
  const deadline=new AbortController()
  const timer=setTimeout(()=>deadline.abort(new DOMException('验收操作超时','TimeoutError')),timeoutMs)
  const signal=AbortSignal.any([this.signal,deadline.signal,...signals])
  const work=Promise.resolve().then(async()=>{
   signal.throwIfAborted()
   const result=await operation(signal)
   signal.throwIfAborted()
   return result
  }).finally(()=>{clearTimeout(timer);this.pending.delete(work)})
  this.pending.add(work)
  return work
 }
 async close():Promise<void>{
  this.stop.abort(new DOMException('验收作用域已结束','AbortError'))
  while(this.pending.size)await Promise.allSettled([...this.pending])
 }
}

/** node:test 超时不等待测试主体；after 必须等待主体和清理，才能释放共享状态。 */
export function withLiveAcceptance<T>(test:Pick<TestContext,'signal'|'after'>,body:(scope:LiveAcceptanceScope)=>Promise<T>,cleanup:()=>void|Promise<void>):Promise<T>{
 const scope=new LiveAcceptanceScope(test.signal)
 const work=Promise.resolve().then(async()=>{
  try{scope.signal.throwIfAborted();return await body(scope)}
  finally{await scope.close();await cleanup()}
 })
 test.after(async()=>{await Promise.allSettled([work])})
 return work
}

/** 强制禁止自动跳转，保留 Request 和调用方的取消信号；规则在任何传输之前检查。 */
export function acceptanceFetch(scope:LiveAcceptanceScope,transport:typeof fetch,allow:(url:URL,method:string)=>void,timeoutMs:number):typeof fetch{
 return (input,init)=>new Promise<Response>((resolve,reject)=>{
  const request=input instanceof Request?input:undefined
  void scope.run(timeoutMs,async signal=>{
   const url=new URL(request?request.url:String(input)),method=(init?.method??request?.method??'GET').toUpperCase()
   allow(url,method)
   const response=await transport(input,{...init,method,signal,redirect:'error'})
   if(response.redirected||(response.status>=300&&response.status<400)){
    await response.body?.cancel()
    assert.fail('验收请求不允许重定向')
   }
   if(!response.body){resolve(response);return}
   // fetch 返回响应头不等于请求结束；管道保留背压，并等待正文消费或取消真正完成。
   let controller!:TransformStreamDefaultController<Uint8Array>
   const stream=new TransformStream<Uint8Array,Uint8Array>({start(value){controller=value}})
   // 消费方尚未读取时，先解除背压中的写入，pipeTo 才能完成源流取消。
   const abort=()=>controller.error(signal.reason)
   signal.addEventListener('abort',abort,{once:true})
   try{
    if(signal.aborted)abort()
    const forwarded=new Response(stream.readable,{status:response.status,statusText:response.statusText,headers:response.headers})
    Object.defineProperty(forwarded,'url',{value:response.url})
    const finished=response.body.pipeTo(stream.writable,{signal})
    resolve(forwarded)
    await finished
   }finally{signal.removeEventListener('abort',abort)}
  },[request?.signal,init?.signal].filter((signal):signal is AbortSignal=>signal!=null)).catch(reject)
 })
}

export function modelAcceptanceFetch(scope:LiveAcceptanceScope,transport:typeof fetch,address:URL):typeof fetch{
 assert.ok(address.protocol==='http:'&&address.hostname==='127.0.0.1'&&address.port&&!['3001','3100','60154','11434'].includes(address.port)&&address.pathname==='/'&&!address.username&&!address.password&&!address.search&&!address.hash,'只允许显式隔离本地模型地址')
 const origin=address.origin
 return acceptanceFetch(scope,transport,(url,method)=>{
  assert.equal(url.origin,origin,'模型请求必须保持精确隔离 origin')
  assert.ok(!url.username&&!url.password&&!url.search&&!url.hash,'模型请求不得包含用户信息、查询或片段')
  assert.ok((url.pathname==='/api/tags'&&method==='GET')||(url.pathname==='/v1/chat/completions'&&method==='POST'),'模型请求路径或方法不在验收范围')
 },180000)
}

export function readAcceptanceTags(scope:LiveAcceptanceScope,transport:typeof fetch,address:URL):Promise<{models:{name:string;digest:string}[]}>{
 return scope.run(5000,async signal=>{
  const response=await transport(address.origin+'/api/tags',{signal})
  assert.ok(response.ok,'本地模型 tags 请求必须成功')
  return await response.json() as {models:{name:string;digest:string}[]}
 })
}
