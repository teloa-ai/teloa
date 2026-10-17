import test from 'node:test'
import assert from 'node:assert/strict'
import {createBusinessShareApi} from '../src/client/business-share-flow.ts'
import type {MarketContentApi} from '../src/client/market-content-api.ts'
import type {BusinessShareInput} from '../src/client/business-share-package.ts'
const token='gh'+'p_'+'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2'
const base:BusinessShareInput={scope:'sales',packageId:'sales-method',packageVersion:'1.0.0',title:'销售方法',description:'分享核实方法',objectTypes:[{localId:'customer',version:'1.0.0',body:{format:'teloa.business-object-type/v1',id:'customer',version:'1.0.0',domain:'sales',title:'客户',unit:'条',lead:'客户',sourceId:'crm',fields:[{name:'note',label:'备注',from:'备注',type:'text',required:false}]}}],views:[],actions:[],sources:[{sourceId:'crm',sourceNoun:'本人客户来源'}],available:{workTemplates:[],executionTools:[]}}
const fixture=()=>{let imported=0;const api=createBusinessShareApi({read:async()=>base} as never,{importIndustry:async item=>{imported++;return item}} as MarketContentApi);return {api,count:()=>imported}}
test('出包预览检查实际内容，命中后下载和固定安装均拒绝，伪造空报告无效',async()=>{
 const {api,count}=fixture(),plan=await api.plan({...base,description:token})
 assert.ok(plan.inspection.findings.length>0)
 await assert.rejects(api.download(plan.item,{...plan.inspection,findings:[]}.digest,token))
 await assert.rejects(api.fix(plan.item,plan.inspection.digest,token));assert.equal(count(),0)
})
test('下载与固定安装重新读字节和用途；正文被改或purpose变化须重新预览',async()=>{
 const {api,count}=fixture(),plan=await api.plan(base)
 const archive=await api.download(plan.item,plan.inspection.digest,base.description);assert.ok(archive.bytes.length>0)
 await api.fix(plan.item,plan.inspection.digest,base.description);assert.equal(count(),1)
 await assert.rejects(api.download(plan.item,plan.inspection.digest,'另一用途'))
 plan.item.packageContent!.files[0]!.bytes[0]=32
 await assert.rejects(api.fix(plan.item,plan.inspection.digest,base.description));assert.equal(count(),1)
})
