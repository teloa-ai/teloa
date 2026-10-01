import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {readBusinessDashboardResource,type BusinessConfigurationCandidateV2} from '@teloa/contract'
import {BusinessDashboardResourceService} from '../src/work/business-dashboard-resource.ts'
import {mapBusinessDashboardConfiguration} from '../src/work/business-dashboard-resource-mapping.ts'
import {businessConfigurationHash} from '../src/work/business-configuration-store.ts'
import {dashboardBody,dashboardManifest} from './fixtures/business-dashboard.ts'

/** 只替代存储和草案端口；来源解析、映射、借用判定及三方合并均运行生产代码。 */
async function upgrade(current:BusinessConfigurationCandidateV2,provenance:Record<string,unknown>,objectId:string,version:string,baseVersion:number){
 const body=dashboardBody();body.version=version
 body.configuration.definitions=body.configuration.definitions.map(item=>item.kind==='object-type'?{...item,definition:{...item.definition,id:objectId}}:item.kind==='view'?{...item,definition:{...item.definition,objectType:objectId}}:item)
 body.configuration.pages=body.configuration.pages.map(page=>page.kind==='records'?{...page,objectType:objectId}:page)
 const manifest=dashboardManifest();manifest.version=version;manifest.resources[0]!.version=version
 const bytes=new TextEncoder().encode(JSON.stringify(body)),hash=createHash('sha256').update(bytes).digest('hex'),contentId=randomUUID(),adoptionId=randomUUID(),draftId=randomUUID()
 const content={id:contentId,kind:'industry-template',hash,metadata:manifest,manifestPath:'teloa.json',references:[],provides:[{resourceId:'soc-overview',kind:'business-configuration',version,path:'configuration.json'}],files:[{path:'configuration.json',bytes,hash}]}
 type StoredPreparation={spec_hash:string;draft_id:string|null;source:Record<string,unknown>;result:Record<string,unknown>}
 let stored:StoredPreparation|undefined
 const pool={query:async(sql:string,values:unknown[])=>{
  if(sql.startsWith('select spec_hash,draft_id,result'))return {rows:[]}
  if(sql.startsWith('select source from'))return {rows:[{source:provenance}]}
  if(sql.startsWith('insert into')){stored={spec_hash:String(values[2]),source:JSON.parse(String(values[3])) as Record<string,unknown>,result:JSON.parse(String(values[4])) as Record<string,unknown>,draft_id:null};return {rows:[]}}
  if(sql.startsWith('select spec_hash,draft_id,source,result'))return {rows:[stored]}
  if(sql.startsWith('update')){stored={...stored!,draft_id:String(values[3]),source:JSON.parse(String(values[4])) as Record<string,unknown>,result:JSON.parse(String(values[5])) as Record<string,unknown>};return {rows:[]}}
  if(sql.startsWith('select spec_hash,draft_id from'))return {rows:[stored]}
  throw Error('未预期存储调用 '+sql)
 }}
 const ports={market:{get:async()=>content},configuration:{current:async()=>({version:baseVersion,manifest:current,leaves:current.definitions.map(item=>({kind:item.kind,body:JSON.stringify(item.definition)}))})},drafts:{
  get:async()=>({id:adoptionId,status:'applied',scope:current.scope}),
  begin:async()=>({id:draftId,baseVersion,candidate:current}),
  revise:async()=>({id:draftId,baseVersion,candidate:(stored!.source.pendingUpgrade as {configuration:BusinessConfigurationCandidateV2}).configuration}),
 }}
 const result=await new BusinessDashboardResourceService(pool as never,ports as never).prepareUpgrade({ownerId:'local:owner',scopeIds:[current.scope]},{requestId:randomUUID(),adoptionId,candidateContentId:contentId,candidateContentHash:hash,resourceId:'soc-overview',expectedConfigurationVersion:baseVersion})
 assert.deepEqual(result.conflicts,[]);assert.ok(result.draft)
 return {configuration:result.draft.candidate as BusinessConfigurationCandidateV2,provenance:stored!.source}
}

test('升级中新借用的业务对象继承归属，下一次来源换对象仍保留两个原业务对象',async()=>{
 const resource=readBusinessDashboardResource(dashboardBody()),scope='business_demo',object=resource.configuration.definitions.find(item=>item.kind==='object-type')!
 const target:BusinessConfigurationCandidateV2={format:'teloa.business-configuration/v2',scope,title:'我的业务',sources:[{sourceId:'mine',kind:'local-records'}],definitions:[
  {kind:'object-type',definition:{...object.definition,domain:scope,sourceId:'mine'}},
  {kind:'object-type',definition:{...object.definition,id:'incident',domain:scope,sourceId:'mine'}},
 ],pages:[]}
 const current=mapBusinessDashboardConfiguration(resource,target),baseline=mapBusinessDashboardConfiguration(resource,{...target,definitions:[],pages:[]})
 const provenance={resource,objectMapping:{},baseline,baselineHash:businessConfigurationHash(baseline),borrowedObjectIds:['alert']}
 const first=await upgrade(current,provenance,'incident','1.1.0',1)
 assert.deepEqual(first.configuration.definitions.filter(item=>item.kind==='object-type').map(item=>item.definition.id),['alert','incident'])
 const second=await upgrade(first.configuration,first.provenance,'event','1.2.0',2)
 assert.deepEqual(second.configuration.definitions.filter(item=>item.kind==='object-type').map(item=>item.definition.id),['alert','incident','event'])
 assert.deepEqual(first.provenance.borrowedObjectIds,['alert','incident'])
 assert.deepEqual(second.provenance.borrowedObjectIds,['alert','incident'])
 assert.equal(second.configuration.title,'我的业务')
})

test('来源新建的对象保持来源归属，下一次升级换对象可移除原来源对象',async()=>{
 const resource=readBusinessDashboardResource(dashboardBody()),target:BusinessConfigurationCandidateV2={format:'teloa.business-configuration/v2',scope:'business_demo',title:'新业务',sources:[{sourceId:'mine',kind:'local-records'}],definitions:[],pages:[]}
 const current=mapBusinessDashboardConfiguration(resource,target)
 const first=await upgrade(current,{resource,objectMapping:{},baseline:current,baselineHash:businessConfigurationHash(current),borrowedObjectIds:[]},'incident','1.1.0',1)
 const second=await upgrade(first.configuration,first.provenance,'event','1.2.0',2)
 assert.deepEqual(first.provenance.borrowedObjectIds,[]);assert.deepEqual(second.provenance.borrowedObjectIds,[])
 assert.deepEqual(first.configuration.definitions.filter(item=>item.kind==='object-type').map(item=>item.definition.id),['incident'])
 assert.deepEqual(second.configuration.definitions.filter(item=>item.kind==='object-type').map(item=>item.definition.id),['event'])
})
