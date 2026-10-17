import assert from 'node:assert/strict'
import test from 'node:test'
import {createRoleRuntimeConfigApi,readRuntimeConfigDirectory, responsibilityGroups, roleFormProgress, runtimeConfigCanSave, runtimeConfigFailed, runtimeConfigLoading, runtimeConfigOptions, runtimeConfigReady, runtimeConfigSummary} from '../src/client/role-runtime-config.ts'

test('新员工只选择Teloa标准模式，旧员工固定的standard保持兼容且不再作为新选项',()=>{
 const directory=readRuntimeConfigDirectory({presets:[
  {id:'teloa-standard',isDefault:true,name:'标准模式',description:'在 DSH 标准能力上支持通用业务协作，分析资料、使用工具、组织工作并交付可核对的成果。'},
  {id:'standard',isDefault:false,name:'DSH 原生标准模式'},
 ]})
 assert.ok(directory.items.some(row=>row.id==='standard'),'底层目录保留旧身份供兼容核对')
 assert.deepEqual(runtimeConfigOptions(undefined,directory).map(row=>row.id),['','teloa-standard'])
 const saved=runtimeConfigOptions('standard',directory).find(row=>row.id==='standard')!
 assert.equal(saved.disabled,true,'旧值只作已保存状态保留，不能再选给新员工')
 assert.doesNotMatch(saved.label,/DSH/)
 assert.equal(runtimeConfigCanSave({initialAgentPresetId:'standard',agentPresetId:'standard',changed:false,directory}),true)
 assert.equal(runtimeConfigSummary('standard',directory).label,'标准模式')
 assert.doesNotMatch(runtimeConfigSummary('teloa-standard',directory).detail,/DSH/)
 assert.equal(runtimeConfigSummary('teloa-standard',directory,'en').detail,'Analyze information, use tools, and deliver work results.')
 assert.equal(runtimeConfigSummary('standard',directory,'zh-Hant').label,'標準模式')
 assert.equal(runtimeConfigSummary('standard',directory,'en').label,'Standard mode')
 assert.equal(runtimeConfigOptions('standard',directory,'en').find(row=>row.id==='standard')?.label,'Saved: Standard mode')
 assert.equal(runtimeConfigOptions('standard',directory,'zh-Hant').find(row=>row.id==='standard')?.label,'已儲存：標準模式')
})

test('本人改名的standard继续可选；Teloa标准缺失或损坏时不伪装成可用替代',()=>{
 const custom=readRuntimeConfigDirectory({presets:[{id:'teloa-standard',isDefault:true,name:'标准模式'},{id:'standard',isDefault:false,name:'本人的研究配置',description:'本人的 DSH 开发约定'}]})
 assert.equal(runtimeConfigOptions(undefined,custom).find(row=>row.id==='standard')?.label,'本人的研究配置')
 assert.equal(runtimeConfigSummary('standard',custom).detail,'本人的 DSH 开发约定')
 for(const canonical of [[],[{id:'teloa-standard',isDefault:false,name:'标准模式',broken:'组合失败'}]]){
  const directory=readRuntimeConfigDirectory({presets:[...canonical,{id:'standard',isDefault:true,name:'DSH 原生标准模式'}]})
  assert.ok(runtimeConfigOptions(undefined,directory).some(row=>row.id==='standard'))
 }
})

test('DSH 0.2.1-alpha.1 roster 只有 presets，缺失已移除的选择器策略不能导致员工编辑失败',async()=>{
 // 固定版 registry/types AgentPresetRoster 与 remoteExportList 只公开 presets。
 const api=createRoleRuntimeConfigApi(async()=>({presets:[
  {id:'teloa-standard',isDefault:true,name:'标准模式',order:0},
  {id:'unloaded',isDefault:false,broken:'缺少插件'},
  {id:'cordis',isDefault:false},
 ]}))
 const directory=await api.list()
 assert.equal(directory.modeSelectionEnabled,undefined,'已移除的宿主策略保持未知，不伪造 false')
 assert.equal(runtimeConfigCanSave({initialAgentPresetId:'teloa-standard',agentPresetId:'teloa-standard',changed:false,directory}),true)
 assert.equal(directory.items.find(item=>item.id==='unloaded')?.health,'unavailable')
 assert.equal(directory.items.find(item=>item.id==='cordis')?.health,'unavailable')
 assert.throws(()=>readRuntimeConfigDirectory({presets:[{id:'x',isDefault:true}],modeSelectionEnabled:'true'}),/运行配置目录/)
})

