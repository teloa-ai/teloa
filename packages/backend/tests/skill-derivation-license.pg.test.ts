import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {writeFile,mkdir} from 'node:fs/promises'
import {join} from 'node:path'
import {PostgreSqlContainer} from '@testcontainers/postgresql'
import {Pool,stopTestContainer} from './postgres-test-lifecycle.ts'
import {useLocalContainerRuntime} from './testcontainers-env.ts'
import {initializeMarketContents,MarketContentStore} from '../src/market/content-store.ts'
import {createMarketContentHandler} from '../../harness-dsh/src/market-content.ts'
import {createMarketContentApi} from '../../client/ui-workbench/src/client/market-content-api.ts'
import {SkillInstallSource} from '../src/market/skill-install-source.ts'
import type {IndustryModelDependency,IndustryModelPhase} from '@teloa/contract'
import {readAtomicSkill} from '../../client/ui-workbench/src/client/atomic-skill.ts'

test('派生技能声明许可经真实RPC解码与PostgreSQL保存，丢回包仅恢复原许可回执且不继承签名',{timeout:180000},async()=>{
 useLocalContainerRuntime()
 const container=await new PostgreSqlContainer('postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73').start(),pool=new Pool({connectionString:container.getConnectionUri()})
 try{
  await initializeMarketContents(pool)
  const ownerId=randomUUID(),requestId=randomUUID(),store=new MarketContentStore(pool,{id:randomUUID,now:()=>new Date().toISOString()}),actor={ownerId,kind:'human' as const}
  const handler=createMarketContentHandler(ownerId,async()=>({import:store.import.bind(store),get:store.get.bind(store),getImport:store.getImport.bind(store),list:store.list.bind(store),importGithub:async()=>{throw Error('not used')},importGithubSkill:async()=>{throw Error('not used')}}))
  const encoder=new TextEncoder(),files=[{path:'SKILL.md',bytes:encoder.encode('---\nname: my-review-copy\ndescription: Review provided evidence.\n---\nIndependent instructions.\n')},{path:'LICENSE',bytes:encoder.encode('Original Apache-2.0 copyright.\n')},{path:'assets/sample.bin',bytes:new Uint8Array([0,255,1,128])}]
  const dependency:IndustryModelDependency={catalogId:'teloa.model.sensevoice',version:'1.0.0',usage:'speech-to-text',required:true}
  const content=await readAtomicSkill(files.map(file=>({path:file.path,size:file.bytes.length,read:async()=>file.bytes})),{id:'my-review-copy',title:'My evidence review',version:'1.0.0',categories:[],modelDependencies:[dependency]})
  const binding={ownerId,installationId:randomUUID(),bundleHash:'a'.repeat(64),sourceIdentity:JSON.stringify({kind:'atomic',contentId:randomUUID()})},options={license:'Apache-2.0',derivation:binding,requirements:{compatibility:{teloa:'0.2.10',dsh:'0.2.1-rc.2'},plugins:[{id:'evidence-helper',version:'1.0.0',required:true}],externalCapabilities:[{id:'evidence-service',kind:'connection' as const,required:true}],permissions:[{id:'read-evidence',description:'Read authorized evidence only',required:true}]}}
  let journal:string|null=null,imports=0,savedRequest:unknown
  const persistence={read:()=>journal,write:(value:string)=>{journal=value},clear:()=>{journal=null}}
  const call=async(endpoint:string,payload:unknown)=>{const value=await handler(endpoint,payload);if(endpoint==='market-content/import'){imports++;savedRequest=payload;throw Error('reply lost after commit')}return value}
  const api=createMarketContentApi(call,persistence,()=>requestId)
  await assert.rejects(api.importAtomic(content,'My independent copy',options),/reply lost/)
  assert.equal(imports,1);assert.ok(journal);assert.doesNotMatch(journal!,/base64|Original Apache/)
  const originalJournal=journal
  await assert.rejects(api.importAtomic(content,'My independent copy',{...options,license:'MIT'}),/先恢复同一/)
  assert.equal(journal,originalJournal);assert.equal(imports,1,'许可变化在本地拒绝，不清掉原未知请求，也不发送冲突写入')
  assert.equal((await pool.query('select count(*)::int as count from teloa_market_contents')).rows[0].count,1)
  const restored=createMarketContentApi(call,persistence,()=>{throw Error('recovery must not allocate a request')})
  const item=await restored.recover()
  assert.equal(journal,null);assert.equal(imports,1);assert.equal(item.license,'Apache-2.0');assert.deepEqual(item.trust?.license,{status:'declared',value:'Apache-2.0'});assert.deepEqual(item.trust?.signature,{status:'unverified',signer:null});assert.equal(item.trust?.review.conclusion,'needs-review');assert.equal(item.author,'本人导入');assert.equal(item.author,item.trust?.publisher)
  const actual=await store.get(actor,{contentId:item.contentStorage!.contentId})
  assert.deepEqual(actual.trust.license,{status:'declared',value:'Apache-2.0'});assert.deepEqual(actual.files.map(file=>({path:file.path,bytes:file.bytes})),[...files].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0))
  assert.deepEqual(actual.metadata.modelDependencies,[dependency]);assert.deepEqual(item.atomicSkill?.modelDependencies,[dependency])
  assert.deepEqual(actual.trust.plugins,options.requirements.plugins);assert.deepEqual(actual.trust.externalCapabilities,options.requirements.externalCapabilities);assert.deepEqual(actual.trust.permissions,options.requirements.permissions);assert.deepEqual(actual.trust.compatibility,options.requirements.compatibility)
  const loads={get:async()=>{throw Error('atomic must not read or prepare a scheme')}}
  let modelPhase:IndustryModelPhase='disabled',modelProbes=0
  const skillSource=new SkillInstallSource(store,loads,async fixed=>{assert.deepEqual(fixed,dependency);modelProbes++;return modelPhase}),bundle=await skillSource.read(ownerId,{kind:'atomic',contentId:actual.id})
  assert.equal(modelProbes,0,'保存和静态读取不准备模型、不调用模型')
  await assert.rejects(skillSource.assertModelsReady(ownerId,bundle.source),{code:'teloa/dependency-unavailable'})
  for(const phase of ['standby','ready'] as const){modelPhase=phase;await skillSource.assertModelsReady(ownerId,bundle.source)}
  modelPhase='disabled';await assert.rejects(skillSource.assertModelsReady(ownerId,bundle.source),{code:'teloa/dependency-unavailable'})
  await assert.rejects(new SkillInstallSource(store,loads).assertModelsReady(ownerId,bundle.source),{code:'teloa/dependency-unavailable'})
  const request=(await pool.query('select request_spec from teloa_market_imports where owner_id=$1 and request_id=$2',[ownerId,requestId])).rows[0].request_spec
  assert.equal(request.trustHash,actual.trustHash)
  const changed=structuredClone(savedRequest) as {trust:{license:{status:'declared';value:string}}};changed.trust.license.value='MIT'
  await assert.rejects(handler('market-content/import',changed),{code:'teloa/conflict'})
  assert.equal((await pool.query('select count(*)::int as count from teloa_market_contents')).rows[0].count,1)
  assert.deepEqual((await store.getImport(actor,{requestId})).content.trust.license,{status:'declared',value:'Apache-2.0'})
  const secondRequestId=randomUUID(),secondContent=await readAtomicSkill(files.map(file=>{const bytes=file.path==='SKILL.md'?encoder.encode(new TextDecoder().decode(file.bytes).replace('my-review-copy','my-other-copy')):file.bytes;return {path:file.path,size:bytes.length,read:async()=>bytes}}),{id:'my-other-copy',title:'Other copy',version:'1.0.0',categories:[]}),sent:unknown[]=[]
  let precommitLost=false
  const secondCall=async(endpoint:string,payload:unknown)=>{if(endpoint==='market-content/import'){sent.push(structuredClone(payload));if(!precommitLost){precommitLost=true;throw Error('connection lost before admission')}}try{return await handler(endpoint,payload)}catch(error){if(error&&typeof error==='object'&&'code'in error)Object.assign(error,{rejected:true});throw error}}
  const second=createMarketContentApi(secondCall,persistence,()=>secondRequestId)
  await assert.rejects(second.importAtomic(secondContent,'Other independent copy',options),/before admission/)
  const afterReload=createMarketContentApi(secondCall,persistence,()=>{throw Error('must retain original request')})
  await assert.rejects(afterReload.recover(),{code:'teloa/not-found'})
  assert.equal(afterReload.pending()?.requestId,secondRequestId)
  const continued=await afterReload.importAtomic(secondContent,'Other independent copy',options)
  assert.deepEqual(sent[0],sent[1],'未准入请求恢复时保持整个原请求和许可，不分配新nonce')
  assert.equal(continued.atomicSkill?.hash,secondContent.hash);assert.equal(journal,null)
  assert.equal((await pool.query('select count(*)::int as count from teloa_market_contents')).rows[0].count,2)
  if(process.env.TELOA_SKILL_DERIVATION_EVIDENCE_DIR){const dir=process.env.TELOA_SKILL_DERIVATION_EVIDENCE_DIR;await mkdir(dir,{recursive:true});await writeFile(join(dir,'postgres-license-proof.json'),JSON.stringify({schema:'teloa.skill-derivation-pg-source-proof/v1',at:new Date().toISOString(),installedCandidate:false,transport:'actual createMarketContentHandler decode/encode',storage:'isolated actual PostgreSQL fixed-image test container',firstRequestId:requestId,contentId:item.contentStorage!.contentId,license:actual.trust.license,signature:actual.trust.signature,review:actual.trust.review,requestTrustHash:request.trustHash,licenseChangeRejectedBeforeDispatch:true,modelDependencies:actual.metadata.modelDependencies,requiredModelDisabledRejected:true,readyAndStandbyAllowed:true,modelDisabledAgainRejected:true,modelProbes,capabilityDeclarationsPreserved:true,firstImports:imports,secondRequestId,preAdmissionRetryEntireRequestExact:true,totalFixedContents:2,existingInstancesTouched:false},null,2)+'\n')}
 }finally{await pool.end();await stopTestContainer(container)}
})
