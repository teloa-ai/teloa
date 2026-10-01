import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {WEB_ACCESS_MESSAGE_ROWS} from '../src/client/i18n/locales/web-access.ts'

// 功能验证 接线收尾裁定（同事上网一期，2026-09-21）：`webAccess.deny.*`（四条）与 `webAccess.run.empty`
// 一期在界面里没有任何消费面（一期只记「已放行」的外发，没有回传拒绝原因的界面，也没有「运行了但
// 零条上网记录」的可渲染边界态），属于死词条，已从词表删除（27→22）；不放进 orphan 守卫的豁免名单。
// 二期若要做「界面回传被拒原因」或运行记录节的显式空态，再重新开词条，不复活这里删掉的键。
test('同事上网词表 32 行（含技能接口代发 9 行）十一列齐全，十种语言无空串，接入主词典',async()=>{
 assert.equal(WEB_ACCESS_MESSAGE_ROWS.length,32)
 const forbidden=/工作空间|单空间|实例|投影|尚未加载|内容待读取|\d+\s*项资源|人类/
 const keys=new Set<string>()
 for(const row of WEB_ACCESS_MESSAGE_ROWS){
  assert.equal(row.length,11,row[0])
  assert.equal(keys.has(row[0]),false,row[0])
  keys.add(row[0])
  assert.equal(row.slice(1).every(value=>typeof value==='string'&&value.trim().length>0),true,row[0])
  assert.doesNotMatch(row[1],forbidden,row[0])
 }
 for(const key of ['roleGrant.web.title','roleGrant.web.description','roleGrant.web.search','roleGrant.web.searchHint','roleGrant.web.fetch','roleGrant.web.fetchHint','roleGrant.web.disabledByGlobal','roleGrant.web.twinNote','webAccess.run.title','webAccess.run.search','webAccess.run.fetch','webAccess.run.copy','webAccess.settings.title','webAccess.settings.enabled','webAccess.settings.enabledHint','webAccess.settings.blockTitle','webAccess.settings.blockHint','webAccess.settings.blockAdd','webAccess.settings.blockRemove','webAccess.settings.blockEmpty','webAccess.settings.blockInvalid','webAccess.settings.disclosure','webAccess.settings.scope'])assert.equal(keys.has(key),true,key)
 for(const key of ['webAccess.run.empty','webAccess.deny.disabled','webAccess.deny.blocked','webAccess.deny.unauthorized','webAccess.deny.record'])assert.equal(keys.has(key),false,key+' 一期无消费面，已删除，不应复活')
 const core=await readFile(new URL('../src/client/i18n/locales/core-pages.ts',import.meta.url),'utf8')
 assert.match(core,/WEB_ACCESS_MESSAGE_ROWS/)
})
