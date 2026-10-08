import assert from 'node:assert/strict'
import test from 'node:test'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {captureRetrievalPreparation} from '@teloa/contract'
import {retrievalPreparationDetails} from '../../../local-embedding/src/preparation-details.ts'
import manifest from '../../../local-embedding/runtime/assets.json' with {type:'json'}
registerHooks({
 resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
})
const {createLocalRetrievalApi,readRetrievalModelStatus,readRetrievalStatus}=await import('../lib/types/client/local-retrieval-api.js')
const {LocalRetrievalModelPresentation}=await import('../lib/types/client/LocalRetrievalModelPanel.js')
const {LocalRetrievalResourcesPresentation}=await import('../lib/types/client/LocalRetrievalResources.js')
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')
const {LOCAL_RETRIEVAL_MESSAGE_ROWS}=await import('../lib/types/client/i18n/locales/local-retrieval.js')
const details=retrievalPreparationDetails('fp32','/host/models/fp32','/host/runtime')
const provider={id:'qwen3-embedding-0.6b',location:'host-local',catalogId:'teloa.model.qwen3-embedding-0-6b',catalogVersion:'1.0.0',profileHash:'a'.repeat(64),variant:'fp32',totalMemoryBytes:8*1024**3,memoryRisk:true,preparation:{phase:'unprepared'},preparationDetails:details}
const model={enabled:true,provider,building:false,guidance:null}
const resource={id:'resource-one',sourceId:'knowledge_one',title:'检索测试资料',status:'active'}
const index={items:[{sourceId:resource.sourceId,resourceId:resource.id,title:resource.title,version:1,state:'stale',chunkCount:null}],enrolled:1,chunks:0,building:false}
const t=(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params)
const modelProps={status:model,catalogId:provider.catalogId,catalogVersion:provider.catalogVersion,confirming:false,busy:false,error:'',t,onAsk:()=>{},onConfirm:()=>{},onDismiss:()=>{},onCancel:()=>{},onBack:()=>{},onExtensions:()=>{}}
const renderModel=(patch={})=>renderToStaticMarkup(createElement(LocalRetrievalModelPresentation,{...modelProps,...patch} as never))
const renderIndex=(patch={})=>renderToStaticMarkup(createElement(LocalRetrievalResourcesPresentation,{status:index,resource,busy:false,error:'',t,onEnroll:()=>{},onRemove:()=>{},onReindex:()=>{},onCancel:()=>{},...patch} as never))

