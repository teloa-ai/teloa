import test from 'node:test'
import assert from 'node:assert/strict'
import {pageCreateBusinessDomainIndustryItem,pageCreateConnectorIndustryItem} from '../src/client/page-create-industry-content.ts'

const connector={
 manifest:{format:'teloa.business-package/v2',id:'soc-alert-source',title:'SOC alert source',version:'1.0.0',domain:'SOC',description:'Alert source for review',resources:[{id:'alert-source',kind:'data-source',title:'Alert source',version:'1.0.0',required:true,source:{kind:'local',path:'resources/alert-source.json'}}],relations:[],entrypoints:[]},
 resource:{format:'teloa.data-source/v1',sourceId:'alert-source',scopes:['SOC']},
}

const business={
 manifest:{format:'teloa.business-package/v2',id:'soc-alerts',title:'SOC alerts',version:'1.0.0',domain:'SOC',description:'SOC alert ledger',resources:[
  {id:'alert-source',kind:'data-source',title:'Alert source',version:'1.0.0',required:true,source:{kind:'local',path:'resources/alert-source.json'}},
  {id:'alert',kind:'object-type',title:'Alert',version:'1.0.0',required:true,source:{kind:'local',path:'resources/alert.json'}},
 ],relations:[],entrypoints:[]},
 definitions:[{format:'teloa.business-object-type/v1',id:'alert',version:'1.0.0',domain:'SOC',title:'Alert',unit:'items',lead:'Review incoming alerts',sourceId:'alert-source',fields:[{name:'title',label:'Title',type:'text',required:true,from:'title'}]}],
}

test('会话连接器草案固定为可导入的最小行业包',async()=>{
 const item=await pageCreateConnectorIndustryItem(connector,'Created from conversation','SOC')
 assert.equal(item.manifest?.format,'teloa.business-package/v2')
 assert.equal(item.packageContent?.files.length,2)
 assert.equal(item.manifest?.resources[0]?.id,'alert-source')
})

test('会话新业务草案补齐对象声明引用的数据源定义',async()=>{
 const item=await pageCreateBusinessDomainIndustryItem(business,'Created business','SOC')
 assert.equal(item.packageContent?.files.length,3)
 const source=item.packageContent?.files.find(file=>file.path==='resources/alert-source.json')
 assert.deepEqual(JSON.parse(new TextDecoder().decode(source?.bytes)),{format:'teloa.data-source/v1',sourceId:'alert-source',scopes:['SOC']})
})

test('会话连接器不能在一次确认中夹带额外资源',async()=>{
 const invalid=structuredClone(connector)
 invalid.manifest.resources.push({id:'another',kind:'mcp',title:'Another',version:'1.0.0',required:false,source:{kind:'local',path:'resources/another.json'}})
 await assert.rejects(pageCreateConnectorIndustryItem(invalid,'Created from conversation','SOC'))
})
