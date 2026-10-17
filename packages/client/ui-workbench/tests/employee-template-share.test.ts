import {test} from 'node:test'
import assert from 'node:assert/strict'
import {buildEmployeeTemplate,inspectEmployeeTemplate,createTemplateAcceptance} from '../src/client/employee-template-share.ts'
import type {IndustryLoadRecord} from '../src/client/industry-load-api.ts'
const role={id:'source-private',kind:'employee' as const,name:'Researcher',duty:'Verify sources.',dataScope:'Provided documents.',executionScope:'Confirm external writes.',skills:['Research'],knowledge:['private-id'],scopes:['private'],runtimeConfig:{modelAccountId:'private'},responsibility:{triggers:[],autonomousActions:[],confirmationPoints:['Ask before external writes.'],escalationRules:[],deliveryChecks:['Cite sources.']}}
type AcceptPorts=Parameters<typeof createTemplateAcceptance>[1]
const memory=()=>{const values=new Map<string,string>();return {values,storage:{getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k)}}}
function industryPorts(over:Partial<AcceptPorts>={}){
 const calls={imports:[] as string[],loads:[] as string[],roles:[] as string[]},spaceId='10000000-0000-4000-8000-000000000001',contentId='10000000-0000-4000-8000-000000000002',loadId='10000000-0000-4000-8000-000000000003',itemInstanceId='10000000-0000-4000-8000-000000000004'
 const ports:AcceptPorts={
  createRole:async()=>{assert.fail('Shared copies must not use the active manual-hiring endpoint')},
  target:async()=>({kind:'existing',spaceId,expectedVersion:1}),
  importContent:async(item,requestId)=>{calls.imports.push(requestId);return {...item,contentStorage:{contentId,createdAt:'2026-10-16T00:00:00.000Z',loaded:true}}},
  load:async request=>{calls.loads.push(request.requestId);return {id:loadId,ownerId:'owner',contentId:request.contentId,contentHash:request.contentHash,templateId:'shared-employee',templateVersion:'1.0.0',templateTitle:'Researcher',domain:'general',scope:'general',description:'Verify sources.',targetVersion:1,space:{id:spaceId,name:'Work',version:1,scope:'general'},items:[{localId:'employee',instanceId:itemInstanceId,kind:'role',title:'Researcher',version:'1.0.0',required:true,status:'pending-adapter'}],relations:[],entrypoints:[],createdAt:'2026-10-16T00:00:00.000Z',mappingHash:'a'.repeat(64),status:'active'} satisfies IndustryLoadRecord},
  knowledge:async()=>{assert.fail('A single-role package has no knowledge to instantiate')},
  role:async input=>{calls.roles.push(input.requestId);assert.equal(input.loadId,loadId);assert.equal(input.itemInstanceId,itemInstanceId);return {state:'paused',role:{id:'own-role'}}},
  ...over,
 }
 return {ports,calls,loadId}
}
test('a new v1 single-role copy uses the fixed-content industry path and stays resumable after an uncertain role reply',async()=>{
 const {storage,values}=memory(),pkg=buildEmployeeTemplate(role),requests:string[]=[],fake=industryPorts({role:async input=>{requests.push(input.requestId);if(requests.length===1)throw Error('Lost role reply');return {state:'paused',role:{id:'own-role'}}}})
 await assert.rejects(createTemplateAcceptance(storage,fake.ports).accept(pkg),/Lost role reply/)
 const saved=JSON.parse([...values.values()][0]!) as {path?:string;roleRequestId:string;load?:IndustryLoadRecord}
 assert.equal(saved.path,'industry');assert.equal(saved.load?.id,fake.loadId)
 const result=await createTemplateAcceptance(storage,fake.ports).accept(pkg)
 assert.deepEqual(result,{roleId:'own-role',loadId:fake.loadId,pendingKinds:[]})
 assert.deepEqual(await createTemplateAcceptance(storage,fake.ports).accept(pkg),result)
 assert.deepEqual(requests,[saved.roleRequestId,saved.roleRequestId]);assert.equal(fake.calls.imports.length,1);assert.equal(fake.calls.loads.length,1)
})
test('an old single-role unknown intent is retained byte-for-byte without changing route or dispatching any request',async()=>{
 const {storage,values}=memory(),pkg=buildEmployeeTemplate(role),checked=await inspectEmployeeTemplate(pkg),key='teloa.template-accept/v1/'+checked.sha256
 const old=JSON.stringify({sha256:checked.sha256,roleRequestId:crypto.randomUUID(),contentRequestId:crypto.randomUUID(),loadRequestId:crypto.randomUUID(),acceptanceId:crypto.randomUUID(),knowledgeRequests:{},completedKnowledge:[]})
 storage.setItem(key,old)
 const never=async():Promise<never>=>{assert.fail('An unconfirmed old direct-create request cannot be migrated or dispatched')}
 const ports:AcceptPorts={createRole:never,target:never,importContent:never,load:never,knowledge:never,role:never,beginAcceptance:never,endAcceptance:never}
 await assert.rejects(createTemplateAcceptance(storage,ports).accept(pkg),{code:'acceptance-recovery-required'})
 assert.equal(storage.getItem(key),old);assert.equal(values.size,1)
})
test('a lost single-role content reply keeps the industry path and reuses the original import request',async()=>{
 const {storage,values}=memory(),pkg=buildEmployeeTemplate(role),requests:string[]=[],base=industryPorts(),ports:AcceptPorts={...base.ports,importContent:async(item,requestId)=>{requests.push(requestId);assert.equal((JSON.parse([...values.values()][0]!) as {path?:string}).path,'industry');if(requests.length===1)throw Error('Lost import reply');return base.ports.importContent(item,requestId)}}
 await assert.rejects(createTemplateAcceptance(storage,ports).accept(pkg),/Lost import reply/)
 assert.equal((await createTemplateAcceptance(storage,ports).accept(pkg)).loadId,base.loadId)
 assert.equal(requests.length,2);assert.equal(requests[0],requests[1]);assert.equal(base.calls.loads.length,1)
})
test('a completed old direct-create result is read without rebuilding the copy or rewriting its record',async()=>{
 const {storage,values}=memory(),pkg=buildEmployeeTemplate(role),checked=await inspectEmployeeTemplate(pkg),key='teloa.template-accept/v1/'+checked.sha256,result={roleId:'original-active-copy',pendingKinds:[]}
 const old=JSON.stringify({sha256:checked.sha256,roleRequestId:crypto.randomUUID(),contentRequestId:crypto.randomUUID(),loadRequestId:crypto.randomUUID(),knowledgeRequests:{},completedKnowledge:[],result})
 storage.setItem(key,old)
 assert.deepEqual(await createTemplateAcceptance(storage,industryPorts().ports).accept(pkg),result)
 assert.equal(storage.getItem(key),old);assert.equal(values.size,1)
})
test('export and receive retain the selected squirrel without copying private identity',async()=>{
 const pkg=buildEmployeeTemplate({...role,avatarKey:'security-analyst'})
 assert.equal(JSON.parse(pkg.files.find(file=>file.path==='role.json')!.text).avatarKey,'security-analyst')
 const checked=await inspectEmployeeTemplate(pkg)
 assert.equal(checked.fields.avatarKey,'security-analyst')
 assert.equal((await inspectEmployeeTemplate(buildEmployeeTemplate(role))).fields.avatarKey,undefined,'older templates remain valid')
})
test('author package is rebuilt and labels remain requirements rather than fake resources',async()=>{const p=buildEmployeeTemplate(role);const raw=JSON.stringify(p);assert.ok(!raw.includes('source-private'));assert.ok(!raw.includes('modelAccountId'));assert.ok(!raw.includes('private-id'));assert.ok(!raw.includes('"scopes"'));assert.deepEqual(p.requirements,['Configure a method for: Research','Connect your own knowledge sources (1).']);const inspected=await inspectEmployeeTemplate(p);assert.equal(inspected.manifest.resources.length,1);assert.ok(inspected.fields.duty.includes('Respond in the user'));assert.ok(inspected.fields.duty.includes('Ask before external writes.'))})
test('uncertain create reuses the frozen request and completed copy survives a reload',async()=>{const {storage}=memory(),p=buildEmployeeTemplate(role),requests:string[]=[];let attempt=0;const {ports}=industryPorts({role:async input=>{requests.push(input.requestId);if(++attempt===1)throw Error('Lost reply');return {state:'paused',role:{id:'own-role'}}}});const first=createTemplateAcceptance(storage,ports);await assert.rejects(first.accept(p));const resumed=createTemplateAcceptance(storage,ports);assert.equal((await resumed.accept(p)).roleId,'own-role');assert.equal((await resumed.accept(p)).roleId,'own-role');assert.equal(requests.length,2);assert.equal(requests[0],requests[1])})
test('failure to persist intent stops before creating a role',async()=>{const storage={getItem:()=>null,setItem:()=>{throw Error('Quota')},removeItem:()=>{}};let calls=0;const {ports}=industryPorts({target:async()=>{calls++;assert.fail('No service is called before saving the intent')}});const flow=createTemplateAcceptance(storage,ports);await assert.rejects(flow.accept(buildEmployeeTemplate(role)));assert.equal(calls,0)})
test('a second uncertain knowledge reply resumes that item in the existing space',async()=>{
 const pkg=buildEmployeeTemplate(role),manifest=JSON.parse(pkg.files[0]!.text),one=crypto.randomUUID(),two=crypto.randomUUID(),employee=crypto.randomUUID(),space=crypto.randomUUID()
 for(const [id,path] of [['one','one.md'],['two','two.md']]){
  manifest.resources.push({id,kind:'knowledge',title:id,version:'1.0.0',required:true,source:{kind:'local',path}})
  manifest.relations.push({kind:'role-knowledge',from:'employee',to:id})
  pkg.files.push({path:path!,text:'# Own guide'})
 }
 pkg.files[0]!.text=JSON.stringify(manifest)
 const values=new Map<string,string>(),storage={getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k)},calls:string[]=[]
 let lost=false,pending:string|undefined
 const ports={
  target:async()=>({kind:'existing',spaceId:space,expectedVersion:1}),
  importContent:async(item:any)=>({...item,contentStorage:{contentId:crypto.randomUUID()}}),
  load:async(input:any)=>{assert.equal(input.target.kind,'existing');assert.equal(input.target.spaceId,space);return {id:crypto.randomUUID(),items:[{kind:'knowledge',instanceId:one},{kind:'knowledge',instanceId:two},{kind:'role',instanceId:employee}]}},
  knowledge:async(input:any)=>{calls.push(input.itemInstanceId);if(pending&&pending!==input.itemInstanceId)throw Error('Previous knowledge is pending');if(input.itemInstanceId===two&&!lost){lost=true;pending=two;throw Error('Lost reply')};pending=undefined;return {state:'active'}},
  role:async()=>({state:'paused',role:{id:crypto.randomUUID()}}),
 }
 await assert.rejects(createTemplateAcceptance(storage,ports as never).accept(pkg),/Lost reply/)
 // 升级前的多资源申请本就走行业路径，缺少新标记时仍续原申请。
 for(const [key,raw] of values){const prior=JSON.parse(raw) as {path?:string};delete prior.path;values.set(key,JSON.stringify(prior))}
 const result=await createTemplateAcceptance(storage,ports as never).accept(pkg)
 assert.ok(result.roleId);assert.deepEqual(calls,[one,two,two])
 assert.ok([...values.values()].every(v=>!v.includes('"bytes"')),'the recovery record keeps identities rather than file arrays')
})
test('long valid role instructions remain complete in a required knowledge resource',async()=>{const p=buildEmployeeTemplate({...role,duty:'a'.repeat(4000)}),checked=await inspectEmployeeTemplate(p);assert.equal(checked.fields.duty.length,4000);assert.equal(checked.manifest.resources.find(r=>r.id==='instructions')?.required,true);assert.ok(p.files.find(f=>f.path==='instructions.md')!.text.includes('Ask before external writes.'))})
test('organization recovery reuses its acceptance identity and closes the exact lease after uncertain writes',async()=>{
 const values=new Map<string,string>(),storage={getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v),removeItem:()=>{}},pkg=buildEmployeeTemplate(role),lease=crypto.randomUUID(),begins:{requestId:string;shareId?:string}[]=[],ends:string[]=[],order:string[]=[]
 let first=true
 const {ports}=industryPorts({beginAcceptance:async(input:{requestId:string;shareId?:string})=>{begins.push(input);order.push('begin');return {acceptanceId:lease}},endAcceptance:async(input:{acceptanceId:string})=>{ends.push(input.acceptanceId);order.push('end')},role:async()=>{order.push('write');if(first){first=false;throw Error('Lost reply')}return {state:'paused',role:{id:'own-role'}}}})
 await assert.rejects(createTemplateAcceptance(storage,ports).accept(pkg,{shareId:pkg.id}),/Lost reply/)
 const flow=createTemplateAcceptance(storage,ports)
 await flow.accept(pkg,{shareId:pkg.id});await flow.accept(pkg,{shareId:pkg.id})
 assert.equal(begins[0]!.requestId,begins[1]!.requestId);assert.equal(begins[0]!.shareId,pkg.id);assert.deepEqual(ends,[lease,lease]);assert.deepEqual(order,['begin','write','end','begin','write','end'])
})
test('a rejected organization acceptance context cannot write a copy',async()=>{
 let writes=0
 const storage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}},{ports}=industryPorts({beginAcceptance:async()=>{throw Object.assign(Error('Original space changed'),{code:'stale-context'})},endAcceptance:async()=>{},importContent:async()=>{writes++;assert.fail('A rejected acceptance cannot import content')}})
 await assert.rejects(createTemplateAcceptance(storage,ports).accept(buildEmployeeTemplate(role)),/Original space changed/);assert.equal(writes,0)
})
test('a confirmed copy retries uncertain lease cleanup without creating another copy',async()=>{
 const values=new Map<string,string>(),storage={getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v),removeItem:()=>{}},pkg=buildEmployeeTemplate(role),lease=crypto.randomUUID(),ends:string[]=[]
 let writes=0,begins=0,first=true
 const {ports}=industryPorts({beginAcceptance:async()=>{begins++;return {acceptanceId:lease}},endAcceptance:async(input:{acceptanceId:string})=>{ends.push(input.acceptanceId);if(first){first=false;throw Error('End reply lost')}},role:async()=>{writes++;return {state:'paused',role:{id:'own-role'}}}})
 await assert.rejects(createTemplateAcceptance(storage,ports).accept(pkg),/End reply lost/)
 assert.equal((await createTemplateAcceptance(storage,ports).accept(pkg)).roleId,'own-role')
 assert.equal(writes,1);assert.equal(begins,1);assert.deepEqual(ends,[lease,lease]);assert.ok(![...values.values()][0]!.includes('acceptanceId'))
})
