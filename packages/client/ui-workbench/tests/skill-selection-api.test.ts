import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {registerHooks} from 'node:module'
import {existsSync} from 'node:fs'
import type {SkillInstallationRecord} from '../src/client/skill-install-api.ts'
import type {SkillSelectionCommand,SkillSelectionPreview} from '../src/client/skill-selection-api.ts'
registerHooks({resolve(specifier,context,next){if(specifier.endsWith('.js')&&specifier.startsWith('.')&&context.parentURL?.includes('/ui-workbench/src/client/')){const source=new URL(specifier.slice(0,-3)+'.ts',context.parentURL);if(existsSync(source))return next(source.href,context)}return next(specifier,context)}})
const {createSkillSelectionApi}=await import('../src/client/skill-selection-api.ts')
const owner='local:teloa-owner',oldId='11111111-1111-4111-8111-111111111111',targetId='22222222-2222-4222-8222-222222222222',oldAt='2026-10-28T00:00:00.000Z',at='2026-10-28T00:01:00.000Z'
const hash=(value:string)=>createHash('sha256').update(value).digest('hex'),stable=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item)
const native={name:'soc-t1-triage',description:'调查',modelInvocable:true,userInvocable:true,bodyHash:hash('body')}
const installation=(id:string,publisher:string):SkillInstallationRecord=>({id,ownerId:owner,source:{kind:'atomic',contentId:id,contentHash:hash(id),resourceId:'soc-t1-triage',resourceVersion:'1.2.2'},bundleHash:hash('same-files'),native,trust:{publisher,repository:null,license:{status:'declared',value:'MIT'},signature:{status:'unverified',signer:null},compatibility:{teloa:'unknown',dsh:'unknown'},plugins:[],externalCapabilities:[],permissions:[],review:{conclusion:'needs-review',summary:'review'}},trustHash:hash(publisher),state:'installed',version:2,createdAt:oldAt,updatedAt:oldAt})
const current=installation(oldId,'旧发布者'),target=installation(targetId,'新发布者'),selection={ownerId:owner,nativeName:native.name,installationId:oldId,version:1,updatedAt:oldAt}
const impact={nativeName:native.name,selection:{installationId:oldId,version:1},current:{installationId:oldId,installationVersion:2,bundleHash:current.bundleHash,availability:'enabled' as const,availabilityVersion:1},target:{installationId:targetId,installationVersion:2,bundleHash:target.bundleHash,availability:'enabled' as const,availabilityVersion:1},industryUsages:[{loadId:'33333333-3333-4333-8333-333333333333',itemInstanceId:'44444444-4444-4444-8444-444444444444'}]}
const fixture:SkillSelectionPreview={selection,current,target,impact,impactDigest:hash(stable(impact))}
function receipt(command:SkillSelectionCommand){const result={...selection,installationId:targetId,version:2,updatedAt:at};return {receipt:{requestId:command.requestId,nativeName:native.name,before:selection,result,migratedIndustryUsages:[],impact,impactDigest:fixture.impactDigest,createdAt:at},current:result}}
const memory=()=>{const state={value:null as string|null,failWrite:false,failClear:false};return {state,journal:{read:()=>state.value,write:(value:string)=>{if(state.failWrite)throw Error('write failed');state.value=value},clear:()=>{if(state.failClear)throw Error('clear failed');state.value=null}}}}
const errorCode=(error:unknown,code:string)=>!!error&&typeof error==='object'&&'code'in error&&error.code===code

