import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {TeloaFeedbackModel,sendTeloaFeedback,type FeedbackPayload} from '../src/client/TeloaFeedbackClient.ts'

const receipt={stored:true as const,receiptId:'TF-0fc6a648-d1bf-4a69-9f3c-9342f9e5b6a7',notification:'sent' as const}
test('发送只包含所填字段，不带Cookie、引用来源、会话或日志',async()=>{
  let sent:RequestInit|undefined
  const result=await sendTeloaFeedback({requestId:crypto.randomUUID(),category:'bug',message:'填写的问题内容',email:''},async(url,init)=>{
    assert.equal(url,'https://feedback.teloa.ai/v1/feedback');sent=init
    return Response.json(receipt,{status:201})
  })
  assert.equal(result.ok,true)
  assert.equal(sent?.credentials,'omit')
  assert.equal(sent?.referrerPolicy,'no-referrer')
  assert.equal(sent?.redirect,'error')
  assert.deepEqual(Object.keys(JSON.parse(sent?.body as string)).sort(),['category','email','message','requestId'])
})
test('产品内附带 appVersion；官网模型不给版本时载荷保持四个字段',async()=>{
  const bodies:Record<string,unknown>[]=[]
  const fetcher=async(_url:string|URL|Request,init?:RequestInit)=>{bodies.push(JSON.parse(init?.body as string));return Response.json(receipt,{status:201})}
  assert.equal((await sendTeloaFeedback({requestId:crypto.randomUUID(),category:'bug',message:'填写的问题内容',email:'',appVersion:'0.2.0-alpha.3'},fetcher)).ok,true)
  assert.deepEqual(bodies[0],{...bodies[0],appVersion:'0.2.0-alpha.3'});assert.deepEqual(Object.keys(bodies[0]!).sort(),['appVersion','category','email','message','requestId'])
  assert.equal((await sendTeloaFeedback({requestId:crypto.randomUUID(),category:'bug',message:'填写的问题内容',email:'',appVersion:'dev'},fetcher)).ok,true)
  assert.deepEqual(Object.keys(bodies[1]!).sort(),['category','email','message','requestId'],'不合法版本不发送')
  const payloads:FeedbackPayload[]=[]
  const model=new TeloaFeedbackModel(async payload=>{payloads.push(payload);return {ok:true,receipt}},'0.2.0-alpha.3')
  model.edit({message:'用户填写的问题'});await model.submit()
  assert.equal(payloads[0]?.appVersion,'0.2.0-alpha.3')
  const web=new TeloaFeedbackModel(async payload=>{payloads.push(payload);return {ok:true,receipt}})
  web.edit({message:'用户填写的问题'});await web.submit()
  assert.equal('appVersion' in payloads[1]!,false)
})
test('产品内两个反馈入口（会话内与关于页）都带应用版本',()=>{
  for(const file of ['TeloaFeedbackIntegration.ts','AboutSettings.tsx']){
    const source=readFileSync(new URL(`../src/client/${file}`,import.meta.url),'utf8')
    const calls=[...source.matchAll(/new TeloaFeedbackModel\(([^)]*)\)/g)].map(match=>match[1])
    assert.ok(calls.length>0,file)
    for(const args of calls)assert.equal(args,'undefined,__TELOA_VERSION__',file)
  }
})
test('兼容旧服务的邮件失败回执且只接受合法收讫回包',async()=>{
  const draft={requestId:crypto.randomUUID(),category:'other' as const,message:'用户补充的信息',email:''}
  assert.deepEqual(await sendTeloaFeedback(draft,async()=>Response.json({...receipt,notification:'failed'},{status:202})),{ok:true,receipt:{...receipt,notification:'failed'}})
  for(const body of [{ok:true},{stored:true,receiptId:'1',notification:'sent'},{...receipt,notification:'unknown'}])assert.equal((await sendTeloaFeedback(draft,async()=>Response.json(body))).ok,false)
})
test('发送失败保留草稿与requestId；编辑后才产生新requestId',async()=>{
  const payloads:FeedbackPayload[]=[]
  const model=new TeloaFeedbackModel(async payload=>{payloads.push(payload);return {ok:false,error:'network'}})
  model.edit({message:'用户填写的问题',email:'me@example.com'})
  await model.submit();await model.submit()
  assert.equal(payloads.length,2)
  assert.equal(payloads[0]?.requestId,payloads[1]?.requestId)
  assert.equal(model.getSnapshot().draft.message,'用户填写的问题')
  model.edit({message:'用户补充过的问题'})
  await model.submit()
  assert.notEqual(payloads[1]?.requestId,payloads[2]?.requestId)
})
test('并发点击只发送一次，忙时拒绝编辑；已收讫禁止重复发送',async()=>{
  let finish:(value:{ok:true;receipt:typeof receipt})=>void=()=>{},calls=0
  const model=new TeloaFeedbackModel(()=>{calls++;return new Promise(resolve=>{finish=resolve})})
  model.edit({message:'用户填写的问题'})
  const pending=model.submit();model.edit({message:'不能覆盖在途内容'})
  await model.submit()
  assert.equal(calls,1)
  assert.equal(model.getSnapshot().draft.message,'用户填写的问题')
  finish({ok:true,receipt});await pending;await model.submit()
  assert.equal(calls,1)
  assert.equal(model.getSnapshot().receipt?.receiptId,receipt.receiptId)
})
test('内容、类别和邮箱不合格时留在表单，发送函数不执行',async()=>{
  let calls=0
  const model=new TeloaFeedbackModel(async()=>{calls++;return {ok:true,receipt}})
  await model.submit()
  model.edit({message:'已有足够的内容',email:'invalid'})
  await model.submit()
  assert.equal(calls,0)
  assert.equal(model.getSnapshot().error,'invalid')
})
test('资源反馈：构造时带资源，提交载荷含 resource；编辑换请求编号但资源不变；reset 后资源仍在',async()=>{
  const resource={entryId:'openai.security-best-practices',version:'1.0.0'}
  const payloads:FeedbackPayload[]=[]
  const model=new TeloaFeedbackModel(async payload=>{payloads.push(payload);return {ok:false,error:'network'}},'0.2.0-alpha.7',resource)
  assert.deepEqual(model.resource,resource)
  model.edit({message:'装好以后跑不起来'});await model.submit()
  model.edit({message:'装好以后完全跑不起来'});await model.submit()
  assert.deepEqual(payloads.map(payload=>payload.resource),[resource,resource])
  assert.notEqual(payloads[0]?.requestId,payloads[1]?.requestId)
  assert.equal(payloads[0]?.appVersion,'0.2.0-alpha.7')
  model.reset();model.edit({message:'再报一个问题'});await model.submit()
  assert.deepEqual(payloads[2]?.resource,resource)
  const plain=new TeloaFeedbackModel(async payload=>{payloads.push(payload);return {ok:true,receipt}})
  plain.edit({message:'没有资源的反馈'});await plain.submit()
  assert.equal('resource' in payloads[3]!,false);assert.equal(plain.resource,undefined)
  for(const bad of [{entryId:'../x',version:'1.0.0'},{entryId:'single',version:'1.0.0'},{entryId:'openai.x',version:'v1'},{entryId:'openai.x',version:''}]){
    const invalid=new TeloaFeedbackModel(async payload=>{payloads.push(payload);return {ok:true,receipt}},undefined,bad)
    invalid.edit({message:'资源参数不合法'});await invalid.submit()
    assert.equal('resource' in payloads.at(-1)!,false,JSON.stringify(bad));assert.equal(invalid.resource,undefined)
  }
})
test('sendTeloaFeedback 只在资源文法合法时发送 resource（只取两键），与 worker 同一文法',async()=>{
  const bodies:Record<string,unknown>[]=[]
  const fetcher=async(_url:string|URL|Request,init?:RequestInit)=>{bodies.push(JSON.parse(init?.body as string));return Response.json(receipt,{status:201})}
  const base={requestId:crypto.randomUUID(),category:'bug' as const,message:'填写的问题内容',email:''}
  for(const resource of [{entryId:'openai.security-best-practices',version:'1.0.0'},{entryId:'teloa.model.local.llama3.1',version:'2.0.0-alpha.1'}]){
    await sendTeloaFeedback({...base,resource:{...resource,extra:'x'} as NonNullable<FeedbackPayload['resource']>},fetcher)
    assert.deepEqual(bodies.at(-1)?.resource,resource)
    assert.deepEqual(Object.keys(bodies.at(-1)!),['requestId','category','message','email','resource'])
  }
  for(const resource of [{entryId:'../x',version:'1.0.0'},{entryId:'a.'+'b'.repeat(119),version:'1.0.0'},{entryId:'openai.x',version:'1.0'},{entryId:1,version:'1.0.0'}]){
    await sendTeloaFeedback({...base,resource:resource as NonNullable<FeedbackPayload['resource']>},fetcher)
    assert.equal('resource' in bodies.at(-1)!,false,JSON.stringify(resource))
  }
  const client=readFileSync(new URL('../src/client/TeloaFeedbackClient.ts',import.meta.url),'utf8')
  for(const name of ['resourceEntryIdPattern','resourceVersionPattern']){
    const pick=(source:string)=>source.match(new RegExp(`^(?:export )?const ${name}=(/.+/)$`,'m'))?.[1]
  }
})
test('反馈表单：模型带资源时顶部显示反馈的资源（标题、标识与版本）；不带资源时不显示',async()=>{
  const {registerHooks}=await import('node:module')
  registerHooks({
    resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
    load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
  })
  const {createElement}=await import('react'),{renderToStaticMarkup}=await import('react-dom/server')
  const {TeloaFeedbackForm}=await import('../lib/types/client/TeloaFeedback.js')
  const {I18nProvider}=await import('../lib/types/client/i18n/provider.js')
  const {translateMessage}=await import('../lib/types/client/i18n/messages.js')
  const render=(model:TeloaFeedbackModel,locale:'zh-CN'|'en',resourceTitle?:string)=>renderToStaticMarkup(createElement(I18nProvider,{runtime:{t:(key:string,params?:Record<string,string|number>)=>translateMessage(locale,key as never,params),subscribe:()=>()=>{},getSnapshot:()=>({locale,dshLocale:locale==='en'?'en':'zh',revision:1})}} as never,createElement(TeloaFeedbackForm,{model,onClose:()=>{},...(resourceTitle?{resourceTitle}:{})} as never)))
  const resource={entryId:'openai.security-best-practices',version:'1.0.0'}
  const zh=render(new TeloaFeedbackModel(undefined,'0.2.0-alpha.7',resource),'zh-CN','安全最佳实践')
  const describedBy=zh.match(/<dialog [^>]*aria-describedby="([^"]+)"/)?.[1]
  assert.ok(describedBy)
  assert.ok(zh.includes(`</header><p id="${describedBy}" class="resource">反馈的资源：安全最佳实践（openai.security-best-practices v1.0.0）</p>`))
  assert.match(render(new TeloaFeedbackModel(undefined,'0.2.0-alpha.7',resource),'en','Security best practices'),/About: Security best practices \(openai\.security-best-practices v1\.0\.0\)/)
  const plain=render(new TeloaFeedbackModel(undefined,'0.2.0-alpha.7'),'zh-CN')
  assert.doesNotMatch(plain,/反馈的资源/);assert.doesNotMatch(plain,/<dialog [^>]*aria-describedby=/)
  // 没给标题时以资源标识代替，不留空括号
  assert.match(render(new TeloaFeedbackModel(undefined,'0.2.0-alpha.7',resource),'zh-CN'),/反馈的资源：openai\.security-best-practices（openai\.security-best-practices v1\.0\.0）/)
})
test('反馈表单：系统菜单与市场资源反馈同时打开时 DOM id 不重复，标签与描述都指向本实例',async()=>{
  // 单独运行本用例时也要能加载 CSS 模块
  const {registerHooks}=await import('node:module')
  registerHooks({
    resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
    load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
  })
  const {createElement,Fragment}=await import('react'),{renderToStaticMarkup}=await import('react-dom/server')
  const {TeloaFeedbackForm}=await import('../lib/types/client/TeloaFeedback.js')
  const {I18nProvider}=await import('../lib/types/client/i18n/provider.js')
  const {translateMessage}=await import('../lib/types/client/i18n/messages.js')
  const form=(model:TeloaFeedbackModel)=>createElement(TeloaFeedbackForm,{model,onClose:()=>{}} as never)
  const html=renderToStaticMarkup(createElement(I18nProvider,{runtime:{t:(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params),subscribe:()=>()=>{},getSnapshot:()=>({locale:'zh-CN',dshLocale:'zh',revision:1})}} as never,
    createElement(Fragment,null,form(new TeloaFeedbackModel(undefined,'0.2.0-alpha.7')),form(new TeloaFeedbackModel(undefined,'0.2.0-alpha.7',{entryId:'openai.security-best-practices',version:'1.0.0'})))))
  const ids=[...html.matchAll(/ id="([^"]+)"/g)].map(match=>match[1]!)
  assert.ok(ids.length>=10,'两个表单各自的标题、说明与字段都有 id')
  assert.equal(new Set(ids).size,ids.length,'id 重复：'+ids.join(','))
  const references=[...html.matchAll(/ (?:for|aria-labelledby|aria-describedby)="([^"]+)"/g)].map(match=>match[1]!)
  assert.ok(references.length>=8)
  for(const reference of references)assert.ok(ids.includes(reference),'引用了不存在的 id：'+reference)
})
