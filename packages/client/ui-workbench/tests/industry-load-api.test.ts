import test from 'node:test'
import assert from 'node:assert/strict'
import {createIndustryLoadApi,readUnloadBlockers} from '../src/client/industry-load-api.ts'

const requestId='12345678-1234-4234-8234-123456789012',contentId='22345678-1234-4234-8234-123456789012',spaceId='32345678-1234-4234-8234-123456789012',loadId='42345678-1234-4234-8234-123456789012',roleId='52345678-1234-4234-8234-123456789012',skillId='62345678-1234-4234-8234-123456789012',hash='a'.repeat(64)
const input={requestId,contentId,contentHash:hash,target:{kind:'new' as const,spaceId,name:' 安全运营 '}}
const record={id:loadId,ownerId:'owner',contentId,contentHash:hash,templateId:'security-template',templateVersion:'1.2.0',templateTitle:'安全模板',domain:'security',scope:'SOC',description:'安全工作资源',targetVersion:1,space:{id:spaceId,name:'安全运营',version:1,scope:'SOC'},items:[{localId:'analyst',instanceId:roleId,kind:'role',title:'分析岗位',version:'1.0.0',required:true,status:'pending-adapter'},{localId:'optional-skill',instanceId:skillId,kind:'skill',title:'可选 Skill',version:'1.0.0',required:false,status:'skipped'}],relations:[],entrypoints:[roleId],createdAt:'2026-09-12T00:00:00.000Z',mappingHash:'b'.repeat(64),status:'active'}

const modelDependency={catalogId:'teloa.model.sensevoice',version:'1.0.0',usage:'speech-to-text',required:true}
test('v3 加载记录保留模型依赖，非法资源类型或非固定声明不能被静默丢弃',async()=>{
 const withModel={...record,items:[{...record.items[1],status:'pending-adapter',modelDependencies:[modelDependency]}],entrypoints:[skillId]}
 assert.deepEqual(await createIndustryLoadApi(async()=>withModel).get(loadId),withModel)
 for(const change of [
  {kind:'knowledge'},
  {modelDependencies:[]},
  {modelDependencies:[{...modelDependency,version:'latest'}]},
  {modelDependencies:[{...modelDependency,required:'true'}]},
  {modelDependencies:[{...modelDependency,url:'https://example.com/weights'}]},
  {modelDependencies:[modelDependency,modelDependency]},
 ])await assert.rejects(createIndustryLoadApi(async()=>({...withModel,items:[{...withModel.items[0],...change}]})).get(loadId),/格式/)
})

test('模型 readiness RPC 保留所有实际阶段、必需标记和入口；拒绝异常状态与扩展字段',async()=>{
 const model={...modelDependency,title:'SenseVoice 本地语音',phase:'disabled'}
 const row={itemInstanceId:skillId,kind:'skill',title:'录音整理',state:'needs-user',step:null,entry:'model-settings',models:[model]}
 const readiness={loadId,status:'active',title:'录音整理',version:'1.0.0',digest:hash,counts:{ready:0,auto:0,needsUser:1,optional:0,pending:0},rows:[row]}
 for(const phase of ['unsupported','disabled','unprepared','checking','downloading','loading','waking','ready','standby','cancelling','cancelled','failed','unavailable'])for(const required of [true,false]){
  const expected={...readiness,rows:[{...row,models:[{...model,phase,required}]}]}
  assert.deepEqual(await createIndustryLoadApi(async()=>expected).readiness(loadId),expected)
  const receipt={loadId,digest:hash,results:[],readiness:expected}
  assert.deepEqual((await createIndustryLoadApi(async()=>receipt).prepare(loadId,hash)).readiness,expected)
 }
 for(const invalid of [
  [],[{...model,phase:'installed'}],[{...model,required:1}],[{...model,version:'^1.0.0'}],[{...model,title:''}],
  [{...model,downloadUrl:'https://example.com/weights'}],[model,model],
 ])await assert.rejects(createIndustryLoadApi(async()=>({...readiness,rows:[{...row,models:invalid}]})).readiness(loadId),/格式/)
 // 旧方案没有模型字段时不增加虚构状态，也不改变原有入口。
 const legacy={...readiness,rows:[{itemInstanceId:skillId,kind:'skill',title:'研究方法',state:'needs-user',step:null,entry:'skill-confirm'}]}
 assert.deepEqual(await createIndustryLoadApi(async()=>legacy).readiness(loadId),legacy)
})