test('准备详情逐文件来自固定 manifest，确认总数包含 shared 分词器；读取不安装或下载',()=>{
 assert.deepEqual(details.files.map(f=>[f.path,f.bytes,f.sha256]),manifest.files.map(f=>[f.path,f.bytes,f.sha256]))
 assert.equal(details.files.reduce((n,f)=>n+f.bytes,0),2_412_031_754)
 assert.equal(details.runtime.version,'1.30.0')
 assert.equal(details.license,manifest.model.upstream.license)
})
test('模型严格读取：拒绝未知键、假本地、非法内存、阶段和不完整/多余准备信息',()=>{
 assert.deepEqual(readRetrievalModelStatus(model),model)
 assert.equal(readRetrievalModelStatus({...model,enabled:false,provider:null}).provider,null)
 for(const patch of [{extra:true},{enabled:false},{provider:{...provider,location:'browser'}},{provider:{...provider,totalMemoryBytes:NaN}},{provider:{...provider,preparation:{phase:'ready',extra:true}}},{provider:{...provider,preparationDetails:{...details,files:[]}}},{provider:{...provider,preparationDetails:{...details,runtime:{...details.runtime,url:'https://secret.invalid/?token=abc'}}}}]){
  assert.throws(()=>readRetrievalModelStatus({...model,...patch}))
 }
})
test('索引严格读取对齐真后端：一来源多资料允许；不可用行不携带旧资料信息',()=>{
 const multiple={...index,items:[...index.items,{...index.items[0],resourceId:'resource-two'}]}
 assert.equal(readRetrievalStatus(multiple).items.length,2)
 assert.equal(readRetrievalStatus({...index,items:[{sourceId:'removed',resourceId:null,title:null,version:null,state:'unavailable',chunkCount:null}]}).items[0]?.state,'unavailable')
 for(const value of [{...index,building:'yes'},{...index,enrolled:0},{...index,items:[index.items[0],index.items[0]]},{...index,items:[{...index.items[0],state:'unavailable'}]},{...index,items:[{...index.items[0],state:'complete'}]},{...index,items:[{...index.items[0],chunkCount:-1}]},{...index,path:'/host/private'}])assert.throws(()=>readRetrievalStatus(value))
})
test('全部八个 RPC 路由使用既有 payload 和请求 signal；只读不会准备',async()=>{
 const calls:{endpoint:string,payload:unknown,signal?:AbortSignal}[]=[]
 const api=createLocalRetrievalApi(async(endpoint,payload,signal)=>{calls.push({endpoint,payload,...(signal?{signal}:{})});return endpoint.startsWith('retrieval-model/')?model:index})
 const signal=new AbortController().signal
 await api.modelStatus(signal);await api.status(signal)
 assert.deepEqual(calls.map(c=>c.endpoint),['retrieval-model/status','retrieval/status'])
 await api.prepare(captureRetrievalPreparation(provider as never),signal);await api.cancelPreparation(signal);await api.enroll('source-a',signal);await api.remove('source-a',signal);await api.reindex(signal);await api.cancel(signal)
 assert.deepEqual(calls.map(c=>c.endpoint),['retrieval-model/status','retrieval/status','retrieval-model/prepare','retrieval-model/cancel','retrieval/enroll','retrieval/remove','retrieval/reindex','retrieval/cancel'])
 assert.deepEqual(calls[2]?.payload,{expected:captureRetrievalPreparation(provider as never)})
 assert.deepEqual(calls[4]?.payload,{sourceIds:['source-a']});assert.deepEqual(calls[5]?.payload,{sourceIds:['source-a']})
 assert.ok(calls.every(c=>c.signal===signal));assert.deepEqual(calls[7]?.payload,{})
})
test('首屏保持简洁；确认态完整显示容量、来源、许可、路径和硬件未验口径',()=>{
 const first=renderModel()
 assert.match(first,/准备检索模型/);assert.doesNotMatch(first,/registry.npmjs.org|host\/models|SHA-256/)
 const confirmation=renderModel({confirming:true})
 for(const text of ['registry.npmjs.org','huggingface.co','onnxruntime-node@1.30.0','Apache-2.0','社区转换','不是原厂发布的文件','M1/M2 8GB','尚未实机验收','host/models/fp32','host/runtime','SHA-256','确认下载并准备'])assert.ok(confirmation.includes(text),text)
 assert.match(confirmation,/2,093,436,928 B/)
})
test('未启用仅引导扩展；版本不符、无详情或 INT8 均不能准备；语音不进入本面板',()=>{
 const disabled=renderModel({status:{...model,enabled:false,provider:null},confirming:true})
 assert.match(disabled,/前往扩展/);assert.doesNotMatch(disabled,/确认下载并准备|<button[^>]*>准备检索模型/)
 for(const p of [{...provider,catalogVersion:'2.0.0'},{...provider,preparationDetails:undefined},{...provider,variant:'int8'}]){
  assert.match(renderModel({status:{...model,provider:p}}),/disabled=""[^>]*>准备检索模型/)
 }
 assert.notDeepEqual(captureRetrievalPreparation(provider as never),captureRetrievalPreparation({...provider,preparationDetails:{...details,modelDirectory:'/changed'}} as never))
})
test('两段进度、不知道总量时的不定进度、取消收尾与可重试失败',()=>{
 for(const stage of ['runtime','assets']){
  const html=renderModel({status:{...model,provider:{...provider,preparation:{phase:'downloading',stage,resource:'model.onnx',completedBytes:20,totalBytes:100}}}})
  assert.match(html,stage==='runtime'?/第 1 步：推理程序/:/第 2 步：模型文件/);assert.match(html,/<progress[^>]*value="20"[^>]*max="100"/);assert.match(html,/取消准备/);assert.match(html,/20 B/);assert.match(html,/100 B/)
 }
 const indefinite=renderModel({status:{...model,provider:{...provider,preparation:{phase:'downloading',stage:'runtime',resource:'runtime',completedBytes:0}}}})
 assert.doesNotMatch(indefinite,/<progress[^>]*value=/)
 assert.match(renderModel({status:{...model,provider:{...provider,preparation:{phase:'cancelling',startedAt:1}}}}),/disabled=""[^>]*>取消准备/)
 const failed=renderModel({status:{...model,provider:{...provider,preparation:{phase:'failed',message:'SECRET ?token=abc',download:{resource:'model.onnx',source:'huggingface.co',reason:'integrity'}}}}})
 assert.match(failed,/完整性校验失败/);assert.match(failed,/准备检索模型/);assert.doesNotMatch(failed,/SECRET|token=abc/)
})
test('资料页显示已加入份数、加入移出、重建/停止整理、所有索引状态及撤回行；索引块数只在技术详情里',()=>{
 assert.match(renderIndex(),/已加入 1 份资料/);assert.match(renderIndex(),/>移出</)
 assert.match(renderIndex({status:{...index,items:[{...index.items[0],chunkCount:3}],chunks:3}}),/<summary>技术详情<\/summary>[\s\S]*3 个索引块/)
 assert.match(renderIndex({status:{items:[],enrolled:0,chunks:0,building:false}}),/>加入</)
 assert.match(renderIndex({status:{...index,building:true}}),/停止整理/)
 assert.match(renderIndex({busy:true}),/disabled=""[^>]*>处理中/)
 for(const state of ['building','ready','failed','stale'])assert.ok(renderIndex({status:{...index,items:[{...index.items[0],state}]}}).includes(t('retrieval.index.'+state)))
 assert.match(renderIndex({status:{...index,items:[{sourceId:'removed',resourceId:null,title:null,version:null,state:'unavailable',chunkCount:null}]}}),/资料当前不可用/)
})
test('新增 10 主语言文案键唯一、列完整、占位符保持一致',()=>{
 const keys=new Set<string>()
 for(const row of LOCAL_RETRIEVAL_MESSAGE_ROWS){
  assert.equal(row.length,11);assert.ok(!keys.has(row[0]));keys.add(row[0])
  const placeholders=(s:string)=>[...s.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort()
  for(const text of row.slice(1)){assert.ok(text.trim());assert.deepEqual(placeholders(text),placeholders(row[1]))}
 }
})
test('确认提交重读身份/工件，未确认、版本漂移和等待期间取消均不发 prepare',async()=>{
 const {prepareConfirmedModel}=await import('../lib/types/client/LocalRetrievalModelPanel.js')
 const calls:string[]=[]
 let value:unknown=model
 const api=createLocalRetrievalApi(async endpoint=>{calls.push(endpoint);return value})
 const target={catalogId:provider.catalogId,catalogVersion:provider.catalogVersion},fingerprint=captureRetrievalPreparation(provider as never)
 await assert.rejects(()=>prepareConfirmedModel(api,undefined,target,new AbortController().signal))
 assert.deepEqual([...calls],[])
 value={...model,provider:{...provider,profileHash:'b'.repeat(64)}}
 await assert.rejects(()=>prepareConfirmedModel(api,fingerprint,target,new AbortController().signal))
 assert.deepEqual([...calls],['retrieval-model/status'])
 value=model
 await prepareConfirmedModel(api,fingerprint,target,new AbortController().signal)
 assert.deepEqual([...calls],['retrieval-model/status','retrieval-model/status','retrieval-model/prepare'])
 let release!:(value:unknown)=>void
 const delayed=createLocalRetrievalApi(async endpoint=>{calls.push(endpoint);return new Promise(resolve=>{release=resolve})})
 const controller=new AbortController(),pending=prepareConfirmedModel(delayed,fingerprint,target,controller.signal)
 controller.abort();release(model)
 await assert.rejects(pending)
 assert.equal(calls.filter(c=>c==='retrieval-model/prepare').length,1)
})
test('已准备的待机态不再要求下载；读取失败禁写但操作错误仍可重试',()=>{
 assert.doesNotMatch(renderModel({status:{...model,provider:{...provider,preparation:{phase:'standby'}}}}),/<button[^>]*>准备检索模型/)
 assert.match(renderModel({readFailed:true,error:'bad reply'}),/disabled=""[^>]*>准备检索模型/)
 assert.doesNotMatch(renderModel({error:'transient error'}),/disabled=""[^>]*>准备检索模型/)
 assert.match(renderIndex({readFailed:true}),/disabled=""[^>]*>移出</)
})
test('资料控制不接受草稿；呈现层事件仅传 sourceId，移出不会撤回原资料',()=>{
 const calls:string[]=[]
 const tree=LocalRetrievalResourcesPresentation({status:index,resource,busy:false,error:'',t,onEnroll:(id:string)=>calls.push('enroll:'+id),onRemove:(id:string)=>calls.push('remove:'+id),onReindex:()=>calls.push('rebuild'),onCancel:()=>calls.push('cancel')} as never)
 const find=(node:unknown,label:string):any=>{
  if(!node||typeof node!=='object')return
  if(Array.isArray(node)){for(const child of node){const result=find(child,label);if(result)return result};return}
  const props=(node as any).props
  if(props?.children===label&&typeof props?.onClick==='function')return props
  return find(props?.children,label)
 }
 find(tree,t('retrieval.resources.remove')).onClick()
 assert.deepEqual([...calls],['remove:'+resource.sourceId])
 assert.doesNotMatch(renderIndex({resource:undefined}),/<button[^>]*>加入</)
 assert.match(renderIndex({resource:{...resource,status:'withdrawn'},status:{items:[],enrolled:0,chunks:0,building:false}}),/disabled=""[^>]*>加入</)
})

test('同来源另一份资料可用，不把已撤回的选中版本标为索引可用',()=>{
 const html=renderIndex({resource:{...resource,title:'已撤回版本',status:'withdrawn'},status:{...index,items:[{...index.items[0],resourceId:'other-active',state:'ready',chunkCount:2}]}})
 assert.match(html,/已撤回版本 · 资料当前不可用/)
 assert.doesNotMatch(html,/已撤回版本 · 已加入/)
 assert.match(html,/>移出</)
})
test('审查 P2-1：真实 ResourceSpec 合法标题在 status/enroll 中均可读',async()=>{
 const {isResourceSpec}=await import('@teloa/contract')
 for(const title of ['👩‍💻 研发手册','段落\n手册','零\u200b宽','内\u0000嵌','x'.repeat(200)]){
  assert.equal(isResourceSpec({title,sourceId:'source',sourceVersion:'a'.repeat(64),scopeIds:['general']}),true)
  const value={...index,items:[{...index.items[0],title}]}
  const api=createLocalRetrievalApi(async()=>value)
  assert.equal((await api.status()).items[0]?.title,title)
  assert.equal((await api.enroll('source')).items[0]?.title,title)
 }
 for(const title of ['', ' \n ', 'x'.repeat(201)])assert.throws(()=>readRetrievalStatus({...index,items:[{...index.items[0],title}]}))
})
test('审查 P3-2：同源多份资料时写明会一起移出，撤回选择也不误导',()=>{
 const status={...index,items:[{...index.items[0],resourceId:'active-b'},{...index.items[0],resourceId:'active-c'}]}
 const html=renderIndex({status,resource:{...resource,status:'withdrawn'}})
 assert.match(html,/检索测试资料 · 资料当前不可用/)
 assert.match(html,/同一来源的 2 份资料会一起移出/)
 assert.doesNotMatch(renderIndex(),/会一起移出/,'只有一份时不多说')
})
test('确认卡的下载来源单选：官方默认选中，镜像写明第三方与可见信息；选择随本次准备提交，缺省载荷不变',async()=>{
 const confirmation=renderModel({confirming:true})
 for(const text of ['下载来源','Hugging Face 官方（默认）','国内镜像 hf-mirror.com','第三方社区镜像','被改动的文件会被发现并拒收','本机 IP'])assert.ok(confirmation.includes(text),text)
 assert.doesNotMatch(confirmation,/无法被篡改/)
 assert.doesNotMatch(confirmation,/实际从/,'选官方时不显示镜像说明')
 assert.doesNotMatch(confirmation,/<input[^>]*disabled=""/)
 const mirrorChosen=renderModel({confirming:true,source:'hf-mirror'})
 assert.match(mirrorChosen,/文件列表显示的是官方地址，本次实际从 hf-mirror\.com 下载/)
 for(const patch of [{busy:true},{readFailed:true}])assert.equal((renderModel({confirming:true,...patch}).match(/<input(?=[^>]*type="radio")(?=[^>]*disabled="")[^>]*>/g)??[]).length,2,JSON.stringify(patch))
 assert.equal((confirmation.match(/type="radio"/g)??[]).length,2)
 assert.match(confirmation,/<input(?=[^>]*value="official")(?=[^>]*checked="")[^>]*>/)
 assert.match(renderModel({confirming:true,source:'hf-mirror'}),/<input(?=[^>]*value="hf-mirror")(?=[^>]*checked="")[^>]*>/)
 const legacy=renderModel({confirming:true,status:{...model,provider:{...provider,preparationDetails:{...details,downloadSources:undefined}}}})
 assert.doesNotMatch(legacy,/type="radio"|国内镜像/)
 const failed=renderModel({status:{...model,provider:{...provider,preparation:{phase:'failed',message:'x',download:{resource:'tokenizer.json',source:'hf-mirror.com',reason:'integrity'}}}}})
 assert.match(failed,/改用 Hugging Face 官方来源重试/)
 const calls:unknown[]=[]
 const api=createLocalRetrievalApi(async(_endpoint,payload)=>{calls.push(payload);return model})
 const {prepareConfirmedModel}=await import('../lib/types/client/LocalRetrievalModelPanel.js')
 const expected=captureRetrievalPreparation(provider as never),target={catalogId:provider.catalogId,catalogVersion:provider.catalogVersion}
 await prepareConfirmedModel(api,expected,target,new AbortController().signal,'hf-mirror')
 await prepareConfirmedModel(api,expected,target,new AbortController().signal)
 assert.deepEqual(calls.filter((_row,i)=>i%2===1),[{expected,source:'hf-mirror'},{expected}])
})

test('本地检索区块只呈现用途和真实状态，不再常驻工程操作说明',()=>{
 const plain=(html:string)=>html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ')
 const excluded=renderIndex({status:{items:[],enrolled:0,chunks:0,building:false}})
 assert.match(plain(excluded),/本地检索 开启后，员工会在需要时自动查找你加入的资料。/)
 assert.match(plain(excluded),/已加入 0 份资料/)
 assert.doesNotMatch(excluded,/索引块/,'统计不再报索引块数')
 assert.match(plain(excluded),/检索测试资料 · 未加入 加入/)
 assert.doesNotMatch(plain(excluded),/需要先在市场|模型就绪|打开资料页时|索引块/)
 assert.doesNotMatch(excluded,/来源与许可|加入与移出均按资料来源生效|取消保留已完成索引/)
 const ready={items:[{...index.items[0],state:'ready',chunkCount:4},{sourceId:'knowledge_two',resourceId:'resource-two',title:'第二份资料',version:2,state:'stale',chunkCount:null}],enrolled:2,chunks:4,building:false}
 const enrolled=renderIndex({status:ready})
 assert.match(plain(enrolled),/已加入 2 份资料/)
 assert.match(plain(enrolled),/检索测试资料 · 已加入 · 可以查找 移出/)
 assert.match(plain(enrolled),/第二份资料 · 已加入 · 等待整理 移出/)
 assert.equal((enrolled.match(/检索测试资料 · 已加入/g)??[]).length,1,'选中的资料已加入时不重复一行')
 // 重建收进「更多」；索引块数只在技术详情里
 assert.match(enrolled,/<details[^>]*data-retrieval-more[^>]*><summary[^>]*>更多<\/summary>[\s\S]*重建索引[\s\S]*<\/details>/)
 assert.match(enrolled,/<details[^>]*><summary[^>]*>技术详情<\/summary>[\s\S]*4 个索引块[\s\S]*<\/details>/)
 // 整理进行中：停止整理就近可点，不藏进更多
 assert.match(plain(renderIndex({status:{...ready,building:true}})),/已加入 2 份资料 停止整理/)
 const calls:string[]=[]
 const tree=LocalRetrievalResourcesPresentation({status:ready,resource,busy:false,error:'',t,onEnroll:(id:string)=>calls.push('enroll:'+id),onRemove:(id:string)=>calls.push('remove:'+id),onReindex:()=>calls.push('rebuild'),onCancel:()=>calls.push('cancel')} as never)
 const buttons=(node:any):any[]=>!node||typeof node!=='object'?[]:Array.isArray(node)?node.flatMap(buttons):[...(typeof node.props?.onClick==='function'?[node.props]:[]),...buttons(node.props?.children)]
 buttons(tree).find(props=>props.children===t('retrieval.resources.rebuild')).onClick()
 buttons(tree).filter(props=>props.children===t('retrieval.resources.remove'))[1].onClick()
 assert.deepEqual(calls,['rebuild','remove:knowledge_two'])
})

test('EmbeddingGemma 2可按受审provider准备并显式选用，默认读取和取消仍兼容',async()=>{
 const {ollamaPreparationDetails}=await import('../../../local-embedding/src/ollama.ts')
 const gemma={...provider,id:'embeddinggemma-2',catalogId:'teloa.model.embeddinggemma-2',variant:'ollama',preparationDetails:ollamaPreparationDetails()}
 const status={...model,provider:gemma,selectedProviderId:'qwen3-embedding-0.6b'}
 const calls:{endpoint:string,payload:unknown}[]=[]
 const api=createLocalRetrievalApi(async(endpoint,payload)=>{calls.push({endpoint,payload});return status})
 await api.modelStatus(undefined,'embeddinggemma-2')
 const {prepareConfirmedModel}=await import('../lib/types/client/LocalRetrievalModelPanel.js')
 await prepareConfirmedModel(api,captureRetrievalPreparation(gemma as never),{catalogId:gemma.catalogId,catalogVersion:gemma.catalogVersion},new AbortController().signal)
 await api.select('embeddinggemma-2',gemma.profileHash)
 await api.cancelPreparation(undefined,'embeddinggemma-2')
 assert.deepEqual(calls.map(c=>c.payload),[{providerId:'embeddinggemma-2'},{providerId:'embeddinggemma-2'},{expected:captureRetrievalPreparation(gemma as never)},{providerId:'embeddinggemma-2',profileHash:gemma.profileHash},{providerId:'embeddinggemma-2'}])
 const ready={...status,provider:{...gemma,preparation:{phase:'ready'}}}
 assert.match(renderModel({status:ready,catalogId:gemma.catalogId,onSelect:()=>{}}),/>使用此模型</)
 const selected=renderModel({status:{...ready,selectedProviderId:gemma.id},catalogId:gemma.catalogId,onSelect:()=>{}})
 assert.match(selected,/data-retrieval-selected="true"[^>]*>[\s\S]*当前使用/)
 assert.doesNotMatch(selected,/>使用此模型<|正在用于知识库检索/)
})
test('就地首次开启只突出一次下载与自动整理，细节收起；准备中没有绕过收尾的第二个取消',()=>{
 const first=renderModel({compact:true,joining:true,confirming:true})
 assert.match(first,/首次使用需下载/);assert.match(first,/准备好后会自动整理这份资料/)
 assert.match(first,/<details><summary>下载详情<\/summary>/)
 assert.match(first,/>下载并开启</)
 const progress=renderModel({compact:true,status:{...model,provider:{...provider,preparation:{phase:'downloading',stage:'assets',resource:'model.onnx',completedBytes:20,totalBytes:100}}}})
 assert.match(progress,/<button[^>]*disabled=""[^>]*aria-label="关闭模型设置"|<button[^>]*aria-label="关闭模型设置"[^>]*disabled=""/)
 assert.match(progress,/取消准备/);assert.doesNotMatch(progress,/model.onnx|第 2 步/)
 assert.match(renderModel({compact:true,error:'未能加入，请重试',status:{...model,provider:{...provider,preparation:{phase:'ready'}}},onRetry:()=>{}}),/>重试加入</)
})

test('查看检索模型不承诺自动加入资料，首次准备后仍须明确选择',()=>{
 const preview=renderModel({compact:true,confirming:true})
 assert.match(preview,/准备好后可选择用于知识库检索/)
 assert.doesNotMatch(preview,/自动整理这份资料|下载并开启/)
})
