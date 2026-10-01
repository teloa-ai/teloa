import test from 'node:test'
import assert from 'node:assert/strict'
import { readAtomicSkill } from '../src/client/atomic-skill.ts'
import { atomicSkillItem } from '../src/client/atomic-market.ts'
import { readFile } from 'node:fs/promises'
import { createMarketContentApi } from '../src/client/market-content-api.ts'

const contentId='11111111-1111-4111-8111-111111111111'
const secondId='22222222-2222-4222-8222-222222222222'
const requestId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const createdAt='2026-09-11T00:00:00.000Z'
const bytes=(text:string)=>new TextEncoder().encode(text)
const file=(path:string,text:string)=>{const value=bytes(text);return {path,size:value.length,read:async()=>value}}
const base64=(value:Uint8Array)=>btoa(String.fromCharCode(...value))

async function skillFixture(){
 return readAtomicSkill([file('report/SKILL.md','# 报告\n按证据写作。'),file('report/examples.md','示例')],{id:'report-writing',title:'报告撰写',version:'1.0.0',categories:['写作']})
}
async function response(id=contentId){
 const skill=await skillFixture()
 return {receipt:{requestId,contentId:id,source:{kind:'upload',name:'report'},createdAt},content:{id,ownerId:'owner',kind:'atomic-skill',logicalId:skill.id,version:skill.version,hash:skill.hash,baseHash:skill.hash,manifestPath:skill.entryPath,metadata:{id:skill.id,title:skill.title,version:skill.version,categories:skill.categories},files:skill.files.map(row=>({path:row.path,hash:row.hash,base64:base64(row.bytes)})),provides:[{resourceId:skill.id,kind:'skill',version:skill.version,path:skill.entryPath}],references:[],createdAt}}
}

test('独立 Skill 提交原始文件字节，后端固定身份返回后才进入持久目录',async()=>{
 const skill=await skillFixture(),calls:{endpoint:string;payload:unknown}[]=[]
 let raw:string|null=null
 const api=createMarketContentApi(async(endpoint,payload)=>{calls.push({endpoint,payload});return response()}, {read:()=>raw,write:value=>{raw=value},clear:()=>{raw=null}},()=>requestId)
 const item=await api.importAtomic(skill,'report')
 assert.equal(calls[0]?.endpoint,'market-content/import')
 assert.deepEqual(calls[0]?.payload,{kind:'atomic-skill',requestId,source:{kind:'upload',name:'report'},metadata:{id:'report-writing',title:'报告撰写',version:'1.0.0',categories:['写作']},trust:{publisher:'report',repository:null,license:{status:'missing'},signature:{status:'unverified',signer:null},compatibility:{teloa:'未声明',dsh:'未声明'},plugins:[],externalCapabilities:[],permissions:[],review:{conclusion:'needs-review',summary:'本地上传来源尚未完成签名与兼容审查'}},files:[{path:'report/SKILL.md',base64:'IyDmiqXlkYoK5oyJ6K+B5o2u5YaZ5L2c44CC'},{path:'report/examples.md',base64:'56S65L6L'}]})
 assert.equal(item.contentStorage?.contentId,contentId)
 assert.equal(item.contentStorage?.loaded,true)
 assert.equal(item.atomicSkill?.text,'# 报告\n按证据写作。')
 assert.equal(raw,null)
})

test('导入回包未知时只持久化请求身份，刷新用 receipt 恢复且不保存文件到浏览器',async()=>{
 const skill=await skillFixture();let raw:string|null=null
 const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
 await assert.rejects(createMarketContentApi(async()=>{throw Error('回包丢失')},journal,()=>requestId).importAtomic(skill,'report'),/回包丢失/)
 assert.ok(raw)
 assert.doesNotMatch(raw!,/base64|IyDmiq/)
 const calls:{endpoint:string;payload:unknown}[]=[]
 const restored=createMarketContentApi(async(endpoint,payload)=>{calls.push({endpoint,payload});return response()},journal,()=>secondId)
 const item=await restored.recover()
 assert.deepEqual(calls,[{endpoint:'market-content/receipt',payload:{requestId}}])
 assert.equal(item.contentStorage?.contentId,contentId)
 assert.equal(raw,null)
})

