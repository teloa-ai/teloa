import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {WorkError,type MarketCatalogSkillSecret,type MarketCatalogText} from '@teloa/contract'
import {memoryCredentialPort} from '../src/managed-mcp-credentials.ts'
import {createManagedAvailabilitySync} from '../src/managed-skill-availability-sync.ts'
import {CredentialStoreLocked} from '../src/credentials/store-state.ts'
import {createTeloaWorkService} from '../src/teloa-work-service.ts'
import {createBroadcastNotificationAdapter,createLocalNotificationAdapter} from '../src/notification-deliveries.ts'
import {createSkillSecretStore,declaredSkillSecretsResolver,isManagedSkillWinner,skillSecretBinding,skillSecretGroupKey,skillSecretKey,type SkillBinding,type SkillSecretGroupMembers} from '../src/skill-secrets.ts'

const rand=(n:number)=>Array.from({length:n},()=>'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random()*36)]).join('')
const secret='xai'+'-'+rand(24)
const declared:Record<string,MarketCatalogSkillSecret[]>={'x-search':[{envVarName:'XAI_API_KEY',label:{'zh-CN':'xAI API 密钥',en:'xAI API key'},required:true,target:'bearer',endpoints:[{origin:'https://api.x.ai',pathPrefixes:['/v1/']}],methods:['POST']}]}
const expected=(skill:string)=>skillSecretBinding(declared[skill]??[])
const fromMap=(map:Record<string,MarketCatalogSkillSecret[]>)=>async(name:string)=>map[name]?{secrets:map[name]!}:undefined
const noMeta={getSkillSecretMetaByEntry:()=>({}),skillSecretGroupMembers:()=>[]}
const stable=createManagedAvailabilitySync({deny(){},read:async()=>{},replace(){}}).stable
function fake(writable=true){
 const port=memoryCredentialPort(),audit:unknown[]=[]
 const credentials={...port,describeRecord:async(key:Parameters<typeof port.describeRecord>[0])=>({...(await port.describeRecord(key)),writable})}
 return {port,audit,api:createSkillSecretStore(credentials,fromMap(declared),event=>audit.push(event))}
}

test('保存后 describe 只见 configured，回包与审计不含值，记录含指纹槽',async()=>{
 const {port,audit,api}=fake()
 assert.deepEqual(await api.handle('skill-secrets/describe',{skill:'x-search'}),{skill:'x-search',binding:expected('x-search'),writable:true,reconfirm:false,vars:[{envVarName:'XAI_API_KEY',label:declared['x-search']![0]!.label,required:true,configured:false,target:'bearer',endpoints:[{origin:'https://api.x.ai',pathPrefixes:['/v1/']}]}]})
 const saved=await api.handle('skill-secrets/save',{skill:'x-search',expectedBinding:expected('x-search'),values:{XAI_API_KEY:secret}})
 assert.equal((saved as {vars:{configured:boolean}[]}).vars[0]!.configured,true)
 assert.doesNotMatch(JSON.stringify(saved),new RegExp(secret.slice(4,12)))
 assert.deepEqual(await port.readRecord(skillSecretKey('x-search')),{kind:'api-key',env:{XAI_API_KEY:secret,TELOA_BINDING_SHA256:skillSecretBinding(declared['x-search']!)}})
 assert.doesNotMatch(JSON.stringify(audit),new RegExp(secret.slice(4,12)))
 assert.deepEqual(audit,[{event:'skill-secret.save',skill:'x-search',envVarNames:['XAI_API_KEY']}])
})

test('save 白名单：未声明变量、未知字段、过短值、未声明技能、空值表、只读存储一律拒绝',async()=>{
 const {api}=fake()
 await assert.rejects(api.handle('skill-secrets/save',{skill:'x-search',expectedBinding:expected('x-search'),values:{OTHER_KEY:secret}}),/未在技能说明中写明/)
 await assert.rejects(api.handle('skill-secrets/save',{skill:'x-search',expectedBinding:expected('x-search'),values:{XAI_API_KEY:secret},extra:1}),/只允许/)
 await assert.rejects(api.handle('skill-secrets/save',{skill:'x-search',expectedBinding:expected('x-search'),values:{XAI_API_KEY:'short'}}),/8 到 4096/)
 await assert.rejects(api.handle('skill-secrets/save',{skill:'no-secrets',expectedBinding:expected('no-secrets'),values:{XAI_API_KEY:secret}}),{code:'teloa/version-conflict'})
 await assert.rejects(api.handle('skill-secrets/save',{skill:'x-search',expectedBinding:expected('x-search'),values:{}}),/至少填写一项/)
 await assert.rejects(fake(false).api.handle('skill-secrets/save',{skill:'x-search',expectedBinding:expected('x-search'),values:{XAI_API_KEY:secret}}),/只读/)
 await assert.rejects(api.handle('skill-secrets/describe',{skill:'../x'}),/技能名/)
})

test('delete 删除记录；readForUse 每次现读',async()=>{
 const {port,api}=fake()
 await api.handle('skill-secrets/save',{skill:'x-search',expectedBinding:expected('x-search'),values:{XAI_API_KEY:secret}})
 assert.equal((await api.readForUse('x-search')).values.XAI_API_KEY,secret)
 const rotated='xai'+'-'+rand(24)
 await port.modifyRecord(skillSecretKey('x-search'),async()=>({kind:'api-key',env:{XAI_API_KEY:rotated,TELOA_BINDING_SHA256:skillSecretBinding(declared['x-search']!)}}))
 assert.equal((await api.readForUse('x-search')).values.XAI_API_KEY,rotated)
 await api.handle('skill-secrets/delete',{skill:'x-search'})
 assert.equal(await port.readRecord(skillSecretKey('x-search')),undefined)
 assert.deepEqual((await api.readForUse('x-search')).values,{})
})

test('声明指纹：目录改了 origin、前缀、注入位置或方法后 stale，describe 要求重新确认；重新保存后恢复',async()=>{
 const {api}=fake()
 const original=declared['x-search']!
 await api.handle('skill-secrets/save',{skill:'x-search',expectedBinding:expected('x-search'),values:{XAI_API_KEY:secret}})
 assert.equal((await api.readForUse('x-search')).stale,false)
 for(const changed of [{endpoints:[{origin:'https://evil.example',pathPrefixes:['/v1/']}]},{endpoints:[{origin:'https://api.x.ai',pathPrefixes:['/']}]},{target:'header' as const,name:'X-Key'},{methods:['GET'] as const}]){
  declared['x-search']=[{...original[0]!,...changed} as MarketCatalogSkillSecret]
  assert.equal((await api.readForUse('x-search')).stale,true,JSON.stringify(changed))
 }
 assert.equal(((await api.handle('skill-secrets/describe',{skill:'x-search'})) as {reconfirm:boolean}).reconfirm,true)
 await api.handle('skill-secrets/save',{skill:'x-search',expectedBinding:expected('x-search'),values:{XAI_API_KEY:secret}})
 assert.equal((await api.readForUse('x-search')).stale,false)
 declared['x-search']=original
})

test('宿主接线：skill-secrets 三端点不进 endpointSet，与 credentialStoreEndpoints 同一位置分发（浏览器专用）',()=>{
 const source=readFileSync(new URL('../src/index.ts',import.meta.url),'utf8')
 const endpointSetLine=source.split('\n').find(line=>line.startsWith('const endpointSet=new Set(['))
 assert.ok(endpointSetLine,'应存在 endpointSet 定义行')
 assert.doesNotMatch(endpointSetLine,/skillSecretEndpoints/)
 const credentialAt=source.indexOf('credentialStoreEndpoints as readonly string[]).includes(endpoint)')
 const skillAt=source.indexOf('skillSecretEndpoints as readonly string[]).includes(endpoint)')
 assert.ok(credentialAt>0&&skillAt>credentialAt&&skillAt-credentialAt<=400,`skill-secrets 分发应紧随 credentialStoreEndpoints 分发之后（${credentialAt}, ${skillAt}）`)
})

test('多变量重新确认（I-2）：声明目标变更后只重存一个变量，其它变量旧值作废，需逐个重新保存',async()=>{
 const {port,api}=fake()
 const good=(envVarName:string):MarketCatalogSkillSecret=>({envVarName,label:{'zh-CN':envVarName,en:envVarName},required:true,target:'header',name:'X-'+envVarName,endpoints:[{origin:'https://api.good.com',pathPrefixes:['/']}],methods:['GET']})
 declared['two-keys']=[good('A_KEY'),good('B_KEY')]
 const a='key'+'-'+rand(24),b='key'+'-'+rand(24)
 await api.handle('skill-secrets/save',{skill:'two-keys',expectedBinding:expected('two-keys'),values:{A_KEY:a,B_KEY:b}})
 assert.deepEqual((await api.readForUse('two-keys')).values,{A_KEY:a,B_KEY:b})
 // 目录把 B 改到别的 origin：整条记录 stale，describe 要求重新确认且回包带各变量的新目标
 declared['two-keys']=[good('A_KEY'),{...good('B_KEY'),endpoints:[{origin:'https://evil.example.org',pathPrefixes:['/']}]}]
 const state=await api.describe('two-keys')
 assert.equal(state.reconfirm,true)
 assert.deepEqual(state.vars.map(v=>[v.envVarName,v.target,v.name,v.endpoints[0]!.origin]),[['A_KEY','header','X-A_KEY','https://api.good.com'],['B_KEY','header','X-B_KEY','https://evil.example.org']])
 // 只重存 A：B 的旧值不得绑到新目标
 const saved=await api.save({skill:'two-keys',expectedBinding:expected('two-keys'),values:{A_KEY:a}})
 assert.deepEqual(saved.vars.map(v=>[v.envVarName,v.configured]),[['A_KEY',true],['B_KEY',false]])
 assert.equal(saved.reconfirm,false)
 const used=await api.readForUse('two-keys')
 assert.deepEqual(used.values,{A_KEY:a})
 assert.equal(used.stale,false)
 assert.deepEqual(Object.keys(((await port.readRecord(skillSecretKey('two-keys'))) as {env:Record<string,string>}).env).sort(),['A_KEY','TELOA_BINDING_SHA256'])
 // 声明未变时保存另一变量：已确认的 A 沿用
 await api.save({skill:'two-keys',expectedBinding:expected('two-keys'),values:{B_KEY:b}})
 assert.deepEqual((await api.readForUse('two-keys')).values,{A_KEY:a,B_KEY:b})
 delete declared['two-keys']
})

test('delete 审计只含技能名与全部声明变量名；未知端点回 not-found；describe 多余键被拒',async()=>{
 const {audit,api}=fake()
 await api.handle('skill-secrets/save',{skill:'x-search',expectedBinding:expected('x-search'),values:{XAI_API_KEY:secret}})
 await api.handle('skill-secrets/delete',{skill:'x-search'})
 assert.deepEqual(audit[1],{event:'skill-secret.delete',skill:'x-search',envVarNames:['XAI_API_KEY']})
 await assert.rejects(api.handle('skill-secrets/list',{skill:'x-search'}),{code:'teloa/not-found'})
 await assert.rejects(api.handle('skill-secrets/describe',{skill:'x-search',values:{}}),/只允许/)
})

test('存储锁定：describe 回 writable:false 不抛；save/delete 回 dependency-unavailable；readForUse 回 storage-unavailable',async()=>{
 const lock=async()=>{throw new CredentialStoreLocked('key-unavailable')}
 const api=createSkillSecretStore({readRecord:lock,describeRecord:async()=>({configured:false,writable:false}),modifyRecord:lock,deleteRecord:lock},fromMap(declared),()=>{})
 assert.equal((await api.describe('x-search')).writable,false)
 await assert.rejects(api.save({skill:'x-search',expectedBinding:expected('x-search'),values:{XAI_API_KEY:secret}}),{code:'teloa/dependency-unavailable'})
 await assert.rejects(api.remove({skill:'x-search'}),{code:'teloa/dependency-unavailable'})
 await assert.rejects(api.readForUse('x-search'),{code:'teloa/storage-unavailable'})
})

test('浏览器专用（行为）：teloaWork.invoke 对 skill-secrets 三端点一律 teloa/forbidden 且不调 dispatch',async()=>{
 const calls:string[]=[]
 const service=createTeloaWorkService({owner:'local:teloa-owner',runtimeRoot:'/tmp/teloa-runtime',attachAllowed:()=>true,dispatch:async endpoint=>{calls.push(endpoint);return {}},broadcast:createBroadcastNotificationAdapter(createLocalNotificationAdapter({info(){}}),{warn(){}}),install:async()=>'/tmp/teloa-runtime/pkg'})
 for(const endpoint of ['skill-secrets/describe','skill-secrets/save','skill-secrets/delete'])await assert.rejects(service.invoke(endpoint,{skill:'x-search'},new AbortController().signal),{code:'teloa/forbidden'},endpoint)
 assert.deepEqual(calls,[])
})

test('声明解析一律看安装绑定（同名单条目也不例外）：绑定目录条目用其声明；GitHub/上传/行业来源、未安装、绑定在集合外一律无声明；describe/readForUse 走同一异步来源',async()=>{
 const xai=declared['x-search']![0]!,other={...xai,envVarName:'OTHER_KEY',endpoints:[{origin:'https://other.example.com',pathPrefixes:['/']}]}
 const byEntry:Record<string,MarketCatalogSkillSecret[]>={'clawhub.a.x-search':[xai],'clawhub.b.x-search':[other],'clawhub.c.x-search':[],'teloa.solo':[xai]}
 const byName:Record<string,string[]>={'x-search':['clawhub.a.x-search','clawhub.b.x-search','clawhub.c.x-search'],solo:['teloa.solo']}
 const asked:string[]=[];let bound:SkillBinding={installed:false}
 const resolve=declaredSkillSecretsResolver({skillEntryIdsByName:name=>byName[name]??[],getSkillSecretsByEntry:id=>byEntry[id]??[],...noMeta},async name=>{asked.push(name);return bound},async()=>true,stable)
 assert.equal(await resolve('unknown'),undefined);assert.deepEqual(asked,[],'目录无此技能不查绑定')
 assert.equal(await resolve('solo'),undefined,'同名单条目但未安装：不注入');assert.deepEqual(asked,['solo'])
 bound={installed:true};assert.equal(await resolve('solo'),undefined,'同名单条目、安装来源为 GitHub/上传/行业（无目录条目）：不注入目录密钥')
 bound={installed:true,entryId:'teloa.solo'};assert.deepEqual((await resolve('solo'))!.secrets.map(s=>s.envVarName),['XAI_API_KEY'],'绑定到该条目才用其声明')
 bound={installed:false};assert.equal(await resolve('x-search'),undefined,'多个同名且未安装：无声明（不取首个）')
 bound={installed:true,entryId:'clawhub.b.x-search'};assert.deepEqual((await resolve('x-search'))!.secrets.map(s=>s.envVarName),['OTHER_KEY'],'以安装绑定的条目为准')
 bound={installed:true,entryId:'clawhub.c.x-search'};assert.equal(await resolve('x-search'),undefined,'绑定条目未声明即无声明')
 bound={installed:true,entryId:'teloa.elsewhere'};assert.equal(await resolve('x-search'),undefined,'绑定条目不在同名集合内即无声明')
 bound={installed:true,entryId:'clawhub.a.x-search'}
 const api=createSkillSecretStore(memoryCredentialPort(),resolve,()=>{})
 assert.deepEqual((await api.describe('x-search')).vars.map(v=>v.envVarName),['XAI_API_KEY'])
 assert.deepEqual((await api.readForUse('x-search')).secrets.map(s=>s.envVarName),['XAI_API_KEY'])
 bound={installed:true}
 // 裁定：当前生效的不是声明密钥的目录安装（未安装/非目录来源/被遮蔽）时 describe 回 vars:[]（界面显示「需先安装」、不给表单），不抛；写与按次读取仍拒绝
 assert.deepEqual(await api.describe('x-search'),{skill:'x-search',binding:null,writable:true,reconfirm:false,vars:[]})
 await assert.rejects(api.save({skill:'x-search',expectedBinding:expected('x-search'),values:{XAI_API_KEY:secret}}),{code:'teloa/version-conflict'})
 await assert.rejects(api.readForUse('x-search'),/没有写明需要密钥/)
})

test('L-6：运行时解析来源须为受管选定安装本身——工作区/用户/插件同名技能遮蔽时一律无声明、不注入',async()=>{
 const managed='/rt/skills/0b3c9a1e-5f7d-4c2b-9a8e-1d2c3b4a5f60/SKILL.md'
 assert.equal(isManagedSkillWinner({provider:'teloa-market',path:managed},managed),true)
 assert.equal(isManagedSkillWinner({provider:'filesystem',path:'/ws/.agents/skills/x-search/SKILL.md'},managed),false,'项目级 .agents/skills 同名遮蔽')
 assert.equal(isManagedSkillWinner({provider:'teloa-market',path:'/rt/skills/other/SKILL.md'},managed),false,'受管但不是选定安装')
 assert.equal(isManagedSkillWinner({provider:'teloa-market'},managed),false,'无路径不认')
 assert.equal(isManagedSkillWinner(undefined,managed),false)
 const xai=declared['x-search']![0]!
 let active=true;const checked:string[]=[]
 const resolve=declaredSkillSecretsResolver({skillEntryIdsByName:name=>name==='x-search'?['clawhub.a.x-search']:[],getSkillSecretsByEntry:()=>[xai],...noMeta},async()=>({installed:true,entryId:'clawhub.a.x-search'}),async name=>{checked.push(name);return active},stable)
 assert.deepEqual((await resolve('x-search'))!.secrets.map(s=>s.envVarName),['XAI_API_KEY'])
 active=false
 assert.equal(await resolve('x-search'),undefined,'被同名技能遮蔽：三态绑定虽指向目录条目，也不取声明')
 assert.deepEqual(checked,['x-search','x-search'])
 const port=memoryCredentialPort()
 await port.modifyRecord(skillSecretKey('x-search'),async()=>({kind:'api-key',env:{XAI_API_KEY:secret,TELOA_BINDING_SHA256:skillSecretBinding([xai])}}))
 const api=createSkillSecretStore(port,resolve,()=>{})
 await assert.rejects(api.readForUse('x-search'),/没有写明需要密钥/,'遮蔽时已存密钥也不读出')
 assert.deepEqual((await api.describe('x-search')).vars,[])
 checked.length=0;await resolve('unknown');assert.deepEqual(checked,[],'目录无此技能不查运行时来源')
})

test('L-6 宿主接线：代发可见性与声明解析都核对胜出者为受管选定安装（isManagedSkillWinner + managedFiles.path）',()=>{
 const source=readFileSync(new URL('../src/index.ts',import.meta.url),'utf8')
 const visible=source.slice(source.indexOf('skillVisible:(exec,name,signal)=>availabilitySync.stable(async()=>{'),source.indexOf('readForUse:name=>skillSecretStore.readForUse(name)'))
 assert.match(visible,/isManagedSkillWinner\(await skills\.get\(name,\{cwd:agent\.session\.header\.cwd,scope:agent,signal\}\),managedFiles\.path\(selected\.installationId\)\)/)
 assert.match(visible,/selected\.availability==='disabled'/)
 const resolver=source.slice(source.indexOf('const declaredSkillSecrets=declaredSkillSecretsResolver('),source.indexOf('const skillSecretStore=createSkillSecretStore('))
 assert.match(resolver,/isManagedSkillWinner\(/);assert.match(resolver,/managedFiles\.path\(selected\.installationId\)/);assert.match(resolver,/cwd:workspaceRoot/)
 assert.match(resolver,/},availabilitySync\.stable\)/,'生产声明解析必须接入与安装维护相同的稳定读取队列')
})

