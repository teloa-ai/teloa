import test from 'node:test'
import assert from 'node:assert/strict'
import {CREDENTIAL_STORE_MESSAGE_ROWS} from '../lib/types/client/i18n/locales/credential-store.js'
import {translateMessage} from '../lib/types/client/i18n/messages.js'

test('18 行、每行 11 列、无禁词，已并入消息表',()=>{
 assert.equal(CREDENTIAL_STORE_MESSAGE_ROWS.length,18)
 for(const row of CREDENTIAL_STORE_MESSAGE_ROWS){
  assert.equal(row.length,11,row[0])
  assert.ok(row.every(cell=>typeof cell==='string'&&cell.trim().length>0),row[0])
  assert.doesNotMatch(row[1],/工作空间|单空间|实例|投影|尚未加载|内容待读取|\d+\s*项资源|人类/,row[0])
  assert.doesNotMatch(row[3],/workspace|instance|human/i,row[0])
 }
 assert.equal(translateMessage('en','credentialStore.copies.confirm',{count:2}),'Permanently delete the 2 selected files?')
 assert.match(translateMessage('ja','error.secretInMessage'),/送信しませんでした/)
 assert.equal(translateMessage('en','credentialStore.copies.selectAll'),'Select all')
 // 审查 m3：确认句各语言一致，不另加「再点一次」；m4：提示覆盖隔离副本并说明系统备份（如时间机器）可能留有旧数据；m5：meta 缺失/损坏与存储不可用有恢复路径
 const row=(key:string)=>CREDENTIAL_STORE_MESSAGE_ROWS.find(item=>item[0]===key)!
 assert.equal(row('credentialStore.copies.confirm')[1],'确定永久删除所选的 {count} 个文件？')
 assert.equal(row('credentialStore.copies.confirm')[2],'確定永久刪除所選的 {count} 個檔案？')
 assert.match(row('credentialStore.copies.hint')[1],/隔离/);assert.match(row('credentialStore.copies.hint')[1],/系统备份/);assert.match(row('credentialStore.copies.hint')[3],/quarantined/);assert.match(row('credentialStore.copies.hint')[3],/backups/i)
 assert.match(row('credentialStore.locked.meta')[1],/reset/);assert.match(row('credentialStore.locked.meta')[1],/\.credentials\.meta\.json/)
 assert.ok(row('credentialStore.locked.storeUnavailable'));assert.ok(row('credentialStore.copies.shared'))
 for(const row of CREDENTIAL_STORE_MESSAGE_ROWS.filter(row=>row[0]==='credentialStore.copies.refused'||row[0]==='credentialStore.copies.confirm'))for(const cell of row.slice(1))assert.match(cell,/\{count\}/,row[0])
})

test('设置页组件：两步确认、逐项与全选、不用 window.confirm 与 dangerouslySetInnerHTML',async()=>{
 const {readFile}=await import('node:fs/promises')
 const source=await readFile(new URL('../src/client/CredentialStoreSettings.tsx',import.meta.url),'utf8')
 assert.doesNotMatch(source,/window\.confirm|dangerouslySetInnerHTML/)
 assert.match(source,/credentialStore\.copies\.selectAll/)
 // 硬链接项（shared）标注需手动处理且不可勾选，全选也不含它；meta 缺失/损坏与存储不可用各有恢复提示
 assert.match(source,/credentialStore\.copies\.shared/)
 assert.match(source,/disabled=\{busy\|\|confirming\|\|copy\.shared\}/)
 assert.match(source,/selectable=status\?\.copies\.filter\(copy=>!copy\.shared\)/)
 assert.match(source,/meta-missing'\|\|status\?\.fault==='meta-invalid'\?t\('credentialStore\.locked\.meta'\)/)
 assert.match(source,/store-unavailable'\?t\('credentialStore\.locked\.storeUnavailable'\)/)
 // 删除端点只在确认态的按钮里调用
 assert.equal(source.split('api.deleteCopies(').length-1,1)
 assert.match(source,/confirming\?[^:]*onClick=\{\(\)=>void remove\(\)\}/)
})