test('receipt 未找到时保留同一请求；重选不同内容被阻止，原内容沿用 requestId 重试',async()=>{
 const skill=await skillFixture();let raw:string|null=null,phase='lost';const sent:unknown[]=[]
 const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
 const call=async(endpoint:string,payload:unknown)=>{
  sent.push({endpoint,payload})
  if(phase==='lost')throw Error('回包丢失')
  if(phase==='missing')throw Object.assign(Error('记录不存在'),{rejected:true,code:'teloa/not-found'})
  return response()
 }
 const first=createMarketContentApi(call,journal,()=>requestId)
 await assert.rejects(first.importAtomic(skill,'report'),/回包丢失/)
 phase='missing';const refreshed=createMarketContentApi(call,journal,()=>secondId)
 await assert.rejects(refreshed.recover(),/重新选择原文件.*同一请求/)
 assert.ok(raw)
 const changed={...skill,title:'另一个 Skill',hash:'f'.repeat(64)}
 await assert.rejects(refreshed.importAtomic(changed,'report'),/先恢复同一市场导入请求/)
 phase='ready';await refreshed.importAtomic(skill,'report')
 const retried=sent.at(-1) as {endpoint:string;payload:{requestId:string}}
 assert.equal(retried.endpoint,'market-content/import')
 assert.equal(retried.payload.requestId,requestId)
 assert.equal(raw,null)
})

test('持久目录使用分页摘要且详情单独取完整字节，重复身份与损坏字节均拒绝',async()=>{
 const full=await response(),first={...full.content};delete (first as Partial<typeof first>).files
 const other={...first,id:secondId,logicalId:'other-skill',hash:'b'.repeat(64),baseHash:'b'.repeat(64),metadata:{id:'other-skill',title:'另一个 Skill',version:'1.0.0',categories:[]},provides:[{resourceId:'other-skill',kind:'skill',version:'1.0.0',path:'other/SKILL.md'}]}
 const calls:string[]=[]
 const api=createMarketContentApi(async(endpoint,payload)=>{
  calls.push(endpoint+':'+JSON.stringify(payload))
  if(endpoint==='market-content/list')return (payload as {cursor?:string}).cursor?{items:[other],nextCursor:null}:{items:[first],nextCursor:contentId}
  if(endpoint==='market-content/get')return full.content
  throw Error('unexpected')
 },undefined,()=>requestId)
 const items=await api.list()
 assert.deepEqual(items.map(item=>item.contentStorage?.contentId),[contentId,secondId])
 assert.ok(items.every(item=>item.contentStorage?.loaded===false&&item.atomicSkill===undefined))
 const loaded=await api.hydrate(items[0]!)
 assert.equal(loaded.atomicSkill?.text,'# 报告\n按证据写作。')
 assert.deepEqual(calls,['market-content/list:{"limit":100}','market-content/list:{"cursor":"11111111-1111-4111-8111-111111111111","limit":100}','market-content/get:{"contentId":"11111111-1111-4111-8111-111111111111"}'])
 const duplicate=createMarketContentApi(async()=>({items:[first,first],nextCursor:null}))
 await assert.rejects(duplicate.list(),/重复/)
 const corrupt={...full.content,files:full.content.files.map((row,index)=>index?row:{...row,base64:'AA=='})}
 const broken=createMarketContentApi(async()=>corrupt)
 await assert.rejects(broken.hydrate(items[0]!),/摘要|字节|不一致/)
 const crossed=createMarketContentApi(async()=>({...full.content,id:secondId}))
 await assert.rejects(crossed.hydrate(items[0]!),/目标身份不一致/)
 const changedSummary={...items[0]!,hash:'b'.repeat(64)}
 const changed=createMarketContentApi(async()=>full.content)
 await assert.rejects(changed.hydrate(changedSummary),/目录摘要不一致/)
})

test('持久 Skill 目录与详情都保留可选标题本地化元数据',async()=>{
 const localized={title:{original:'报告撰写',defaultLocale:'en',locales:{en:'Report writing'}}}
 const skill=await readAtomicSkill([file('report/SKILL.md','# 报告')],{id:'localized-report',title:'报告撰写',version:'1.0.0',categories:[],localized})
 const full={id:contentId,ownerId:'owner',kind:'atomic-skill' as const,logicalId:skill.id,version:skill.version,hash:skill.hash,baseHash:skill.hash,manifestPath:skill.entryPath,metadata:{id:skill.id,title:skill.title,version:skill.version,categories:skill.categories,localized},files:skill.files.map(row=>({path:row.path,hash:row.hash,base64:base64(row.bytes)})),provides:[{resourceId:skill.id,kind:'skill',version:skill.version,path:skill.entryPath}],references:[],createdAt}
 const head={...full};delete (head as Partial<typeof head>).files
 const api=createMarketContentApi(async(endpoint)=>endpoint==='market-content/list'?{items:[head],nextCursor:null}:full)
 const item=(await api.list())[0]!
 // 标题本地化原样保留；说明文字另有白话十语（atomicSkillCopy）
 assert.deepEqual(item.localized?.title,localized.title)
 assert.deepEqual((await api.hydrate(item)).localized?.title,localized.title)
 assert.equal(item.localized?.summary?.locales.en,'A saved skill; open the details to check the original text.')
 assert.doesNotMatch(item.summary,/DSH|Skill/)
})

