import {test} from 'node:test'
import assert from 'node:assert/strict'
import {buildSharePlan,sharePackageDigest,sharePackageSummary} from '../src/client/share-package-plan.ts'
import {createShareAcceptance,resolvePublicCatalogEntry,shareIndustryItem,teamCoordination,type ShareAcceptPorts} from '../src/client/template-share-accept.ts'
import {templateShareErrorKey} from '../src/client/template-share-errors.ts'
import {buildEmployeeTemplate} from '../src/client/employee-template-share.ts'
import type {IndustryLoadRecord} from '../src/client/industry-load-api.ts'

const duties={triggers:['New ticket arrives'],autonomousActions:['Draft a reply'],confirmationPoints:['Before refunds'],escalationRules:['Legal threats go to the lead'],deliveryChecks:['Cite the source']}
const role=(id:string,name:string,skills:string[]=[],responsibility=duties)=>({id,name,kind:'employee' as const,duty:'Verify sources.',dataScope:'Provided documents.',executionScope:'Confirm external writes.',skills,knowledge:[],scopes:['general'],responsibility})
const skillText=(name:string)=>`---\nname: ${name}\ndescription: Keep notes\n---\n# Notes`
const base={publisher:'Max',license:'CC-BY-4.0',plugins:[]}
const memory=()=>{const values=new Map<string,string>();return {values,storage:{getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k)}}}
/** 两位员工各有自己的技能，另有一项公共技能；协调者明确声明为第二位。 */
const team=()=>buildSharePlan({...base,subject:'team',title:'Support team',roles:[role('a','Lead',['research-notes']),role('b','Agent',['triage','internal-comms'])],coordinatorRoleId:'b',
 skills:[{name:'research-notes',title:'Research notes',resourceId:'research-notes',version:'1.0.0',text:skillText('research-notes'),license:'MIT'},{name:'triage',title:'Triage',resourceId:'triage',version:'2.0.0',text:skillText('triage'),license:'MIT'},{name:'internal-comms',title:'Internal comms',resourceId:'internal-comms',version:'1.2.0',publicId:'internal-comms'}],
 connections:[{serverName:'slack',title:'Slack',tools:['send_message']}],bindings:[{roleId:'b',connections:['slack']}]})

/** 内存模拟的加载服务：按导入内容的清单生成条目实例与关系；安装回执给出与资源 id 不同的原生名。 */
/** pluginRow：一键准备后读到的依赖应用行（状态、入口与原因），缺省时清单不含应用行。 */
function industry(over:Partial<NonNullable<ShareAcceptPorts['industry']>>={},pluginRow?:{state:string;entry:string|null;reason?:string}){
 const calls={imports:[] as string[],loads:[] as string[],installs:[] as {itemInstanceId:string;requestId:string}[],prepare:0,manifests:[] as any[]}
 let load:IndustryLoadRecord|undefined
 const roles:{itemInstanceId:string;state:string;roleId?:string}[]=[]
 const ports:NonNullable<ShareAcceptPorts['industry']>={
  publicSkill:async({publicId,version})=>({id:'atomic-'+'c'.repeat(64),kind:'skill',contentStorage:{contentId:'00000000-0000-4000-8000-0000000000aa',createdAt:'2026-10-14T00:00:00.000Z',loaded:true},atomicSkill:{id:publicId,version,title:'Internal comms',hash:'c'.repeat(64),entryPath:'internal-comms/SKILL.md',files:[{path:'internal-comms/SKILL.md',hash:'d'.repeat(64),bytes:new TextEncoder().encode(skillText('internal-comms'))}],text:skillText('internal-comms'),categories:[]}} as never),
  target:async()=>({kind:'existing',spaceId:'00000000-0000-4000-8000-000000000001',expectedVersion:1}),
  importContent:async(item,requestId)=>{calls.imports.push(requestId);calls.manifests.push(item.manifest);return {...item,contentStorage:{contentId:'00000000-0000-4000-8000-000000000002',createdAt:'x',loaded:true}}},
  load:async request=>{
   calls.loads.push(request.requestId)
   const manifest=calls.manifests.at(-1),instance=(id:string)=>'10000000-0000-4000-8000-'+String(manifest.resources.findIndex((r:any)=>r.id===id)).padStart(12,'0')
   load={id:'20000000-0000-4000-8000-000000000000',status:'active',contentId:request.contentId,contentHash:request.contentHash,mappingHash:'b'.repeat(64),templateTitle:manifest.title,space:{scope:manifest.scope},items:manifest.resources.map((r:any)=>({localId:r.id,instanceId:instance(r.id),kind:r.kind,title:r.title,version:r.version,required:r.required,status:'pending-adapter'})),relations:manifest.relations.map((l:any)=>({kind:l.kind,from:instance(l.from),to:instance(l.to)}))} as never
   return load!
  },
  getLoad:async()=>load!,
  installSkill:async(source,requestId)=>{calls.installs.push({itemInstanceId:source.itemInstanceId,requestId});const item=load!.items.find(i=>i.instanceId===source.itemInstanceId)!;return {state:'installed',installationId:'inst-'+item.localId,nativeName:'native-'+item.localId}},
  prepare:async()=>{calls.prepare++;for(const item of load!.items.filter(i=>i.kind==='role'))if(!roles.some(r=>r.itemInstanceId===item.instanceId))roles.push({itemInstanceId:item.instanceId,state:'paused',roleId:'role-'+item.localId});return {rows:[...load!.items.filter(i=>i.kind==='mcp').map(i=>({itemInstanceId:i.instanceId,kind:'mcp',state:'needs-user',step:null,entry:'connector-settings'})),...(pluginRow?load!.items.filter(i=>i.kind==='plugin').map(i=>({itemInstanceId:i.instanceId,kind:'plugin',step:null,...pluginRow})):[])]} as never},
  roles:async()=>roles.map(r=>({...r})),
  ...over,
 }
 return {ports,calls,roles,get load(){return load}}
}