test('创建失败保留完整固定请求，恢复重放同一参数且成功才清理',async()=>{
 let raw:string|null=null,fail=true;const calls:unknown[]=[]
 const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
 const call=async(method:string,payload:unknown)=>{calls.push([method,payload]);if(fail){fail=false;throw Error('连接断开')}return record}
 await assert.rejects(createIndustryLoadApi(call,journal).create(input),/连接断开/)
 const api=createIndustryLoadApi(call,journal);assert.deepEqual(api.pending(),{...input,target:{...input.target,name:'安全运营'}})
 assert.deepEqual(await api.recover(),record);assert.deepEqual(calls[0],calls[1]);assert.equal(raw,null)
})

test('同一待核对请求不能更换来源或目标，日志写失败时不调用服务',async()=>{
 let raw:string|null=null,calls=0;const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
 await assert.rejects(createIndustryLoadApi(async()=>{calls++;throw Error('未知')},journal).create(input),/未知/)
 await assert.rejects(createIndustryLoadApi(async()=>record,journal).create({...input,contentHash:'b'.repeat(64)}),/原请求/)
 const broken=createIndustryLoadApi(async()=>{calls++;return record},{read:()=>null,write:()=>{throw Error('无法保存')},clear:()=>{}})
 await assert.rejects(broken.create(input),/无法保存/);assert.equal(calls,1)
})

test('get与list使用固定端点并严格解析记录',async()=>{
 const calls:unknown[]=[];const api=createIndustryLoadApi(async(method,payload)=>{calls.push([method,payload]);return method==='industry-loads/list'?{items:[record]}:record})
 assert.deepEqual(await api.get(loadId),record);assert.deepEqual(await api.list(),[record])
 assert.deepEqual(calls,[['industry-loads/get',{loadId}],['industry-loads/list',{}]])
})

test('拒绝损坏身份、状态、空间、关系与重复资源',async()=>{
 const bad=[
  {...record,id:'bad'},
  {...record,space:{...record.space,scope:'  '}},
  {...record,targetVersion:2},
  {...record,items:[record.items[0],record.items[0]]},
  {...record,items:[{...record.items[0],status:'ready'}]},
  {...record,items:[{...record.items[0],status:'skipped'}]},
  {...record,relations:[{kind:'role-skill',from:roleId,to:'72345678-1234-4234-8234-123456789012'}]},
 ]
 for(const value of bad)await assert.rejects(createIndustryLoadApi(async()=>value).get(loadId),/格式/)
 assert.deepEqual(await createIndustryLoadApi(async()=>({...record,relations:[{kind:'role-skill',from:roleId,to:skillId}],entrypoints:[skillId]})).get(loadId),{...record,relations:[{kind:'role-skill',from:roleId,to:skillId}],entrypoints:[skillId]})
 await assert.rejects(createIndustryLoadApi(async()=>({items:[record,record]})).list(),/重复/)
 await assert.rejects(createIndustryLoadApi(async()=>({items:[],extra:true})).list(),/目录格式/)
 await assert.rejects(createIndustryLoadApi(async()=>({items:[record,{...record,id:'82345678-1234-4234-8234-123456789012',contentId:'92345678-1234-4234-8234-123456789012',contentHash:'b'.repeat(64),space:{...record.space,version:2}}]})).list(),/空间现状不一致/)
})