test('导入被服务明确拒绝时释放请求，未知错误仍保留待核对身份',async()=>{
 const skill=await skillFixture();let raw:string|null=null
 const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
 const denied=createMarketContentApi(async()=>{throw Object.assign(Error('内容无效'),{rejected:true,code:'teloa/invalid-input'})},journal,()=>requestId)
 await assert.rejects(denied.importAtomic(skill,'report'),/内容无效/)
 assert.equal(denied.pending(),undefined);assert.equal(raw,null)
 const unknown=createMarketContentApi(async()=>{throw Error('连接中断')},journal,()=>secondId)
 await assert.rejects(unknown.importAtomic(skill,'report'),/连接中断/)
 assert.equal(unknown.pending()?.requestId,secondId);assert.ok(raw)
})

test('公共 Skill 没有真实 contentId 或来源只是演示时不提交行业模板',async()=>{
 const skill=await skillFixture(),source=atomicSkillItem(skill)
 const manifest={format:'teloa.business-package/v2' as const,id:'research',title:'研究行业',version:'1.0.0',domain:'general',scope:'general',description:'研究',resources:[{id:'report',kind:'skill' as const,title:'报告',version:'1.0.0',required:true,source:{kind:'public' as const,id:'report-writing',version:'1.0.0'}}],relations:[],entrypoints:['report']}
 const raw=JSON.stringify(manifest),manifestBytes=bytes(raw)
 const item={id:'directory-'+'c'.repeat(64),kind:'bundle' as const,title:'研究行业',version:'1.0.0',scope:'general',visibility:'personal' as const,summary:'研究',requirements:['核对'],output:'工作空间',author:'本人导入',license:'待核对',source:{kind:'upload' as const,name:'research',size:manifestBytes.length},owner:'Teloa' as const,compatibility:'未安装',components:[],manifest,hash:'d'.repeat(64),raw,packageContent:{manifestPath:'teloa.json',hash:'c'.repeat(64),files:[{path:'teloa.json',hash:'e'.repeat(64),bytes:manifestBytes}],resources:[{id:'report',state:'unresolved' as const}],resolved:[{resourceId:'report',sourceItemId:source.id,sourceResourceId:'report-writing',sourceHash:skill.hash,sourceKind:'atomic-skill' as const,kind:'skill' as const,version:'1.0.0',inspection:{id:'report',state:'pending' as const,message:'待核验'},sourcePath:'report/SKILL.md',sourceFiles:skill.files}]}}
 let calls=0;const api=createMarketContentApi(async()=>{calls++;throw Error('不应调用')})
 await assert.rejects(api.importIndustry(item),/真实 contentId/)
 await assert.rejects(api.importIndustry({...item,source:{kind:'builtin'}}),/上传来源/)
 assert.equal(calls,0)
 let submitted:unknown
 const sending=createMarketContentApi(async(_endpoint,payload)=>{submitted=payload;throw Error('停止在请求边界')},undefined,()=>requestId)
 const fixed={...item,packageContent:{...item.packageContent,resolved:item.packageContent.resolved.map(reference=>({...reference,sourceContentId:contentId}))}}
 await assert.rejects(sending.importIndustry(fixed),/停止在请求边界/)
 assert.deepEqual((submitted as {references:unknown}).references,[{resourceId:'report',sourceContentId:contentId,sourceItemId:source.id,sourceResourceId:'report-writing',sourceHash:skill.hash}])
})

const githubRequestId='33333333-3333-4333-8333-333333333333'
const industryManifest={format:'teloa.business-package/v2',id:'github-industry',title:'GitHub 行业',version:'1.0.0',domain:'general',scope:'general',description:'来自固定归档的行业模板',resources:[{id:'method',kind:'skill',title:'方法',version:'1.0.0',required:true,source:{kind:'local',path:'method/SKILL.md'}}],relations:[],entrypoints:['method']}
const digest=async(value:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(value))),byte=>byte.toString(16).padStart(2,'0')).join('')
async function githubResponse(){
 const rows=[{path:'method/SKILL.md',bytes:bytes('# 方法\n')},{path:'teloa.json',bytes:bytes(JSON.stringify(industryManifest))}]
 const files=await Promise.all(rows.map(async row=>({path:row.path,hash:await digest(row.bytes),base64:base64(row.bytes)})))
 const hash=await digest(bytes(JSON.stringify({manifestPath:'teloa.json',files:files.map(file=>[file.path,file.hash])})))
 const content={id:contentId,ownerId:'owner',kind:'industry-template',logicalId:industryManifest.id,version:industryManifest.version,hash,baseHash:hash,manifestPath:'teloa.json',metadata:industryManifest,files,provides:[{resourceId:'method',kind:'skill',version:'1.0.0',path:'method/SKILL.md'}],references:[],createdAt}
 return {receipt:{requestId,contentId,source:{kind:'github',owner:'teloa-ai',repo:'starter',requestedRef:'main',resolvedCommit:'0'.repeat(40),archiveHash:'c'.repeat(64)},createdAt},content}
}

