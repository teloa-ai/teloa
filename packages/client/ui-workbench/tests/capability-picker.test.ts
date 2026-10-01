import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import ts from 'typescript'
import * as React from 'react'
import type {CapabilitySnapshot} from '@teloa/contract'
import {FORMAL_UI_RESIDUAL_MESSAGE_ROWS} from '../src/client/i18n/locales/formal-ui-residual.ts'

const source=readFileSync(new URL('../src/client/Capabilities.tsx',import.meta.url),'utf8')
const frame=readFileSync(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8')

/** 组件带样式与图标依赖，这里只取真值函数：转译后用桩 require 装载，行为与线上同一份源码。 */
function loadModule(){
 const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
 const exported:Record<string,any>={}
 const require=(id:string)=>{
  if(id==='react')return React
  if(id==='clsx')return {default:(...values:unknown[])=>values.filter(Boolean).join(' ')}
  if(id==='lucide-react')return new Proxy({},{get:()=>()=>null})
  if(id==='@teloa/contract')return {isCapabilitySnapshot:()=>false}
  if(id.endsWith('ComposerPopover.js'))return {ComposerPopover:()=>null,ComposerSubmenu:()=>null}
  if(id.endsWith('i18n/format.js'))return {formatDateTime:()=>''}
  if(id.endsWith('i18n/errors.js'))return {localizeWorkError:()=>''}
  if(id.endsWith('.module.css'))return {default:new Proxy({},{get:(_,key)=>String(key)})}
  throw Error('未声明的组件依赖：'+id)
 }
 new Function('require','exports','React',code)(require,exported,React)
 return exported
}
const {capabilityCandidates}=loadModule()

const conversation={id:'c1',sessionId:'s1',requestedSessionId:'s1',ownerId:'owner',title:'对账工作',scopeIds:['general'],version:1,status:'ready',createdAt:'2026-09-20T00:00:00.000Z'}
const snapshot=(patch:Partial<CapabilitySnapshot>={}):CapabilitySnapshot=>({
 schema:'teloa.capabilities/v1',
 conversation:conversation as CapabilitySnapshot['conversation'],
 observedAt:'2026-09-20T01:00:00.000Z',
 skills:[
  {name:'对账核验',description:'核对账单与回执',source:'teloa',provider:'native',modelInvocable:true,userInvocable:true},
  {name:'内部巡检',description:'后台自动巡检',source:'teloa',provider:'native',modelInvocable:true,userInvocable:false},
 ],
 knowledge:{status:'ready',resources:[
  {id:'11111111-1111-4111-8111-111111111111',ownerId:'owner',version:3,status:'active',title:'对账手册',sourceId:'src-1',sourceVersion:'a'.repeat(64),scopeIds:['general'],createdAt:'2026-09-20T00:00:00.000Z',updatedAt:'2026-09-20T00:00:00.000Z'},
 ]},
 connections:{status:'observed',tools:[{name:'mcp__ledger__read',description:'读取账本'}]},
 writes:{status:'draft-only'},
 ...patch,
})

test('候选项按页签取自会话能力快照，连接只列出不可勾',()=>{
 const rows=snapshot()
 const knowledge=capabilityCandidates(rows,'knowledge','知识','')
 assert.deepEqual(knowledge.map((row:any)=>[row.key,row.title,row.detail,row.blocked]),[
  ['knowledge:11111111-1111-4111-8111-111111111111','对账手册','知识 · v3',false],
 ])
 const skills=capabilityCandidates(rows,'skill','技能','')
 assert.deepEqual(skills.map((row:any)=>[row.key,row.title,row.blocked]),[
  ['skill:对账核验','对账核验',false],
  ['skill:内部巡检','内部巡检',true],
 ])
 const connections=capabilityCandidates(rows,'connection','连接','')
 assert.deepEqual(connections.map((row:any)=>[row.key,row.title,row.blocked]),[['connection:mcp__ledger__read','mcp__ledger__read',true]])
})

test('搜索按标题、描述与小字过滤，空查询列出全部；无快照与未接入时为空',()=>{
 const rows=snapshot()
 assert.deepEqual(capabilityCandidates(rows,'skill','技能','  ').length,2)
 assert.deepEqual(capabilityCandidates(rows,'skill','技能','回执').map((row:any)=>row.id),['对账核验'])
 assert.deepEqual(capabilityCandidates(rows,'skill','技能','native').map((row:any)=>row.id),['对账核验','内部巡检'])
 assert.deepEqual(capabilityCandidates(rows,'knowledge','知识','没有这个'),[])
 assert.deepEqual(capabilityCandidates(undefined,'knowledge','知识',''),[])
 assert.deepEqual(capabilityCandidates(snapshot({knowledge:{status:'not-connected'}}),'knowledge','知识',''),[])
 assert.deepEqual(capabilityCandidates(snapshot({connections:{status:'not-connected'}}),'connection','连接',''),[])
})

test('知识与能力复用输入框级联菜单，保留搜索、勾选与本会话应用',()=>{
 assert.match(source,/<ComposerPopover cascade anchor=\{anchor\}/)
 assert.match(source,/<ComposerSubmenu key=\{tab\}/)
 assert.match(source,/onPointerEnter=\{event=>\{if\(event.pointerType==='mouse'/)
 assert.match(source,/event.key==='ArrowRight'/)
 assert.doesNotMatch(source,/<dialog|openDialog|base\.alignedDialog/)
 assert.match(source,/aria-label=\{t\('capabilities\.close'\)\}/)
 for(const key of ['capabilities.picker.searchAria','capabilities.picker.searchPlaceholder','capabilities.picker.listAria','capabilities.picker.selectAria','capabilities.picker.empty','capabilities.picker.selected','capabilities.picker.apply'])
  assert.ok(source.includes("t('"+key+"'"),key)
 for(const key of ['capabilities.picker.tab.knowledge','capabilities.picker.tab.skill','capabilities.picker.tab.connection','capabilities.picker.manage.knowledge','capabilities.picker.manage.skill','capabilities.picker.manage.connection','capabilities.picker.connectionBlocked'])
  assert.ok(source.includes("'"+key+"'"),key)
 assert.match(source,/aria-expanded=\{tab===key\}/)
 assert.match(source,/type="checkbox"[\s\S]{0,200}disabled=\{row\.blocked\}/)
 assert.doesNotMatch(source,/dangerouslySetInnerHTML/)
})

test('管理行沿用既有入口，「用于本会话」直接进入原生引用插入口',()=>{
 assert.match(source,/if\(tab==='knowledge'\)openResources\(\);else openTeamCapabilities\(\)/)
 assert.match(source,/handler\(\{sessionId,title:t\('capabilities\.title'\),skills,resources\}\);close\(\)/)
 assert.match(frame,/registerCapabilitySelection\(selection=>\{[^}]*insertConversationCapabilities\(selection\)/)
})

test('选择器词条覆盖十套主语言，文案逐字照原型且不带系统黑话',()=>{
 const rows=new Map(FORMAL_UI_RESIDUAL_MESSAGE_ROWS.map(row=>[row[0],row]))
 const keys=['context','tabsAria','tab.knowledge','tab.skill','tab.connection','searchAria','searchPlaceholder','listAria','selectAria','empty','connectionBlocked','manage.knowledge','manage.skill','manage.connection','selected','cancel','apply','limit','unavailable','preparedText'].map(name=>'capabilities.picker.'+name)
 for(const key of keys){
  const row=rows.get(key)
  assert.ok(row,key)
  assert.equal(row?.length,11,key)
  for(const value of row!.slice(1))assert.ok(value.trim(),key)
 }
 assert.equal(rows.get('capabilities.picker.context')?.[1],'用于 {title}')
 assert.equal(rows.get('capabilities.picker.tabsAria')?.[1],'能力分类')
 assert.deepEqual(keys.slice(2,5).map(key=>rows.get(key)?.[1]),['知识','技能','连接'])
 assert.equal(rows.get('capabilities.picker.searchAria')?.[1],'搜索知识与能力')
 assert.equal(rows.get('capabilities.picker.searchPlaceholder')?.[1],'搜索名称、方法或业务范围…')
 assert.equal(rows.get('capabilities.picker.listAria')?.[1],'{category}候选项')
 assert.equal(rows.get('capabilities.picker.selectAria')?.[1],'选择{title}')
 assert.equal(rows.get('capabilities.picker.empty')?.[1],'没有匹配的{category}，试试其他关键词。')
 assert.equal(rows.get('capabilities.picker.connectionBlocked')?.[1],'由执行位置统一提供')
 assert.deepEqual(keys.slice(11,14).map(key=>rows.get(key)?.[1]),['打开知识库','去市场找技能','管理连接'])
 assert.equal(rows.get('capabilities.picker.selected')?.[1],'已选 {count} 项')
 assert.equal(rows.get('capabilities.picker.cancel')?.[1],'取消')
 assert.equal(rows.get('capabilities.picker.apply')?.[1],'用于本会话')
 const text=keys.flatMap(key=>rows.get(key)!.slice(1)).join('\n')
 assert.doesNotMatch(text,/工作空间|单空间|实例|投影|尚未加载|内容待读取|项资源|人类/)
})
