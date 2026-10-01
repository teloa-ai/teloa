import test from 'node:test'
import assert from 'node:assert/strict'
import {readIndustryDirectory} from '../src/client/industry-directory.ts'
import {compareIndustryUpdate,type IndustryUpdateContext} from '../src/client/industry-update.ts'
import type {IndustryLoadRecord} from '../src/client/industry-load-api.ts'
import type {IndustryRoleInstance} from '../src/client/industry-role-api.ts'
import type {MarketItem} from '../src/client/market-preview.ts'
const now='2026-09-11T12:00:00.000Z'
const loadRecordId='11111111-1111-4111-8111-111111111111',candidateContentId='22222222-2222-4222-8222-222222222222'
const requestId='33333333-3333-4333-8333-333333333333',mappingHash='a'.repeat(64)
const baselineContentId='44444444-4444-4444-8444-444444444444',spaceId='55555555-5555-4555-8555-555555555555'
const roleItemId='66666666-6666-4666-8666-666666666666',guideItemId='77777777-7777-4777-8777-777777777777'
const roleId='88888888-8888-4888-8888-888888888888',roleInstanceId='99999999-9999-4999-8999-999999999999'
const scope='space-'+spaceId
const file=(path:string,text:string)=>{const bytes=new TextEncoder().encode(text);return {path,size:bytes.length,read:async()=>bytes}}
async function source(body='# 原手册',id='research',removeRole=false,roleKind:'employee'|'twin'='employee'){
 const manifest={format:'teloa.business-package/v2',id,title:'同名模板',version:'1.0.0',domain:'general',scope:'general',description:'研究资料',resources:[...(!removeRole?[{id:'role',kind:'role',title:'研究岗',version:'1.0.0',required:true,source:{kind:'local',path:'role.json'}}]:[]),{id:'guide',kind:'knowledge',title:'手册',version:'1.0.0',required:true,source:{kind:'local',path:'guide.md'}}],relations:removeRole?[]:[{kind:'role-knowledge',from:'role',to:'guide'}],entrypoints:[]}
 return readIndustryDirectory([file('teloa.json',JSON.stringify(manifest)),file('role.json',JSON.stringify({format:'teloa.role/v1',name:'研究岗',kind:roleKind,duty:'核对来源',dataScope:'给定资料',executionScope:'代拟'})),file('guide.md',body)],'teloa.json','研究')
}
/** 基线内容按内容身份与摘要与加载记录对上：比较入口只认这条身份，不按名称或摘要猜。 */
const fixed=(item:Awaited<ReturnType<typeof source>>,contentId=baselineContentId):MarketItem=>({...item,contentStorage:{contentId,createdAt:now,loaded:true}})
const record=(baseline:MarketItem):IndustryLoadRecord=>({
 id:loadRecordId,ownerId:'local:teloa-owner',contentId:baselineContentId,contentHash:baseline.packageContent!.hash,
 templateId:'research',templateVersion:'1.0.0',templateTitle:'同名模板',domain:'general',scope:'general',description:'研究资料',targetVersion:1,
 space:{id:spaceId,name:'研究团队',version:1,scope},
 items:[
  {localId:'role',instanceId:roleItemId,kind:'role',title:'研究岗',version:'1.0.0',required:true,status:'pending-adapter'},
  {localId:'guide',instanceId:guideItemId,kind:'knowledge',title:'手册',version:'1.0.0',required:true,status:'pending-adapter'},
 ],
 relations:[],entrypoints:[],createdAt:now,mappingHash,status:'active',
})
/** 岗位实例把加载项身份与真实岗位对起来：本地修改就是真实岗位与模板固定定义的逐字段差。 */
const roleInstance=(patch:Record<string,unknown>={}):IndustryRoleInstance=>({
 id:roleInstanceId,ownerId:'local:teloa-owner',loadId:loadRecordId,itemInstanceId:roleItemId,itemLocalId:'role',scope,
 definitionHash:'d'.repeat(64),revision:1,state:'active',
 role:{id:roleId,ownerId:'local:teloa-owner',version:1,state:'active',createdAt:now,updatedAt:now,
  name:'研究岗',kind:'employee',scopes:[scope],duty:'核对来源',dataScope:'给定资料',executionScope:'代拟',skills:[],knowledge:[],
  responsibility:{triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]},...patch},
 knowledge:[],omittedKnowledge:[],declarations:[],failure:null,createdAt:now,updatedAt:now,
})
async function setup(roles:IndustryRoleInstance[]=[roleInstance()]){
 const baseline=fixed(await source())
 const context:IndustryUpdateContext={industryRoles:roles,tasks:[],plans:[]}
 return {baseline,row:record(baseline),context}
}
// 资源级比较本身由 contract 的 industry-update-compare 测试覆盖；这里只核对客户端包装的接线与只读性。
test('比较结果带上本地解析并原样透传核的资源差异，预览不修改空间资源',async()=>{
 const {baseline,row,context}=await setup(),before=structuredClone(context)
 const diff=compareIndustryUpdate(context,row,baseline,await source('# 更新手册'))
 const guide=diff.resources.find(item=>item.id==='guide')
 assert.equal(guide?.change,'changed')
 assert.equal(guide?.after?.state,'parsed')
 assert.equal(diff.resources.find(item=>item.id==='role')?.change,'unchanged')
 // 真实岗位与模板固定定义逐字相同时没有本地修改，岗位身份与加载项身份都带出来。
 assert.deepEqual(diff.localRoles,[{id:roleItemId,roleId,name:'研究岗',fields:[],state:'active',kindChanged:false}])
 assert.deepEqual(context,before)
})
test('拒绝同名不同模板和非加载基线，不能按名称或摘要猜版本关系',async()=>{
 const {baseline,row,context}=await setup()
 const unrelated=await source('# 其他','different')
 assert.throws(()=>compareIndustryUpdate(context,row,baseline,unrelated),/模板身份/)
 const changed=fixed(await source('# 变更'))
 assert.throws(()=>compareIndustryUpdate(context,row,changed,baseline),/内容不匹配/)
 // 内容摘要对上但内容身份不是加载记录固定的那一份，同样拒绝。
 const misfiled=fixed(await source(),candidateContentId)
 assert.throws(()=>compareIndustryUpdate(context,row,misfiled,changed),/内容不匹配/)
})
test('模板移除岗位时列出本地修改，不退役或删除已有岗位',async()=>{
 const {baseline,row,context}=await setup([roleInstance({duty:'本团队定制职责',version:2})])
 const diff=compareIndustryUpdate(context,row,baseline,await source('# 原手册','research',true))
 assert.equal(diff.resources.find(item=>item.id==='role')?.change,'removed')
 assert.deepEqual(diff.localRoles[0]?.fields,['duty'])
 assert.equal(diff.relationsChanged,true)
 assert.equal(context.industryRoles[0]?.role?.state,'active')
 assert.equal(context.industryRoles[0]?.role?.duty,'本团队定制职责')
})
test('岗位尚未建立时按缺失列出，不给出可打开的岗位身份',async()=>{
 const {baseline,row,context}=await setup([])
 const diff=compareIndustryUpdate(context,row,baseline,await source('# 更新手册'))
 assert.deepEqual(diff.localRoles,[{id:roleItemId,roleId:undefined,name:'研究岗',fields:['missing'],state:'missing',kindChanged:false}])
})
test('同一资源换类型由客户端写成阻断说明，关联与入口差异原样带出',async()=>{
 const {baseline,row,context}=await setup()
 assert.ok(baseline.manifest?.format==='teloa.business-package/v2')
 const candidate={...baseline,manifest:{...baseline.manifest,resources:baseline.manifest.resources.map(item=>item.id==='guide'?{...item,kind:'skill' as const}:item),relations:[{kind:'role-skill' as const,from:'role',to:'guide'}],entrypoints:['guide']}}
 const diff=compareIndustryUpdate(context,row,baseline,candidate)
 assert.equal(diff.relationChanges.length,2)
 assert.deepEqual(diff.entrypointChanges,[{change:'added',id:'guide'}])
 assert.ok(diff.blockers.some(text=>text.includes('类型变化（knowledge 改为 skill）')))
})