test('GitHub 固定来源按独立日志导入行业模板，未知回包保留同一请求，明确拒绝释放请求',async()=>{
 const payload=await githubResponse(),sent:{endpoint:string;payload:unknown}[]=[]
 let raw:string|null=null
 const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
 const api=createMarketContentApi(async(endpoint,value)=>{sent.push({endpoint,payload:value});return payload},undefined,()=>requestId,journal)
 const item=await api.importGithub({githubRequestId,manifestPath:'teloa.json'})
 assert.equal(sent.length,1);assert.deepEqual(sent.at(0),{endpoint:'market-content/import-github',payload:{requestId,githubRequestId,manifestPath:'teloa.json'}})
 assert.equal(item.kind,'bundle');assert.equal(item.contentStorage?.contentId,contentId);assert.equal(item.packageContent?.manifestPath,'teloa.json')
 assert.equal(raw,null);assert.equal(api.pendingGithubImport(),undefined)
 const lost=createMarketContentApi(async()=>{throw Error('回包丢失')},undefined,()=>requestId,journal)
 await assert.rejects(lost.importGithub({githubRequestId,manifestPath:'teloa.json'}),/回包丢失/)
 assert.ok(raw);assert.match(raw!,/teloa\.market-import-github\/v1/);assert.doesNotMatch(raw!,/base64|IyDmlrk/)
 const retry=createMarketContentApi(async(endpoint,value)=>{sent.push({endpoint,payload:value});return payload},undefined,()=>secondId,journal)
 await assert.rejects(retry.importGithub({githubRequestId,manifestPath:'other.json'}),/先恢复同一 GitHub 导入请求/)
 await retry.importGithub({githubRequestId,manifestPath:'teloa.json'})
 assert.equal((sent.at(-1)?.payload as {requestId:string}).requestId,requestId)
 assert.equal(raw,null)
 const denied=createMarketContentApi(async()=>{throw Object.assign(Error('来源不可用'),{rejected:true,code:'teloa/source-unavailable'})},undefined,()=>secondId,journal)
 await assert.rejects(denied.importGithub({githubRequestId,manifestPath:'teloa.json'}),/来源不可用/)
 assert.equal(raw,null);assert.equal(denied.pendingGithubImport(),undefined)
})

test('GitHub 导入回执的出处、内容种类与清单路径不符时拒绝进入目录',async()=>{
 const payload=await githubResponse()
 const wrongSource=createMarketContentApi(async()=>({...payload,receipt:{...payload.receipt,source:{kind:'upload',name:'report'}}}),undefined,()=>requestId)
 await assert.rejects(wrongSource.importGithub({githubRequestId,manifestPath:'teloa.json'}),/GitHub 来源出处/)
 const wrongPath=createMarketContentApi(async()=>payload,undefined,()=>requestId)
 await assert.rejects(wrongPath.importGithub({githubRequestId,manifestPath:'method/SKILL.md'}),/回执与原请求不一致/)
 const shortCommit=createMarketContentApi(async()=>({...payload,receipt:{...payload.receipt,source:{...payload.receipt.source,resolvedCommit:'abc'}}}),undefined,()=>requestId)
 await assert.rejects(shortCommit.importGithub({githubRequestId,manifestPath:'teloa.json'}),/GitHub 来源出处/)
})