test('public skills resolve by original name and pinned version to exactly one catalog entry',()=>{
 const entry=(id:string,name:string,version:string)=>({entry:{id,kind:'skill',version,skill:{name}}}) as never
 const catalog=[entry('anthropic.internal-comms','internal-comms','1.2.0'),entry('anthropic.internal-comms-v1','internal-comms','1.0.0'),entry('teloa.pdf','pdf','1.0.0')]
 assert.equal((resolvePublicCatalogEntry(catalog,'internal-comms','1.2.0') as any).entry.id,'anthropic.internal-comms','catalog id differs from the public name')
 assert.throws(()=>resolvePublicCatalogEntry(catalog,'internal-comms','9.9.9'),/not in the catalog/,'no fallback to latest')
 assert.throws(()=>resolvePublicCatalogEntry([...catalog,entry('mirror.internal-comms','internal-comms','1.2.0')],'internal-comms','1.2.0'),/ambiguous/,'never takes the first of several')
 assert.throws(()=>resolvePublicCatalogEntry(catalog,'anthropic.internal-comms','1.2.0'),/not in the catalog/,'the dotted catalog id is not a public name')
})

test('receiving a shared application preserves its declared publisher and license without treating it as verified',async()=>{
 const pkg=buildSharePlan({...base,subject:'app',title:'Meeting summary',roles:[],skills:[{name:'meeting-summary',version:'1.0.0',text:skillText('meeting-summary'),license:'MIT'}]})
 const item=await shareIndustryItem(pkg as never,{scope:'general',skills:['meeting-summary']})
 assert.equal(item.author,'Max')
 assert.equal(item.license,'CC-BY-4.0')
 assert.equal(item.trust?.publisher,'Max')
 assert.deepEqual(item.trust?.license,{status:'declared',value:'CC-BY-4.0'})
 assert.deepEqual(item.trust?.signature,{status:'unverified',signer:null})
 assert.equal(item.trust?.review.conclusion,'needs-review')
 assert.deepEqual(item.trust?.permissions,[])
})

test('an empty atomic selection is rejected before persisting an intent or calling any service',async()=>{
 const pkg=buildSharePlan({...base,subject:'app',title:'Notes',roles:[],skills:[{name:'notes',text:skillText('notes'),license:'MIT'}]})
 const {storage,values}=memory(),fake=industry(),flow=createShareAcceptance(storage,{createRole:async()=>'unused',industry:fake.ports})
 await assert.rejects(flow.accept(pkg,{scope:'general',skills:[]}),{code:'teloa/validation-error'})
 assert.equal(values.size,0);assert.equal(fake.calls.imports.length,0);assert.equal(fake.calls.loads.length,0)
 assert.equal(await flow.choice(pkg),undefined)
})

