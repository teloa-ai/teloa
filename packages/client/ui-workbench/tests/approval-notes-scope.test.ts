import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import type {ApprovalRecord} from '../src/client/approval-preview.ts'

// 与 attention-decision-card.test.ts 同样的取巧：.tsx 走 tsc 产物，CSS Modules 换成类名代理。
registerHooks({
 resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
})
const {ApprovalCard}=await import('../lib/types/client/ApprovalCard.js')
const {ApprovalNotesProvider}=await import('../lib/types/client/ApprovalNotes.js')
const {I18nProvider}=await import('../lib/types/client/i18n/provider.js')
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')

const runtime={t:(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params),subscribe:()=>()=>{},getSnapshot:()=>({locale:'zh-CN' as const,dshLocale:'zh',revision:1})}
const render=(node:unknown)=>renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime as never},node as never))

const approval:ApprovalRecord={
 id:'ap-1',version:2,status:'pending',submittedAt:'2026-09-15T02:00:00.000Z',expiresAt:'2099-09-15T02:00:00.000Z',
 snapshot:{
  title:'隔离 prod-03',object:{key:'business.operation.kicker',params:{version:1}},subjectLabel:{key:'business.operation.kicker',params:{version:1}},subjectVersion:1,
  risk:{key:'security.risk.high'},goal:'隔离受控主机',result:'建议隔离',evidence:['外联 C2'],effect:{key:'security.reversible.irreversible'},artifactText:'',
 },
} as unknown as ApprovalRecord

/**
 * C1：右栏页签的正文挂在 `.details` 轨道里的座位上。provider 只包 `<main>` 时它是兄弟而不是祖先，
 * 正文一渲染就抛，而 DSH 右栏与 dockkit 都没有 error boundary。
 */
test('页签正文里的 ApprovalCard 在 provider 之下能渲染，缺 provider 必抛',()=>{
 const html=render(createElement(ApprovalNotesProvider as never,null,
  createElement('div',{className:'details'},createElement(ApprovalCard as never,{approval,onDecide:()=>true} as never)),
 ))
 assert.match(html,/隔离 prod-03/)
 // 反面：没有 provider 就是今天右栏崩掉的那条路径，必须一直抛，别被“顺手加个默认值”悄悄抹平。
 assert.throws(()=>render(createElement(ApprovalCard as never,{approval,onDecide:()=>true} as never)))
})

test('ApprovalNotesProvider 与 BusinessScopeProvider 同层包住整个 frame，含 .details 轨道',async()=>{
 const source=await readFile(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8')
 assert.match(source,/<BusinessScopeProvider labels=\{scopeLabels\}><ApprovalNotesProvider><div ref=\{frameRef\}/)
 assert.match(source,/<\/div><\/ApprovalNotesProvider><\/BusinessScopeProvider>/)
 assert.doesNotMatch(source,/<ApprovalNotesProvider><main/,'provider 不能只包 <main>')
 const opened=source.indexOf('<ApprovalNotesProvider>'),closed=source.indexOf('</ApprovalNotesProvider>')
 assert.ok(opened>=0&&closed>opened)
 assert.ok(source.slice(opened,closed).includes('className={css.details}'),'.details 轨道必须在 provider 之内')
})
