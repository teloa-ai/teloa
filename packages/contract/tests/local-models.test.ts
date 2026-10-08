import test from 'node:test'
import assert from 'node:assert/strict'
import {readOllamaAddress,localModelEndpoints,readLocalModelPullInput,readLocalModelPullRequest,readLocalModelTargetNameInput,readLocalModelAddressInput,readLocalModelNameInput,readLocalModelsOverview,readPullJobView,OLLAMA_DEFAULT_ADDRESS,OLLAMA_MIN_VERSION,OLLAMA_ROUTE_KEY,OLLAMA_CREDENTIAL_REF} from '../src/local-models.ts'

test('地址：缺省与回环判本机；外部主机不判本机；拒绝路径/账号/查询/坏端口',()=>{
 assert.deepEqual(readOllamaAddress('http://127.0.0.1:11434'),{baseURL:'http://127.0.0.1:11434',host:'127.0.0.1',port:11434,local:true})
 assert.equal(readOllamaAddress('http://localhost:11434/').local,true)
 assert.equal(readOllamaAddress('http://[::1]:11434').local,true)
 assert.equal(readOllamaAddress('https://ollama.lan:443').local,false)
 assert.equal(readOllamaAddress('http://10.0.0.8:11434').local,false)
 for(const bad of ['ftp://127.0.0.1:1','http://user:pw@127.0.0.1:11434','http://127.0.0.1:11434/v1','http://127.0.0.1:11434?x=1','http://127.0.0.1:0','http://-bad.host:1','not a url'])
  assert.throws(()=>readOllamaAddress(bad),/teloa\/invalid-input|地址/,bad)
})
test('地址：缺省端口补齐；IPv6 字面量保留方括号；常量固定',()=>{
 assert.deepEqual(readOllamaAddress('https://ollama.lan'),{baseURL:'https://ollama.lan:443',host:'ollama.lan',port:443,local:false})
 assert.deepEqual(readOllamaAddress('http://[::1]:11434'),{baseURL:'http://[::1]:11434',host:'::1',port:11434,local:true})
 assert.deepEqual(readOllamaAddress(OLLAMA_DEFAULT_ADDRESS),{baseURL:'http://127.0.0.1:11434',host:'127.0.0.1',port:11434,local:true})
 assert.throws(()=>readOllamaAddress('http://127.0.0.1:11434#frag'),/地址/)
 assert.throws(()=>readOllamaAddress('http://'+'a'.repeat(260)+':1'),/地址/)
 assert.throws(()=>readOllamaAddress(11434),/地址/)
 assert.equal(OLLAMA_MIN_VERSION,'0.6.0');assert.equal(OLLAMA_ROUTE_KEY,'ollama');assert.equal(OLLAMA_CREDENTIAL_REF,'OLLAMA_API_KEY')
})
test('地址：契约只解析语法，网段授权由宿主复核；拒绝首尾空白',()=>{
 assert.equal(readOllamaAddress('http://[::ffff:10.0.0.8]:11434').local,false)
 for(const bad of ['http://127.0.0.1:11434 ',' http://127.0.0.1:11434','http://127.0.0.1:11434\n'])assert.throws(()=>readOllamaAddress(bad),/地址/)
})
test('端点清单固定七条；拉取入参 exact',()=>{
 assert.deepEqual([...localModelEndpoints],['local-models/overview','local-models/address','local-models/pull','local-models/pull-status','local-models/pull-cancel','local-models/remove','local-models/attach'])
 const ok={requestId:'0d3b8e1e-2f0e-4c7a-9a0b-6f1a2b3c4d5e',entryId:'teloa.model.local.qwen3',version:'1.0.0',variant:1,acknowledgeRestrictions:false}
 assert.deepEqual(readLocalModelPullInput(ok),ok)
 assert.throws(()=>readLocalModelPullInput({...ok,baseURL:'http://x'}),/未知字段|格式/)
 assert.throws(()=>readLocalModelPullInput({...ok,variant:-1}),/格式/)
 assert.throws(()=>readLocalModelPullInput({...ok,requestId:'bad'}),/格式/)
 assert.throws(()=>readLocalModelPullInput({...ok,entryId:'Teloa.Model'}),/格式/)
 assert.throws(()=>readLocalModelPullInput({...ok,acknowledgeRestrictions:'yes'}),/格式/)
})
test('地址入参：null 恢复缺省，字符串走地址校验；名称入参 exact 且按 Ollama 名称文法',()=>{
 const requestId='0d3b8e1e-2f0e-4c7a-9a0b-6f1a2b3c4d5e'
 assert.deepEqual(readLocalModelAddressInput({requestId,baseURL:null}),{requestId,baseURL:null})
 assert.deepEqual(readLocalModelAddressInput({requestId,baseURL:'http://localhost:11434/'}),{requestId,baseURL:'http://localhost:11434'})
 assert.throws(()=>readLocalModelAddressInput({requestId,baseURL:'http://ollama.lan/v1'}),/地址/)
 assert.throws(()=>readLocalModelAddressInput({requestId}),/格式/)
 assert.deepEqual(readLocalModelNameInput({requestId,name:'qwen3:8b'}),{requestId,name:'qwen3:8b'})
 assert.throws(()=>readLocalModelNameInput({requestId,name:'qwen3'}),/格式/)
 assert.throws(()=>readLocalModelNameInput({requestId,name:'qwen3:8b',extra:1}),/格式/)
})
test('浏览器下载与模型操作必须绑定确认时的目标地址',()=>{
 const requestId='0d3b8e1e-2f0e-4c7a-9a0b-6f1a2b3c4d5e'
 const pull={requestId,entryId:'teloa.model.local.qwen3',version:'1.0.0',variant:0,acknowledgeRestrictions:false}
 const target={requestId,name:'qwen3:8b'}
 assert.throws(()=>readLocalModelPullRequest(pull),/格式/)
 assert.throws(()=>readLocalModelTargetNameInput(target),/格式/)
 assert.equal(readLocalModelPullRequest({...pull,expectedAddress:'http://localhost:11434/'}).expectedAddress,'http://localhost:11434')
 assert.deepEqual(readLocalModelTargetNameInput({...target,expectedAddress:'https://ollama.lan'}),{...target,expectedAddress:'https://ollama.lan:443'})
 assert.throws(()=>readLocalModelTargetNameInput({...target,expectedAddress:'https://secret@ollama.lan'}),/地址/)
})
test('总览与拉取作业读取器：合法回包原样通过，缺字段/多字段/坏状态拒绝',()=>{
 const pull={pullId:'0d3b8e1e-2f0e-4c7a-9a0b-6f1a2b3c4d5e',name:'qwen3:8b',phase:'pulling',completed:100,total:4000,error:null}
 assert.deepEqual(readPullJobView(pull),pull)
 assert.deepEqual(readPullJobView({...pull,phase:'failed',total:null,error:'no such host'}),{...pull,phase:'failed',total:null,error:'no such host'})
 assert.throws(()=>readPullJobView({...pull,phase:'paused'}),/格式/)
 assert.throws(()=>readPullJobView({...pull,completed:-1}),/格式/)
 const row={entryId:'teloa.model.local.qwen3',version:'1.0.0',variant:0,name:'qwen3:8b',title:{'zh-CN':'通义千问 3','en':'Qwen3'},quant:'Q4_K_M',sizeBytes:5_200_000_000,fit:'good',licenseTier:'commercial',licenseName:'Apache 2.0',licenseURL:'https://www.apache.org/licenses/LICENSE-2.0',restrictions:[],catalogDigest:'sha256:'+'a'.repeat(64),status:'ready',loaded:false}
 const overview={runtime:{state:'running',version:'0.11.4',outdated:false,address:{baseURL:'http://127.0.0.1:11434',custom:false,local:true}},hardware:{totalMemGb:32,unified:true,diskFreeBytes:120_000_000_000},rows:[row],offCatalog:[{name:'mistral:7b',sizeBytes:4_000_000_000,family:'llama',parameterSize:'7B',loaded:true,status:'unverified'}],pull:pull}
 assert.deepEqual(readLocalModelsOverview(overview),overview)
 const allocated={...overview,rows:[{...row,loaded:true,runtimeContextLength:4096}],offCatalog:[{...overview.offCatalog[0],runtimeContextLength:8192}]}
 assert.deepEqual(readLocalModelsOverview(allocated),allocated)
 assert.equal(readLocalModelsOverview({...overview,rows:[{...row,runtimeContextLength:null}]}).rows[0]!.runtimeContextLength,null)
 for(const runtimeContextLength of [0,-1,1.5,'4096',Number.MAX_SAFE_INTEGER+1]){
  assert.throws(()=>readLocalModelsOverview({...overview,rows:[{...row,loaded:true,runtimeContextLength}]}),/格式/)
  assert.throws(()=>readLocalModelsOverview({...overview,offCatalog:[{...overview.offCatalog[0],runtimeContextLength}]}),/格式/)
 }
 assert.throws(()=>readLocalModelsOverview({...overview,rows:[{...row,loaded:false,runtimeContextLength:4096}]}),/格式/)
 assert.deepEqual(readLocalModelsOverview({...overview,runtime:{state:'missing',version:null,outdated:false,address:overview.runtime.address},hardware:{totalMemGb:16,unified:false,diskFreeBytes:null},rows:[{...row,status:'runtime-missing',catalogDigest:null}],offCatalog:[],pull:null}).rows[0]!.status,'runtime-missing')
 assert.throws(()=>readLocalModelsOverview({...overview,rows:[{...row,status:'downloading'}]}),/格式/)
 assert.throws(()=>readLocalModelsOverview({...overview,rows:[{...row,fit:'great'}]}),/格式/)
 for(const licenseURL of ['javascript:alert(1)','http://example.com/license','https://user:secret@example.com/license'])assert.throws(()=>readLocalModelsOverview({...overview,rows:[{...row,licenseURL}]}),/格式/)
 assert.throws(()=>readLocalModelsOverview({...overview,runtime:{...overview.runtime,address:{...overview.runtime.address,secret:'x'}}}),/格式/)
 assert.throws(()=>readLocalModelsOverview({...overview,extra:1}),/格式/)
 assert.throws(()=>readLocalModelsOverview({...overview,offCatalog:[{name:'x',sizeBytes:1}]}),/格式/)
})


