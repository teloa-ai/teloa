import test from 'node:test'
import assert from 'node:assert/strict'
import {generateKeyPairSync,sign} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {WorkError} from '../src/work-error.ts'
import {MARKET_INDEX_HOST,MARKET_INDEX_MAX_BYTES,MARKET_INDEX_V1_KINDS,marketIndexPath,readMarketIndex,readMarketIndexV2,assembleMarketIndexV2} from '../src/market-index.ts'
import {verifyMarketIndex} from '../src/market-index-signature.ts'
import {readMarketCatalogEntry,marketEntryNeedsV2} from '../src/market-catalog.ts'

const root=new URL('../../../',import.meta.url)
const official=JSON.parse(await readFile(new URL('tests/fixtures/public-market/catalog/skills/anthropic.internal-comms.json',root),'utf8'))
// 市场仓 2026.9.28.6 起 Maton 条目改为需配置并声明技能密钥；这里要的是不带密钥、不可添加的上游条目，按改动前的形状还原
const {secrets:_secrets,httpGuide:_guide,secretGroup:_group,...calendly}=JSON.parse(await readFile(new URL('tests/fixtures/public-market/catalog/skills/clawhub.byungkyu.calendly-api.json',root),'utf8'))
const upstream={...calendly,compatibility:{...calendly.compatibility,status:'unsupported',teloa:'>=0.2.0-alpha.6'},requires:{...calendly.requires,tools:['bash']}}
const valid=()=>({format:'teloa.market-index/v1',catalogVersion:'2026.9.25',entries:[structuredClone(official),structuredClone(upstream)]})

test('索引其他来源：v1 拒绝新键，v2 保留推荐并核对完整原始目录',async()=>{
 const connector=JSON.parse(await readFile(new URL('tests/fixtures/public-market/catalog/connectors/teloa.mcp-context7.json',root),'utf8'))
 const skill=structuredClone(upstream)
 const alternative={entryId:connector.id,marketplace:'teloa',installs:null,recommended:true}
 skill.alternatives=[alternative]
 connector.alternatives=[{entryId:skill.id,marketplace:'clawhub',installs:null}]
 for(const entry of [skill,connector])entry.compatibility.teloa='>=0.2.0-alpha.7'
 const doc={format:'teloa.market-index/v2',catalogVersion:'2026.9.27',entries:[skill,connector]}
 assert.deepEqual(assembleMarketIndexV2(doc).entries[0],skill)
 assert.throws(()=>readMarketIndex({...doc,format:'teloa.market-index/v1'}),/v1 索引/)
 assert.throws(()=>readMarketIndex({format:'teloa.market-index/v1',catalogVersion:doc.catalogVersion,entries:[{...connector,alternatives:[]}]}),/v1 索引/)
 assert.throws(()=>readMarketIndex({...doc,format:'teloa.market-index/v1',entries:[skill,{...connector,alternatives:undefined}]}),/格式|其他来源/)
 delete connector.alternatives
 assert.throws(()=>readMarketIndex({...doc,format:'teloa.market-index/v1'}),/v1 索引/)
 for(const filter of [()=>{connector.compatibility.teloa='>=0.3.0'},()=>{connector.kind='future-kind'}]){
  filter()
  const parsed=readMarketIndexV2(doc,'0.2.0-alpha.7')
  assert.deepEqual(parsed.entries,[skill],'目标被本机版本过滤，不等于原始索引缺少目标')
 }
 const dangling={...doc,entries:[skill]}
 assert.throws(()=>assembleMarketIndexV2(dangling),/不在目录中/)
 assert.throws(()=>readMarketIndexV2(dangling,'0.2.0-alpha.7'),/不在目录中/)
 delete skill.alternatives[0].recommended
 assert.throws(()=>readMarketIndex({...dangling,format:'teloa.market-index/v1'}),/不在目录中/)
})
const rejects=(value:unknown,pattern:RegExp)=>assert.throws(()=>readMarketIndex(value),(error:unknown)=>error instanceof WorkError&&error.code==='teloa/invalid-input'&&pattern.test(error.message))

test('readMarketIndex 接受按标识升序、官方与上游混排的索引',()=>{
 const index=readMarketIndex(valid())
 assert.equal(index.format,'teloa.market-index/v1')
 assert.deepEqual(index.entries.map(entry=>[entry.id,entry.delivery]),[['anthropic.internal-comms','install'],['clawhub.byungkyu.calendly-api','upstream']])
 assert.equal(MARKET_INDEX_HOST,'market.teloa.ai')
 assert.equal(MARKET_INDEX_MAX_BYTES,5*1024*1024)
})