test('指纹向后兼容（规格 2026-09-27 §4.4）：无新字段的声明与改动前逐字节相同；加 allowHeaders 或 httpGuide 后变化',()=>{
 const a:MarketCatalogSkillSecret={envVarName:'XAI_API_KEY',label:{'zh-CN':'xAI API 密钥',en:'xAI API key'},required:true,target:'bearer',endpoints:[{origin:'https://api.x.ai',pathPrefixes:['/v1/']}],methods:['GET','POST']}
 const b:MarketCatalogSkillSecret={envVarName:'EM_API_KEY',label:{'zh-CN':'东方财富密钥',en:'EM key'},required:false,target:'header',name:'em_api_key',endpoints:[{origin:'https://api.example.com',pathPrefixes:['/a/','/b/']},{origin:'https://b.example.com',pathPrefixes:['/']}],methods:['POST']}
 // 两个期望值由改动前的 main（53bd55a8）上的 skillSecretBinding 算出并写死
 assert.equal(skillSecretBinding([a]),'777cf5d395bf352cfca348a2d1122e57e57d774e9312de5766b55505a90e2333')
 assert.equal(skillSecretBinding([b,a]),'9d265e2d04a3c2f707565e4cdabec09dd0d16e0f7c63cb6631e47f2d3c214b5b')
 const guide:MarketCatalogText={'zh-CN':'POST /v1/responses，模型 grok-4。',en:'POST /v1/responses with model grok-4.'}
 const withHeaders=skillSecretBinding([{...a,allowHeaders:['Maton-Connection']}]),withGuide=skillSecretBinding([a],guide)
 assert.notEqual(withHeaders,skillSecretBinding([a]));assert.notEqual(withGuide,skillSecretBinding([a]));assert.notEqual(withHeaders,withGuide)
 assert.equal(skillSecretBinding([{...a,allowHeaders:['B-H','A-H']}]),skillSecretBinding([{...a,allowHeaders:['A-H','B-H']}]),'allowHeaders 顺序归一')
 assert.notEqual(skillSecretBinding([a],{...guide,en:'changed'}),withGuide,'指引任一语言变化都要重新确认')
})

