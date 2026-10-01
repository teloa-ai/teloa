import test from 'node:test'
import assert from 'node:assert/strict'
import { bindingFormKey, editBindingForm, rebaseBindingForm, clearBindingForm, capabilityFailures } from '../src/client/capability-work.ts'
import type { CapabilityBinding } from '../src/client/capability-preview.ts'
const now = '2026-09-11T04:00:00Z'
const binding = (): CapabilityBinding => ({id:'binding-a',revision:4,title:'资料连接',source:{itemId:'mcp',itemVersion:'1',intentId:'intent',intentVersion:1},target:{kind:'business',id:'general',scope:'general',title:'通用工作',version:1},versions:[1,2,3].map(version=>({version,fields:{runtimeRef:'reference',usage:'read',dataScope:'范围 '+version,executionScope:'仅查询'},createdAt:now})),activeVersion:2,disabled:false,removed:false,history:[]})

test('未保存表单按绑定和版本隔离，恢复或清理一个版本不影响另一份草稿',()=>{
  const a=binding(),b={...binding(),id:'binding-b'}
  let forms=editBindingForm({},a,2,{fields:{...a.versions[1]!.fields,dataScope:'未保存 A2'},note:'核验草稿'})
  forms=editBindingForm(forms,a,3,{note:'A3 说明'})
  forms=editBindingForm(forms,b,2,{note:'B2 说明'})
  assert.equal(forms[bindingFormKey(a.id,2)]?.fields.dataScope,'未保存 A2')
  assert.equal(forms[bindingFormKey(a.id,3)]?.note,'A3 说明')
  forms=clearBindingForm(forms,a.id,3)
  assert.equal(forms[bindingFormKey(a.id,2)]?.note,'核验草稿')
  assert.equal(forms[bindingFormKey(b.id,2)]?.note,'B2 说明')
  assert.equal(a.versions[1]?.fields.dataScope,'范围 2')
})

test('后续修订不静默推进草稿基线，只有明确复核后才使用当前修订',()=>{
  const a=binding(),updated={...a,revision:7}
  let forms=editBindingForm({},a,2,{note:'旧草稿'})
  forms=editBindingForm(forms,updated,2,{note:'继续填写'})
  assert.equal(forms[bindingFormKey(a.id,2)]?.baseRevision,4)
  forms=rebaseBindingForm(forms,updated,2)
  assert.equal(forms[bindingFormKey(a.id,2)]?.baseRevision,7)
  assert.equal(forms[bindingFormKey(a.id,2)]?.note,'继续填写')
  assert.throws(()=>editBindingForm(forms,a,99,{note:'错误版本'}),/版本/)
  assert.throws(()=>editBindingForm(forms,{...a,removed:true},2,{note:'已解除'}),/解除/)
})

test('配置异常只投影当前待处理版本，定位原绑定和版本而不造任务',()=>{
  const a=binding()
  a.versions[1]!.check={result:'failed',note:'当前连接不可用',at:now}
  a.versions[2]!.check={result:'failed',note:'候选范围无权读取',at:now}
  const rows=capabilityFailures({bindings:[a]})
  assert.deepEqual(rows.map(row=>[row.bindingId,row.version,row.active]).sort((a,b)=>Number(a[1])-Number(b[1])),[['binding-a',2,true],['binding-a',3,false]])
  assert.equal(new Set(rows.map(row=>row.id)).size,2)
  a.versions[2]!.check={result:'passed',note:'已重新核验',at:now}
  assert.deepEqual(capabilityFailures({bindings:[a]}).map(row=>row.version),[2])
  a.activeVersion=3
  assert.equal(capabilityFailures({bindings:[a]}).length,0)
  a.versions[2]!.check={result:'failed',note:'再次失败',at:now}
  assert.equal(capabilityFailures({bindings:[a]}).length,1)
  assert.equal(capabilityFailures({bindings:[{...a,removed:true}]}).length,0)
})
