import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {readDirectoryFilterCategory,writeDirectoryFilterCategory} from '../src/client/workbench-navigation-state.ts'
import {translateMessage} from '../lib/types/client/i18n/messages.js'
import {LIBRARY_MESSAGE_KEYS} from '../src/client/i18n/locales/library.ts'
const frame=readFileSync(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8')
test('真实Frame资料入口携带固定版本与业务范围进入准备流程，不自动发送',()=>{
 const expression=frame.match(/<ResourceManager[^\n]+onUseResource=\{resource=>(.*?)\} onExtensions=/)?.[1]
 assert.ok(expression)
 const calls:any[]=[]
 const invoke=new Function('requestCreation','t','resource',expression.replace(' as CollaborationScope',''))
 invoke((input:any)=>calls.push(input),(key:string,params:any)=>params.name,{id:'r',version:4,title:'手册',scopeIds:['SOC']})
 assert.deepEqual(calls,[{goal:'手册',scope:'SOC',resources:[{id:'r',version:4,title:'手册'}]}])
 assert.doesNotMatch(expression,/sendConversationMessage|execute/)
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
