import assert from 'node:assert/strict'
import test from 'node:test'
import {customizationApplyGuard,customizationDraftRows,customizationFailureKey,customizationRevertOptions,blockLocalCustomized} from '../src/client/business-customization-presentation.ts'
import {block} from './business-ledger-fixtures.ts'

const hash=(character:string)=>character.repeat(64)
const version=(number:number,definitionHash=hash('a'))=>({version:number,semver:'1.0.0',definitionHash,bodyHash:hash('b'),createdAt:'2026-09-17T00:00:00.000Z',draftId:'11111111-1111-4111-8111-111111111111'})
const draft={id:'11111111-1111-4111-8111-111111111111',ownerId:'local:teloa-owner',requestId:'22222222-2222-4222-8222-222222222222',scope:'SOC',kind:'object-type' as const,localId:'ticket',semver:'1.0.0',definitionHash:hash('c'),body:'{}',status:'draft' as const,createdAt:'2026-09-17T00:00:00.000Z',updatedAt:'2026-09-17T00:00:00.000Z'}
const preview=(base:{origin:'template'|'local'|'none';semver?:string;definitionHash?:string})=>({schema:'teloa.business-definition-preview/v1' as const,draft,receipt:hash('d'),base,diff:[],diffTruncated:false,impact:{scope:'SOC',objectType:'ticket',views:[],actions:[],fields:[],widgets:[],dashboards:[]},trialUnavailable:'no-objects' as const,computedAt:'2026-09-17T00:00:00.000Z'})
const entry=(current?:ReturnType<typeof version>,available=true)=>({scope:'SOC',kind:'object-type' as const,localId:'ticket',...(current?{current}:{}),versions:[version(1),version(2,hash('e'))],template:available?{available:true as const,version:'1.0.0'}:{available:false as const}})

test('草案行保留类型、人类版本与待确认状态，不让组件重写判据',()=>{
 const rows=customizationDraftRows({schema:'teloa.business-customization/v1',scope:'SOC',readAt:'2026-09-17T00:00:00.000Z',drafts:[draft,{...draft,id:'33333333-3333-4333-8333-333333333333',kind:'view',status:'applied'}],entries:[]})
 assert.deepEqual(rows.map(row=>[row.kindKey,row.pending]),[['business.custom.kind.objectType',true],['business.custom.kind.view',false]])
})

test('确认只接受仍与预览基准一致的当前版本，并逐字回传预览里的声明摘要',()=>{
 const local=preview({origin:'local',semver:'1.0.0',definitionHash:hash('a')})
 assert.deepEqual(customizationApplyGuard(local,entry(version(1))),{ok:true,expectedDefinitionHash:hash('c'),expectedCurrentVersion:1})
 assert.deepEqual(customizationApplyGuard(local,entry(version(1,hash('e')))),{ok:false,reason:'stale-preview'})
 assert.deepEqual(customizationApplyGuard(preview({origin:'template',semver:'1.0.0',definitionHash:hash('f')}),entry()),{ok:true,expectedDefinitionHash:hash('c'),expectedCurrentVersion:0})
 assert.deepEqual(customizationApplyGuard(preview({origin:'none'}),entry(version(1))),{ok:false,reason:'stale-preview'})
 assert.deepEqual(customizationApplyGuard({...local,draft:{...draft,status:'applied'}},entry(version(1))),{ok:false,reason:'already-applied'})
})

test('回退只提供真正可改变当前指针的版本，并且模板不存在时没有模板入口',()=>{
 assert.deepEqual(customizationRevertOptions(entry(version(2))),[
  {target:{kind:'local-version',version:1},labelKey:'business.custom.revert.version',version:1},
  {target:{kind:'template'},labelKey:'business.custom.revert.template'},
 ])
 assert.deepEqual(customizationRevertOptions(entry(undefined,false)),[
  {target:{kind:'local-version',version:1},labelKey:'business.custom.revert.version',version:1},
  {target:{kind:'local-version',version:2},labelKey:'business.custom.revert.version',version:2},
 ])
})

test('本地对象类型或任一视图都必须给块加本地定制标记，错误只映射固定文案键',()=>{
 const template=block()
 assert.equal(blockLocalCustomized(template as never),false)
 assert.equal(blockLocalCustomized({...template,objectType:{...template.objectType,source:{...template.objectType.source,origin:'local'}}} as never),true)
 assert.equal(blockLocalCustomized({...template,views:template.views.map(view=>({...view,origin:'local'}))} as never),true)
 assert.deepEqual(customizationFailureKey(Object.assign(Error('x'),{code:'teloa/version-conflict'})),{key:'business.custom.conflict'})
 assert.deepEqual(customizationFailureKey(Object.assign(Error('x'),{code:'teloa/forbidden'})),{key:'business.custom.forbidden'})
 assert.deepEqual(customizationFailureKey(Object.assign(Error('x'),{code:'teloa/source-unavailable',details:{hidden:true}})),{key:'business.custom.readFailed'})
 // 只有带 details.crossReference 的 invalid-input 才是「草案与已有定义对不上」；其余 invalid-input 用通用原因句。原因都截 200 个码点；缺 message 时 reason 为空串。
 const reason='数据源映射的目标字段不在对象类型声明里。'.repeat(20)
 const crossReference={crossReference:true}
 assert.deepEqual(customizationFailureKey(Object.assign(Error(reason),{code:'teloa/invalid-input',details:crossReference})),{key:'business.custom.invalidDraft',params:{reason:reason.slice(0,200)}})
 assert.equal(customizationFailureKey(Object.assign(Error(reason),{code:'teloa/invalid-input',details:crossReference})).params?.reason.length,200)
 assert.deepEqual(customizationFailureKey({code:'teloa/invalid-input',details:crossReference}),{key:'business.custom.invalidDraft',params:{reason:''}})
 assert.deepEqual(customizationFailureKey(Object.assign(Error('业务定制请求缺少有效的预览回执。'),{code:'teloa/invalid-input'})),{key:'business.custom.invalidRequest',params:{reason:'业务定制请求缺少有效的预览回执。'}})
 assert.deepEqual(customizationFailureKey(Object.assign(Error(reason),{code:'teloa/invalid-input',details:{crossReference:'yes'}})),{key:'business.custom.invalidRequest',params:{reason:reason.slice(0,200)}},'标记必须严格为 true')
 // 按码点截断：代理对不被从中间切开。
 const emoji='a'+'😀'.repeat(250)
 const cut=customizationFailureKey(Object.assign(Error(emoji),{code:'teloa/invalid-input'})).params!.reason
 assert.equal(Array.from(cut).length,200)
 assert.equal(cut,'a'+'😀'.repeat(199))
 assert.doesNotMatch(cut,/[\ud800-\udbff](?![\udc00-\udfff])/)
})
