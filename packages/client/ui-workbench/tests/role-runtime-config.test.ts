import assert from 'node:assert/strict'
import test from 'node:test'
import {createRoleRuntimeConfigApi,readRuntimeConfigDirectory, responsibilityGroups, roleFormProgress, runtimeConfigCanSave, runtimeConfigFailed, runtimeConfigLoading, runtimeConfigOptions, runtimeConfigReady, runtimeConfigSummary} from '../src/client/role-runtime-config.ts'

test('rc1 原生目录接纳排序元数据且创造模式不能用作同事配置',()=>{
 const directory=readRuntimeConfigDirectory({presets:[
  {id:'teloa-standard',name:'Teloa 标准模式',order:0,isDefault:false},
  {id:'cordis',order:4,isDefault:true},
 ],modeSelectionEnabled:true})
 assert.equal(directory.items[0]?.label,'Teloa 标准模式')
 assert.equal(runtimeConfigOptions(undefined,directory).find(item=>item.id==='cordis')?.disabled,true)
 assert.equal(runtimeConfigCanSave({initialAgentPresetId:undefined,agentPresetId:'cordis',changed:true,directory}),false)
 assert.match(runtimeConfigSummary(undefined,directory).detail,/创造模式.*Teloa 标准模式/)
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
  presets:[{id:'teloa-standard',isDefault:true,name:'Teloa 标准模式'}],
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
  label:'继承当前默认，未固定',
  detail:'新执行会在创建时核对当前默认运行配置；本人选择创造模式时，员工使用 Teloa 标准模式。当前员工不会自动写回。',
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
 assert.equal(runtimeConfigSummary('standard',failed.directory).label,'运行配置待核对')
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
  {id:'',label:'继承当前默认（不固定）',disabled:false},
  {id:'removed-preset',label:'已保存：removed-preset · 当前不存在',disabled:true},
  {id:'standard',label:'standard · 当前默认',disabled:false},
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
