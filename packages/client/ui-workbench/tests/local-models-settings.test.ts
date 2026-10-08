import test from 'node:test'
import assert from 'node:assert/strict'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
registerHooks({resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context)})
const {LocalModelsView}=await import('../lib/types/client/LocalModelsSettings.js')
const {createLocalModelsApi,formatBytes}=await import('../lib/types/client/local-models-api.js')
const {I18nProvider}=await import('../lib/types/client/i18n/provider.js')
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')
const {LOCAL_MODELS_MESSAGE_ROWS}=await import('../lib/types/client/i18n/locales/local-models.js')
const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1}
const runtime={t:(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot}
const row={entryId:'teloa.model.local.qwen3',version:'1.0.0',variant:0,name:'qwen3:4b',title:{'zh-CN':'通义千问 3',en:'Qwen 3'},quant:'Q4_K_M',sizeBytes:2**30,fit:'good',licenseTier:'commercial',licenseName:'Apache 2.0',licenseURL:'https://www.apache.org/licenses/LICENSE-2.0',restrictions:[],catalogDigest:'sha256:'+'a'.repeat(64),status:'not-pulled',loaded:false}
const overview={runtime:{state:'running',version:'0.11.4',outdated:false,address:{baseURL:'http://127.0.0.1:11434',custom:false,local:true}},hardware:{totalMemGb:32,unified:true,diskFreeBytes:100*2**30},rows:[row],offCatalog:[],pull:null}
const pull={pullId:'0d3b8e1e-2f0e-4c7a-9a0b-6f1a2b3c4d5e',name:'qwen3:4b',phase:'pulling',completed:50,total:100,error:null}
const no=()=>{}
const render=(props:Record<string,unknown>={})=>renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime as never},createElement(LocalModelsView,{overview,error:undefined,busy:false,loading:false,confirmation:undefined,acknowledged:false,focus:undefined,onRefresh:no,onAsk:no,onClose:no,onAcknowledge:no,onConfirm:no,onCancelPull:no,onAddress:no,...props} as never)))

