import assert from 'node:assert/strict'
import test from 'node:test'
import {roleConfigurationRelations} from '../src/client/role-configuration-relations.ts'
import type {BusinessScope} from '../src/client/business-directory.ts'

const role={id:'investigator',name:'调查岗',kind:'employee' as const,scopes:['SOC'] as BusinessScope[],state:'paused' as const,version:2,duty:'核验证据并提交建议',dataScope:'SOC 资料',executionScope:'只读与代拟',skills:['证据核验'],knowledge:['soc-handbook'],memories:[],history:[],runtimeConfig:{agentPresetId:'standard'}}
const {runtimeConfig:ignoredRuntimeConfig,...roleWithoutRuntimeConfig}=role
const state={tasks:[{id:'saved-task',storage:'persistent' as const,assigneeId:'investigator',authorId:'self',assigneeHistory:['investigator']}],continuous:{plans:[{fields:{roleId:'investigator'},enabled:true,archived:false}],loaded:true},approvals:[{taskId:'saved-task',status:'pending'}]}
const t=(key:string,params?:Readonly<Record<string,string|number>>)=>key+(params?' '+JSON.stringify(params):'')

test('配置总览按五类真实关系汇总当前岗位，而不把声明冒充可用',()=>{
 const rows=roleConfigurationRelations({role,scopeLabel:'安全运营',state,collaboration:{groups:[{memberIds:['investigator']}]} ,capabilities:{bindings:[{target:{kind:'role',id:'investigator'},activeVersion:1,disabled:false,removed:false}]},runtimeLabel:'标准模式',t})
 assert.deepEqual(rows.map(row=>row.label),['roleRelation.label.scope','roleRelation.label.knowledge','roleRelation.label.capabilities','roleRelation.label.work','roleRelation.label.authorization'])
 assert.match(rows[0]!.detail,/"scope":"安全运营"/)
 assert.match(rows[1]!.detail,/"count":1/)
 assert.match(rows[2]!.detail,/roleRelation\.bindings .*"active":1/)
 assert.match(rows[3]!.detail,/roleRelation\.tasks .*"saved":1/)
 assert.match(rows[4]!.detail,/roleRelation\.approvals .*"pending":1/)
 assert.doesNotMatch(rows[2]!.detail,/已经可用|真实已连接/)
})

test('缺少关系数据时明确待核对或无记录',()=>{
 const rows=roleConfigurationRelations({role:{...roleWithoutRuntimeConfig,knowledge:[],skills:[]},scopeLabel:'安全运营',state:{tasks:[],continuous:{plans:[],loaded:false},approvals:[]},collaboration:{groups:[]},runtimeLabel:'运行配置待核对',t})
 assert.match(rows[1]!.detail,/roleRelation\.knowledgeNone/)
 assert.match(rows[2]!.detail,/roleRelation\.bindingsPending/)
 assert.match(rows[3]!.detail,/roleRelation\.notLoaded/)
 assert.match(rows[4]!.detail,/roleRelation\.approvalsNone/)
})