test('an old empty selection with no dispatched step can be corrected; a possibly dispatched record remains frozen',async()=>{
 const pkg=buildSharePlan({...base,subject:'skill',title:'Notes',roles:[],skills:[{name:'notes',text:skillText('notes'),license:'MIT'}]})
 const sha256=await sharePackageDigest(pkg),key='teloa.share-accept/v3/'+sha256,old={sha256,scope:'support',skills:[],contentRequestId:crypto.randomUUID(),loadRequestId:crypto.randomUUID(),installs:{}}
 const {storage}=memory(),fake=industry(),flow=createShareAcceptance(storage,{createRole:async()=>'unused',industry:fake.ports})
 storage.setItem(key,JSON.stringify(old));assert.equal(await flow.choice(pkg),undefined)
 const result=await flow.accept(pkg,{scope:'general',skills:['notes']});assert.equal(result.complete,true);assert.equal(fake.calls.imports.length,1);assert.equal(fake.calls.manifests[0].scope,'general')
 const uncertain={...old,target:{kind:'existing',spaceId:'00000000-0000-4000-8000-000000000001',expectedVersion:1}},bytes=JSON.stringify(uncertain)
 storage.setItem(key,bytes);assert.deepEqual(await flow.choice(pkg),{scope:'support',skills:[]})
 await assert.rejects(flow.accept(pkg,{scope:'general',skills:['notes']}),{code:'teloa/validation-error'});assert.equal(storage.getItem(key),bytes);assert.equal(fake.calls.imports.length,1)
})

test('the package keeps the five structured responsibilities and the receiver fixes scope, selection and coordination into the loaded content',async()=>{
 const pkg=team(),summary=sharePackageSummary(pkg)
 assert.deepEqual(summary.roles.map(r=>r.responsibility),[duties,duties],'each duty group is kept, not folded into the duty text')
 assert.ok(summary.roles.every(r=>r.duty==='Verify sources.'))
 const item=await shareIndustryItem(pkg as never,{scope:'support',skills:['research-notes','internal-comms']}),manifest=item.manifest as any
 assert.equal(manifest.scope,'support')
 assert.deepEqual(manifest.resources.filter((r:any)=>r.kind==='skill').map((r:any)=>r.id).sort(),['internal-comms','research-notes'],'an unselected skill is not part of this application')
 assert.equal(manifest.resources.find((r:any)=>r.id==='research-notes').source.path,'research-notes/SKILL.md')
 assert.ok(!manifest.relations.some((l:any)=>l.to==='triage'))
 const lead=summary.coordinatorResourceId!,agent=summary.roles.find(r=>r.name==='Agent')!.resourceId,other=summary.roles.find(r=>r.name==='Lead')!.resourceId
 assert.equal(lead,agent);assert.deepEqual(manifest.relations.filter((l:any)=>l.kind==='role-coordination'),[{kind:'role-coordination',from:agent,to:other}])
 const roleFile=item.packageContent!.files.find(f=>f.path===agent+'.json')!
 assert.deepEqual(JSON.parse(new TextDecoder().decode(roleFile.bytes)).responsibility,duties)
})