test('rc1 原生目录接纳排序元数据且创造模式不能用作同事配置',()=>{
 const directory=readRuntimeConfigDirectory({presets:[
  {id:'teloa-standard',name:'标准模式',order:0,isDefault:false},
  {id:'cordis',order:4,isDefault:true},
 ],modeSelectionEnabled:true})
 assert.equal(directory.items[0]?.label,'标准模式')
 assert.equal(runtimeConfigOptions(undefined,directory).find(item=>item.id==='cordis')?.disabled,true)
 assert.equal(runtimeConfigCanSave({initialAgentPresetId:undefined,agentPresetId:'cordis',changed:true,directory}),false)
 assert.match(runtimeConfigSummary(undefined,directory).detail,/创造模式.*标准模式/)
})

test('运行配置目录保留 DSH 原生 preset 的显示名、默认项与不可用原因',()=>{
 const directory=readRuntimeConfigDirectory({
  presets:[
   {id:'standard',isDefault:true,name:'标准工作',description:'适合一般任务'},
   {id:'investigate',isDefault:false,name:'调查工作',broken:'缺少所需插件'},
  ],modeSelectionEnabled:false,
 })
 assert.equal(directory.status,'ready')
 assert.equal(directory.modeSelectionEnabled,false)
 assert.deepEqual(directory.items.map(item=>({id:item.id,label:item.label,health:item.health,default:item.default,reason:item.reason})),[
  {id:'standard',label:'标准工作',health:'ready',default:true,reason:undefined},
  {id:'investigate',label:'调查工作',health:'unavailable',default:false,reason:'缺少所需插件'},
 ])
})

test('运行配置目录接纳 DSH 0.1.7-rc.1 的会话选择能力字段',()=>{
 const directory=readRuntimeConfigDirectory({
  presets:[{id:'teloa-standard',isDefault:true,name:'标准模式'}],
  modeSelectionEnabled:true,
 })
 assert.equal(directory.modeSelectionEnabled,true)
 assert.equal(directory.items[0]?.id,'teloa-standard')
})

test('运行配置目录仍拒绝未知的宿主字段',()=>{
 assert.throws(()=>readRuntimeConfigDirectory({presets:[],modeSelectionEnabled:false,unexpected:true}),/运行配置目录/)
})

test('旧数字员工未固定运行配置时明确继承当前默认且不写回',()=>{
 const directory=readRuntimeConfigDirectory({presets:[{id:'standard',isDefault:true,name:'标准工作'}],modeSelectionEnabled:true})
 assert.deepEqual(runtimeConfigSummary(undefined,directory),{
  label:'使用默认工作模式',
  detail:'新工作使用当前默认模式；创造模式不可用于员工，将使用标准模式。',
  health:'inherited',
 })
})