const sharedSecret=(pathPrefixes:string[],methods:MarketCatalogSkillSecret['methods'],extra:Partial<MarketCatalogSkillSecret>={}):MarketCatalogSkillSecret=>({envVarName:'SHARED_API_KEY',label:{'zh-CN':'共享密钥',en:'Shared key'},required:true,target:'header',name:'X-Shared-Key',endpoints:[{origin:'https://api.shared.example.com',pathPrefixes}],methods,...extra})
function groupFixture(){
 const entries:Record<string,{skill:string;secrets:MarketCatalogSkillSecret[];httpGuide?:MarketCatalogText;group?:string}>={
  'grp.b':{skill:'b',secrets:[sharedSecret(['/b/'],['GET'])],group:'shared-demo'},
  'grp.a':{skill:'a',secrets:[sharedSecret(['/a/'],['GET'])],group:'shared-demo'},
  'solo.c':{skill:'c',secrets:[sharedSecret(['/c/'],['GET'])]},
 }
 const members=(group:string):SkillSecretGroupMembers=>Object.entries(entries).filter(([,e])=>e.group===group).map(([entryId,e])=>({entryId,skill:e.skill,secrets:structuredClone(e.secrets),...(e.httpGuide?{httpGuide:e.httpGuide}:{})})).sort((x,y)=>x.skill<y.skill?-1:1)
 const catalog={
  skillEntryIdsByName:(name:string)=>Object.keys(entries).filter(id=>entries[id]!.skill===name),
  getSkillSecretsByEntry:(id:string)=>structuredClone(entries[id]?.secrets??[]),
  getSkillSecretMetaByEntry:(id:string)=>({...(entries[id]?.httpGuide?{httpGuide:entries[id]!.httpGuide!}:{}),...(entries[id]?.group?{secretGroup:entries[id]!.group!}:{})}),
  skillSecretGroupMembers:members,
 }
 const resolve=declaredSkillSecretsResolver(catalog,async name=>({installed:true,entryId:catalog.skillEntryIdsByName(name)[0]!}),async()=>true,stable)
 const port=memoryCredentialPort(),audit:unknown[]=[]
 return {entries,members,resolve,port,audit,api:createSkillSecretStore(port,resolve,event=>audit.push(event))}
}

