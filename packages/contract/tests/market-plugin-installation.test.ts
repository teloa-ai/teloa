import test from 'node:test'
import assert from 'node:assert/strict'
import {
  marketPluginPackageRef,
  marketPluginPermissionDescription,
  sameMarketPluginPermissions,
  readMarketPluginInstallObservation,
  readMarketPluginInstallPreview,
  readMarketPluginInstallReceipt,
  readMarketPluginInstallSpec,
  readMarketPluginInstallationState,
} from '../src/market-plugin-installation.ts'

const requestId='bc3e088e-dd97-4f4a-b184-f30d9b6a3e70'
const bundleHash='a'.repeat(64)
const source={registry:'npm' as const,packageName:'@teloa/example-plugin',version:'1.2.3-beta.1+build.7'}
const trust={status:'verified' as const,publisher:'Teloa Labs',integrity:'sha512-QWxhZGRpbjp0ZXN0'}
const permissionSummary={permissions:[{id:'workspace.read',description:'读取当前工作区',required:true}]}
const preview={schema:'teloa.market-plugin-install-preview/v1' as const,source,trust,bundleHash,permissionSummary}

test('插件合同接受固定 npm registry 包和完整精确版本',()=>{
 assert.deepEqual(readMarketPluginInstallPreview(preview),preview)
 assert.deepEqual(readMarketPluginInstallSpec({schema:'teloa.market-plugin-install-spec/v1',requestId,preview}),{schema:'teloa.market-plugin-install-spec/v1',requestId,preview})
 assert.equal(marketPluginPackageRef(source),'@teloa/example-plugin@1.2.3-beta.1+build.7')
 for(const state of ['preparing','installed-active','installed-restart-required','failed','unknown'])assert.equal(readMarketPluginInstallationState(state),state)
})

test('插件合同拒绝 flags、非 registry 来源和非精确版本',()=>{
 const invalidSources=[
  {...source,flags:['--force']},
  {registry:'npm',packageName:'example-plugin',version:'latest'},
  {registry:'npm',packageName:'example-plugin',version:'^1.2.3'},
  {registry:'npm',packageName:'example-plugin',version:'1.2.x'},
  {registry:'npm',packageName:'git+https://example.com/plugin.git',version:'1.2.3'},
  {registry:'npm',packageName:'../plugin',version:'1.2.3'},
  {registry:'npm',packageName:'plugin.tgz',version:'1.2.3'},
  {registry:'git',packageName:'example-plugin',version:'1.2.3'},
 ]
 for(const candidate of invalidSources)assert.throws(()=>readMarketPluginInstallPreview({...preview,source:candidate}))
 assert.throws(()=>readMarketPluginInstallPreview({...preview,unexpected:true}))
 assert.throws(()=>readMarketPluginInstallPreview({...preview,permissionSummary:{permissions:[...permissionSummary.permissions,permissionSummary.permissions[0]]}}))
})

test('副作用回执、原生观察和失败均使用严格判别联合',()=>{
 const failure={code:'install-failed' as const,message:'原生命令失败',retryable:true}
 assert.deepEqual(readMarketPluginInstallReceipt({schema:'teloa.market-plugin-install-receipt/v1',outcome:'failed',failure}),{schema:'teloa.market-plugin-install-receipt/v1',outcome:'failed',failure})
 assert.deepEqual(readMarketPluginInstallReceipt({schema:'teloa.market-plugin-install-receipt/v1',outcome:'succeeded'}),{schema:'teloa.market-plugin-install-receipt/v1',outcome:'succeeded'})
 assert.throws(()=>readMarketPluginInstallReceipt({schema:'teloa.market-plugin-install-receipt/v1',outcome:'succeeded',failure}))
 assert.throws(()=>readMarketPluginInstallReceipt({schema:'teloa.market-plugin-install-receipt/v1',outcome:'unknown'}))
 assert.throws(()=>readMarketPluginInstallReceipt({schema:'teloa.market-plugin-install-receipt/v1',outcome:'failed',failure:{...failure,code:'install-unknown'}}))

 const active={schema:'teloa.market-plugin-install-observation/v1' as const,status:'active' as const,source,bundleHash,permissionSummary}
 assert.deepEqual(readMarketPluginInstallObservation(active),active)
 assert.deepEqual(readMarketPluginInstallObservation({schema:'teloa.market-plugin-install-observation/v1',status:'unknown',failure:{code:'observation-unavailable',message:'暂时无法读取',retryable:true}}),{schema:'teloa.market-plugin-install-observation/v1',status:'unknown',failure:{code:'observation-unavailable',message:'暂时无法读取',retryable:true}})
 assert.throws(()=>readMarketPluginInstallObservation({...active,source:{...source,version:'latest'}}))
 assert.throws(()=>readMarketPluginInstallObservation({schema:'teloa.market-plugin-install-observation/v1',status:'absent'}))
 assert.throws(()=>readMarketPluginInstallObservation({schema:'teloa.market-plugin-install-observation/v1',status:'unknown',failure:{code:'observation-mismatch',message:'身份不一致',retryable:true}}))
})

test('权限说明由 id 决定，比对只看 id 与 required',()=>{
  assert.equal(marketPluginPermissionDescription('dsh.bundle.insert:example-extra'),'该扩展会新增 DSH 组合配置行 example-extra。')
  assert.equal(marketPluginPermissionDescription('dsh.bundle.patch:example-tool'),'该扩展会改动 DSH 组合配置行 example-tool。')
  assert.equal(marketPluginPermissionDescription('dsh.client:web'),'将加载 DSH web 客户端代码。')
  assert.equal(marketPluginPermissionDescription('workspace.read'),undefined)
  const current={permissions:[{id:'dsh.bundle',description:'将加载 DSH 宿主配置层。',required:true},{id:'dsh.bundle.insert:x',description:'该扩展会新增 DSH 组合配置行 x。',required:true}]}
  const legacy={permissions:[...current.permissions].reverse().map(item=>({...item,description:item.description.replace('该扩展','该插件')}))}
  assert.equal(sameMarketPluginPermissions(current,legacy),true)
  assert.equal(sameMarketPluginPermissions(current,{permissions:[current.permissions[0]!,{...current.permissions[1]!,required:false}]}),false)
  assert.equal(sameMarketPluginPermissions(current,{permissions:[current.permissions[0]!,{...current.permissions[1]!,id:'dsh.bundle.insert:y'}]}),false)
  assert.equal(sameMarketPluginPermissions(current,{permissions:[current.permissions[0]!]}),false)
})