test('内存评估是可选、固定来源且有上下文的估计；旧总览兼容、异常估算拒绝',()=>{
 const row={entryId:'teloa.model.local.qwen3',version:'1.0.0',variant:0,name:'qwen3:8b',title:{'zh-CN':'通义千问 3',en:'Qwen3'},quant:'Q4_K_M',sizeBytes:5_200_000_000,fit:'good',licenseTier:'commercial',licenseName:'Apache 2.0',licenseURL:'https://www.apache.org/licenses/LICENSE-2.0',restrictions:[],catalogDigest:'sha256:'+'a'.repeat(64),status:'ready',loaded:false}
 const overview={runtime:{state:'running',version:'0.40.1',outdated:false,address:{baseURL:'http://127.0.0.1:11434',custom:false,local:true}},hardware:{totalMemGb:32,unified:true,diskFreeBytes:120_000_000_000},rows:[row],offCatalog:[],pull:null}
 const memoryEstimate={sourceVersion:'1.1.16',contextTokens:8192,contextSupported:true,requiredMemoryBytes:6*2**30,availableMemoryBytes:24*2**30,fit:'good'}
 assert.equal(readLocalModelsOverview(overview).rows[0]?.memoryEstimate,undefined)
 assert.deepEqual(readLocalModelsOverview({...overview,rows:[{...row,memoryEstimate}]}).rows[0]?.memoryEstimate,memoryEstimate)
 for(const bad of [{...memoryEstimate,contextTokens:0},{...memoryEstimate,requiredMemoryBytes:-1},{...memoryEstimate,availableMemoryBytes:NaN},{...memoryEstimate,sourceVersion:'latest'},{...memoryEstimate,tps:100}])assert.throws(()=>readLocalModelsOverview({...overview,rows:[{...row,memoryEstimate:bad}]}),/格式/)
})
