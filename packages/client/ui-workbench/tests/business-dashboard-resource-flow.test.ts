import {readBusinessConfigurationCandidateV2,type BusinessConfigurationDraftResponseVersioned} from '@teloa/contract'
import {isIndustryManifest} from '../src/client/industry-manifest.ts'
import {referenceCandidates,resolveIndustryReferences} from '../src/client/industry-reference.ts'
import {readIndustryDirectory} from '../src/client/industry-directory.ts'
import {createDashboardMarketJournal} from '../src/client/business-dashboard-market-journal.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import {dashboardResourceFixture} from './fixtures/business-dashboard-resource.ts'
import {createBusinessDashboardResourceApi,packageBusinessDashboardResource} from '../src/client/business-dashboard-resource-api.ts'
import {inspectIndustryContent} from '../src/client/industry-content.ts'
const requestId='11111111-1111-4111-8111-111111111111',contentId='22222222-2222-4222-8222-222222222222',hash='a'.repeat(64)
test('权威导出完整配置固定为 v4 资源，不含记录或自动授权',async()=>{
 const resource=dashboardResourceFixture(),calls:unknown[]=[]
 const api=createBusinessDashboardResourceApi(async(e,r)=>{calls.push([e,r]);return {resource,excluded:['source bindings'],configurationHash:hash}})
 const exported=await api.export({scope:'SOC',id:resource.id,version:resource.version})
 const item=await packageBusinessDashboardResource(exported.resource,{title:'安全看板',description:'配置'});
 assert.equal(item.manifest?.format,'teloa.business-package/v4')
 assert.equal(item.id,'directory-'+item.packageContent!.hash)
 assert.equal(item.manifest!.resources[0]!.kind,'business-configuration')
 const inspection=inspectIndustryContent(item.manifest!,item.packageContent!)[0]!
 assert.equal(inspection.state,'parsed');assert.equal(inspection.definition?.kind,'business-configuration')
 assert.deepEqual(inspection.definition?.definition,resource)
 assert.deepEqual(calls,[['business-dashboard-resources/export',{scope:'SOC',id:resource.id,version:resource.version}]])
})
test('市场草案采用用独立端点，错回执与投递身份拒绝',async()=>{
 const candidate=dashboardResourceFixture().configuration,draftId=contentId
 const draft:BusinessConfigurationDraftResponseVersioned={ownerId:'owner',id:draftId,scope:'SOC',revision:1,baseVersion:0,status:'draft',hash,createdAt:'2026-10-01T00:00:00.000Z',updatedAt:'2026-10-01T00:00:00.000Z',candidate}
 const preview={draftId,revision:1,candidateHash:hash,baseVersion:0,dependencyHash:hash,receipt:hash,changes:{rows:[],truncated:false},issues:[]}
 const calls:[string,unknown][]=[],api=createBusinessDashboardResourceApi(async(e,r)=>{calls.push([e,r]);return e.endsWith('/prepare')?draft:e.endsWith('/preview')?preview:{scope:'SOC',version:1,configurationHash:hash,requestId}})
 const input={requestId,contentId,contentHash:hash,resourceId:'soc-overview',target:{kind:'new' as const,title:'业务'}}
 assert.equal((await api.prepare(input)).id,draftId)
 await api.preview({draftId,expectedRevision:1})
 await api.apply({draftId,expectedRevision:1,expectedBaseVersion:0,previewReceipt:hash,requestId})
 assert.ok(calls.every(([,r])=>r!==null&&typeof r==='object'&&!('sessionId' in r)))
 await assert.rejects(api.preview({draftId,expectedRevision:2}),{code:'teloa/invalid-host-response'})
 await assert.rejects(api.export({scope:'SOC',id:'wrong',version:'1.0.0'}),{code:'teloa/invalid-host-response'})
})


test('看板恢复记录按本人宿主与内容隔离，未知准备保留同一请求且损坏不静默清除',()=>{
 const values=new Map<string,string>(),storage:Pick<Storage,'getItem'|'setItem'|'removeItem'>={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)}
 const journal=createDashboardMarketJournal(storage,'owner@host')
 const prepare={requestId,contentId,contentHash:hash,resourceId:'soc-overview',target:{kind:'new' as const,title:'业务'}}
 journal.write(contentId,{prepare})
 assert.deepEqual(journal.read(contentId),{prepare})
 assert.equal(createDashboardMarketJournal(storage,'other@host').read(contentId),undefined)
 assert.equal(journal.read(requestId),undefined)
 const key=[...values.keys()][0]!;values.set(key,'{"draft":{}}');assert.throws(()=>journal.read(contentId))
 assert.ok(values.has(key));journal.clear(contentId);assert.equal(journal.read(contentId),undefined)
})