test('GitHub 导入回包丢失后可按原请求找回回执；回执不匹配保留日志，宿主没有该请求则释放日志',async()=>{
 const payload=await githubResponse();let raw:string|null=null
 const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
 const lost=createMarketContentApi(async()=>{throw Error('回包丢失')},undefined,()=>requestId,journal)
 await assert.rejects(lost.importGithub({githubRequestId,manifestPath:'teloa.json'}),/回包丢失/)
 assert.deepEqual(lost.pendingGithubImport(),{requestId,githubRequestId,manifestPath:'teloa.json'})
 const mismatch=createMarketContentApi(async()=>({...payload,content:{...payload.content,manifestPath:'method/SKILL.md'}}),undefined,()=>secondId,journal)
 await assert.rejects(mismatch.recoverGithubImport(),/不一致|响应/)
 assert.ok(raw);assert.equal(mismatch.pendingGithubImport()?.requestId,requestId)
 const sent:unknown[]=[]
 const restored=createMarketContentApi(async(endpoint,value)=>{sent.push({endpoint,payload:value});return payload},undefined,()=>secondId,journal)
 const item=await restored.recoverGithubImport()
 assert.deepEqual(sent,[{endpoint:'market-content/receipt',payload:{requestId}}])
 assert.equal(item.contentStorage?.contentId,contentId)
 assert.equal(raw,null);assert.equal(restored.pendingGithubImport(),undefined)
 await assert.rejects(restored.recoverGithubImport(),/没有待核对的 GitHub 导入请求/)
 const again=createMarketContentApi(async()=>{throw Error('回包丢失')},undefined,()=>requestId,journal)
 await assert.rejects(again.importGithub({githubRequestId,manifestPath:'teloa.json'}),/回包丢失/)
 const missing=createMarketContentApi(async()=>{throw Object.assign(Error('记录不存在'),{rejected:true,code:'teloa/not-found'})},undefined,()=>secondId,journal)
 await assert.rejects(missing.recoverGithubImport(),/没有这笔 GitHub 导入请求/)
 assert.equal(raw,null);assert.equal(missing.pendingGithubImport(),undefined)
})

test('客户端把 GitHub 导入日志与固定来源动作接到市场表单',async()=>{
 const [index,forms]=await Promise.all([readFile(new URL('../src/client/index.ts',import.meta.url),'utf8'),readFile(new URL('../src/client/MarketForms.tsx',import.meta.url),'utf8')])
 assert.match(index,/teloa\.market-import-github\/v1/)
 assert.match(forms,/contentApi\.importGithub\(\{githubRequestId:fixedRequest,manifestPath:found\[0\]!\.path\}\)/)
 assert.match(forms,/market\.forms\.import\.as\.industry\.template/)
 assert.match(forms,/market\.forms\.multiple\.industry\.lists\.in\.the\.fixed\.source/)
 const page=await readFile(new URL('../src/client/MarketPage.tsx',import.meta.url),'utf8')
 assert.match(page,/contentApi\.recoverGithubImport\(\)/);assert.match(page,/market\.content\.pendingGithubImport/);assert.match(page,/market\.content\.reviewGithubImport/)
})

test('GitHub 子目录导入 Skill：只发请求身份与 SKILL.md 路径，回执来源带 path 且内容路径一致',async()=>{
 const skill=await skillFixture(),calls:{endpoint:string;payload:unknown}[]=[]
 const base=await response(),path=skill.entryPath
 const github={kind:'github',owner:'openai',repo:'skills',requestedRef:'main',resolvedCommit:'0123456789abcdef0123456789abcdef01234567',archiveHash:'b'.repeat(64),path:path.slice(0,path.lastIndexOf('/'))}
 const githubRequestId='33333333-3333-4333-8333-333333333333'
 const api=createMarketContentApi(async(endpoint,payload)=>{calls.push({endpoint,payload});return {...base,receipt:{...base.receipt,source:github}}},undefined,()=>requestId)
 const item=await api.importGithubSkill({githubRequestId,skillPath:path})
 assert.deepEqual(calls,[{endpoint:'market-content/import-github-skill',payload:{requestId,githubRequestId,skillPath:path}}])
 assert.equal(item.contentStorage?.contentId,contentId)
 await assert.rejects(api.importGithubSkill({githubRequestId,skillPath:'report/README.md'}))
 const wrongPath=createMarketContentApi(async()=>({...base,receipt:{...base.receipt,source:github}}),undefined,()=>requestId)
 await assert.rejects(wrongPath.importGithubSkill({githubRequestId,skillPath:'other/SKILL.md'}),/GitHub 导入回执/)
 let attempts=0;const ids:unknown[]=[]
 const retry=createMarketContentApi(async(_endpoint,payload)=>{ids.push((payload as {requestId:string}).requestId);if(attempts++===0)throw Error('断线');return {...base,receipt:{...base.receipt,requestId:(payload as {requestId:string}).requestId,source:github}}},undefined,()=>crypto.randomUUID())
 await assert.rejects(retry.importGithubSkill({githubRequestId,skillPath:path}),/断线/)
 await retry.importGithubSkill({githubRequestId,skillPath:path})
 assert.equal(ids[0],ids[1])
})
