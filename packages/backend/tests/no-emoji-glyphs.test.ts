import assert from 'node:assert/strict'
import test from 'node:test'
import {fileURLToPath} from 'node:url'
import {directoryGlyphHits,glyphHits} from '../../../tests/lib/no-emoji-glyphs.mjs'

// 用户可见文案（确认卡、报错、提示）不含 emoji 或易成 emoji 的符号；规则与豁免理由见 tests/lib/no-emoji-glyphs.mjs。
test('源码字符串与模板字面量不含 emoji 或易成 emoji 的符号字符（注释不计）',async()=>{
  assert.deepEqual(await directoryGlyphHits(fileURLToPath(new URL('../src/',import.meta.url))),[])
})

test('守卫本身能拦住：字符串与模板里的箭头、星形会被找出，注释、©与群聊表情回应不会',()=>{
  const sample="// 设置 → 模型\nconst a='打开 ↗'\nconst b=`评分 ★ ${4}`\nconst c='© 2026',d='👀',e='收到 👀'\n"
  assert.deepEqual(glyphHits('sample.ts',sample),['2 ↗ U+2197','3 ★ U+2605','4 👀 U+1F440'])
})
