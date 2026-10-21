import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import ts from 'typescript'
import {readDirectoryFilterCategory,writeDirectoryFilterCategory} from '../src/client/workbench-navigation-state.ts'
import {translateMessage} from '../lib/types/client/i18n/messages.js'
import {LIBRARY_MESSAGE_KEYS} from '../src/client/i18n/locales/library.ts'
const frame=readFileSync(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8')
test('真实Frame资料入口携带固定版本与业务范围进入准备流程，不自动发送',()=>{
 const source=ts.createSourceFile('WorkbenchFrame.tsx',frame,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
 let expression:ts.Expression|undefined
 const visit=(node:ts.Node)=>{
  if(ts.isJsxSelfClosingElement(node)&&node.tagName.getText(source)==='ResourceManager'){
   const prop=node.attributes.properties.find(row=>ts.isJsxAttribute(row)&&row.name.getText(source)==='onUseResource')
   if(prop&&ts.isJsxAttribute(prop)&&prop.initializer&&ts.isJsxExpression(prop.initializer))expression=prop.initializer.expression
  }
  ts.forEachChild(node,visit)
 }
 visit(source);assert.ok(expression&&ts.isArrowFunction(expression),'实际资料入口必须提供准备动作')
 const code=ts.transpileModule('const useResource='+expression.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText
 const calls:any[]=[]
 const invoke=new Function('requestCreation','t',code+';return useResource')((input:any)=>calls.push(input),(key:string,params:any)=>params.name)
 invoke({id:'r',version:4,title:'手册',scopeIds:['SOC']})
 invoke({id:'general-r',version:2,title:'通用手册',scopeIds:['SOC','general']})
 assert.deepEqual(calls,[{goal:'手册',scope:'SOC',resources:[{id:'r',version:4,title:'手册'}]},{goal:'通用手册',scope:'general',resources:[{id:'general-r',version:2,title:'通用手册'}]}])
 assert.doesNotMatch(code,/sendConversationMessage|execute/)
})
test('目录记忆保留访问视图、浏览文件夹与详情层，旧记忆兼容',()=>{
 const defaults={category:'all',mobileLayer:'directory',libraryView:'mine',browseNodeId:''},allowed={libraryView:['mine','recent','star','local','space'],category:['all'],mobileLayer:['directory','detail']}
 const fields={...defaults,libraryView:'space',browseNodeId:'folder-123',mobileLayer:'detail'}
 assert.deepEqual(readDirectoryFilterCategory(writeDirectoryFilterCategory(fields),defaults,allowed),fields)
 assert.deepEqual(readDirectoryFilterCategory('{"category":"all","mobileLayer":"detail"}',defaults,allowed),{...defaults,mobileLayer:'detail'})
})
test('简繁英资料库词条完整，地区保留原支持，其余语言英文回退',()=>{
 for(const locale of ['zh-CN','zh-HK','zh-TW','en'] as const)for(const key of LIBRARY_MESSAGE_KEYS){assert.notEqual(translateMessage(locale,key),key)}
 assert.equal(translateMessage('ja','library.search'),translateMessage('en','library.search'))
 assert.equal(translateMessage('zh-CN','library.local'),'本地文件')
 assert.equal(translateMessage('zh-TW','library.local'),'本機檔案')
})