test('共享密钥组：键为 teloa-skill-group/<组>；保存 A 后 B 同为已保存且读到同一值；describe 回 group.members；删除 B 后 A 变未填写；审计带 group 不含值',async()=>{
 const {api,port,audit}=groupFixture()
 assert.equal(skillSecretGroupKey('shared-demo'),'teloa-skill-group/shared-demo');assert.equal(skillSecretKey('c'),'teloa-skill/c')
 const shownA=await api.describe('a')
 assert.deepEqual(shownA.group,{id:'shared-demo',members:['a','b']});assert.equal(shownA.binding,(await api.describe('b')).binding,'同组同一组指纹')
 const value='shr'+'-'+rand(24)
 await api.save({skill:'a',expectedBinding:shownA.binding,values:{SHARED_API_KEY:value}})
 assert.deepEqual(await port.readRecord(skillSecretGroupKey('shared-demo')),{kind:'api-key',env:{SHARED_API_KEY:value,TELOA_BINDING_SHA256:shownA.binding}})
 assert.equal(await port.readRecord(skillSecretKey('a')),undefined,'分组技能不写按技能名的记录')
 const shownB=await api.describe('b')
 assert.equal(shownB.vars[0]!.configured,true);assert.deepEqual(shownB.group,{id:'shared-demo',members:['a','b']});assert.equal(shownB.reconfirm,false)
 assert.deepEqual(await api.readForUse('b'),{secrets:[sharedSecret(['/b/'],['GET'])],values:{SHARED_API_KEY:value},stale:false,group:'shared-demo'},'B 读到同一值且按自己的前缀声明')
 // 未分组技能不受影响、不带 group
 const c=await api.describe('c');assert.equal('group' in c,false);assert.equal(c.vars[0]!.configured,false)
 assert.equal('group' in (await api.readForUse('c')),false)
 await api.remove({skill:'b'})
 assert.equal(await port.readRecord(skillSecretGroupKey('shared-demo')),undefined)
 assert.equal((await api.describe('a')).vars[0]!.configured,false,'删除作用于整组')
 assert.deepEqual(audit,[{event:'skill-secret.save',skill:'a',envVarNames:['SHARED_API_KEY'],group:'shared-demo'},{event:'skill-secret.delete',skill:'b',envVarNames:['SHARED_API_KEY'],group:'shared-demo'}])
 assert.doesNotMatch(JSON.stringify(audit),new RegExp(value.slice(4,12)))
})

