import test from 'node:test'
import assert from 'node:assert/strict'
import { createIndustryTask } from '../src/client/industry-task.ts'
import { loadedIndustryPreview } from './industry-load-fixture.ts'
import { readIndustryDirectory } from '../src/client/industry-directory.ts'
const now='2026-09-11T14:00:00Z'
async function setup(){
 const work={format:'teloa.work-template/v1',id:'review',title:'资料核对',version:'1.0.0',domain:'general',description:'逐条核对来源',requirements:['资料位置','核对范围'],output:'核对报告',skills:[]}
 const manifest={format:'teloa.business-package/v2',id:'demo',title:'研究',version:'1.0.0',domain:'general',description:'研究',resources:[{id:'work',kind:'work-template',title:'资料核对',version:'1.0.0',required:true,source:{kind:'local',path:'work.json'}}],relations:[],entrypoints:['work']}
 const files=[['teloa.json',JSON.stringify(manifest)],['work.json',JSON.stringify(work)]].map(([path,text])=>{const bytes=new TextEncoder().encode(text);return {path:path!,size:bytes.length,read:async()=>bytes}})
 const item=await readIndustryDirectory(files,'teloa.json','研究')
 return loadedIndustryPreview(item,{id:'load-demo',scope:'space-demo',title:'研究空间',now})
}
test('从行业常用工作创建任务，固定方法、输入、交付及空间身份',async()=>{
 const state=await setup(),next=createIndustryTask(state,{id:'task-demo',loadId:'load-demo',resourceId:'load-demo:work',goal:'核对本周资料',inputs:['本周文档','来源和日期'],now})
 assert.equal(next.tasks[0]?.scope,'space-demo')
 assert.deepEqual(next.tasks[0]?.industrySource?.inputs,['本周文档','来源和日期'])
 assert.equal(next.tasks[0]?.industrySource?.method,'逐条核对来源')
 assert.equal(next.tasks[0]?.execution,'not_started')
 assert.equal(state.tasks.length,0)
})
test('缺少输入、错误入口或重复任务身份拒绝，不改变原任务',async()=>{
 const state=await setup(),command={id:'task-demo',loadId:'load-demo',resourceId:'load-demo:work',goal:'核对资料',inputs:['文档','日期'],now}
 assert.throws(()=>createIndustryTask(state,{...command,inputs:['文档']}),/输入/)
 assert.throws(()=>createIndustryTask(state,{...command,resourceId:'unknown'}),/入口/)
 const next=createIndustryTask(state,command)
 assert.throws(()=>createIndustryTask(next,command),/冲突/)
})