test('API 精确载荷、目标地址及回包校验；未知结果重试复用身份',async()=>{
 const calls:{endpoint:string;payload:any}[]=[],id=pull.pullId
 let fail=true
 const api=createLocalModelsApi(async(endpoint,payload)=>{calls.push({endpoint,payload});if(endpoint==='local-models/pull'&&fail){fail=false;throw Error('connection lost')}return endpoint==='local-models/pull'||endpoint==='local-models/pull-cancel'?pull:endpoint==='local-models/pull-status'?null:overview},()=>id)
 await api.overview();await api.pullStatus()
 const input={entryId:row.entryId,version:row.version,variant:0,acknowledgeRestrictions:false,expectedAddress:overview.runtime.address.baseURL}
 await assert.rejects(api.pull(input),/connection lost/);await api.pull(input)
 assert.deepEqual(calls.slice(0,2),[{endpoint:'local-models/overview',payload:{}},{endpoint:'local-models/pull-status',payload:{}}])
 assert.deepEqual(calls[2]!.payload,{...input,requestId:id});assert.deepEqual(calls[2],calls[3])
 await api.attach(row.name,input.expectedAddress);await api.remove(row.name,input.expectedAddress);await api.pullCancel(row.name);await api.address(null)
 assert.deepEqual(calls.at(-4)?.payload,{requestId:id,name:row.name,expectedAddress:input.expectedAddress})
 assert.deepEqual(calls.at(-2)?.payload,{requestId:id,name:row.name})
 assert.deepEqual(calls.at(-1)?.payload,{requestId:id,baseURL:null})
 await assert.rejects(createLocalModelsApi(async()=>({oops:true})).overview(),/格式/)
 await assert.rejects(createLocalModelsApi(async()=>({oops:true})).pullStatus(),/格式/)
})
test('运行时未安装显示原生安装入口，不能下载；外部运行时不声称本机硬件适配',()=>{
 const missing=render({overview:{...overview,runtime:{...overview.runtime,state:'missing',version:null},rows:[{...row,status:'runtime-missing'}]}})
 assert.match(missing,/未检测到 Ollama/);assert.match(missing,/https:\/\/ollama.com\/download/);assert.doesNotMatch(missing,/>下载<\/button>/)
 const remote=render({overview:{...overview,runtime:{...overview.runtime,address:{baseURL:'http://remote.lan:11434',custom:true,local:false}}}})
 assert.match(remote,/remote.lan/);assert.doesNotMatch(remote,/内存 32| · 适合/)
})
test('下载进度 50% 可取消；已完成不能误显示模型就绪；真实错误可见',()=>{
 const running=render({overview:{...overview,pull}})
 assert.match(running,/下载中 50%/);assert.match(running,/value="50"/);assert.match(running,/取消下载/)
 const done=render({overview:{...overview,rows:[{...row,status:'unverified'}],pull:{...pull,phase:'done'}}})
 assert.match(done,/下载完成/);assert.match(done,/未核验/);assert.doesNotMatch(done,/>就绪</)
 const failed=render({overview:{...overview,pull:{...pull,phase:'failed',error:'network unavailable'}}})
 assert.match(failed,/role="alert"/);assert.match(failed,/network unavailable/)
})
test('确认下载列明目标、大小、磁盘、适配、许可与摘要；限制未勾选禁用确认',()=>{
 const restricted={...row,licenseTier:'restricted',licenseName:'Apache 2.0',licenseURL:'https://www.apache.org/licenses/LICENSE-2.0',restrictions:[{'zh-CN':'仅限研究',en:'Research only'}]}
 const html=render({confirmation:{kind:'pull',row:restricted,overview}})
 for(const text of ['确认下载 qwen3:4b','127.0.0.1:11434','1 GiB','100 GiB','适合','许可','仅限研究','sha256:'])assert.ok(html.includes(text),text)
 assert.match(html,/<button[^>]*disabled=""[^>]*>确认下载<\/button>/)
 assert.doesNotMatch(render({confirmation:{kind:'pull',row:restricted,overview},acknowledged:true}),/<button[^>]*disabled=""[^>]*>确认下载<\/button>/)
})
test('已有模型状态分明：就绪可移除，未核验可接入；未收录模型已接入刷新后仍可移除',()=>{
 const html=render({overview:{...overview,rows:[{...row,status:'ready'},{...row,variant:1,name:'qwen3:8b',status:'unverified'}],offCatalog:[{name:'custom:latest',sizeBytes:20,family:null,parameterSize:null,loaded:false,status:'attached'}]}})
 assert.match(html,/就绪/);assert.match(html,/作为未收录模型接入/);assert.match(html,/其他已下载模型/);assert.match(html,/custom:latest/);assert.equal((html.match(/>移除<\/button>/g)??[]).length,2)
})
test('字节显示和十语文案完整',()=>{
 assert.equal(formatBytes(null),'—');assert.equal(formatBytes(0),'0 B');assert.equal(formatBytes(2**30),'1 GiB')
 for(const row of LOCAL_MODELS_MESSAGE_ROWS){assert.equal(row.length,11,row[0]);assert.ok(row.every(value=>value.trim()),row[0])}
})
test('只显示已加载模型的实测容量，未知不能填成标称上限或 8K',()=>{
 const html=render({overview:{...overview,rows:[{...row,status:'ready',loaded:true,runtimeContextLength:4096}],offCatalog:[{name:'custom:latest',sizeBytes:20,family:null,parameterSize:null,loaded:true,status:'attached',runtimeContextLength:null}]}})
 assert.match(html,/当前上下文 4,096 tokens/);assert.match(html,/当前上下文未核实/)
 const unloaded=render({overview:{...overview,rows:[{...row,status:'ready',runtimeContextLength:null}]}})
 assert.doesNotMatch(unloaded,/当前上下文/)
 const confirm=render({confirmation:{kind:'attach',name:'custom:latest',overview}})
 assert.match(confirm,/加载模型并核验可用上下文/)
 assert.doesNotMatch(render({confirmation:{kind:'remove',name:'custom:latest',overview}}),/加载模型并核验可用上下文/)
})


test('本机模型按明确上下文显示内存估计，不冒充速度、实际加载容量或远端硬件',()=>{
 const memoryEstimate={sourceVersion:'1.1.16',contextTokens:8192,contextSupported:true,requiredMemoryBytes:5*2**30,availableMemoryBytes:24*2**30,fit:'good'}
 const next={...overview,rows:[{...row,memoryEstimate}]}
 const html=render({overview:next})
 assert.match(html,/内存充裕（估算）/);assert.match(html,/按 8,192 上下文估算，约需 5 GiB 内存/)
 assert.doesNotMatch(html,/tokens\/s|当前上下文 8,192/)
 const remote=render({overview:{...next,runtime:{...next.runtime,address:{baseURL:'http:\/\/remote.lan:11434',custom:true,local:false}}}})
 assert.doesNotMatch(remote,/内存充裕|约需 5 GiB/)
})