test('请求与恢复日志严格校验',async()=>{
 await assert.rejects(createIndustryLoadApi(async()=>record).create({...input,requestId:'bad'}),/请求格式/)
 const api=createIndustryLoadApi(async()=>record,{read:()=>JSON.stringify({schema:'teloa.industry-load-create/v1',request:{...input,target:{kind:'new',spaceId,name:'x',extra:true}}}),write:()=>{},clear:()=>{}})
 assert.equal(api.recoveryMessage()?.code,'teloa/storage-corrupt');await assert.rejects(api.recover(),(error:unknown)=>(error as {code?:unknown})?.code==='teloa/storage-corrupt')
})
test('服务明确拒绝释放请求，未知错误与坏回包仍保留',async()=>{
 for(const [failure,kept] of [[Object.assign(Error('拒绝'),{rejected:true,code:'teloa/version-conflict'}),false],[Error('断线'),true]] as const){let raw:string|null=null;const api=createIndustryLoadApi(async()=>{throw failure},{read:()=>raw,write:value=>{raw=value},clear:()=>{raw=null}});await assert.rejects(api.create(input));assert.equal(!!api.pending(),kept)}
 let raw:string|null=null;const api=createIndustryLoadApi(async()=>({...record,id:'bad'}),{read:()=>raw,write:value=>{raw=value},clear:()=>{raw=null}});await assert.rejects(api.create(input),/格式/);assert.ok(api.pending())
})

test('记录解析接受实例化后的投影状态并拒绝其它状态',async()=>{
 for(const status of ['pending-adapter','instantiated','active','detached']){
  const projected={...record,items:[{...record.items[0]!,status},record.items[1]!]}
  assert.deepEqual(await createIndustryLoadApi(async()=>projected).get(loadId),projected)
 }
 for(const status of ['pending','instantiating','retired','']){
  const projected={...record,items:[{...record.items[0]!,status},record.items[1]!]}
  await assert.rejects(createIndustryLoadApi(async()=>projected).get(loadId),/格式/)
 }
 await assert.rejects(createIndustryLoadApi(async()=>({...record,items:[{...record.items[0]!,status:'skipped'},record.items[1]!]})).get(loadId),/格式/)
})

const unloaded={...record,status:'unloaded',unloadedAt:'2026-09-13T00:00:00.000Z'}
const unloadInput={requestId,loadId,expectedMappingHash:'b'.repeat(64)}

test('卸载写入独立日志，成功清理且只提交请求身份、加载与映射指纹',async()=>{
 let raw:string|null=null;const calls:unknown[]=[]
 const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
 const api=createIndustryLoadApi(async(method,payload)=>{calls.push([method,payload]);return unloaded},undefined,journal)
 assert.deepEqual(await api.unload(unloadInput),unloaded)
 assert.deepEqual(calls,[['industry-loads/unload',unloadInput]])
 assert.equal(raw,null);assert.equal(api.unloadPending(),undefined)
 await assert.rejects(api.unload({...unloadInput,expectedMappingHash:'bad'}),/卸载请求格式/)
 const stale=createIndustryLoadApi(async()=>record,undefined,journal)
 await assert.rejects(stale.unload(unloadInput),/卸载响应与原请求不一致/)
})

