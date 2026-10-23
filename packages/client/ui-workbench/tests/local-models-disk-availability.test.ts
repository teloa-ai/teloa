import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {LOCAL_MODELS_MESSAGE_ROWS} from '../src/client/i18n/locales/local-models.ts'

test('本地模型硬件信息在宿主未提供磁盘空间时给出可读说明，而不是空破折号',async()=>{
 const rows=new Map(LOCAL_MODELS_MESSAGE_ROWS.map(row=>[row[0],row]))
 const copy=rows.get('localModels.hardware.diskUnavailable')
 assert.ok(copy,'缺少 localModels.hardware.diskUnavailable 词条')
 assert.equal(copy!.length,11,copy![0])
 for(const value of copy!.slice(1))assert.ok(String(value).trim(),copy![0])
 assert.match(String(copy![1]),/不可读取|未提供/, '中文说明应解释为什么没有数值')
 const source=await readFile(new URL('../src/client/LocalModelsSettings.tsx',import.meta.url),'utf8')
 assert.match(source,/diskUnavailable/,'硬件信息与确认弹窗都应使用显式不可读取说明')
 assert.match(source,/diskFree\s*===\s*null|diskFreeBytes===null|value===null\|\|value===undefined/,'空磁盘值不得直接交给 formatBytes 输出破折号')
})
