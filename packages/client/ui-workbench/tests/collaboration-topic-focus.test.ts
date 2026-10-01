import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {returnPanelFocus as returnCollaborationPanelFocus} from '../src/client/panel-focus.ts'

const root = new URL('../src/client/', import.meta.url)

test('触发按钮仍在场且可见可用时，焦点归还助手把焦点还给它',()=>{
  const focusCalls:Array<{preventScroll?:boolean}|undefined>=[]
  const opener={focus:(options?:{preventScroll?:boolean})=>focusCalls.push(options),isConnected:true,getClientRects:()=>[{}],matches:(_selector:string)=>false}
  const mainFocusCalls:Array<{preventScroll?:boolean}|undefined>=[]
  const doc={getElementById:(id:string)=>id==='teloa-main'?{focus:(options?:{preventScroll?:boolean})=>mainFocusCalls.push(options)}:null}
  returnCollaborationPanelFocus(opener,doc)
  assert.deepEqual(focusCalls,[{preventScroll:true}])
  assert.deepEqual(mainFocusCalls,[])
})

test('触发按钮已从 DOM 移除、不可见或被禁用时，焦点归还助手回退到 #teloa-main',()=>{
  const doc=()=>{const calls:Array<{preventScroll?:boolean}|undefined>=[];return {calls,doc:{getElementById:(id:string)=>id==='teloa-main'?{focus:(options?:{preventScroll?:boolean})=>calls.push(options)}:null}}}
  const disconnected={focus:()=>assert.fail('不应聚焦已移除的元素'),isConnected:false,getClientRects:()=>[{}],matches:()=>false}
  const {calls:calls1,doc:doc1}=doc()
  returnCollaborationPanelFocus(disconnected,doc1)
  assert.deepEqual(calls1,[{preventScroll:true}])

  const invisible={focus:()=>assert.fail('不应聚焦不可见的元素'),isConnected:true,getClientRects:()=>[],matches:()=>false}
  const {calls:calls2,doc:doc2}=doc()
  returnCollaborationPanelFocus(invisible,doc2)
  assert.deepEqual(calls2,[{preventScroll:true}])

  const disabled={focus:()=>assert.fail('不应聚焦已禁用的元素'),isConnected:true,getClientRects:()=>[{}],matches:(selector:string)=>selector===':disabled'}
  const {calls:calls3,doc:doc3}=doc()
  returnCollaborationPanelFocus(disabled,doc3)
  assert.deepEqual(calls3,[{preventScroll:true}])

  const {calls:calls4,doc:doc4}=doc()
  returnCollaborationPanelFocus(null,doc4)
  assert.deepEqual(calls4,[{preventScroll:true}])
})

test('话题侧栏元素接管 tabIndex 并在打开／关闭时驱动焦点归还助手',async()=>{
  const source=await readFile(new URL('SavedCollaborationPage.tsx',root),'utf8')
  const asideLine=source.split('\n').find(line=>line.includes("aria-label={t(rootId?'collaboration.panel.topic'"))
  assert.ok(asideLine,'找不到话题讨论侧栏所在行')
  assert.match(asideLine!,/<aside ref=\{panelRef\} tabIndex=\{-1\}/)
  assert.match(asideLine!,/onKeyDown=\{event=>closeDirectoryDetailOnEscape\(event,closePanel\)\}/)
  // 关闭按钮改用同一个 closePanel，Esc 与「关闭协作侧栏」共享同一条关闭路径。
  assert.match(asideLine!,/aria-label=\{t\('collaboration\.panel\.close'\)\} onClick=\{closePanel\}/)
  assert.match(source,/returnPanelFocus\(panelOpener\.current,document\)/)
  assert.match(source,/panelRef\.current\?\.focus\(\{preventScroll:true\}\)/)
})