test('readMarketIndex 拒绝未知字段、错误格式、重复或乱序标识、非法条目',()=>{
 rejects({...valid(),extra:1},/未知字段/)
 rejects({...valid(),format:'teloa.market-catalog/v1'},/格式版本/)
 rejects({...valid(),catalogVersion:'bad version!'},/目录版本/)
 const unsorted=valid();unsorted.entries.reverse();rejects(unsorted,/升序/)
 const duplicated=valid();duplicated.entries=[duplicated.entries[0],duplicated.entries[0]];rejects(duplicated,/不能重复/)
 const broken=valid();(broken.entries[1] as Record<string,unknown>).compatibility={status:'maybe'};rejects(broken,/兼容/)
})

test('verifyMarketIndex 只接受 Ed25519 公钥且对完整字节验签',()=>{
 const {privateKey,publicKey}=generateKeyPairSync('ed25519')
 const bytes=Buffer.from(JSON.stringify(valid()))
 const signature=sign(null,bytes,privateKey)
 const pem=publicKey.export({type:'spki',format:'pem'}) as string
 assert.equal(verifyMarketIndex(bytes,signature,pem),true)
 assert.equal(verifyMarketIndex(Buffer.concat([bytes,Buffer.from(' ')]),signature,pem),false)
 assert.equal(verifyMarketIndex(bytes,signature.subarray(1),pem),false)
 const rsa=generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({type:'spki',format:'pem'}) as string
 assert.equal(verifyMarketIndex(bytes,signature,rsa),false)
 assert.equal(verifyMarketIndex(bytes,signature,''),false)
})

const roleEntry=()=>({format:'teloa.market-catalog-entry/v1',id:'teloa.role.internal-comms-editor',kind:'role',delivery:'install',version:'1.0.0',upstream:null,
 taxonomy:{functions:['communication'],industries:['general']},
 role:{roleId:'internal-comms-editor',title:{'zh-CN':'内部沟通编辑',en:'Internal comms editor'},summary:{'zh-CN':'起草稿件。',en:'Drafts.'},
  definition:{name:'内部沟通编辑',kind:'employee',duty:'起草',dataScope:'已提供材料',executionScope:'代拟',responsibility:{triggers:['收到需求'],autonomousActions:['起草'],confirmationPoints:['外发前确认'],escalationRules:['敏感内容升级'],deliveryChecks:['有来源']}},
  skills:['internal-comms'],scope:'office',preferredModel:null,fromSolution:{packageId:'office-collaboration',version:'1.0.0',path:'roles/office-collaborator.json'}},
 modifications:[],license:{spdx:'Apache-2.0',files:[],url:'https://www.apache.org/licenses/LICENSE-2.0'},
 compatibility:{status:'content-only',teloa:'>=0.2.0-alpha.6',dsh:'0.1.7-rc.1',conditions:[]},
 requires:{tools:[],network:false,runtimes:[]},review:{status:'approved',reviewedAt:'2026-09-25',reviewer:'Teloa'}})

test('v1 索引冻结：只认 skill / solution / connector，含 role 即拒绝；路径与 kind 常量固定',()=>{
 assert.deepEqual([...MARKET_INDEX_V1_KINDS],['skill','solution','connector'])
 assert.equal(marketIndexPath(1),'index.json');assert.equal(marketIndexPath(2),'v2/index.json')
 rejects({...valid(),entries:[structuredClone(official),structuredClone(upstream),roleEntry()]},/v1 索引/)
})

