import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {existsSync,readFileSync} from 'node:fs'

const resources=new URL('../src/brand/resources/',import.meta.url)
const assets=readFileSync(new URL('../src/client/resource-icon-assets.ts',import.meta.url),'utf8')
const sources=JSON.parse(readFileSync(new URL('app-icons-sources.json',resources),'utf8')) as {path:string;source:string;license:string;licenseFile?:string;sha256:string;sourceSha256:string}[]
const sha=(file:string)=>createHash('sha256').update(readFileSync(new URL(file,resources))).digest('hex')
const brandFile=(key:string)=>{
 const variable=new RegExp(`'${key}':(\\w+)`).exec(/export const resourceBrands=\{([^}]*)\}/.exec(assets)![1]!)![1]
 return new RegExp(`import ${variable} from '\\.\\./brand/resources/([\\w.-]+)'`).exec(assets)![1]!
}

test('原插件图标逐个记录来源、固定提交与许可；文件字节与记录摘要一致',()=>{
 for(const record of sources){
  assert.ok(existsSync(new URL(record.path,resources)),record.path)
  assert.equal(sha(record.path),record.sha256,record.path+' 与采用摘要一致')
  if(!record.licenseFile)continue
  assert.equal(record.sourceSha256,record.sha256,record.path+' 原样采用')
  assert.match(record.source,/^https:\/\/raw\.githubusercontent\.com\/[\w.-]+\/[\w.-]+\/[0-9a-f]{40}\//,record.path+' 指向固定提交')
  assert.match(readFileSync(new URL(record.licenseFile,resources),'utf8'),/^MIT License/,record.licenseFile)
 }
})

test('已有品牌改用原插件素材，品牌键不变，不为尚无入口的服务预置图标',()=>{
 const original:Record<string,string>={github:'cursor-github.svg',gmail:'cursor-gmail.svg','google-drive':'cursor-google-drive.svg','google-sheets':'cursor-google-sheets.svg','google-slides':'cursor-google-slides.svg',hubspot:'cursor-hubspot.png',posthog:'cursor-posthog-mcp.png',todoist:'cursor-todoist.png',trello:'cursor-trello.png',sentry:'sentry-plugin-cursor.svg',remotion:'remotion.svg',pstack:'pstack.png'}
 for(const [key,file] of Object.entries(original)){
  assert.equal(brandFile(key),file,key)
  assert.ok(sources.some(record=>record.path===file),file+' 有来源记录')
 }
 assert.ok(!/export const connectorBrands/.test(assets),'不另建预置品牌表')
 assert.ok(!sources.some(record=>/cursor-(teams|zoom|outlook|x)\./.test(record.path)),'无入口服务的原图只留在私有对照表')
})