test('方案引用本人固定看板用 directory-baseHash，template允许映到业务而其他来源范围保持隔离',async()=>{
 const raw=dashboardResourceFixture(),configuration=readBusinessConfigurationCandidateV2({...raw.configuration,scope:'template',definitions:raw.configuration.definitions.map(row=>({...row,definition:{...row.definition,domain:'template'}}))})
 const source=await packageBusinessDashboardResource({...raw,configuration},{title:'看板',description:'配置'})
 assert.ok(isIndustryManifest(source.manifest))
 source.contentStorage={contentId,createdAt:'2026-10-01T00:00:00.000Z',loaded:true};source.source={kind:'stored',contentId}
 const manifest={...source.manifest,scope:'SOC',id:'solution',resources:[{...source.manifest.resources[0]!,id:'shared-board',source:{kind:'public',id:raw.id,version:raw.version}}]}
 const bytes=new TextEncoder().encode(JSON.stringify(manifest)),target=await readIndustryDirectory([{path:'teloa.json',size:bytes.length,read:async()=>bytes}],'teloa.json','本人方案')
 const candidates=referenceCandidates(target,[source],'shared-board');assert.equal(candidates.length,1)
 assert.equal(candidates[0]!.sourceContentId,contentId);assert.equal(candidates[0]!.sourceItemId,'directory-'+source.packageContent!.hash)
 const resolved=await resolveIndustryReferences(target,[source],candidates)
 assert.ok(isIndustryManifest(resolved.manifest))
 assert.equal(inspectIndustryContent(resolved.manifest,resolved.packageContent!)[0]!.definition?.kind,'business-configuration')
 const scoped=await packageBusinessDashboardResource(raw,{title:'仅SOC',description:'配置'});scoped.contentStorage={contentId,createdAt:'2026-10-01T00:00:00.000Z',loaded:true}
 assert.ok(isIndustryManifest(target.manifest))
 const other={...target,manifest:{...target.manifest!,scope:'OTHER'}}
 assert.equal(referenceCandidates(other,[scoped],'shared-board').length,0)
})


test('升级有未裁定冲突时不形成草案，并严格核候选目标与配置版本',async()=>{
 const calls:unknown[]=[],conflict={key:'page:home',entity:'page',id:'home',baseline:{title:'原名'},current:{title:'本地名'},incoming:{title:'新版名'}}
 const api=createBusinessDashboardResourceApi(async(e,r)=>{calls.push([e,r]);return {draft:null,conflicts:[conflict],changed:[]}})
 const input={requestId,adoptionId:contentId,candidateContentId:'33333333-3333-4333-8333-333333333333',candidateContentHash:hash,resourceId:'soc-overview',expectedConfigurationVersion:2}
 assert.deepEqual(await api.prepareUpgrade(input),{draft:null,conflicts:[conflict],changed:[]})
 assert.deepEqual(calls,[['business-dashboard-resources/prepare-upgrade',input]])
 await assert.rejects(createBusinessDashboardResourceApi(async()=>({draft:null,conflicts:[],changed:[]})).prepareUpgrade(input),{code:'teloa/invalid-host-response'})
})

test('同请求恢复允许已采用草案；权威采用身份不伪造保存请求且清单摘要与正文摘要分离',async()=>{
 const candidate=dashboardResourceFixture().configuration
 const draft:BusinessConfigurationDraftResponseVersioned={ownerId:'owner',id:contentId,scope:'SOC',revision:1,baseVersion:2,status:'applied',hash,createdAt:'2026-10-01T00:00:00.000Z',updatedAt:'2026-10-01T00:00:00.000Z',candidate}
 const adoption={draftId:contentId,scope:'SOC',version:3,configurationHash:'b'.repeat(64)}
 const api=createBusinessDashboardResourceApi(async endpoint=>endpoint.endsWith('/adoption')?adoption:endpoint.endsWith('/prepare-upgrade')?{draft,conflicts:[],changed:[]}:draft)
 assert.equal((await api.prepare({requestId,contentId,contentHash:hash,resourceId:'soc-overview',target:{kind:'existing',scope:'SOC',expectedVersion:2}})).status,'applied')
 assert.equal((await api.prepareUpgrade({requestId,adoptionId:requestId,candidateContentId:contentId,candidateContentHash:hash,resourceId:'soc-overview',expectedConfigurationVersion:2})).draft?.status,'applied')
 assert.deepEqual(await api.adoption({draftId:contentId}),adoption)
 await assert.rejects(api.adoption({draftId:requestId}),{code:'teloa/invalid-host-response'})
 const memory=new Map<string,string>(),journal=createDashboardMarketJournal({getItem:key=>memory.get(key)??null,setItem:(key,value)=>memory.set(key,value),removeItem:key=>memory.delete(key)},'fixture')
 journal.write(contentId,{draft,result:adoption})
 assert.deepEqual(journal.read(contentId)?.result,adoption)
 journal.write(contentId,{draft,result:{...adoption,draftId:requestId}})
 assert.throws(()=>journal.read(contentId))
})