import {industryUpdateSubmission} from '../src/client/industry-update-plan.ts'
test('升级提交固定继任目标、候选内容与处理选择，不改写已加载记录；遗漏或越界选择拒绝提交',async()=>{
 const {baseline,row,context}=await setup(),candidate=fixed(await source('# 新手册'),candidateContentId)
 const before=structuredClone(context)
 const choices={resources:{guide:'candidate'},roles:{},relations:'keep',entrypoints:'keep',positioning:'keep'} as const
 const input=industryUpdateSubmission(context,row,baseline,candidate,choices,requestId)
 assert.deepEqual(input,{requestId,loadId:loadRecordId,candidateContentId,expectedMappingHash:mappingHash,choices})
 assert.notEqual(input.choices,choices)
 assert.deepEqual(context,before)
 assert.throws(()=>industryUpdateSubmission(context,row,baseline,candidate,{...choices,resources:{}},requestId),/请选择处理方式/)
 assert.throws(()=>industryUpdateSubmission(context,row,baseline,candidate,{...choices,resources:{guide:'candidate',role:'keep'}},requestId),/重新比较/)
 assert.throws(()=>industryUpdateSubmission(context,{...row,contentHash:'b'.repeat(64)},baseline,candidate,choices,requestId),/内容不匹配/)
 const {contentStorage:_stored,...unstored}=candidate
 assert.throws(()=>industryUpdateSubmission(context,row,baseline,unstored,choices,requestId),/尚未持久化/)
})
test('本地岗位修改必须明确处理，移除模板岗位只能搁置——岗位不是可解除的四类资源',async()=>{
 const {baseline,row,context}=await setup([roleInstance({duty:'本地职责',version:2})])
 const candidate=fixed(await source('# 原手册','research',true),candidateContentId)
 const choices={resources:{role:'skip'},roles:{},relations:'candidate',entrypoints:'keep',positioning:'keep'} as const
 assert.throws(()=>industryUpdateSubmission(context,row,baseline,candidate,choices,requestId),/本地修改/)
 // 岗位选择按加载项身份记，服务端也按它核对归属。
 const input=industryUpdateSubmission(context,row,baseline,candidate,{...choices,roles:{[roleItemId]:'keep-local'}},requestId)
 assert.equal(input.choices.resources.role,'skip')
 assert.equal(context.industryRoles[0]?.role?.duty,'本地职责')
 // 岗位的本地对象在模板移除后一律保留，因此"解除"不是它的可选项。
 assert.throws(()=>industryUpdateSubmission(context,row,baseline,candidate,{...input.choices,resources:{role:'detach'}},requestId),/处理方式与资源变化不符/)
 assert.throws(()=>industryUpdateSubmission(context,row,baseline,candidate,{...input.choices,resources:{role:'candidate'}},requestId),/处理方式与资源变化不符/)
})
test('岗位本地修改选择不能与保留资源或过期身份冲突',async()=>{
 // 岗位取暂停态：运行中的岗位另有更早的拒绝判据（见下一例），这里要核对的是与资源选择的耦合。
 const {baseline,row,context}=await setup([roleInstance({duty:'定制职责',version:2,state:'paused'})])
 const candidate=fixed(await source('# 新手册'),candidateContentId)
 const choices={resources:{guide:'candidate'},roles:{[roleItemId]:'use-template'},relations:'keep',entrypoints:'keep',positioning:'keep'} as const
 // 岗位资源本身未变化时比较核不接受它的处理方式，服务端仍按候选内容重放模板字段：这一支必须放行，
 // 否则"有本地修改的未变化岗位"在两条判据之间无路可走（表单也照常给出这个选项）。
 assert.equal(industryUpdateSubmission(context,row,baseline,candidate,choices,requestId).choices.roles[roleItemId],'use-template')
 assert.throws(()=>industryUpdateSubmission(context,row,baseline,candidate,{...choices,roles:{[roleItemId]:'keep-local',[guideItemId]:'keep-local'}},requestId),/员工选择已过期/)
 // 岗位资源确有变化时仍要求同时采用候选：沿用旧资源再重放模板字段会让两者对不上。
 assert.ok(candidate.manifest?.format==='teloa.business-package/v2')
 const bumped:MarketItem={...candidate,manifest:{...candidate.manifest,resources:candidate.manifest.resources.map(item=>item.id==='role'?{...item,version:'1.1.0'}:item)}}
 assert.throws(()=>industryUpdateSubmission(context,row,baseline,bumped,{...choices,resources:{guide:'candidate',role:'keep'}},requestId),/采用候选员工资源/)
 assert.equal(industryUpdateSubmission(context,row,baseline,bumped,{...choices,resources:{guide:'candidate',role:'candidate'}},requestId).choices.resources.role,'candidate')
})
test('运行中的岗位与身份类型变化都不能采用模板定义，搁置本地修改仍可提交',async()=>{
 // 两种情形在服务端都会让整笔升级回滚（运行岗位不可编辑、岗位不能改身份类型），因此提交前就拒绝。
 const running=await setup([roleInstance({duty:'定制职责',version:2})])
 assert.equal(running.context.industryRoles[0]?.role?.state,'active')
 const changedRole=fixed(await source('# 原手册','research',false,'twin'),candidateContentId)
 const roleChoices={resources:{role:'candidate'},roles:{[roleItemId]:'use-template'},relations:'keep',entrypoints:'keep',positioning:'keep'} as const
 assert.throws(()=>industryUpdateSubmission(running.context,running.row,running.baseline,changedRole,roleChoices,requestId),/请先暂停员工/)
 // 同一份候选在暂停岗位上换来身份类型变化的拒绝。
 const paused=await setup([roleInstance({duty:'定制职责',version:2,state:'paused'})])
 const diff=compareIndustryUpdate(paused.context,paused.row,paused.baseline,changedRole)
 assert.equal(diff.localRoles[0]?.kindChanged,true)
 assert.throws(()=>industryUpdateSubmission(paused.context,paused.row,paused.baseline,changedRole,roleChoices,requestId),/身份类型/)
 // 搁置本地修改不受影响：两种情形都能照常提交。
 for(const ready of [running,paused])
  assert.equal(industryUpdateSubmission(ready.context,ready.row,ready.baseline,changedRole,{...roleChoices,roles:{[roleItemId]:'keep-local'}},requestId).choices.roles[roleItemId],'keep-local')
})