test('运行配置目录拒绝损坏的 DSH roster，避免把未知配置伪装为可用',()=>{
 assert.throws(()=>readRuntimeConfigDirectory({presets:[{id:'standard',isDefault:'yes'}],modeSelectionEnabled:true}),/运行配置目录/)
})
test('运行配置 preset id 严格遵循 DSH 目录身份格式',()=>{
 for(const id of ['-standard','Standard','a'.repeat(121)])assert.throws(()=>readRuntimeConfigDirectory({presets:[{id,isDefault:true}],modeSelectionEnabled:true}),/运行配置目录/)
})
test('运行配置刷新会先清空旧目录；失败后旧固定 id 只能待核验',()=>{
 const ready=runtimeConfigReady(readRuntimeConfigDirectory({presets:[{id:'standard',isDefault:true,name:'标准'}],modeSelectionEnabled:true}))
 assert.equal(ready.directory?.items[0]?.id,'standard')
 const loading=runtimeConfigLoading()
 assert.equal(loading.directory,undefined)
 const failed=runtimeConfigFailed(Error('连接断开'))
 assert.equal(failed.directory,undefined)
 assert.doesNotMatch(runtimeConfigFailed(Error('DSH RPC private/diagnostic'), 'en').error??'',/DSH|RPC|private|diagnostic/)
 assert.match(runtimeConfigFailed(Error('连接断开'),'zh-Hant').error??'',/請重試/)
 assert.equal(runtimeConfigSummary('standard',failed.directory).label,'工作模式待核对')
})

test('五组职责按用户能理解的工作问题呈现，不混入资料与权限范围',()=>{
 assert.deepEqual(responsibilityGroups({
  triggers:['新告警进入队列'],autonomousActions:['关联证据'],confirmationPoints:['提交处置前'],escalationRules:['证据冲突时'],deliveryChecks:['结论附来源'],
 }),[
  {key:'triggers',labelKey:'team.form.responsibility.triggers',items:['新告警进入队列']},
  {key:'autonomousActions',labelKey:'team.form.responsibility.autonomousActions',items:['关联证据']},
  {key:'confirmationPoints',labelKey:'team.form.responsibility.confirmationPoints',items:['提交处置前']},
  {key:'escalationRules',labelKey:'team.form.responsibility.escalationRules',items:['证据冲突时']},
  {key:'deliveryChecks',labelKey:'team.form.responsibility.deliveryChecks',items:['结论附来源']},
 ])
})
test('五组职责的标签是词典键而非中文字面量，确保外语用户也能看到对应语言',()=>{
 for(const group of responsibilityGroups({triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]}))
  assert.doesNotMatch(group.labelKey,/[一-龥]/)
})

test('运行配置通过 DSH 原生 roster 读取，不经过 Teloa 业务接口复制名单',async()=>{
 const api=createRoleRuntimeConfigApi(async()=>({presets:[{id:'standard',isDefault:true,name:'标准模式'}],modeSelectionEnabled:true}))
 assert.equal((await api.list()).items[0]?.label,'标准模式')
})

test('已保存但从 DSH 目录消失的运行配置保留为明确的禁用选项',()=>{
 const directory=readRuntimeConfigDirectory({modeSelectionEnabled:true,presets:[{id:'standard',isDefault:true}]})
 assert.deepEqual(runtimeConfigOptions('removed-preset',directory),[
  {id:'',label:'使用当前默认',disabled:false},
  {id:'removed-preset',label:'已保存的工作模式 · 当前不可用',disabled:true},
  {id:'standard',label:'标准模式 · 当前默认',disabled:false},
 ])
})

test('保存前必须核对固定 preset，编辑时只有明确切到继承才可清除失效值',()=>{
 const directory=readRuntimeConfigDirectory({modeSelectionEnabled:true,presets:[
  {id:'standard',isDefault:true},
  {id:'broken',isDefault:false,broken:'缺少插件'},
 ]})
 assert.equal(runtimeConfigCanSave({initialAgentPresetId:undefined,agentPresetId:undefined,changed:false,directory}),true)
 assert.equal(runtimeConfigCanSave({initialAgentPresetId:'removed',agentPresetId:'removed',changed:false,directory}),false)
 assert.equal(runtimeConfigCanSave({initialAgentPresetId:'broken',agentPresetId:'broken',changed:false,directory}),false)
 assert.equal(runtimeConfigCanSave({initialAgentPresetId:'removed',agentPresetId:undefined,changed:false,directory}),false)
 assert.equal(runtimeConfigCanSave({initialAgentPresetId:'removed',agentPresetId:undefined,changed:true,directory}),true)
 assert.equal(runtimeConfigCanSave({initialAgentPresetId:'removed',agentPresetId:'standard',changed:true,directory}),true)
})

