import test from 'node:test'
import assert from 'node:assert/strict'
import {createRoleToolGrantApi} from '../src/client/role-tool-grant-api.ts'
const roleId='c1234567-1234-4123-8123-123456789abc',rules=[{name:'read',allowed:[{id:'one',version:'v1'}]}]
const command={roleId,expectedRoleVersion:1,action:'save' as const,rules}
const receipt={roleId,roleVersion:2,state:'active',rules,createdAt:'2026-09-11T00:00:00Z'}
test('保存回包丢失后跨实例保留原请求，匹配回执后清理',async()=>{
 let raw:string|null=null;const journal={read:()=>raw,write:(v:string)=>{raw=v},clear:()=>{raw=null}},sent:unknown[]=[]
 const first=createRoleToolGrantApi(async(_endpoint,payload)=>{sent.push(payload);throw Error('lost')},journal)
 await assert.rejects(first.change(command),/lost/);assert.ok(raw)
 const second=createRoleToolGrantApi(async(_endpoint,payload)=>{sent.push(payload);return receipt},journal)
 await second.recover();assert.deepEqual(sent,[command,command]);assert.equal(raw,null)
})
test('不一致回执保留请求，明确拒绝清除请求，损坏恢复阻止新授权',async()=>{
 let raw:string|null=null;const journal={read:()=>raw,write:(v:string)=>{raw=v},clear:()=>{raw=null}}
 const api=createRoleToolGrantApi(async()=>({...receipt,roleVersion:3}),journal)
 await assert.rejects(api.change(command),/不一致/);assert.ok(api.pending())
 const denied=createRoleToolGrantApi(async()=>{throw Object.assign(Error('changed'),{rejected:true,code:'teloa/version-conflict'})},journal)
 await assert.rejects(denied.recover(),/changed/);assert.equal(raw,null)
 raw='broken';let calls=0;const corrupt=createRoleToolGrantApi(async()=>{calls++},journal)
 await assert.rejects(corrupt.change(command),error=>error instanceof Error&&'code' in error&&error.code==='teloa/storage-corrupt');assert.equal(calls,0)
})

test('技能代发候选（规格 2026-09-27 §5.1，审查修复 R1 M-1）：按技能逐项枚举，展示信息（含来源）与规则逐项一一对应',async()=>{
 const skillHttpRule={name:'teloa_skill_http',allowed:[{skill:'x-search'},{skill:'macro-data'}]}
 const journal={read:()=>null,write:()=>{},clear:()=>{}}
 const api=(value:unknown)=>createRoleToolGrantApi(async()=>value,journal)
 const skillHttp=[{skill:'x-search',origins:['https://api.x.ai'],configured:true,source:'role'},{skill:'macro-data',origins:['https://api.example.com','https://api.example.cn'],source:'industry'}]
 assert.deepEqual(await api({roleVersion:3,rules:[skillHttpRule],skillHttp}).candidates(roleId),{roleVersion:3,rules:[skillHttpRule],skillHttp})
 assert.deepEqual(await api({roleVersion:3,rules:[]}).candidates(roleId),{roleVersion:3,rules:[]})
 const one=(patch:Record<string,unknown>)=>[{skill:'x-search',origins:['https://api.x.ai'],source:'role',...patch}]
 const oneRule={name:'teloa_skill_http',allowed:[{skill:'x-search'}]}
 for(const bad of [
  {roleVersion:3,rules:[skillHttpRule]},
  {roleVersion:3,rules:[],skillHttp},
  {roleVersion:3,rules:[oneRule],skillHttp:[]},
  {roleVersion:3,rules:[{name:'teloa_skill_http',anyArguments:true,allowed:[]}],skillHttp:one({})},
  {roleVersion:3,rules:[skillHttpRule],skillHttp:one({})},
  {roleVersion:3,rules:[oneRule],skillHttp:[...one({}),...one({})]},
  {roleVersion:3,rules:[{name:'teloa_skill_http',allowed:[{skill:'x-search',method:'GET'}]}],skillHttp:one({})},
  {roleVersion:3,rules:[oneRule],skillHttp:one({origins:['http://api.x.ai']})},
  {roleVersion:3,rules:[oneRule],skillHttp:one({origins:[]})},
  {roleVersion:3,rules:[oneRule],skillHttp:one({source:'github'})},
  {roleVersion:3,rules:[oneRule],skillHttp:one({source:undefined})},
  {roleVersion:3,rules:[oneRule],skillHttp:one({configured:'yes'})},
  {roleVersion:3,rules:[oneRule],skillHttp:one({extra:1})},
  {roleVersion:3,rules:[{name:'teloa_skill_http',allowed:[{skill:'X Search'}]}],skillHttp:one({skill:'X Search'})},
 ])await assert.rejects(api(bad).candidates(roleId),/技能接口代发授权候选格式不正确/,JSON.stringify(bad))
})

test('roleGrant.skillHttp.* 词条 11 列、十种语言非空且不直接复用中文、按语言禁词不命中，并在授权页有引用',async()=>{
 const {readFile}=await import('node:fs/promises')
 const {WEB_ACCESS_MESSAGE_ROWS}=await import('../src/client/i18n/locales/web-access.ts')
 const rows=WEB_ACCESS_MESSAGE_ROWS.filter(row=>row[0].startsWith('roleGrant.skillHttp.'))
 assert.ok(rows.length>=4)
 const locales=['zh-CN','zh-Hant','en','ja','ko','vi','es','fr','de','pt'] as const
 const forbidden:Record<typeof locales[number],RegExp>={
  'zh-CN':/工作空间|单空间|实例|投影|尚未加载|内容待读取|\d+\s*项资源|人类/,
  'zh-Hant':/工作空間|單空間|實例|投影|尚未載入|內容待讀取|\d+\s*項資源|人類/,
  en:/workspace|instance|\bhumans?\b/i,
  ja:/ワークスペース|インスタンス|人間/,
  ko:/워크스페이스|인스턴스|인간/,
  vi:/workspace|instance|con người/i,
  es:/workspace|instance|humanos?/i,
  fr:/workspace|instance|humains?/i,
  de:/workspace|instance|Mensch(?:en)?/i,
  pt:/workspace|instance|humanos?/i,
 }
 const view=await readFile(new URL('../src/client/RoleToolGrants.tsx',import.meta.url),'utf8')
 for(const row of rows){
  assert.equal(row.length,11,row[0])
  assert.ok(row.slice(1).every(value=>typeof value==='string'&&value.trim().length>0),row[0])
  assert.notEqual(row[3],row[1],row[0]+' 英文不能直接复用中文')
  locales.forEach((locale,index)=>assert.doesNotMatch(row[index+1]!,forbidden[locale],row[0]+' '+locale))
  assert.ok(view.includes("'"+row[0]+"'"),'未接线：'+row[0])
  // 同文件既有德语词条用 Sie 体（审查修复 R1 L-4）
  assert.doesNotMatch(row[9]!,/\b(?:du|dich|dir|dein\w*|gib|trag)\b/i,row[0]+' de 须用 Sie')
 }
 for(const key of ['roleGrant.skillHttp.sourceRole','roleGrant.skillHttp.sourceIndustry','roleGrant.skillHttp.granted'])assert.ok(rows.some(row=>row[0]===key),key)
})