test('two employees get their own skills by the installed native name, connections are registered and the coordinator is read back from the load',async()=>{
 const {storage}=memory(),pkg=team(),fake=industry({team:async()=>({groupId:'saved-real-group'})})
 const result=await createShareAcceptance(storage,{createRole:async()=>{throw Error('v2 must not create roles directly')},industry:fake.ports}).accept(pkg,{skills:['research-notes','triage','internal-comms'],scope:'general'})
 assert.deepEqual(result.skills.map(s=>[s.resourceId,s.state,s.nativeName]),[['research-notes','done','native-research-notes'],['triage','done','native-triage'],['internal-comms','done','native-internal-comms']])
 assert.equal(fake.calls.installs.length,3);assert.equal(fake.calls.prepare,1,'employees are created by the original prepare engine after every skill is installed')
 const manifest=fake.calls.manifests[0],lead=manifest.resources.find((r:any)=>r.title==='Lead').id
 assert.deepEqual(manifest.relations.filter((l:any)=>l.kind==='role-skill'&&l.from===lead).map((l:any)=>l.to),['research-notes'],'each employee keeps only its own skills')
 assert.deepEqual(result.roles.map(r=>r.state),['done','done']);assert.equal(result.coordinator,'done')
 assert.equal(result.coordinatorRoleId,'role-'+manifest.resources.find((r:any)=>r.title==='Agent').id)
 assert.equal(result.mcp[0]!.state,'done');assert.equal(result.complete,true)
 assert.deepEqual(teamCoordination(fake.load!,fake.roles),{coordinatorRoleId:result.coordinatorRoleId,memberRoleIds:['role-'+lead]})
 const again=await createShareAcceptance(storage,{createRole:async()=>{throw Error('no')},industry:fake.ports}).accept(pkg,{skills:['internal-comms','triage','research-notes'],scope:'general'})
 assert.equal(fake.calls.loads.length,1,'continuing never loads the package twice');assert.deepEqual(again.roleIds,result.roleIds)
})

test('a failed or pending skill keeps employees uncreated and the result is never complete',async()=>{
 const {storage}=memory(),pkg=team()
 const failing=industry({installSkill:async()=>{throw Error('offline')}})
 const failed=await createShareAcceptance(storage,{createRole:async()=>'x',industry:failing.ports}).accept(pkg,{skills:['research-notes'],scope:'general'})
 assert.equal(failed.skills.find(s=>s.resourceId==='research-notes')!.state,'failed');assert.equal(failing.calls.prepare,0,'no employee is created without its method')
 assert.deepEqual(failed.roles.map(r=>r.state),['pending','pending']);assert.equal(failed.coordinator,'pending');assert.equal(failed.complete,false)
 const waiting=industry({installSkill:async()=>({state:'pending'})})
 const pending=await createShareAcceptance(memory().storage,{createRole:async()=>'x',industry:waiting.ports}).accept(pkg,{skills:['triage'],scope:'general'})
 assert.equal(pending.skills.find(s=>s.resourceId==='triage')!.state,'pending');assert.equal(pending.complete,false)
 const unreadable=industry({prepare:async()=>{throw Error('down')}})
 const unknown=await createShareAcceptance(memory().storage,{createRole:async()=>'x',industry:unreadable.ports}).accept(pkg,{skills:[],scope:'general'})
 assert.equal(unknown.mcp[0]!.state,'pending');assert.equal(unknown.complete,false)
})

test('the first confirmation freezes scope, selected skills and request ids; a lost reply resumes the same request',async()=>{
 const {storage}=memory(),pkg=team()
 let lost=true
 const fake=industry()
 const load=fake.ports.load
 fake.ports.load=async request=>{const row=await load(request);if(lost){lost=false;throw Error('Lost reply')}return row}
 const flow=()=>createShareAcceptance(storage,{createRole:async()=>'x',industry:fake.ports})
 await assert.rejects(flow().accept(pkg,{skills:['research-notes'],scope:'support'}),/Lost reply/)
 assert.deepEqual(await flow().choice(pkg),{scope:'support',skills:['research-notes']})
 const frozen=storage.getItem('teloa.share-accept/v3/'+await sharePackageDigest(pkg))
 await assert.rejects(flow().accept(pkg,{skills:['research-notes'],scope:'general'}),{code:'acceptance-choice-conflict'},'仅改变范围也不能继续原请求')
 await assert.rejects(flow().accept(pkg,{skills:['research-notes','triage','internal-comms'],scope:'support'}),{code:'acceptance-choice-conflict'},'仅改变技能也不能继续原请求')
 assert.equal(storage.getItem('teloa.share-accept/v3/'+await sharePackageDigest(pkg)),frozen,'拒绝不同选择不改原 journal')
 assert.equal(fake.calls.loads.length,1,'不同选择不能继续原加载请求')
 const result=await flow().accept(pkg,{skills:['research-notes'],scope:'support'})
 assert.equal(fake.calls.loads.length,2);assert.equal(fake.calls.loads[0],fake.calls.loads[1],'the unknown load reply is resumed with the same request id')
 assert.equal(fake.calls.imports.length,1,'the saved content is not imported again')
 assert.equal(fake.calls.manifests[0].scope,'support','the original business scope is kept')
 assert.deepEqual(result.skills.map(s=>s.state),['done','skipped','skipped'],'恢复原选择后仍只添加原确认的技能')
})

