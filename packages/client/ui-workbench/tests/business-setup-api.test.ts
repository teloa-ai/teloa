import test from 'node:test'
import assert from 'node:assert/strict'
import type {BusinessResponsibility,CapabilitySnapshot,DigitalRole,WorkResource} from '@teloa/contract'
import type {BusinessBuilderApi} from '../src/client/business-builder-api.ts'
import type {ManagedMcpConnectionRecord} from '../src/client/mcp-connections-api.ts'
import {createBusinessSetupApi,type BusinessSetupPorts} from '../src/client/business-setup-api.ts'

const stamp='2026-09-30T00:00:00.000Z',hash='a'.repeat(64),input={scope:'sales',expectedVersion:2,expectedHash:hash}
const roleId='11111111-1111-4111-8111-111111111111'
const role=(patch:Partial<DigitalRole>={}):DigitalRole=>({id:roleId,ownerId:'local:owner',version:3,state:'active',name:'销售同事',kind:'employee',scopes:['sales'],duty:'跟进业务',dataScope:'业务资料',executionScope:'只读',skills:['unique','duplicate','disabled','absent'],knowledge:[],createdAt:stamp,updatedAt:stamp,...patch})
const responsibility=(patch:Partial<BusinessResponsibility>={}):BusinessResponsibility=>({scope:'sales',version:1,roleId,selectedRoleVersion:2,currentRoleVersion:3,availability:'ready',...patch})
const resource=(id:string,patch:Partial<WorkResource>={}):WorkResource=>({id,ownerId:'local:owner',version:1,status:'active',title:id,sourceId:id,sourceVersion:hash,scopeIds:['sales'],createdAt:stamp,updatedAt:stamp,...patch})
const skill=(name:string,modelInvocable=true):CapabilitySnapshot['skills'][number]=>({name,description:'目录描述',source:'private-source',provider:'native',modelInvocable,userInvocable:true})
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
function fixture(){
 let active=true
 const calls:string[]=[],currentValue={scope:'sales',version:2,hash,createdAt:stamp,manifest:{format:'teloa.business-configuration/v2',scope:'sales',title:'销售业务',sources:[{sourceId:'records',kind:'local-records'}],definitions:[{kind:'object-type',localId:'customer',version:1,definitionHash:hash}],pages:[{id:'customers',kind:'records',title:'客户',objectType:'customer',fields:['name'],allowCreate:true,allowEdit:true,allowArchive:true}],homePageId:'customers'}} satisfies NonNullable<Awaited<ReturnType<BusinessBuilderApi['current']>>>
 const ports:BusinessSetupPorts={current:{current:async data=>{assert.deepEqual(data,{scope:'sales'});calls.push('current');return currentValue}},responsibility:{read:async data=>{assert.deepEqual(data,{scope:'sales'});calls.push('responsibility');return responsibility()}},roles:{list:async()=>{calls.push('roles');return [role()]}},resources:{directory:async()=>{calls.push('directory');return {drafts:[],resources:[]}},sources:async()=>{calls.push('sources');return []}},skills:async()=>{calls.push('skills');return [skill('unique'),skill('duplicate'),skill('duplicate',false),skill('disabled',false)]},connections:{list:async()=>{calls.push('connections');return []}},isCurrent:()=>active,now:()=>stamp}
 return {ports,calls,currentValue,leave:()=>{active=false},read:(signal?:AbortSignal)=>createBusinessSetupApi(ports).read(input,signal)}
}