test('组指纹：不含路径前缀（改 A 的前缀不变）；方法并集、附加头并集、任一成员指引变化即变；组指纹与单技能指纹不同',async()=>{
 const {entries,resolve}=groupFixture()
 const binding=async()=>(await resolve('a'))!.group!.binding
 const base=await binding()
 assert.notEqual(base,skillSecretBinding(entries['grp.a']!.secrets))
 entries['grp.a']!.secrets=[sharedSecret(['/a/','/a2/'],['GET'])]
 assert.equal(await binding(),base,'路径前缀不进组指纹')
 entries['grp.b']!.secrets=[sharedSecret(['/b/'],['GET','POST'])]
 const widened=await binding();assert.notEqual(widened,base,'方法并集扩大')
 entries['grp.a']!.secrets=[sharedSecret(['/a/'],['POST'])]
 assert.equal(await binding(),widened,'并集不变则指纹不变')
 entries['grp.a']!.secrets=[sharedSecret(['/a/'],['POST'],{allowHeaders:['Maton-Connection']})]
 const headers=await binding();assert.notEqual(headers,widened,'附加头并集变化')
 entries['grp.b']!.httpGuide={'zh-CN':'先列出再取详情。',en:'List first, then fetch.'}
 assert.notEqual(await binding(),headers,'成员指引变化')
 assert.equal((await resolve('b'))!.group!.binding,await binding(),'同组成员同一组指纹')
})

