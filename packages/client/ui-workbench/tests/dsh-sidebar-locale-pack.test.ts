import assert from 'node:assert/strict'
import test from 'node:test'
import {DSH_SIDEBAR_NAMESPACES,installDshSidebarLanguagePack} from '../src/client/i18n/dsh-sidebar.ts'

const LOCALES=['zh-Hant','ja','ko','vi','es','fr','de','pt'] as const

test('九个命名空间的键集与上游逐键一致，不多不少',()=>{
 assert.deepEqual(Object.keys(DSH_SIDEBAR_NAMESPACES).sort(),['documentHtml','documentMarkdown','sidebarCodePreview','sidebarDocumentPreview','sidebarFiles','sidebarImage','sidebarPdf','sidebarRight','sidebarTerminal'])
 const counts:Record<string,number>={sidebarRight:21,sidebarTerminal:27,sidebarFiles:13,sidebarDocumentPreview:19,documentMarkdown:4,sidebarCodePreview:3,sidebarPdf:9,documentHtml:4,sidebarImage:5}
 for(const [namespace,rows] of Object.entries(DSH_SIDEBAR_NAMESPACES)){
  assert.equal(rows.length,counts[namespace],namespace+' 行数不对')
  assert.equal(new Set(rows.map(row=>row[0])).size,rows.length,namespace+' 有重复键')
 }
})

test('五个渲染器命名空间使用上游的真实键与占位符，不能把未传入的参数画到界面上',()=>{
 const rendererKeys:Record<string,readonly string[]>={
  documentMarkdown:['viewer.label','code.copy','code.copied','footnotes'],
  sidebarCodePreview:['title','copy','copied'],
  sidebarPdf:['title','pageImage','loading','rendering','failed','password','workerFailed','unsupported','retry'],
  documentHtml:['title','frame','loading','failed'],
  sidebarImage:['title','preview','loading','failed','unsupported'],
 }
 const placeholders:Record<string,Readonly<Record<string,readonly string[]>>>={
  documentMarkdown:{},sidebarCodePreview:{},sidebarPdf:{pageImage:['page'],failed:['message']},documentHtml:{},sidebarImage:{preview:['name']},
 }
 const names=(text:string)=>[...text.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map(match=>match[1]).sort()
 for(const [namespace,keys] of Object.entries(rendererKeys)){
  const rows=DSH_SIDEBAR_NAMESPACES[namespace as keyof typeof DSH_SIDEBAR_NAMESPACES]
  const namespacePlaceholders=placeholders[namespace]??{}
  assert.deepEqual(rows.map(row=>row[0]),keys,namespace+' 键集与上游不一致')
  for(const row of rows)for(const value of row.slice(1))assert.deepEqual(names(value),[...(namespacePlaceholders[row[0]]??[])],namespace+' · '+row[0]+' 占位符不正确')
 }
})

test('每行都是 9 列且没有空串',()=>{
 for(const [namespace,rows] of Object.entries(DSH_SIDEBAR_NAMESPACES))for(const row of rows){
  assert.equal(row.length,9,namespace+' · '+row[0]+' 不是 9 列')
  for(const value of row)assert.ok(typeof value==='string'&&value.trim().length>0,namespace+' · '+row[0]+' 有空列')
 }
})

test('占位符在九列之间一致，漏一个 {message} 就是运行期显示花括号',()=>{
 const placeholders=(text:string)=>[...text.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map(match=>match[1]).sort()
 for(const [namespace,rows] of Object.entries(DSH_SIDEBAR_NAMESPACES))for(const row of rows){
  const expected=placeholders(String(row[1]))
  for(let index=2;index<row.length;index++)assert.deepEqual(placeholders(String(row[index])),expected,namespace+' · '+row[0]+' 第 '+index+' 列占位符不一致')
 }
})

test('安装为每种语言逐个命名空间注册一次，卸载全部释放',()=>{
 const registered:Array<[string,string,number]>=[]
 let disposed=0
 const locale={
  getSnapshot:()=>({active:'zh',revision:1}),
  subscribe:()=>()=>{},
  bind:()=>((key:string)=>key) as never,
  addLanguage:()=>()=>{},
  register:(namespace:string,target:string,dictionary:Readonly<Record<string,string>>)=>{registered.push([namespace,target,Object.keys(dictionary).length]);return ()=>{disposed++}},
 }
 const disposers=installDshSidebarLanguagePack(locale,'zh-TW')
 assert.equal(registered.length,9*LOCALES.length)
 assert.ok(registered.some(([namespace,target])=>namespace==='sidebarTerminal'&&target==='zh-TW'))
 assert.ok(!registered.some(([,target])=>target==='zh-Hant'))
 assert.ok(registered.every(([namespace,,size])=>size===DSH_SIDEBAR_NAMESPACES[namespace as keyof typeof DSH_SIDEBAR_NAMESPACES].length))
 for(const dispose of disposers)dispose()
 assert.equal(disposed,9*LOCALES.length)
})

test('繁中入口只有一个：传 zh-Hant 时注册到 zh-Hant',()=>{
 const registered:string[]=[]
 const locale={
  getSnapshot:()=>({active:'zh',revision:1}),
  subscribe:()=>()=>{},
  bind:()=>((key:string)=>key) as never,
  addLanguage:()=>()=>{},
  register:(_namespace:string,target:string)=>{registered.push(target);return ()=>{}},
 }
 installDshSidebarLanguagePack(locale,'zh-Hant')
 assert.equal(registered.filter(target=>target==='zh-Hant').length,9)
 assert.equal(registered.filter(target=>target==='zh-TW').length,0)
})

test('两份词表共用同一层取列与安装规矩，只维护词表内容',async()=>{
 const {DSH_PACK_LOCALES,dshPackDictionary}=await import('../src/client/i18n/dsh-locale-pack.ts')
 assert.deepEqual([...DSH_PACK_LOCALES],[...LOCALES])
 const rows=[['k','繁','ja','ko','vi','es','fr','de','pt']] as const
 assert.deepEqual(dshPackDictionary(rows as never,'ja'),{k:'ja'})
 assert.deepEqual(dshPackDictionary(rows as never,'pt'),{k:'pt'})
 // 两份词表都不再各写一遍语言清单、dictionary 与安装循环。
 const {readFile}=await import('node:fs/promises')
 for(const file of ['dsh-sidebar.ts','dsh-settings.ts']){
  const source=await readFile(new URL('../src/client/i18n/'+file,import.meta.url),'utf8')
  assert.match(source,/installDshLanguagePack\(locale,traditionalLocale,/,file)
  assert.doesNotMatch(source,/locales\.indexOf|function dictionary/,file+' 不该再自带公共层')
 }
})
