import assert from 'node:assert/strict'
import {readFile,readdir} from 'node:fs/promises'
import test from 'node:test'
import {
 readBusinessActionDefinition,readBusinessObjectTypeDefinition,readBusinessViewDefinition,
 type LocalizedMetadata,
} from '@teloa/contract'
import {
 localizedBusinessActionTitle,localizedBusinessFieldLabel,localizedBusinessFieldValue,
 localizedBusinessMeasureLabel,localizedBusinessObjectType,localizedBusinessViewTitle,
} from '../src/client/business-definition-localization.ts'
import {resolveMarketLocalizedMetadata} from '../src/client/market-locale-metadata.ts'
import {validateManifest,type WorkTemplateLocalizedMetadata} from '../src/client/market-preview.ts'

const root=new URL('../../../../tests/fixtures/业务定制层/',import.meta.url)
const han=/[\u3400-\u9fff]/u

async function definitions(domain:'SOC'|'AppSec',folder:'object-types'|'views'|'actions'|'workflows'){
 const directory=new URL(domain+'/'+folder+'/',root)
 return Promise.all((await readdir(directory)).sort().map(async name=>JSON.parse(await readFile(new URL(name,directory),'utf8')) as unknown))
}

function english(metadata:LocalizedMetadata|undefined,original:string):string{
 return resolveMarketLocalizedMetadata(metadata??{original,defaultLocale:'und',locales:{}},'en').value
}

test('SOC 与 AppSec 正式业务定义的英文可见文案完整，不回退到中文稳定值',async()=>{
 for(const domain of ['SOC','AppSec'] as const){
  for(const input of await definitions(domain,'object-types')){
   const definition=readBusinessObjectTypeDefinition(input),copy=localizedBusinessObjectType(definition,'en')
   for(const value of [copy.title,copy.unit,copy.lead])assert.doesNotMatch(value,han,domain+' '+definition.id)
   for(const field of definition.fields){
    assert.doesNotMatch(localizedBusinessFieldLabel(field,'en'),han,domain+' '+definition.id+' '+field.name)
    for(const value of field.values??[])assert.doesNotMatch(localizedBusinessFieldValue(field,value,'en'),han,domain+' '+definition.id+' '+field.name+' '+value)
   }
  }
  for(const input of await definitions(domain,'views')){
   const definition=readBusinessViewDefinition(input)
   assert.doesNotMatch(localizedBusinessViewTitle(definition,'en'),han,domain+' '+definition.id)
   for(const measure of definition.measures)assert.doesNotMatch(localizedBusinessMeasureLabel(measure,'en'),han,domain+' '+definition.id+' '+measure.id)
  }
  for(const input of await definitions(domain,'actions')){
   const definition=readBusinessActionDefinition(input)
   assert.doesNotMatch(localizedBusinessActionTitle(definition,'en'),han,domain+' '+definition.id)
  }
  for(const input of await definitions(domain,'workflows')){
   const definition=validateManifest(input)
   assert.equal(definition.format,'teloa.work-template/v1')
   const localized=definition.localized as WorkTemplateLocalizedMetadata|undefined
   const visible=[english(localized?.title,definition.title),english(localized?.description,definition.description),...definition.requirements.map((value,index)=>english(localized?.requirements?.[index],value)),english(localized?.output,definition.output)]
   for(const value of visible)assert.doesNotMatch(value,han,domain+' '+definition.id)
  }
 }
})

test('没有元数据时保留稳定原文，枚举未知值也不被猜译',()=>{
 const definition=readBusinessObjectTypeDefinition({format:'teloa.business-object-type/v1',id:'ticket',version:'1.0.0',domain:'SOC',title:'工单',unit:'条',lead:'业务说明',sourceId:'source',fields:[{name:'state',label:'状态',type:'enum',required:true,from:'状态',values:['新建','完成']}]})
 assert.deepEqual(localizedBusinessObjectType(definition,'en'),{title:'工单',unit:'条',lead:'业务说明'})
 assert.equal(localizedBusinessFieldValue(definition.fields[0]!,'第三方新增状态','en'),'第三方新增状态')
})
