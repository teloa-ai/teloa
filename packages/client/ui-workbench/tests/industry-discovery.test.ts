import test from 'node:test'
import assert from 'node:assert/strict'
import { discoverIndustryTemplates } from '../src/client/industry-directory.ts'
const file=(path:string,text:string)=>{const bytes=new TextEncoder().encode(text);return {path,size:bytes.length,read:async()=>bytes}}
const manifest=(id:string)=>({format:'teloa.business-package/v2',id,title:id,version:'1.0.0',domain:'general',description:'行业集合',resources:[{id:'guide',kind:'knowledge',title:'手册',version:'1.0.0',required:true,source:{kind:'local',path:'guide.md'}}],relations:[],entrypoints:[]})
test('发现多个行业模板，隔离内容树和摘要，文件只读取一次',async()=>{
 let reads=0
 const inputs=[file('repo/a/teloa.json',JSON.stringify(manifest('a'))),file('repo/a/guide.md','A'),file('repo/b/teloa.json',JSON.stringify(manifest('b'))),file('repo/b/guide.md','B')].map(input=>({...input,read:async()=>{reads++;return input.read()}}))
 const rows=await discoverIndustryTemplates(inputs,'repo')
 assert.equal(reads,4);assert.equal(rows.length,2)
 assert.equal(rows[0]?.item?.packageContent?.files.length,2)
 const changed=await discoverIndustryTemplates([...inputs.slice(0,3),file('repo/b/guide.md','Changed')],'repo')
 assert.equal(rows[0]?.item?.id,changed[0]?.item?.id)
 assert.notEqual(rows[1]?.item?.id,changed[1]?.item?.id)
})
test('坏清单单独报告，普通组件JSON不冒充行业模板',async()=>{
 const rows=await discoverIndustryTemplates([file('good/teloa.json',JSON.stringify(manifest('good'))),file('bad/teloa.json','{bad'),file('good/role.json','{"format":"teloa.role/v1"}')],'repo')
 assert.equal(rows.length,2)
 assert.ok(rows.find(row=>row.path==='bad/teloa.json')?.error)
 assert.equal(rows.find(row=>row.path==='good/teloa.json')?.item?.title,'good')
})