test('a v1 employee package still goes through the original acceptance and its saved key',async()=>{
 const {storage,values}=memory(),pkg=buildEmployeeTemplate(role('x','Legacy')),fake=industry()
 let creates=0
 const flow=createShareAcceptance(storage,{createRole:async()=>{assert.fail('A new v1 shared employee cannot use active manual hiring')},v1:{target:fake.ports.target,importContent:fake.ports.importContent,load:fake.ports.load,knowledge:async()=>{assert.fail('This package has no knowledge')},role:async()=>{creates++;return {state:'paused',role:{id:'legacy-role'}}}}})
 const result=await flow.accept(pkg,{skills:[],scope:'general'})
 assert.deepEqual(result.roleIds,['legacy-role']);assert.equal(creates,1)
 assert.equal(result.loadId,fake.load!.id);assert.equal(fake.calls.imports.length,1);assert.equal(fake.calls.loads.length,1)
 assert.ok([...values.keys()].some(key=>key.startsWith('teloa.template-accept/v1/')))
 await flow.accept(pkg,{skills:[],scope:'general'});assert.equal(creates,1)
})

test('persisting the frozen choice must succeed before anything is imported',async()=>{
 const fake=industry()
 await assert.rejects(createShareAcceptance({getItem:()=>null,setItem:()=>{throw Error('Quota')},removeItem:()=>{}},{createRole:async()=>'x',industry:fake.ports}).accept(team(),{skills:[],scope:'general'}))
 assert.equal(fake.calls.imports.length,0)
})

test('an older uncertain import preserves its original metadata payload and request after upgrade',async()=>{
 const {storage,values}=memory(),pkg=team(),sha256=await sharePackageDigest(pkg),fake=industry()
 const contentRequestId=crypto.randomUUID(),loadRequestId=crypto.randomUUID()
 values.set('teloa.share-accept/v3/'+sha256,JSON.stringify({sha256,scope:'general',skills:[],contentRequestId,loadRequestId,installs:{},target:{kind:'existing',spaceId:'00000000-0000-4000-8000-000000000001',expectedVersion:1}}))
 const importContent=fake.ports.importContent
 fake.ports.importContent=async(item,requestId)=>{
  assert.equal(requestId,contentRequestId)
  assert.equal(item.trust,undefined,'a previous server receipt used the legacy upload declaration; a retry cannot change that payload')
  return importContent(item,requestId)
 }
 const flow=createShareAcceptance(storage,{createRole:async()=>'unused',industry:fake.ports})
 await assert.rejects(flow.accept(pkg,{scope:'other',skills:['triage']}),{code:'acceptance-choice-conflict'})
 assert.deepEqual(fake.calls.imports,[],'不同选择不派发原导入请求')
 await flow.accept(pkg,{scope:'general',skills:[]})
 assert.deepEqual(fake.calls.imports,[contentRequestId])
 assert.deepEqual(fake.calls.loads,[loadRequestId])
 assert.equal(fake.calls.manifests[0].scope,'general')
})

test('a new reception freezes declaration metadata before importing; unknown metadata versions refuse writes',async()=>{
 const {storage,values}=memory(),pkg=team(),fake=industry(),sha256=await sharePackageDigest(pkg)
 fake.ports.importContent=async item=>{
  const progress=JSON.parse(values.get('teloa.share-accept/v3/'+sha256)!)
  assert.equal(progress.sourceMetadataVersion,1)
  assert.equal(item.trust?.publisher,'Max')
  throw Error('Lost import reply')
 }
 await assert.rejects(createShareAcceptance(storage,{createRole:async()=>'unused',industry:fake.ports}).accept(pkg,{scope:'general',skills:[]}),/Lost import reply/)
 const progress=JSON.parse(values.get('teloa.share-accept/v3/'+sha256)!)
 values.set('teloa.share-accept/v3/'+sha256,JSON.stringify({...progress,sourceMetadataVersion:2}))
 fake.ports.importContent=async()=>{assert.fail('unsupported recovery metadata cannot write')}
 await assert.rejects(createShareAcceptance(storage,{createRole:async()=>'unused',industry:fake.ports}).accept(pkg,{scope:'general',skills:[]}),/recovery record is invalid/)
})