test('卸载失败保留请求，明确拒绝才清理独立日志',async()=>{
 for(const [failure,kept] of [[Object.assign(Error('阻塞'),{rejected:true,code:'teloa/conflict'}),false],[Error('断线'),true]] as const){
  let raw:string|null=null
  const api=createIndustryLoadApi(async()=>{throw failure},undefined,{read:()=>raw,write:value=>{raw=value},clear:()=>{raw=null}})
  await assert.rejects(api.unload(unloadInput));assert.equal(!!api.unloadPending(),kept);assert.equal(raw!==null,kept)
 }
 let raw:string|null=null;const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
 await assert.rejects(createIndustryLoadApi(async()=>{throw Error('断线')},undefined,journal).unload(unloadInput),/断线/)
 const resumed=createIndustryLoadApi(async()=>unloaded,undefined,journal)
 assert.deepEqual(resumed.unloadPending(),unloadInput)
 await assert.rejects(resumed.unload({...unloadInput,loadId:spaceId}),/再卸载其他行业模板/)
 assert.deepEqual(await resumed.recoverUnload(),unloaded);assert.equal(raw,null)
 const broken=createIndustryLoadApi(async()=>unloaded,undefined,{read:()=>JSON.stringify({schema:'teloa.industry-load-unload/v1',request:{...unloadInput,extra:true}}),write:()=>{},clear:()=>{}})
 assert.equal(broken.unloadRecoveryMessage()?.code,'teloa/storage-corrupt');await assert.rejects(broken.unload(unloadInput),(error:unknown)=>(error as {code?:unknown})?.code==='teloa/storage-corrupt')
})

test('目录默认不带过滤，显式索取已卸载加载时提交标记并接受卸载记录',async()=>{
 const calls:unknown[]=[];const api=createIndustryLoadApi(async(method,payload)=>{calls.push([method,payload]);return {items:[unloaded]}})
 assert.deepEqual(await api.list(true),[unloaded])
 await createIndustryLoadApi(async()=>({items:[record]})).list()
 assert.deepEqual(calls,[['industry-loads/list',{includeUnloaded:true}]])
 await assert.rejects(createIndustryLoadApi(async()=>({...record,unloadedAt:'2026-09-13T00:00:00.000Z'})).get(loadId),/格式/)
 await assert.rejects(createIndustryLoadApi(async()=>({...unloaded,unloadedAt:'2026-09-11T00:00:00.000Z'})).get(loadId),/格式/)
 await assert.rejects(createIndustryLoadApi(async()=>({...record,status:'removed'})).get(loadId),/格式/)
 await assert.rejects(createIndustryLoadApi(async()=>({...record,mappingHash:'bad'})).get(loadId),/格式/)
})

test('阻塞项只从冲突拒绝的既定形状读出，其它一律视为没有阻塞项',()=>{
 const blockers=[{kind:'plan-occurrence',id:roleId},{kind:'task-run',id:skillId}]
 assert.deepEqual(readUnloadBlockers(Object.assign(Error('阻塞'),{rejected:true,code:'teloa/conflict',details:{blockers}})),blockers)
 for(const reason of [
  Object.assign(Error('阻塞'),{code:'teloa/version-conflict',details:{blockers}}),
  Object.assign(Error('阻塞'),{code:'teloa/conflict',details:{}}),
  Object.assign(Error('阻塞'),{code:'teloa/conflict',details:{blockers:[{kind:'other',id:roleId}]}}),
  Object.assign(Error('阻塞'),{code:'teloa/conflict',details:{blockers:[{kind:'task-run',id:'bad'}]}}),
  Error('断线'),undefined,
 ])assert.deepEqual(readUnloadBlockers(reason),[])
})

test('同一空间下多个业务范围标签共存：scope 不参与空间现状一致性，id/name/version 仍严格',async()=>{
 const other={...record,id:'82345678-1234-4234-8234-123456789012',contentId:'92345678-1234-4234-8234-123456789012',contentHash:'b'.repeat(64),domain:'finance',scope:'finance',templateTitle:'财务模板'}
 const rows=await createIndustryLoadApi(async()=>({items:[{...record,space:{...record.space,scope:'SOC'}},{...other,space:{...other.space,scope:'finance'}}]})).list()
 assert.deepEqual(rows.map(row=>row.space.scope),['SOC','finance'])
 assert.equal(new Set(rows.map(row=>row.space.id)).size,1)
 for(const drift of [{name:'别的空间'},{version:2}])
  await assert.rejects(createIndustryLoadApi(async()=>({items:[{...record,space:{...record.space,scope:'SOC'}},{...other,space:{...other.space,scope:'finance',...drift}}]})).list(),/空间现状不一致/)
})