test('readMarketIndexV2：未知 kind 与高于本机版本的条目跳过并计数，其余照读；已知 kind 结构错误仍整份拒绝',()=>{
 const newer={...roleEntry(),id:'teloa.role.newer',role:{...roleEntry().role,roleId:'newer'},compatibility:{...roleEntry().compatibility,teloa:'>=0.3.0'}}
 const future={...roleEntry(),id:'teloa.plugin.future',kind:'plugin'}
 const entries=[structuredClone(official),structuredClone(upstream),future,roleEntry(),newer].sort((a,b)=>a.id<b.id?-1:1)
 const index=readMarketIndexV2({format:'teloa.market-index/v2',catalogVersion:'2026.9.25',entries},'0.2.0-alpha.6')
 assert.deepEqual(index.entries.map(entry=>entry.id),['anthropic.internal-comms','clawhub.byungkyu.calendly-api','teloa.role.internal-comms-editor'])
 assert.deepEqual(index.skipped,{unknownKind:1,newerApp:1})
 assert.throws(()=>readMarketIndexV2({format:'teloa.market-index/v1',catalogVersion:'2026.9.25',entries},'0.2.0-alpha.6'),/格式版本/)
 const broken=structuredClone(entries);(broken[0] as Record<string,unknown>).compatibility={status:'maybe'}
 assert.throws(()=>readMarketIndexV2({format:'teloa.market-index/v2',catalogVersion:'2026.9.25',entries:broken},'0.2.0-alpha.6'),/兼容/)
 const unsorted=[...entries].reverse()
 assert.throws(()=>readMarketIndexV2({format:'teloa.market-index/v2',catalogVersion:'2026.9.25',entries:unsorted},'0.2.0-alpha.6'),/升序/)
})

test('readMarketIndexV2：本机不认识的范围语法（如 ^0.3.0）按需更新应用计入 newerApp 跳过，不整份拒绝；收录端严格读取仍拒绝该语法',()=>{
 const caret={...roleEntry(),id:'teloa.role.caret',role:{...roleEntry().role,roleId:'caret'},compatibility:{...roleEntry().compatibility,teloa:'^0.3.0'}}
 const entries=[structuredClone(official),roleEntry(),caret].sort((a,b)=>a.id<b.id?-1:1)
 const index=readMarketIndexV2({format:'teloa.market-index/v2',catalogVersion:'2026.9.25',entries},'0.2.0-alpha.6')
 assert.deepEqual(index.entries.map(entry=>entry.id),['anthropic.internal-comms','teloa.role.internal-comms-editor'])
 assert.deepEqual(index.skipped,{unknownKind:0,newerApp:1})
 assert.throws(()=>readMarketCatalogEntry(caret),/Teloa 兼容范围格式不正确/)
})

test('assembleMarketIndexV2：发布端不按版本过滤，带上限的范围照收；v2 读取器以更高版本读取时跳过',()=>{
 const capped={...roleEntry(),id:'teloa.role.capped',role:{...roleEntry().role,roleId:'capped'},compatibility:{...roleEntry().compatibility,teloa:'>=0.2.0 <0.3.0'}}
 const exact={...roleEntry(),id:'teloa.role.exact',role:{...roleEntry().role,roleId:'exact'},compatibility:{...roleEntry().compatibility,teloa:'=0.2.0'}}
 const entries=[structuredClone(official),capped,exact].sort((a,b)=>a.id<b.id?-1:1)
 const assembled=assembleMarketIndexV2({format:'teloa.market-index/v2',catalogVersion:'2026.9.25',entries})
 assert.deepEqual(Object.keys(assembled),['format','catalogVersion','entries'])
 assert.deepEqual(assembled.entries.map(entry=>entry.id),['anthropic.internal-comms','teloa.role.capped','teloa.role.exact'])
 const later=readMarketIndexV2(JSON.parse(JSON.stringify(assembled)),'0.3.0')
 assert.deepEqual(later.entries.map(entry=>entry.id),['anthropic.internal-comms'])
 assert.deepEqual(later.skipped,{unknownKind:0,newerApp:2})
 const envelope=(list:unknown[])=>({format:'teloa.market-index/v2',catalogVersion:'2026.9.25',entries:list})
 assert.throws(()=>assembleMarketIndexV2(envelope([...entries,{...roleEntry(),id:'zz.future',kind:'plugin'}])),/类型/)
 assert.throws(()=>assembleMarketIndexV2(envelope([...entries].reverse())),/升序/)
 assert.throws(()=>assembleMarketIndexV2(envelope([entries[0],entries[0]])),/不能重复/)
 assert.throws(()=>assembleMarketIndexV2(envelope([{...capped,compatibility:{...capped.compatibility,teloa:'^0.3.0'}}])),/范围/)
 assert.throws(()=>assembleMarketIndexV2({...envelope(entries),format:'teloa.market-index/v1'}),/格式版本/)
})