test('五步导航与底部操作共用同一运行配置闸',()=>{
 const blocked=roleFormProgress({step:3,identityReady:true,scopeReady:true,runtimeReady:false})
 assert.equal(blocked.canContinue,false)
 assert.equal(blocked.canOpenStep(4),false)
 assert.equal(blocked.canOpenStep(2),true)
 const ready=roleFormProgress({step:3,identityReady:true,scopeReady:true,runtimeReady:true})
 assert.equal(ready.canContinue,true)
 assert.equal(ready.canOpenStep(4),true)
})

test('同事选模候选只来自 DSH preset roster；市场 local-specialist 模型条目的形状进不了目录',()=>{
 // 本地垂类模型（语音、嵌入）以 kind:'model' + form:'local-specialist' 出现在市场，不是 preset；roster 行不认这些键。
 for(const stray of [
  {id:'sensevoice-local',isDefault:false,kind:'model',form:'local-specialist'},
  {id:'qwen3-embedding-0-6b',isDefault:false,form:'local-specialist',usage:['embedding']},
 ])assert.throws(()=>readRuntimeConfigDirectory({presets:[{id:'standard',isDefault:true},stray],modeSelectionEnabled:true}),/运行配置目录/)
})

test('工作模式选择器与摘要用产品名显示未命名的内置模式，不露出 ptc/minimal/cordis 原始 ID；ID、默认与不可用状态保持',()=>{
 const directory=readRuntimeConfigDirectory({presets:[
  {id:'teloa-standard',name:'标准模式',isDefault:false},
  {id:'ptc',isDefault:false},
  {id:'minimal',isDefault:false},
  {id:'cordis',isDefault:true},
 ]})
 const labels=(locale:string)=>runtimeConfigOptions(undefined,directory,locale).filter(row=>row.id).map(row=>[row.id,row.label,row.disabled])
 assert.deepEqual(labels('zh-Hans'),[['teloa-standard','标准模式',false],['ptc','PTC 模式',false],['minimal','极简模式',false],['cordis','创造模式 · 当前默认 · 不可用',true]])
 assert.deepEqual(labels('zh-Hant'),[['teloa-standard','標準模式',false],['ptc','PTC 模式',false],['minimal','極簡模式',false],['cordis','創造模式 · 目前預設 · 無法使用',true]])
 assert.deepEqual(labels('en'),[['teloa-standard','Standard mode',false],['ptc','PTC mode',false],['minimal','Minimal mode',false],['cordis','Creator mode · Current default · Unavailable',true]])
 assert.equal(runtimeConfigSummary('ptc',directory).label,'PTC 模式')
 assert.equal(runtimeConfigSummary('minimal',directory,'en').label,'Minimal mode')
 const creator=runtimeConfigSummary('cordis',directory,'zh-Hant')
 assert.equal(creator.label,'創造模式');assert.equal(creator.health,'unavailable')
 assert.equal(runtimeConfigCanSave({initialAgentPresetId:undefined,agentPresetId:'cordis',changed:true,directory}),false,'创造模式仍不能用于员工')
 assert.deepEqual(directory.items.map(item=>item.label),['标准模式','ptc','minimal','cordis'],'目录原值不改，命名只在展示层')
})

test('本人命名或改名的模式原样显示，不翻译也不覆盖；未知且无名称的模式才显示 ID',()=>{
 const directory=readRuntimeConfigDirectory({presets:[
  {id:'ptc',name:'我的批处理',isDefault:false},
  {id:'my-copy',name:'minimal',isDefault:false},
  {id:'research',isDefault:true},
 ]})
 for(const locale of ['zh-Hans','zh-Hant','en']){
  assert.deepEqual(runtimeConfigOptions(undefined,directory,locale).filter(row=>row.id).map(row=>row.label.split(' · ')[0]),['我的批处理','minimal','research'],locale)
  assert.equal(runtimeConfigSummary('ptc',directory,locale).label,'我的批处理')
 }
})