test('team role preparation without an actual saved group cannot report team added, even without a declared coordinator',async()=>{
 for(const pkg of [team(),buildSharePlan({...base,subject:'team',title:'Unassigned team',roles:[role('a','One'),role('b','Two')],skills:[]})]){
  const {storage}=memory(),fake=industry()
  const result=await createShareAcceptance(storage,{createRole:async()=>'unused',industry:fake.ports}).accept(pkg,{scope:'general',skills:sharePackageSummary(pkg).skills.map(s=>s.resourceId)})
  assert.equal(result.complete,false,'prepared employees are not a saved AI team')
  assert.equal(result.coordinator,'pending','coordination cannot be marked complete without a group receipt')
 }
})

test('an employee shared with the apps it depends on binds them and reports each app\'s real prepared state',async()=>{
 const pkg=buildSharePlan({...base,subject:'employee',roles:[role('a','Lead')],skills:[],plugins:[{packageName:'@example/ticket',version:'1.0.0',title:'Ticket'}]})
 const manifest=JSON.parse(pkg.files.find(f=>f.path==='teloa.json')!.text),roleId=manifest.resources.find((r:any)=>r.kind==='role').id,pluginId=manifest.resources.find((r:any)=>r.kind==='plugin').id
 assert.deepEqual(manifest.relations,[{kind:'role-connection',from:roleId,to:pluginId}],'员工主题默认依赖所列应用')
 const cases=[[{state:'ready',entry:null},'done',undefined,false],[{state:'needs-user',entry:'plugin',reason:'unverified'},'needs-user','unverified',true],[{state:'needs-user',entry:'plugin',reason:'rejected'},'needs-user','rejected',true],[{state:'needs-user',entry:'plugin',reason:'failed'},'failed','failed',true]] as const
 for(const [row,state,reason,pending] of cases){
  const {storage}=memory(),fake=industry({},row),flow=createShareAcceptance(storage,{createRole:async()=>'unused',industry:fake.ports})
  const result=await flow.accept(pkg,{scope:'general',skills:[]})
  assert.deepEqual(result.plugins,[{resourceId:pluginId,title:'Ticket',state,...(reason?{reason}:{})}],state)
  assert.equal(result.pendingKinds.includes('plugin'),pending,state)
 }
})


test('offline application public-source failure is readable and resumes the same saved choice after the source recovers',async()=>{
 const pkg=buildSharePlan({...base,subject:'app',title:'Offline app',roles:[],skills:[{name:'internal-comms',title:'Internal comms',resourceId:'internal-comms',version:'1.2.0',publicId:'internal-comms'}]})
 const {storage,values}=memory(),fake=industry(),source=Object.assign(Error('GitHub API rate limit'),{code:'teloa/source-unavailable'});let blocked=true
 const ports={createRole:async()=>{throw Error('app must not create an employee')},industry:{...fake.ports,publicSkill:async(input:{publicId:string;version:string})=>{if(blocked)throw source;return fake.ports.publicSkill(input)}}}
 const flow=createShareAcceptance(storage,ports),choice={scope:'general',skills:['internal-comms']}
 await assert.rejects(flow.accept(pkg,choice),error=>error===source)
 assert.equal(templateShareErrorKey(source),'templateShare.receiveSourceUnavailable','source rate limits must not be shown as an online-share outage')
 assert.deepEqual(await flow.choice(pkg),choice);assert.equal(fake.calls.imports.length,0);assert.equal(fake.calls.loads.length,0)
 const pending=JSON.parse([...values.values()][0]!),originalRequest=pending.contentRequestId,originalLoad=pending.loadRequestId
 blocked=false
 const resumed=createShareAcceptance(storage,ports),result=await resumed.accept(pkg,choice)
 assert.equal(result.complete,true);assert.deepEqual(result.roleIds,[]);assert.deepEqual(fake.calls.imports,[originalRequest]);assert.deepEqual(fake.calls.loads,[originalLoad]);assert.equal(fake.calls.installs.length,1)
 await resumed.accept(pkg,choice)
 assert.deepEqual(fake.calls.imports,[originalRequest]);assert.deepEqual(fake.calls.loads,[originalLoad]);assert.equal(fake.calls.installs.length,1)
})