test('v1 / v2 索引都不收 upstream 为 null 的 Teloa 内置技能（它们只随发行快照提供）',()=>{
 const builtin={...structuredClone(official),id:'teloa.dashboard-designer',delivery:'builtin',skill:{...official.skill,name:'teloa-dashboard-designer'},upstream:null}
 const entries=[structuredClone(official),builtin,structuredClone(upstream)]
 rejects({...valid(),entries},/内置技能/)
 assert.throws(()=>readMarketIndexV2({format:'teloa.market-index/v2',catalogVersion:'2026.9.25',entries},'0.2.0-alpha.6'),/内置技能/)
 assert.throws(()=>assembleMarketIndexV2({format:'teloa.market-index/v2',catalogVersion:'2026.9.25',entries}),/内置技能/)
})

test('带 secrets 的技能条目：v1 索引整份拒绝；v2 按版本闸收录或计入 newerApp',()=>{
 const secret={envVarName:'CALENDLY_TOKEN',label:{'zh-CN':'Calendly 令牌',en:'Calendly token'},required:true,target:'bearer',endpoints:[{origin:'https://api.calendly.com',pathPrefixes:['/']}],methods:['GET','POST']}
 const entry={...structuredClone(upstream),secrets:[secret]} as Record<string,any>
 entry.compatibility={...entry.compatibility,status:'needs-configuration',teloa:'>=0.2.0-alpha.7'}
 entry.requires={...entry.requires,tools:['teloa_skill_http']}
 rejects({...valid(),entries:[structuredClone(official),entry]},/v2 索引/)
 const v2={format:'teloa.market-index/v2',catalogVersion:'2026.9.25',entries:[entry]}
 const parsed=readMarketIndexV2(v2,'0.2.0-alpha.7')
 assert.equal(parsed.entries.length,1)
 assert.deepEqual((parsed.entries[0] as {secrets?:unknown}).secrets,[secret])
 const old=readMarketIndexV2(v2,'0.2.0-alpha.6')
 assert.equal(old.entries.length,0);assert.equal(old.skipped.newerApp,1)
 assert.equal(assembleMarketIndexV2(v2).entries.length,1)
 const loose={...entry,compatibility:{...entry.compatibility,teloa:'>=0.2.0-alpha.6'}}
 assert.throws(()=>assembleMarketIndexV2({...v2,entries:[loose]}),/兼容范围/)
})

// 二次开发相关新字段（derivation、install 文件 sha256/repositoryPath、origin.installsSource）只进 v2。
const derivedOfficial=()=>{
 const entry=structuredClone(official)
 entry.upstream.files=entry.upstream.files.map((file:Record<string,unknown>,at:number)=>({...file,sha256:String(at).repeat(64)}))
 entry.modifications=[]
 entry.derivation={unchangedFiles:entry.upstream.files.slice(1).map((file:{path:string})=>file.path),changes:[{id:'AIC-M01',type:'adapted',path:'LICENSE.txt',upstream:'anthropics/skills@'+entry.upstream.commit+':skills/internal-comms/LICENSE.txt',summary:{'zh-CN':'改排版。',en:'Reformats.'},reason:{'zh-CN':'适配。',en:'Adapts.'}}]}
 entry.compatibility.teloa='>=0.2.0-alpha.7'
 return entry
}
const sourcedUpstream=()=>{
 const entry=structuredClone(upstream)
 entry.origin={...entry.origin,marketplace:'claude-code',installsSource:{url:'https://claude.com/plugins/calendly',scope:'plugin'}}
 entry.compatibility.teloa='>=0.2.0-alpha.7'
 return entry
}

test('二次开发 10：v1 索引拒收用到 derivation、原版文件摘要或安装量来源的条目，提示发布到 v2；v2 照收',()=>{
 const hashed=structuredClone(official);hashed.upstream.files[0].sha256='a'.repeat(64);hashed.compatibility.teloa='>=0.2.0-alpha.7'
 for(const [derived,other] of [[derivedOfficial(),structuredClone(upstream)],[structuredClone(official),sourcedUpstream()],[hashed,structuredClone(upstream)]]){
  assert.equal([derived,other].filter(entry=>marketEntryNeedsV2(readMarketCatalogEntry(structuredClone(entry)))).length,1,'二次开发字段并入 marketEntryNeedsV2（规格 D12）')
  rejects({format:'teloa.market-index/v1',catalogVersion:'2026.9.28',entries:[derived,other]},/v2/)
  const v2={format:'teloa.market-index/v2',catalogVersion:'2026.9.28',entries:[derived,other]}
  assert.equal(assembleMarketIndexV2(v2).entries.length,2)
  assert.equal(readMarketIndexV2(v2,'0.2.0-alpha.7').entries.length,2)
  const legacyApp=readMarketIndexV2(v2,'0.2.0-alpha.6')
  assert.equal(legacyApp.skipped.newerApp,1)
  assert.equal(legacyApp.entries.length,1)
 }
})