test('只读预览固定owner/native/两安装和实际impact摘要；本人确认只切选择，不迁旧usage',async()=>{
 const calls:[string,unknown][]=[],storage=memory()
 const api=createSkillSelectionApi(async(endpoint,payload)=>{calls.push([endpoint,payload]);return endpoint==='skill-selections/get'?selection:endpoint==='skill-selections/preview'?fixture:receipt(payload as SkillSelectionCommand)},storage.journal)
 assert.deepEqual(await api.get(target),selection)
 const preview=await api.preview(target);assert.deepEqual(preview,fixture);assert.equal(api.pending(),undefined);assert.equal(storage.state.value,null)
 assert.deepEqual(calls.map(([endpoint])=>endpoint),['skill-selections/get','skill-selections/get','skill-selections/preview'])
 const result=await api.change(preview,target),command=calls.at(-1)![1] as SkillSelectionCommand
 assert.deepEqual(command.industryUsages,[]);assert.equal(command.expectedImpactDigest,fixture.impactDigest);assert.equal(result.current.installationId,targetId);assert.equal(storage.state.value,null)
 assert.equal(calls.some(([endpoint])=>endpoint==='skill-installations/install'),false)
})
test('跨owner、错误native/target身份、安装状态、伪造impact及未知键均拒绝，不能生成写请求',async()=>{
 const cases=[{...fixture,target:{...target,ownerId:'other'}},{...fixture,target:{...target,id:oldId}},{...fixture,target:{...target,native:{...native,name:'other'}}},{...fixture,target:{...target,state:'preparing'}},{...fixture,target:{...target,trustHash:hash('different-trust')}},{...fixture,selection:{...selection,ownerId:'other'}},{...fixture,selection:{...selection,nativeName:'other'}},{...fixture,impact:{...impact,target:{...impact.target,bundleHash:hash('wrong')}}},{...fixture,impactDigest:hash('not-the-impact')},{...fixture,impact:{...impact,extra:true}},{...fixture,extra:true}]
 for(const value of cases){let writes=0;const api=createSkillSelectionApi(async endpoint=>{if(endpoint==='skill-selections/change')writes++;return endpoint==='skill-selections/get'?selection:value});await assert.rejects(api.preview(target));assert.equal(writes,0);assert.equal(api.pending(),undefined)}
 for(const value of [{...selection,ownerId:'other'},{...selection,nativeName:'other'},{...selection,version:1.5},{...selection,updatedAt:'bad'},{...selection,extra:true}])await assert.rejects(createSkillSelectionApi(async()=>value).get(target))
})
test('未知提交结果跨API重建保留同requestId；恢复不能改投另一安装或owner',async()=>{
 const storage=memory(),commands:SkillSelectionCommand[]=[];let lost=true
 const call=async(endpoint:string,payload:unknown)=>{if(endpoint==='skill-selections/get')return selection;if(endpoint==='skill-selections/preview')return fixture;const command=payload as SkillSelectionCommand;commands.push(structuredClone(command));if(lost){lost=false;throw Error('response lost')}return receipt(command)}
 const first=createSkillSelectionApi(call,storage.journal);await assert.rejects(first.change(await first.preview(target),target));const pending=first.pending()!;assert.ok(storage.state.value)
 const restored=createSkillSelectionApi(call,storage.journal)
 await assert.rejects(restored.recover(current));await assert.rejects(restored.recover({...target,ownerId:'other'}));await assert.rejects(restored.recover({...target,trustHash:hash('changed')}));assert.equal(commands.length,1,'旧目标恢复入口不能发送另一目标的命令')
 const result=await restored.recover(target);assert.equal(result.current.installationId,targetId);assert.deepEqual(commands[1],commands[0]);assert.equal(commands[1]!.requestId,pending.command.requestId);assert.equal(storage.state.value,null)
})
test('A卡片旧恢复按钮遇到当前pending已改为B时，不向change发送B或新命令',async()=>{
 const storage=memory(),other={...target,id:'55555555-5555-4555-8555-555555555555'},otherImpact={...impact,target:{...impact.target,installationId:other.id}},otherPreview={...fixture,target:other,impact:otherImpact,impactDigest:hash(stable(otherImpact))};let writes=0
 const api=createSkillSelectionApi(async(endpoint,payload)=>{if(endpoint==='skill-selections/get')return selection;if(endpoint==='skill-selections/preview')return (payload as {targetInstallationId:string}).targetInstallationId===other.id?otherPreview:fixture;writes++;throw Error('response lost')},storage.journal)
 await assert.rejects(api.change(await api.preview(target),target));const oldRecover=()=>api.recover(target);api.discard()
 await assert.rejects(api.change(await api.preview(other),other));assert.equal(writes,2);await assert.rejects(oldRecover());assert.throws(()=>api.discard(target));assert.equal(writes,2);assert.equal(api.pending()!.command.targetInstallationId,other.id)
})
test('回包身份、版本、摘要或迁移集合错配时保持journal，不伪造成功',async()=>{
 const mutate=[(value:any)=>({...value,receipt:{...value.receipt,requestId:oldId}}),(value:any)=>({...value,receipt:{...value.receipt,before:{...selection,version:2}}}),(value:any)=>({...value,receipt:{...value.receipt,result:{...value.receipt.result,installationId:oldId}}}),(value:any)=>({...value,receipt:{...value.receipt,migratedIndustryUsages:impact.industryUsages}}),(value:any)=>({...value,receipt:{...value.receipt,impactDigest:hash('bad')}}),(value:any)=>({...value,current:{...value.current,version:1}}),(value:any)=>({...value,receipt:{...value.receipt,extra:true}})]
 for(const bad of mutate){const storage=memory(),api=createSkillSelectionApi(async(endpoint,payload)=>endpoint==='skill-selections/get'?selection:endpoint==='skill-selections/preview'?fixture:bad(receipt(payload as SkillSelectionCommand)),storage.journal);await assert.rejects(api.change(await api.preview(target),target));assert.ok(api.pending());assert.ok(storage.state.value)}
})
test('写恢复记录失败不发送；成功回执后清除失败仍可按原请求恢复',async()=>{
 const storage=memory();let writes=0
 const call=async(endpoint:string,payload:unknown)=>{if(endpoint==='skill-selections/get')return selection;if(endpoint==='skill-selections/preview')return fixture;writes++;return receipt(payload as SkillSelectionCommand)}
 const api=createSkillSelectionApi(call,storage.journal),preview=await api.preview(target);storage.state.failWrite=true
 await assert.rejects(api.change(preview,target),error=>errorCode(error,'teloa/recovery-write-failed'));assert.equal(writes,0)
 storage.state.failWrite=false;storage.state.failClear=true;await assert.rejects(api.recover(target),error=>errorCode(error,'teloa/recovery-clear-failed'));assert.equal(writes,1);const pending=api.pending()!
 storage.state.failClear=false;await api.recover(target);assert.equal(writes,2);assert.equal(api.pending(),undefined);assert.equal(storage.state.value,null);assert.ok(pending.command.requestId)
})
test('损坏、跨窗口覆盖及恢复目标切换不能清理或替换其它journal',async()=>{
 const storage=memory();storage.state.value='broken';let writes=0
 const api=createSkillSelectionApi(async()=>{writes++;return fixture},storage.journal);assert.ok(api.recoveryMessage());await assert.rejects(api.recover(target));assert.equal(writes,0);assert.equal(storage.state.value,'broken');api.discard();assert.equal(storage.state.value,null)
 const journal=memory();let replace=false
 const next=createSkillSelectionApi(async(endpoint,payload)=>{if(endpoint==='skill-selections/get')return selection;if(endpoint==='skill-selections/preview')return fixture;const command=payload as SkillSelectionCommand;if(replace){const stored=JSON.parse(journal.state.value!);stored.command.requestId=oldId;journal.state.value=JSON.stringify(stored)}return receipt(command)},journal.journal)
 const preview=await next.preview(target);replace=true;await assert.rejects(next.change(preview,target),error=>errorCode(error,'teloa/recovery-clear-failed'));assert.equal(JSON.parse(journal.state.value!).command.requestId,oldId);await assert.rejects(next.recover(target),error=>errorCode(error,'teloa/recovery-write-failed'));assert.equal(JSON.parse(journal.state.value!).command.requestId,oldId)
})
