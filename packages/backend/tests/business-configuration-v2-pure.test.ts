import test from 'node:test'
import assert from 'node:assert/strict'
import {prepareBusinessDefinition,prepareBusinessConfigurationDefinition} from '../src/work/business-definition-write.ts'

const scope='business_0123456789abcdef0123456789abcdef'
const state={name:'state',label:'阶段',type:'enum',required:true,from:'原阶段',values:['新建','完成']}
const money={format:'teloa.business-rich-field/v2',name:'amount',label:'金额',type:'money',required:false,from:'原金额',currencies:['CNY']}
const object={format:'teloa.business-object-type/v2',id:'customer',version:'1.0.0',domain:scope,title:'客户',unit:'位',lead:'客户跟进',sourceId:'records',fields:[state,money]}

test('v2 配置叶子由真实正文产生固定哈希，旧独立定义入口仍严格拒收',()=>{
 const result=prepareBusinessConfigurationDefinition(scope,'object-type',object,'teloa.business-configuration/v2')
 assert.equal(result.bodyHash,'8e5fd469af2764411dfe4925b715031a9c27e2007b08dbf5efa539ccf6937d2d')
 assert.match(result.body,/"format":"teloa\.business-object-type\/v2"/)
 assert.match(result.body,/"type":"money"/)
 assert.throws(()=>prepareBusinessDefinition(scope,'object-type',object),{code:'teloa/invalid-input'})
 assert.throws(()=>prepareBusinessConfigurationDefinition(scope,'object-type',{...object,format:'teloa.business-object-type/v1'},'teloa.business-configuration/v2'),{code:'teloa/invalid-input'})
})

test('v1 配置叶子仍保留原正文哈希，未知格式不能回退',()=>{
 const legacy={...object,format:'teloa.business-object-type/v1',id:'ticket',title:'工单',unit:'条',lead:'跟进事项',fields:[{name:'state',label:'状态',type:'text',required:true,from:'状态'}]}
 assert.equal(prepareBusinessConfigurationDefinition(scope,'object-type',legacy,'teloa.business-configuration/v1').bodyHash,'cc71f08bea4221bc1db6b9c29e4b3af9b9be5a5d10c19f003f534cb70200059a')
 assert.throws(()=>prepareBusinessConfigurationDefinition(scope,'object-type',legacy,'teloa.business-configuration/v3'),{code:'teloa/invalid-input'})
})
test('类型化视图只经整体v2保存真实正文，旧独立入口仍拒收',()=>{
 const view={format:'teloa.business-view/v2',id:'amount-total',version:'1.0.0',domain:scope,title:'金额汇总',kind:'board-card',chart:'number',objectType:'customer',measures:[{id:'amount',label:'金额',aggregation:'sum',field:'amount',currency:'CNY'}],filters:[],limit:1}
 const prepared=prepareBusinessConfigurationDefinition(scope,'view',view,'teloa.business-configuration/v2')
 assert.equal(JSON.parse(prepared.body).format,'teloa.business-view/v2')
 assert.equal(JSON.parse(prepared.body).measures[0].currency,'CNY')
 assert.throws(()=>prepareBusinessDefinition(scope,'view',view),{code:'teloa/invalid-input'})
 assert.throws(()=>prepareBusinessConfigurationDefinition(scope,'view',view,'teloa.business-configuration/v1'),{code:'teloa/invalid-input'})
})
