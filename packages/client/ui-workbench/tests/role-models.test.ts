import test from 'node:test'
import assert from 'node:assert/strict'
import type {ModelOptionsDirectory,RoleRuntimeConfig} from '@teloa/contract'
import * as models from '../src/client/role-models.ts'
import * as runtime from '../src/client/role-runtime-config.ts'
import {mount,nodes} from './market-component-harness.ts'
const local={provider:'ollama',model:'small'},remote={provider:'cloud',model:'large'}
const directory:ModelOptionsDirectory={default:remote,groups:[{id:'ollama',name:'Ollama',remote:false,models:[{id:'small',name:'Small'}]},{id:'cloud',name:'Cloud',remote:true,models:[{id:'large',name:'Large',reasoning:{efforts:[{id:'high',name:'High'}]}}]}],failures:[]}

test('已确认缺密钥的路由不能从表单或伪造选择值选入，原配置仍可保留编辑其他字段',()=>{
 const unavailable={...directory,groups:directory.groups.map(group=>({...group,...(group.id==='cloud'?{credentialMissing:true as const}:{})}))}
 assert.equal(models.findRoleModel(unavailable,models.modelOptionValue(remote)),undefined)
 assert.equal(models.roleModelIssue('model',{model:remote},unavailable),'credential')
 assert.equal(models.roleModelsCanSave(undefined,{model:remote},unavailable),false)
 assert.equal(models.roleModelsCanSave({model:remote},{model:remote},unavailable),true)
 assert.deepEqual(models.findRoleModel(unavailable,models.modelOptionValue(local)),local)
})

test('表单显示继承默认的实际模型及缺密钥状态，缺密钥选项禁用而不改写历史选择',()=>{
 const unavailable={...directory,groups:directory.groups.map(group=>({...group,...(group.id==='cloud'?{credentialMissing:true as const}:{})}))},ui=mount('RoleModelFields.tsx',{'./role-models.js':models})
 const tree=ui.render('RoleModelFields',{runtime:undefined,state:{status:'ready',directory:unavailable},change:()=>assert.fail('显示模型状态不能写入选择'),retry:()=>{}}),all=nodes(tree)
 const option=all.find(node=>node.type==='option'&&node.props.value===models.modelOptionValue(remote));assert.ok(option);assert.equal(option.props.disabled,true)
 const inherited=all.find(node=>node.type==='option'&&node.props.value==='');assert.ok(inherited);assert.ok(inherited.children.some((text:unknown)=>typeof text==='string'&&text.includes('Large')),'默认选项应说明实际模型名称')
 assert.ok(all.some(node=>node.props?.role==='alert'),'继承未配置默认模型不能假装可直接执行')
})
test('岗位目录只能选择已公布模型，组合身份不会因分隔符冲突',()=>{
 assert.deepEqual(models.findRoleModel(directory,models.modelOptionValue(local)),local)
 assert.equal(models.findRoleModel(directory,'cloud/large'),undefined)
 assert.notEqual(models.modelOptionValue({provider:'a/b',model:'c'}),models.modelOptionValue({provider:'a',model:'b/c'}))
})
test('失效值可保留编辑其他字段，改模型时必须重新核验且不可默默清除',()=>{
 const saved={agentPresetId:'teloa-standard',model:{provider:'gone',model:'old'}}
 assert.equal(models.roleModelsCanSave(saved,saved,undefined),true)
 assert.equal(models.roleModelsCanSave(saved,{model:local},undefined),false)
 assert.equal(models.roleModelsCanSave(saved,{model:local},directory),true)
 assert.equal(models.roleModelIssue('model',saved,directory),'missing')
 const patched=models.patchRoleModel(saved,'fallbackModel',remote)
 assert.deepEqual(patched,{...saved,fallbackModel:remote});assert.deepEqual(saved.model,{provider:'gone',model:'old'})
 assert.deepEqual(models.patchRoleModel(patched,'model',undefined),{agentPresetId:'teloa-standard'})
 assert.equal(models.patchRoleModel({model:local},'model',undefined),undefined)
})
test('备用须为远程且不同于当前或继承的首选，思考档位来自所选模型',()=>{
 assert.equal(models.roleModelIssue('fallbackModel',{fallbackModel:local},directory),'remote')
 assert.equal(models.roleModelIssue('fallbackModel',{fallbackModel:remote},directory),'same')
 assert.equal(models.roleModelIssue('fallbackModel',{model:local,fallbackModel:remote},directory),undefined)
 assert.equal(models.roleModelIssue('model',{model:{...local,reasoningEffort:'high'}},directory),'effort')
 assert.equal(models.roleModelsCanSave({model:local,fallbackModel:remote},{fallbackModel:remote},directory),false)
 assert.equal(models.roleModelsCanSave(undefined,{model:{...remote,reasoningEffort:'high'}},directory),true)
})
test('表单只选一个模型，所有路由统一展示；失败可重试且不触发写入',()=>{
 const ui=mount('RoleModelFields.tsx',{'./role-models.js':models});const changes:any[]=[];let retried=0
 const render=(state:any={status:'ready',directory},config:RoleRuntimeConfig={model:local})=>ui.render('RoleModelFields',{runtime:config,state,change:(...args:any[])=>changes.push(args),retry:()=>retried++})
 const selectors=nodes(render()).filter(n=>n.type==='select')
 assert.equal(selectors.length,1)
 assert.deepEqual(nodes(selectors[0]).filter(n=>n.type==='optgroup').map(n=>n.props.label),['Ollama','Cloud'])
 selectors[0]!.props.onChange({target:{value:models.modelOptionValue(remote)}})
 assert.deepEqual(changes,[['model',remote]])
 const missing=nodes(render({status:'ready',directory},{model:{provider:'gone',model:'old'}}))
 assert.ok(missing.some(n=>n.type==='option'&&n.props.disabled&&n.props.value===models.modelOptionValue({provider:'gone',model:'old'})))
 assert.ok(missing.some(n=>n.props.role==='alert'&&n.children.includes('roleModels.issue.missing')))
 const failed=nodes(render({status:'error'}));assert.ok(failed.filter(n=>n.type==='select').every(n=>n.props.disabled))
 failed.find(n=>n.type==='button')!.props.onClick();assert.equal(retried,1);assert.equal(changes.length,1)
})
test('模型目录 API 独立于预设名单，读失败不会返回空成功',async()=>{
 const api=runtime.createRoleRuntimeConfigApi(async()=>({presets:[],modeSelectionEnabled:false}),async()=>directory)
 assert.deepEqual(await api.models!(),directory)
 await assert.rejects(runtime.createRoleRuntimeConfigApi(async()=>({}),async()=>({groups:[]})).models!())
})

test('明确改选或恢复默认时清除旧备用；只编辑其他职责不更改原配置',()=>{
 const old={agentPresetId:'preset',model:local,fallbackModel:remote}
 assert.deepEqual(models.patchRoleModel(old,'model',remote),{agentPresetId:'preset',model:remote})
 assert.deepEqual(models.patchRoleModel(old,'model',undefined),{agentPresetId:'preset'})
 assert.deepEqual(old.fallbackModel,remote)
})
