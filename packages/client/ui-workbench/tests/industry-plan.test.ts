import test from 'node:test'
import assert from 'node:assert/strict'
import { industryPlanTemplate, templatePlanFields } from '../src/client/plan-template.ts'
import { changeContinuousWork } from '../src/client/continuous-work.ts'
import { businessScopeNames } from '../src/client/business-directory.ts'
import { readIndustryDirectory } from '../src/client/industry-directory.ts'
import { loadedIndustryPreview } from './industry-load-fixture.ts'
const now='2026-09-11T15:00:00Z'
async function setup(){
 const manifest={format:'teloa.business-package/v2',id:'security',title:'安全运营',version:'1.0.0',domain:'security',description:'调查',resources:[{id:'role',kind:'role',title:'调查岗',version:'1.0.0',required:true,source:{kind:'local',path:'role.json'}},{id:'review',kind:'work-template',title:'告警核对',version:'1.0.0',required:true,source:{kind:'local',path:'work.json'}}],relations:[{kind:'role-work',from:'role',to:'review'}],entrypoints:['review']}
 const role={format:'teloa.role/v1',name:'调查岗',kind:'employee',duty:'调查',dataScope:'获准告警',executionScope:'代拟'}
 const work={format:'teloa.work-template/v1',id:'review',title:'告警核对',version:'1.0.0',domain:'security',description:'核对来源与证据',requirements:['获准告警'],output:'调查报告',skills:[]}
 const files=[['teloa.json',manifest],['role.json',role],['work.json',work]].map(([path,value])=>{const bytes=new TextEncoder().encode(JSON.stringify(value));return {path:path as string,size:bytes.length,read:async()=>bytes}})
 const item=await readIndustryDirectory(files,'teloa.json','安全运营')
 return loadedIndustryPreview(item,{id:'load-soc',scope:'space-east',title:'东区',now})
}
test('行业模板绑定实际空间创建暂停计划，逐次执行保留固定来源',async()=>{
 let state=await setup()
 const template=industryPlanTemplate(state.industryLoads,'load-soc','load-soc:review')
 const fields={...templatePlanFields(template,businessScopeNames(state.business.spaces)),roleId:'load-soc:role',notificationPolicy:'attention' as const}
 state=changeContinuousWork(state,{type:'save',id:'plan-east',fields,template,now})
 assert.equal(state.continuous.plans[0]?.fields.scope,'space-east')
 assert.equal(state.continuous.plans[0]?.enabled,false)
 assert.equal(state.continuous.plans[0]?.template?.industry?.resourceId,'load-soc:review')
 state=changeContinuousWork(state,{type:'enabled',planId:'plan-east',expectedRevision:1,enabled:true,now})
 state=changeContinuousWork(state,{type:'trigger',planId:'plan-east',id:'run-east',occurrenceId:'once',input:'告警批次',now})
 assert.equal(state.continuous.runs[0]?.snapshot.template?.hash,template.hash)
})
test('伪造来源、丢失加载记录或跨空间保存拒绝',async()=>{
 const state=await setup(),template=industryPlanTemplate(state.industryLoads,'load-soc','load-soc:review'),fields={...templatePlanFields(template,businessScopeNames(state.business.spaces)),roleId:'load-soc:role',notificationPolicy:'attention' as const}
 assert.throws(()=>changeContinuousWork(state,{type:'save',id:'p',fields,template:{...template,description:'伪造'},now}),/变化/)
 assert.throws(()=>changeContinuousWork({...state,industryLoads:[]},{type:'save',id:'p',fields,template,now}),/来源|不存在/)
 assert.throws(()=>changeContinuousWork(state,{type:'save',id:'p',fields:{...fields,scope:'general'},template,now}),/业务|空间/)
})