test('v1 索引拒收任一目录扩展字段条目（走同一谓词 marketEntryNeedsV2）；旧条目为 false',()=>{
 for(const entry of [official,upstream])assert.equal(marketEntryNeedsV2(readMarketCatalogEntry(structuredClone(entry))),false)
 const label={'zh-CN':'令牌',en:'Token'}
 const secret={envVarName:'CALENDLY_TOKEN',label,required:true,target:'bearer',endpoints:[{origin:'https://api.calendly.com',pathPrefixes:['/']}],methods:['GET']}
 const skill=(patch:(entry:Record<string,any>)=>void)=>{
  const entry={...structuredClone(upstream),secrets:[secret]} as Record<string,any>
  entry.compatibility={...entry.compatibility,status:'needs-configuration',teloa:'>=0.2.0-alpha.7'};entry.requires={...entry.requires,tools:['teloa_skill_http']};patch(entry);return entry
 }
 const connector=(patch:(entry:Record<string,any>)=>void)=>{
  const entry:Record<string,any>={format:'teloa.market-catalog-entry/v1',id:'teloa.mcp-ext',kind:'connector',delivery:'managed',version:'1.0.0',upstream:null,
   taxonomy:{functions:['automation'],industries:['general']},
   connector:{serverName:'ext',title:{'zh-CN':'扩展连接器',en:'Extension connector'},summary:{'zh-CN':'测试。',en:'Test.'},auth:{kind:'none'},recipe:{transport:'streamable-http',url:'https://example.com/mcp'},tools:[],upstreamUrl:'https://example.com'},
   modifications:[],license:{spdx:'MIT',files:['LICENSE']},compatibility:{status:'needs-configuration',teloa:'>=0.2.0-alpha.7',dsh:'0.1.7-rc.1',conditions:[]},
   requires:{tools:[],network:true,runtimes:[]},review:{status:'approved',reviewedAt:'2026-09-25',reviewer:'Teloa'}}
  patch(entry);return entry
 }
 const cases:Record<string,any>[]=[
  skill(()=>{}),
  skill(entry=>{entry.httpGuide={'zh-CN':'GET /scheduled_events',en:'GET /scheduled_events'}}),
  skill(entry=>{entry.secretGroup='calendly'}),
  skill(entry=>{entry.secrets=[{...secret,allowHeaders:['X-Request-Id']}]}),
  skill(entry=>{entry.secrets=[{...secret,target:'header',name:'em_api_key'}]}),
  connector(entry=>{entry.connector.auth={kind:'secret',vars:[{target:'header',name:'X-Api-Key',label,required:true}]}}),
  connector(entry=>{entry.connector.auth={kind:'secret',vars:[{target:'basic',userLabel:label,label,required:true}]}}),
  connector(entry=>{entry.connector.instructionsMaxBytes=8192}),
  connector(entry=>{entry.connector.auth={kind:'secret',vars:[{target:'env',envVarName:'API_TOKEN',label,required:true}]};entry.connector.recipe={transport:'stdio',package:'mcp-remote',version:'0.1.0',integrity:'sha512-'+'A'.repeat(86)+'==',bin:'dist/proxy.js',args:['--header','Authorization:${API_TOKEN}']}}),
  connector(entry=>{entry.connector.auth={kind:'oauth',supported:false,reason:'暂不支持'};entry.compatibility={...entry.compatibility,status:'unsupported',teloa:'>=0.2.0-alpha.6'}}),
 ]
 for(const entry of cases){
  assert.equal(marketEntryNeedsV2(readMarketCatalogEntry(entry)),true,entry.id)
  rejects({...valid(),entries:[entry]},/v2 索引/)
 }
 const plain=connector(()=>{});assert.equal(marketEntryNeedsV2(readMarketCatalogEntry(plain)),false)
 assert.doesNotThrow(()=>readMarketIndex({...valid(),entries:[structuredClone(official),structuredClone(upstream),plain]}))
})
