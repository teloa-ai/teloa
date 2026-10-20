import test from 'node:test'
import assert from 'node:assert/strict'
import {readRoleTemplateDefinition} from '../src/roles.ts'

const role={format:'teloa.role/v1',name:' 研究岗 ',kind:'employee',duty:'核对来源',dataScope:'本人提供的资料',executionScope:'只读和代拟'}
const responsibility={triggers:['收到调查任务'],autonomousActions:['核对证据'],confirmationPoints:['扩大资料范围'],escalationRules:['关键证据不足'],deliveryChecks:['保留来源与版本']}
test('旧模板和完整职责共用严格读取，不输出实例授权字段',()=>{
 const legacy=readRoleTemplateDefinition(role)
 assert.equal(legacy.definition.name,'研究岗')
 assert.deepEqual(legacy.definition.responsibility,{triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]})
 assert.deepEqual(readRoleTemplateDefinition({...role,responsibility}).definition.responsibility,responsibility)
 for(const key of ['scopes','skills','knowledge','allowedTools','ownerId']){
  assert.equal(Object.hasOwn(legacy.definition,key),false)
  assert.throws(()=>readRoleTemplateDefinition({...role,[key]:['all']}),{code:'teloa/invalid-input'})
 }
})
test('职责和运行配置不吞非法字段；模板模型不随安装继承',()=>{
 for(const value of [null,'职责',{...responsibility,unknown:[]},{...responsibility,triggers:['x'.repeat(1001)]}])assert.throws(()=>readRoleTemplateDefinition({...role,responsibility:value}),{code:'teloa/invalid-input'})
 const parsed=readRoleTemplateDefinition({...role,runtimeConfig:{agentPresetId:'research',model:{provider:'other-cloud',model:'template-model'}}})
 assert.deepEqual(parsed.definition.runtimeConfig,{agentPresetId:'research'});assert.equal(parsed.ignoredModelSelection,true)
 assert.throws(()=>readRoleTemplateDefinition({...role,runtimeConfig:{agentPresetId:'research',unknown:true}}),{code:'teloa/invalid-input'})
})
