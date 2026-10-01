import test from 'node:test'
import assert from 'node:assert/strict'
import {readdir,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createBusinessShareSource} from '../src/client/business-share-source.ts'
import {readIndustryDirectory} from '../src/client/industry-directory.ts'

const fixture=fileURLToPath(new URL('../../../../tests/fixtures/业务定制层/SOC/',import.meta.url))
const contentId='11111111-1111-4111-8111-111111111111'

async function files(directory:string,prefix=''):Promise<{path:string;size:number;read:()=>Promise<Uint8Array>}[]>{
 const entries=await readdir(directory,{withFileTypes:true})
 return (await Promise.all(entries.map(async entry=>{
  const path=join(directory,entry.name),relative=prefix?prefix+'/'+entry.name:entry.name
  return entry.isDirectory()?files(path,relative):{path:relative,size:(await readFile(path)).byteLength,read:async()=>new Uint8Array(await readFile(path))}
 }))).flat()
}

async function sourceWithLocalOverride(){
 const item=await readIndustryDirectory(await files(fixture),'teloa.json','SOC fixture')
 assert.equal(item.manifest?.format,'teloa.business-package/v2')
 const manifest=item.manifest
 const alert=JSON.parse(await readFile(join(fixture,'object-types/alert-ticket.json'),'utf8')) as Record<string,unknown>
 // 契约钉住 `localized.title.original` 必须与 `title` 逐字相等，本地覆盖改标题时把 original 与 zh-CN 值一并同步。
 const alertLocalized=alert.localized as {title:{original:string;defaultLocale:string;locales:Record<string,string>}}
 const local={...alert,title:'本地告警工单',localized:{...alertLocalized,title:{...alertLocalized.title,original:'本地告警工单',locales:{...alertLocalized.title.locales,'zh-CN':'本地告警工单'}}}}
 const loads=[{status:'active',domain:'SOC',scope:'SOC',space:{scope:'SOC'},contentId,items:manifest.resources.map(resource=>({kind:resource.kind,localId:resource.id,status:resource.kind==='work-template'?'pending-adapter':resource.kind==='execution-tool'?'active':'instantiated'}))}]
 return createBusinessShareSource({
  customization:{directory:async()=>({drafts:[{id:'local-alert',status:'applied',kind:'object-type',localId:'alert-ticket',body:JSON.stringify(local)}],entries:[{kind:'object-type',localId:'alert-ticket',current:{draftId:'local-alert'}}]})} as never,
  market:{list:async()=>[{...item,contentStorage:{contentId,createdAt:'2026-09-17T00:00:00.000Z',loaded:true}}],hydrate:async()=>item} as never,
  loads:()=>loads as never,
 })
}

test('分享源只从已加载固定内容读取声明，并用当前本地版本覆盖同标识模板',async()=>{
 const source=await sourceWithLocalOverride(),value=await source.read('SOC')
 const alert=value.objectTypes.find(row=>row.localId==='alert-ticket')
 assert.ok(alert)
 assert.equal((alert.body as {title:unknown}).title,'本地告警工单')
 assert.equal(value.views.length,6)
 assert.deepEqual(value.views.filter(row=>(row.body as {kind?:unknown}).kind==='list').map(row=>row.localId).sort(),['soc-alert-list','soc-asset-list','soc-incident-list'])
 assert.equal(value.actions.length,2)
 assert.deepEqual(value.sources,[{sourceId:'security-alert-http',sourceNoun:'告警源'}])
 assert.deepEqual(value.available,{workTemplates:[],executionTools:['soc-endpoint-isolation']},'任务模板正文不随声明包发布，动作必须在生成阶段排除')
})