test('组成员声明不一致（快照与上游缓存版本错位）：describe / readForUse 一律 teloa/invalid-input，不读记录',async()=>{
 const {entries,api,port}=groupFixture()
 const shown=await api.describe('a'),value='shr'+'-'+rand(24)
 await api.save({skill:'a',expectedBinding:shown.binding,values:{SHARED_API_KEY:value}})
 for(const change of [{label:{'zh-CN':'另一用途',en:'Other'}},{required:false},{name:'X-Other-Key'},{endpoints:[{origin:'https://other.shared.example.com',pathPrefixes:['/b/']}]}] as Partial<MarketCatalogSkillSecret>[]){
  entries['grp.b']!.secrets=[{...sharedSecret(['/b/'],['GET']),...change}]
  let read=0
  const guarded=createSkillSecretStore({...port,readRecord:async key=>{read++;return port.readRecord(key)}},async name=>groupFixtureResolve(entries,name),()=>{})
  await assert.rejects(guarded.readForUse('b'),(error:unknown)=>error instanceof WorkError&&error.code==='teloa/invalid-input'&&error.message==='该技能的共享密钥说明不一致，请更新目录后重试',JSON.stringify(change))
  await assert.rejects(guarded.readForUse('a'),{code:'teloa/invalid-input'})
  await assert.rejects(guarded.describe('a'),{code:'teloa/invalid-input'})
  assert.equal(read,0,'不一致时不读记录')
 }
})
// 不一致用例单独建解析器：每次都按当前 entries 取成员
async function groupFixtureResolve(entries:ReturnType<typeof groupFixture>['entries'],name:string){
 const members=Object.entries(entries).filter(([,e])=>e.group==='shared-demo').map(([entryId,e])=>({entryId,skill:e.skill,secrets:structuredClone(e.secrets)}))
 const resolve=declaredSkillSecretsResolver({skillEntryIdsByName:n=>Object.keys(entries).filter(id=>entries[id]!.skill===n),getSkillSecretsByEntry:id=>structuredClone(entries[id]?.secrets??[]),getSkillSecretMetaByEntry:id=>entries[id]?.group?{secretGroup:entries[id]!.group!}:{},skillSecretGroupMembers:()=>members},async n=>({installed:true,entryId:Object.keys(entries).find(id=>entries[id]!.skill===n)!}),async()=>true,stable)
 return resolve(name)
}

test('组保存在 modifyRecord 回调内重新核对组指纹：等待期间同组另一成员的方法并集变化即拒绝且不写',async()=>{
 const {entries,resolve}=groupFixture()
 const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done});return {promise,resolve}}
 const port=memoryCredentialPort(),entered=deferred(),release=deferred()
 const api=createSkillSecretStore({...port,modifyRecord:async(key,mutate)=>{entered.resolve();await release.promise;return port.modifyRecord(key,mutate)}},resolve,()=>{})
 const shown=await api.describe('a')
 const saving=assert.rejects(api.save({skill:'a',expectedBinding:shown.binding,values:{SHARED_API_KEY:'shr'+'-'+rand(24)}}),{code:'teloa/version-conflict'})
 await entered.promise;entries['grp.b']!.secrets=[sharedSecret(['/b/'],['GET','DELETE'])];release.resolve();await saving
 assert.equal(await port.readRecord(skillSecretGroupKey('shared-demo')),undefined)
})
