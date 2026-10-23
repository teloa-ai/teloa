import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {WORKSPACE_SETTINGS_MESSAGE_ROWS} from '../src/client/i18n/locales/workspace-settings.ts'

test('执行位置说明：Web 端不能选择本机目录时必须给出明确路径与桌面端提示',async()=>{
 const rows=new Map(WORKSPACE_SETTINGS_MESSAGE_ROWS.map(row=>[row[0],row]))
 const hint=rows.get('workspaceSettings.webPickerHint')
 assert.ok(hint,'缺少 workspaceSettings.webPickerHint 词条')
 assert.equal(hint.length,11,hint[0])
 for(const value of hint!.slice(1))assert.ok(String(value).trim(),hint![0])
 assert.match(String(hint![1]),/Web/)
 assert.match(String(hint![1]),/绝对路径/)
 const source=await readFile(new URL('../src/client/WorkspaceSettings.tsx',import.meta.url),'utf8')
 assert.match(source,/workspaceSettings\.webPickerHint/,'执行位置页必须渲染 Web 目录选择说明')
 assert.match(source,/role="note"/,'说明使用 note 角色，读屏可读到')
})