test('无正式配置或scope/version/hash不匹配时零目录读取',async()=>{
 for(const patch of [null,{scope:'support'},{version:3},{hash:'b'.repeat(64)}]){
  const f=fixture();f.ports.current.current=async()=>{f.calls.push('current');return patch===null?null:{...f.currentValue!,...patch}}
  await assert.rejects(f.read());assert.deepEqual(f.calls,['current'])
 }
})
test('首读前及首读等待期间身份改变时不读目录',async()=>{
 const f=fixture();f.leave();await assert.rejects(f.read());assert.deepEqual(f.calls,[])
 const g=fixture(),wait=deferred<Awaited<ReturnType<BusinessBuilderApi['current']>>>()
 g.ports.current.current=()=>{g.calls.push('current');return wait.promise}
 const pending=g.read();g.leave();wait.resolve(g.currentValue);await assert.rejects(pending);assert.deepEqual(g.calls,['current'])
})
test('并行等待后身份改变时不返回旧数据',async()=>{
 const f=fixture(),wait=deferred<CapabilitySnapshot['skills']>(),started=deferred<void>()
 f.ports.skills=()=>{started.resolve();return wait.promise}
 const pending=f.read();await started.promise;f.leave();wait.resolve([]);await assert.rejects(pending)
})
test('结束前再次核配置，第二次current变更或失败拒收投影',async()=>{
 for(const patch of [null,{scope:'support'},{version:3},{hash:'b'.repeat(64)},'failure'] as const){
  const f=fixture();let reads=0
  f.ports.current.current=async()=>{reads++;if(reads===1)return f.currentValue;if(patch==='failure')throw Error('secret failure');return patch===null?null:{...f.currentValue!,...patch}}
  await assert.rejects(f.read());assert.equal(reads,2)
 }
})
test('第二次配置读取等待期间身份改变仍拒收',async()=>{
 const f=fixture(),wait=deferred<Awaited<ReturnType<BusinessBuilderApi['current']>>>(),started=deferred<void>();let reads=0
 f.ports.current.current=()=>{if(++reads===1)return Promise.resolve(f.currentValue);started.resolve();return wait.promise}
 const pending=f.read();await started.promise;f.leave();wait.resolve(f.currentValue);await assert.rejects(pending)
})
test('负责人只匹配当前岗位版本，目录过滤本业务同事并保留固定负责人真实状态',async()=>{
 const f=fixture(),selected=role({state:'paused',scopes:['support']}),other=role({id:'22222222-2222-4222-8222-222222222222'}),twin=role({id:'33333333-3333-4333-8333-333333333333',kind:'twin'}),unrelated=role({id:'44444444-4444-4444-8444-444444444444',scopes:['support']})
 f.ports.roles.list=async()=>[selected,other,twin,unrelated];f.ports.responsibility.read=async()=>responsibility({availability:'paused'})
 const result=await f.read();assert.deepEqual(result.colleagues,{status:'observed',value:{responsibility:responsibility({availability:'paused'}),roles:[selected,other],selectedRole:selected}})
 assert.equal(result.scope,'sales');assert.equal(result.configurationVersion,2);assert.equal(result.configurationHash,hash);assert.equal(result.observedAt,stamp)
 for(const version of [2,4]){const g=fixture();g.ports.roles.list=async()=>[role({version})];const snapshot=await g.read();assert.equal(snapshot.colleagues.status,'observed');if(snapshot.colleagues.status==='observed')assert.equal(snapshot.colleagues.value.selectedRole,null);assert.deepEqual(snapshot.skills,{status:'unavailable'});assert.deepEqual(snapshot.knowledge,{status:'unavailable'})}
})
test('负责人已缺失或撤掉业务范围时保留状态，不用其他同事替换',async()=>{
 for(const availability of ['missing','forbidden','retired'] as const){
  const f=fixture(),expected=responsibility({availability,currentRoleVersion:availability==='missing'?null:3});f.ports.responsibility.read=async()=>expected
  f.ports.roles.list=async()=>availability==='missing'?[role({id:'22222222-2222-4222-8222-222222222222'})]:[role({state:availability==='retired'?'retired':'active',scopes:['support']})]
  const snapshot=await f.read();assert.equal(snapshot.colleagues.status,'observed');if(snapshot.colleagues.status==='observed'){assert.deepEqual(snapshot.colleagues.value.responsibility,expected);assert.equal(snapshot.colleagues.value.selectedRole?.id??null,availability==='missing'?null:roleId)}
 }
})
test('技能只观察固定负责人声明，唯一且modelInvocable才标观察到，重名不猜执行可用',async()=>{
 const f=fixture(),snapshot=await f.read()
 assert.deepEqual(snapshot.skills,{status:'observed',value:{declared:[{name:'unique',status:'observed'},{name:'duplicate',status:'ambiguous'},{name:'disabled',status:'unobserved'},{name:'absent',status:'unobserved'}],executionChecked:false}})
 assert.equal(JSON.stringify(snapshot).includes('private-source'),false)
})
test('无负责人时空声明可观察，岗位目录缺失不能猜知识',async()=>{
 const f=fixture();f.ports.responsibility.read=async()=>responsibility({version:0,roleId:null,selectedRoleVersion:null,currentRoleVersion:null,availability:'none'})
 assert.deepEqual((await f.read()).skills,{status:'observed',value:{declared:[],executionChecked:false}})
 const g=fixture();g.ports.responsibility.read=f.ports.responsibility.read;g.ports.roles.list=async()=>{throw Error('unavailable')}
 const snapshot=await g.read();assert.deepEqual(snapshot.colleagues,{status:'unavailable'});assert.deepEqual(snapshot.knowledge,{status:'unavailable'})
})
test('知识使用全部范围包含、固定来源版本和256KiB上限，计数只反映目录事实',async()=>{
 const f=fixture(),rows=[resource('available'),resource('withdrawn',{status:'withdrawn'}),resource('outside',{scopeIds:['sales','support']}),resource('large'),resource('unknown'),resource('boundary'),resource('general',{scopeIds:['general']}),resource('mixed',{scopeIds:['general','sales']}),resource('other',{scopeIds:['support']}),resource('general-withdrawn',{scopeIds:['general'],status:'withdrawn'})]
 f.ports.roles.list=async()=>[role({knowledge:['available','withdrawn','missing','outside','large','unknown','boundary']})]
 f.ports.resources.directory=async()=>({drafts:[],resources:rows})
 f.ports.resources.sources=async()=>[{id:'available',version:hash,bytes:20},{id:'large',version:hash,bytes:262145},{id:'unknown',version:'b'.repeat(64),bytes:20},{id:'boundary',version:hash,bytes:262144}].map(row=>({...row,title:row.id,source:'source body must not escape'}))
 const snapshot=await f.read()
 assert.deepEqual(snapshot.knowledge,{status:'observed',value:{assigned:[{id:'available',title:'available',version:1,state:'available'},{id:'withdrawn',title:'withdrawn',version:1,state:'withdrawn'},{id:'missing',title:null,version:null,state:'missing'},{id:'outside',title:'outside',version:1,state:'out-of-scope'},{id:'large',title:'large',version:1,state:'oversized'},{id:'unknown',title:'unknown',version:1,state:'size-unknown'},{id:'boundary',title:'boundary',version:1,state:'available'}],businessResourceCount:6,generalResourceCount:1}})
 assert.equal(JSON.stringify(snapshot).includes('source body'),false)
})
test('知识范围按负责人已授权全部范围核对，不能单凭含业务scope推断可用',async()=>{
 const f=fixture();f.ports.roles.list=async()=>[role({scopes:['sales','general'],knowledge:['mixed']})];f.ports.resources.directory=async()=>({drafts:[],resources:[resource('mixed',{scopeIds:['sales','general']})]});f.ports.resources.sources=async()=>[{id:'mixed',title:'mixed',source:'host',version:hash,bytes:1}]
 assert.deepEqual((await f.read()).knowledge,{status:'observed',value:{assigned:[{id:'mixed',title:'mixed',version:1,state:'available'}],businessResourceCount:1,generalResourceCount:0}})
})
test('五类连接状态原样投影，不携带工具、错误、正文或凭据',async()=>{
 const f=fixture(),statuses=['saved','installing','connected','error','pending-oauth'] as const
 f.ports.connections.list=async()=>statuses.map((status,index)=>({id:String(index),catalogId:'catalog-'+index,serverName:'server'+index,status,updatedAt:stamp,createdAt:stamp,errorMessage:'token=secret',errorCode:'install-failed',tools:[{name:'write',fullName:'mcp__server__write',readOnly:false}],credentials:{token:'secret'},body:'private'} as ManagedMcpConnectionRecord))
 assert.deepEqual((await f.read()).connections,{status:'observed',value:{items:statuses.map((status,index)=>({id:String(index),catalogId:'catalog-'+index,serverName:'server'+index,status,updatedAt:stamp})),binding:'not-declared'}})
})
test('任一只读组失败保留unavailable，不能当空或泄漏原始错误',async()=>{
 for(const group of ['responsibility','roles','directory','sources','skills','connections'] as const){
  const f=fixture(),fail=async():Promise<never>=>{throw Error('token=secret')}
  if(group==='responsibility')f.ports.responsibility.read=fail
  if(group==='roles')f.ports.roles.list=fail
  if(group==='directory')f.ports.resources.directory=fail
  if(group==='sources')f.ports.resources.sources=fail
  if(group==='skills')f.ports.skills=fail
  if(group==='connections')f.ports.connections.list=fail
  const snapshot=await f.read()
  if(group==='responsibility'||group==='roles')assert.deepEqual(snapshot.colleagues,{status:'unavailable'})
  if(group==='responsibility'||group==='roles'||group==='skills')assert.deepEqual(snapshot.skills,{status:'unavailable'})
  if(group==='responsibility'||group==='roles'||group==='directory'||group==='sources')assert.deepEqual(snapshot.knowledge,{status:'unavailable'})
  if(group==='connections')assert.deepEqual(snapshot.connections,{status:'unavailable'})
  assert.equal(JSON.stringify(snapshot).includes('token=secret'),false)
 }
})
test('同步端口失败不阻止独立组读取，失败组仍不可用',async()=>{
 const f=fixture();f.ports.roles.list=()=>{throw Error('sync failure')}
 const snapshot=await f.read();assert.deepEqual(snapshot.colleagues,{status:'unavailable'});assert.deepEqual(snapshot.connections,{status:'observed',value:{items:[],binding:'not-declared'}})
})
test('取消首读或并行等待均拒收，signal传给可取消的只读端口',async()=>{
 const f=fixture(),cancelled=new AbortController();cancelled.abort();await assert.rejects(f.read(cancelled.signal));assert.deepEqual(f.calls,[])
 const g=fixture(),controller=new AbortController(),wait=deferred<CapabilitySnapshot['skills']>(),started=deferred<void>();let reads=0
 g.ports.current.current=async(_data,signal)=>{assert.equal(signal,controller.signal);reads++;return g.currentValue}
 g.ports.skills=signal=>{assert.equal(signal,controller.signal);started.resolve();return wait.promise}
 const pending=g.read(controller.signal);await started.promise;controller.abort();wait.resolve([]);await assert.rejects(pending);assert.equal(reads,1)
})
