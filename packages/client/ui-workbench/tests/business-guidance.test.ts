import test from 'node:test'
import assert from 'node:assert/strict'
import {businessGuideSteps} from '../src/client/business-guidance.ts'

const messages:Record<string,string>={
 'business.guide.data.empty':'尚未接入数据',
 'business.guide.work.empty':'尚未交办；群协作尚未接入业务空间',
 'business.guide.data.demo':'{count} 条页面内示例对象',
 'business.guide.execution.verified':'{count} 项页面内核验记录；真实执行未接入',
}
const t:Parameters<typeof businessGuideSteps>[1]=(key,params)=>{
 const template=messages[key]??key
 return template.replace(/\{(\w+)\}/g,(value,name)=>params&&Object.hasOwn(params,name)?String(params[name]):value)
}

test('业务空间引导按对象、判断、协作和审批回流呈现当前页面状态，不把演示当作真实接入',()=>{
 const empty=businessGuideSteps({loaded:false,objects:0,runs:0,tasks:0,operations:0,verifiedOperations:0},t)
 assert.deepEqual(empty.map(step=>step.state),['current','upcoming','upcoming','upcoming'])
 assert.equal(empty[0]?.label,'尚未接入数据')
 assert.match(empty[2]?.label??'',/群协作尚未接入/)
 const demonstrated=businessGuideSteps({loaded:true,objects:4,runs:2,tasks:1,operations:2,verifiedOperations:1},t)
 assert.deepEqual(demonstrated.map(step=>step.state),['complete','complete','complete','complete'])
 assert.match(demonstrated[0]?.label??'',/页面内示例/)
 assert.match(demonstrated[3]?.label??'',/真实执行未接入/)
})
